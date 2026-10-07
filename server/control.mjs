import { randomUUID } from 'node:crypto';
import { delegateToTeam } from './control/team-delegation.mjs';
import {
  readTeamTask,
  listTeamCollaborations,
} from './control/team-collaboration-read.mjs';
import { hashToken } from './auth.mjs';
import {
  bounded,
  collections,
  fail,
  findTeam,
  messageKinds,
  publicRecord,
  required,
  teamKey,
  teamMeta,
} from './control/primitives.mjs';
import { handleJobs } from './control/jobs.mjs';
import { createOperation, saveScopedRecord } from './control/records.mjs';
import { runAtomic } from './control/transactions.mjs';
import {
  handleNodes,
  isMachineRequest,
  nodeFromToken,
  nodeView,
  validateInstanceToken,
} from './control/nodes.mjs';
import {
  markNodeOnline,
  reconcileNodeLiveness,
} from './control/node-liveness.mjs';
import {
  eligible,
  dependencyComplete,
  claimLocal,
  heartbeatLocal,
  finishLocal,
  revokeExecution,
} from './control/execution-lifecycle.mjs';
import {
  completeJob,
  summarizeWhenReady,
  createJob,
  setTeamStatus,
} from './control/job-lifecycle.mjs';
import {
  proposeTeam,
  confirmTeamRecruitment,
  readTeamRoster,
} from './control/team-recruitment.mjs';
export class ControlPlane {
  constructor({
    store,
    createTask = (input) => store.createTask(input),
    updateTask = (id, changes) => store.updateTask(id, changes),
    stopTask,
    buildAssignment,
    onEvent,
    onRemoteDone,
    evaluateDecision = async () => {
      throw fail('TypeSafe 决策服务未配置。');
    },
    now = () => Date.now(),
    leaseMs = 60000,
  } = {}) {
    this.store = store;
    this.records = store.records;
    this.createTask = createTask;
    this.updateTask = updateTask;
    this.stopTask = stopTask;
    this.buildAssignment = buildAssignment;
    this.onEvent = onEvent;
    this.onRemoteDone = onRemoteDone;
    this.evaluateDecision = evaluateDecision;
    this.now = now;
    this.leaseMs = leaseMs;
  }
  atomic(fn) {
    return runAtomic(this.store, fn);
  }
  isMachineRequest(input) {
    return isMachineRequest(input);
  }
  nodeFromToken(token) {
    return nodeFromToken(this, token);
  }
  nodeView(node) {
    return nodeView(this, node);
  }
  reconcileNodes() {
    return reconcileNodeLiveness(this);
  }
  markNodeOnline(node) {
    return markNodeOnline(this, node);
  }
  validateInstanceToken(token) {
    return validateInstanceToken(this, token);
  }
  taskGroup(taskId) {
    const meta = this.records.get('task-meta', taskId) || {};
    const job = meta.jobId && this.records.get('jobs', meta.jobId);
    return job?.groupId || meta.groupId || meta.jobId || taskId;
  }
  authorizeTask(principal, taskId) {
    const task = this.store.task(required(taskId, '执行实例', 150));
    if (!task) throw fail('执行实例不存在。', 404);
    if (
      principal.type === 'instance' &&
      this.taskGroup(taskId) !== principal.groupId
    )
      throw fail('不能访问其他任务组。', 403);
    return task;
  }
  ensureCurrent(principal) {
    if (principal.type !== 'instance') return;
    const execution = this.records.get('executions', principal.taskId);
    if (
      !execution ||
      execution.epoch !== principal.epoch ||
      execution.status !== 'running' ||
      execution.expiresAt <= this.now()
    ) {
      throw fail('执行权限已撤销。', 401);
    }
  }
  attention(input, id) {
    const attention = this.records.save(
      'attention',
      { status: 'open', ...input },
      id,
    );
    if (attention.status === 'open') {
      const notificationId = `attention:${attention.id}`;
      const previous = this.records.get('notifications', notificationId);
      this.records.save(
        'notifications',
        {
          ...previous,
          name: attention.title || attention.name || '需要你处理',
          kind: attention.kind || 'attention',
          message:
            attention.detail ||
            attention.message ||
            '团队有一项需要确认的事项。',
          attentionId: attention.id,
          taskId: attention.taskId || null,
          jobId: attention.jobId || null,
          groupId: attention.groupId || null,
          spaceId: attention.spaceId || attention.teamId || null,
          read: previous?.read === true,
          occurredAt:
            previous?.occurredAt || new Date(this.now()).toISOString(),
        },
        notificationId,
      );
    }
    return attention;
  }
  reconcile() {
    const expired = [];
    for (const execution of this.records.list('executions')) {
      if (execution.status !== 'running' || execution.expiresAt > this.now())
        continue;
      this.records.save(
        'executions',
        {
          ...execution,
          status: 'state_unknown',
          tokenHash: null,
          revokedAt: this.now(),
        },
        execution.id,
      );
      this.updateTask(execution.taskId, {
        status: 'state_unknown',
        error: '执行节点失联，原执行状态未知；请确认已有操作后从新实例继续。',
      });
      this.attention(
        {
          taskId: execution.taskId,
          kind: 'lease-expired',
          title: '执行节点失联',
          detail: '原目录已隔离，不会自动重新执行。',
        },
        `lease:${execution.taskId}:${execution.epoch}`,
      );
      expired.push(publicRecord(execution));
    }
    return expired;
  }
  eligible(task, nodeId) {
    return eligible(this, task, nodeId);
  }
  dependencyComplete(taskId) {
    return dependencyComplete(this, taskId);
  }
  claimLocal(task, nodeId = 'local') {
    return claimLocal(this, task, nodeId);
  }
  heartbeatLocal(taskId, epoch, nodeId = 'local') {
    return heartbeatLocal(this, taskId, epoch, nodeId);
  }
  publishHandoffResult(task, meta, status, content) {
    if (!meta?.sourceMessageId || !meta.spaceId) return;
    const sourceHandoff = this.records
      .list('space-messages')
      .find(
        (message) =>
          message.kind === 'handoff' &&
          message.relatedMessageId === meta.sourceMessageId &&
          message.spaceId !== meta.spaceId,
      );
    if (!sourceHandoff) return;
    const target = this.store.teamSpace(meta.spaceId);
    const source = this.store.teamSpace(sourceHandoff.spaceId);
    if (!target || !source) return;
    const labels = {
      completed: '已完成',
      failed: '失败',
      cancelled: '已停止',
      interrupted: '已中断',
      state_unknown: '状态未知',
    };
    const summary =
      String(content || '').trim() ||
      `目标团队任务${labels[status] || status}。`;
    this.store.saveTeamMessage(
      {
        spaceId: source.id,
        teamId: source.id,
        kind: 'reply',
        senderType: 'team',
        senderId: target.id,
        fromTeamId: target.id,
        toTeamId: source.id,
        relatedMessageId: sourceHandoff.id,
        taskId: task.id,
        content:
          `目标团队「${target.name}」${labels[status] || status}：\n\n${summary}`.slice(
            0,
            32000,
          ),
        status: 'answered',
      },
      `handoff-reply:${task.id}`,
    );
    const targetHandoff = this.records.get(
      'space-messages',
      meta.sourceMessageId,
    );
    if (targetHandoff)
      this.records.save(
        'space-messages',
        { ...targetHandoff, status: 'answered' },
        targetHandoff.id,
      );
    this.records.save(
      'space-messages',
      { ...sourceHandoff, status: 'answered' },
      sourceHandoff.id,
    );
  }
  finishLocal(taskId, epoch, result = {}, nodeId = 'local') {
    return finishLocal(this, taskId, epoch, result, nodeId);
  }
  completeJob(job, status) {
    return completeJob(this, job, status);
  }
  summarizeWhenReady(job) {
    return summarizeWhenReady(this, job);
  }
  revokeExecution(taskId, reason = 'cancelled') {
    return revokeExecution(this, taskId, reason);
  }
  createJob(body, principal = { type: 'owner' }) {
    return createJob(this, body, principal);
  }
  setTeamStatus(teamId, status) {
    return setTeamStatus(this, teamId, status);
  }
  currentTeam(principal) {
    if (principal?.type !== 'instance')
      throw fail('只有运行中的团队智能体可以发起跨团队协作。', 403);
    const task = this.store.task(principal.taskId);
    if (!task) throw fail('当前执行实例不存在。', 404);
    const meta = teamMeta(this.store, task.id);
    const team = findTeam(this.store, meta.teamId || meta.spaceId);
    if (!team || team.status !== 'active')
      throw fail('当前执行实例不属于可协作的活动团队。', 403);
    return { task, meta, team };
  }
  recruitmentContext(principal) {
    this.ensureCurrent(principal);
    const context = this.currentTeam(principal);
    if (context.task.role !== context.team.pmRoleId)
      throw fail('只有团队项目经理可以维护团队招募方案。', 403);
    return context;
  }
  proposeTeam(body, principal) {
    return proposeTeam(this, body, principal);
  }
  confirmTeamRecruitment(spaceId, options = {}, principal = { type: 'owner' }) {
    return confirmTeamRecruitment(this, spaceId, options, principal);
  }
  readTeamRoster(principal) {
    return readTeamRoster(this, principal);
  }
  collaborationAllowed(source, target) {
    if (source.collaboration?.enabled === false) return false;
    const allowed = Array.isArray(source.collaboration?.allowedTeamIds)
      ? source.collaboration.allowedTeamIds
      : [];
    if (source.collaboration?.autoHandoff === false) return false;
    if (!allowed.length) return true;
    const targetId = teamKey(target);
    return (
      allowed.includes(target.id) ||
      allowed.includes(targetId) ||
      allowed.includes(target.chatId)
    );
  }
  listTeamSpaces(principal) {
    const { team: source } = this.currentTeam(principal);
    const teams = this.store
      .teamSpaces()
      .filter(
        (team) =>
          team.status === 'active' &&
          team.recruitment?.phase === 'confirmed' &&
          team.id !== source.id &&
          this.collaborationAllowed(source, team),
      );
    return {
      current: {
        id: source.id,
        teamId: teamKey(source),
        chatId: source.chatId || source.id,
        name: source.name,
      },
      items: teams.map((team) => ({
        id: team.id,
        teamId: teamKey(team),
        chatId: team.chatId || team.id,
        name: team.name,
        purpose: team.purpose || team.goal || '',
        teamType: team.teamType || 'custom',
        pmRoleId: team.pmRoleId,
        memberCount:
          team.recruitment?.phase === 'confirmed'
            ? Array.isArray(team.memberRoleIds)
              ? team.memberRoleIds.length
              : 0
            : team.pmRoleId
              ? 1
              : 0,
        status: team.status,
      })),
    };
  }
  delegateToTeam(body, principal) {
    return delegateToTeam(this, body, principal);
  }
  listTeamCollaborations(body, principal) {
    return listTeamCollaborations(this, body, principal);
  }
  readTeamTask(body, principal) {
    return readTeamTask(this, body, principal);
  }
  sendMessage(body, principal) {
    this.ensureCurrent(principal);
    let receiver;
    if (body.toTaskId) receiver = this.authorizeTask(principal, body.toTaskId);
    else if (principal.type === 'owner') {
      const role = this.store.role(required(body.toAgentId, '收件助手', 150));
      if (!role) throw fail('收件助手不存在。', 404);
      receiver = this.store
        .tasks()
        .find((task) => task.role === role.id && task.status === 'running') || {
        id: null,
        role: role.id,
      };
    } else throw fail('实例消息必须指定收件执行实例。');
    if (body.toAgentId && body.toAgentId !== receiver.role)
      throw fail('收件助手与执行实例不匹配。');
    const idempotencyKey = required(
      body.idempotencyKey || (principal.type === 'owner' ? randomUUID() : ''),
      '消息幂等键',
      200,
    );
    const senderId = principal.type === 'instance' ? principal.taskId : 'owner';
    const id = hashToken(`${senderId}:${idempotencyKey}`);
    const existing = this.records.get('messages', id);
    const payload = {
      toTaskId: receiver.id,
      toAgentId: receiver.role,
      kind: body.kind || 'notice',
      content: required(body.content, '消息内容'),
      replyTo: body.replyTo || null,
    };
    if (!messageKinds.has(payload.kind)) throw fail('消息类型不支持。');
    if (existing) {
      if (JSON.stringify(existing.payload) !== JSON.stringify(payload))
        throw fail('同一幂等键不能用于不同消息。', 409);
      return existing;
    }
    if (payload.replyTo) {
      const original = this.records.get('messages', payload.replyTo);
      if (
        !original ||
        original.toTaskId !== principal.taskId ||
        original.fromTaskId !== receiver.id
      )
        throw fail('回复关联不属于当前通信双方。', 403);
    }
    const meta =
      (receiver.id && this.records.get('task-meta', receiver.id)) || {};
    const job = meta.jobId && this.records.get('jobs', meta.jobId);
    return this.records.save(
      'messages',
      {
        ...payload,
        payload,
        fromTaskId: principal.taskId || null,
        fromAgentId: principal.agentId || 'owner',
        groupId: receiver.id ? this.taskGroup(receiver.id) : null,
        batchId: meta.batchId || receiver.id,
        requirementVersion:
          body.requirementVersion ||
          principal.requirementVersion ||
          job?.requirementVersion ||
          1,
        requirementUpdate:
          principal.type === 'owner' && body.requirementUpdate === true,
        stale:
          !!body.requirementVersion &&
          !!job &&
          body.requirementVersion !== job.requirementVersion,
        status: 'sent',
        idempotencyKey,
      },
      id,
    );
  }
  readMessages(taskId, principal) {
    if (principal.type === 'instance' && taskId !== principal.taskId)
      throw fail('只能领取自己的收件箱。', 403);
    this.authorizeTask(principal, taskId);
    const messages = this.records
      .list('messages')
      .filter((item) => item.toTaskId === taskId)
      .reverse()
      .slice(-100);
    const meta = this.records.get('task-meta', taskId) || {};
    const job = meta.jobId && this.records.get('jobs', meta.jobId);
    return messages.map((message) => {
      const updated = {
        ...message,
        stale: !!job && message.requirementVersion < job.requirementVersion,
      };
      return message.status === 'sent'
        ? this.records.save(
            'messages',
            { ...updated, status: 'received', receivedAt: this.now() },
            message.id,
          )
        : updated;
    });
  }
  acknowledge(id, body, principal) {
    this.ensureCurrent(principal);
    const message = this.records.get('messages', id);
    if (!message) throw fail('消息不存在。', 404);
    if (principal.type === 'instance' && message.toTaskId !== principal.taskId)
      throw fail('不能确认其他实例的消息。', 403);
    if (!['received', 'processing', 'processed'].includes(body.status))
      throw fail('回执状态不支持。');
    const rank = { sent: 0, received: 1, processing: 2, processed: 3 };
    if (rank[body.status] < rank[message.status]) return message;
    if (
      body.status === 'processed' &&
      message.requirementUpdate &&
      message.fromAgentId === 'owner'
    ) {
      const execution = this.records.get('executions', message.toTaskId);
      if (
        execution?.status === 'running' &&
        message.requirementVersion > (execution.requirementVersion || 1)
      ) {
        this.records.save(
          'executions',
          { ...execution, requirementVersion: message.requirementVersion },
          execution.id,
        );
      }
    }
    return this.records.save(
      'messages',
      { ...message, status: body.status, acknowledgedAt: this.now() },
      id,
    );
  }
  saveScoped(collection, body, principal, id) {
    return saveScopedRecord(this, collection, body, principal, id);
  }
  operation(body, principal) {
    return createOperation(this, body, principal);
  }
  async handle({
    method,
    parts,
    body = {},
    req,
    principal = { type: 'owner' },
    query,
  }) {
    if (parts[0] === 'api') parts = parts.slice(1);
    const [collection, id, action] = parts;
    if (collection !== 'nodes' && !collections.has(collection)) return null;
    try {
      if (collection === 'nodes')
        return await this.handleNodes({
          method,
          id,
          action,
          body,
          req,
          principal,
          query,
        });
      this.ensureCurrent(principal);
      if (method === 'GET') {
        if (id) {
          const record = this.records.get(collection, id);
          if (!record) throw fail('记录不存在。', 404);
          if (
            principal.type === 'instance' &&
            record.groupId !== principal.groupId
          )
            throw fail('没有访问权限。', 403);
          if (collection === 'jobs')
            return {
              status: 200,
              body: {
                ...record,
                tasks: this.store
                  .tasks()
                  .filter(
                    (task) =>
                      this.records.get('task-meta', task.id)?.jobId === id,
                  )
                  .map(({ context: _context, log: _log, ...task }) => task),
                children: this.records
                  .list('jobs')
                  .filter((job) => job.parentJobId === id),
                checkpoints: this.records
                  .list('checkpoints')
                  .filter((item) => item.groupId === record.groupId)
                  .slice(0, 50),
                artifacts: this.records
                  .list('artifacts')
                  .filter((item) => item.groupId === record.groupId)
                  .slice(0, 50),
              },
            };
          return { status: 200, body: record };
        }
        let records = this.records.list(collection);
        if (principal.type === 'instance')
          records = records.filter(
            (item) => item.groupId === principal.groupId,
          );
        const taskId = query?.get?.('taskId');
        if (taskId)
          records = records.filter(
            (item) =>
              (collection === 'messages' ? item.toTaskId : item.taskId) ===
              taskId,
          );
        return { status: 200, body: bounded(records, query) };
      }
      if (collection === 'jobs')
        return await handleJobs(this, { method, id, action, body, principal });
      if (collection === 'messages') {
        if (method === 'POST' && !id)
          return { status: 201, body: this.sendMessage(body, principal) };
        if (method === 'POST' && id === 'receive')
          return {
            status: 200,
            body: {
              items: this.readMessages(
                body.taskId || principal.taskId,
                principal,
              ),
            },
          };
        if (method === 'POST' && action === 'ack')
          return { status: 200, body: this.acknowledge(id, body, principal) };
      }
      if (collection === 'operations') {
        if (method === 'POST' && !id)
          return { status: 201, body: this.operation(body, principal) };
        if (method === 'POST' && action === 'result') {
          const record = this.records.get('operations', id);
          if (!record) throw fail('操作不存在。', 404);
          if (
            principal.type === 'instance' &&
            record.taskId !== principal.taskId
          )
            throw fail('不能更新其他实例的操作。', 403);
          if (!['succeeded', 'failed', 'unknown'].includes(body.status))
            throw fail('操作结果状态不支持。');
          if (record.status !== 'pending' && principal.type !== 'owner')
            return { status: 200, body: record };
          return {
            status: 200,
            body: this.records.save(
              'operations',
              {
                ...record,
                status: body.status,
                evidence: required(body.evidence, '执行证据'),
                reportedAt: this.now(),
              },
              id,
            ),
          };
        }
      }
      if (
        ['checkpoints', 'artifacts', 'attention', 'board'].includes(
          collection,
        ) &&
        ['POST', 'PUT'].includes(method)
      ) {
        return {
          status: id ? 200 : 201,
          body: this.saveScoped(collection, body, principal, id),
        };
      }
      return { status: 404, body: { error: '接口不存在。' } };
    } catch (error) {
      return { status: error.status || 400, body: { error: error.message } };
    }
  }
  async handleNodes(input) {
    return handleNodes(this, input);
  }
}

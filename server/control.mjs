import { randomBytes, randomUUID } from 'node:crypto';
import { bearer, hashToken } from './auth.mjs';
import { SKILLS } from './roles.mjs';

const terminal = new Set(['completed', 'failed', 'cancelled', 'interrupted', 'state_unknown']);
const messageKinds = new Set(['task', 'question', 'reply', 'progress', 'blocked', 'handoff', 'notice']);
const collections = new Set(['jobs', 'messages', 'checkpoints', 'artifacts', 'operations', 'attention', 'board']);
const fail = (message, status = 400) => Object.assign(new Error(message), { status });
const required = (value, label, max = 32000) => {
  if (typeof value !== 'string' || !value.trim() || value.length > max) throw fail(`${label}不能为空，且不能超过 ${max} 字符。`);
  return value.trim();
};
const publicRecord = record => {
  if (!record) return record;
  const { tokenHash: _tokenHash, ...safe } = record;
  return safe;
};
const bounded = (items, query) => {
  const limit = Math.max(1, Math.min(Number(query?.get?.('limit')) || 50, 100));
  const offset = Math.max(0, Number(query?.get?.('offset')) || 0);
  return { items: items.slice(offset, offset + limit), total: items.length, offset, limit };
};
const teamKey = team => team?.teamId || team?.id;
const findTeam = (store, value) => {
  const key = String(value || '').trim();
  if (!key) return null;
  return store.teamSpaces().find(team => team.id === key || team.teamId === key || team.chatId === key) || null;
};
const teamMeta = (store, taskId) => store.records.get('task-meta', taskId) || {};

export class ControlPlane {
  constructor({ store, createTask = input => store.createTask(input), updateTask = (id, changes) => store.updateTask(id, changes),
    stopTask, buildAssignment, onEvent, onRemoteDone, now = () => Date.now(), leaseMs = 60000 } = {}) {
    this.store = store;
    this.records = store.records;
    this.createTask = createTask;
    this.updateTask = updateTask;
    this.stopTask = stopTask;
    this.buildAssignment = buildAssignment;
    this.onEvent = onEvent;
    this.onRemoteDone = onRemoteDone;
    this.now = now;
    this.leaseMs = leaseMs;
  }
  atomic(fn) {
    this.store.db.exec('BEGIN IMMEDIATE');
    try { const result = fn(); this.store.db.exec('COMMIT'); return result; }
    catch (error) { this.store.db.exec('ROLLBACK'); throw error; }
  }
  isMachineRequest({ method, parts }) {
    if (parts[0] === 'api') parts = parts.slice(1);
    return method === 'POST' && parts[0] === 'nodes' && ['pair', 'claim', 'heartbeat', 'report'].includes(parts[1]);
  }
  nodeFromToken(token) {
    if (!token) throw fail('缺少节点认证。', 401);
    const node = this.records.list('nodes').find(item => item.tokenHash === hashToken(token));
    if (!node || node.revokedAt) throw fail('节点凭据无效或已撤销。', 401);
    return node;
  }
  validateInstanceToken(token) {
    if (!token) throw fail('缺少执行实例认证。', 401);
    const execution = this.records.list('executions').find(item => item.tokenHash === hashToken(token));
    if (!execution || execution.status !== 'running' || execution.expiresAt <= this.now()) throw fail('执行实例已过期或被撤销。', 401);
    const task = this.store.task(execution.taskId);
    if (!task || task.role !== execution.agentId || terminal.has(task.status)) throw fail('执行实例已结束。', 401);
    const meta = this.records.get('task-meta', task.id) || {};
    const job = meta.jobId && this.records.get('jobs', meta.jobId);
    if (job && (['paused', 'cancelled', 'budget-exceeded'].includes(job.status) || job.budgetExceeded)) throw fail('任务已暂停、取消或达到预算。', 403);
    return { type: 'instance', taskId: task.id, agentId: task.role, jobId: meta.jobId,
      groupId: execution.groupId, batchId: execution.batchId, epoch: execution.epoch,
      permissions: execution.permissions || [], requirementVersion: execution.requirementVersion || job?.requirementVersion || 1 };
  }
  taskGroup(taskId) {
    const meta = this.records.get('task-meta', taskId) || {};
    const job = meta.jobId && this.records.get('jobs', meta.jobId);
    return job?.groupId || meta.groupId || meta.jobId || taskId;
  }
  authorizeTask(principal, taskId) {
    const task = this.store.task(required(taskId, '执行实例', 150));
    if (!task) throw fail('执行实例不存在。', 404);
    if (principal.type === 'instance' && this.taskGroup(taskId) !== principal.groupId) throw fail('不能访问其他任务组。', 403);
    return task;
  }
  ensureCurrent(principal) {
    if (principal.type !== 'instance') return;
    const execution = this.records.get('executions', principal.taskId);
    if (!execution || execution.epoch !== principal.epoch || execution.status !== 'running' || execution.expiresAt <= this.now()) {
      throw fail('执行权限已撤销。', 401);
    }
  }
  attention(input, id) {
    return this.records.save('attention', { status: 'open', ...input }, id);
  }
  reconcile() {
    const expired = [];
    for (const execution of this.records.list('executions')) {
      if (execution.status !== 'running' || execution.expiresAt > this.now()) continue;
      this.records.save('executions', { ...execution, status: 'state_unknown', tokenHash: null, revokedAt: this.now() }, execution.id);
      this.updateTask(execution.taskId, { status: 'state_unknown', error: '执行节点失联，原执行状态未知；请确认已有操作后从新实例继续。' });
      this.attention({ taskId: execution.taskId, kind: 'lease-expired', title: '执行节点失联', detail: '原目录已隔离，不会自动重新执行。' }, `lease:${execution.taskId}:${execution.epoch}`);
      expired.push(publicRecord(execution));
    }
    return expired;
  }
  eligible(task, nodeId) {
    const meta = this.records.get('task-meta', task.id) || {};
    if ((meta.nodeId || 'local') !== nodeId) return false;
    if (task.status !== 'queued' || this.records.get('executions', task.id)) return false;
    const job = meta.jobId && this.records.get('jobs', meta.jobId);
    if (job && ['paused', 'cancelled', 'completed', 'failed', 'blocked', 'budget-exceeded'].includes(job.status)) return false;
    const group = job && this.records.list('jobs').filter(item => item.groupId === job.groupId);
    if (group?.some(item => item.status === 'budget-exceeded' || item.budgetExceeded)) return false;
    if ((job?.dependencies || []).some(id => this.records.get('jobs', id)?.status !== 'completed')) return false;
    if ((meta.dependencies || []).some(id => !this.dependencyComplete(id))) return false;
    return !this.store.role(task.role)?.archived;
  }
  dependencyComplete(taskId) {
    const meta = this.records.get('task-meta', taskId);
    const job = meta?.jobId && this.records.get('jobs', meta.jobId);
    return job ? job.status === 'completed' && this.store.task(job.taskId)?.status === 'completed' : this.store.task(taskId)?.status === 'completed';
  }
  claimLocal(task, nodeId = 'local') {
    return this.atomic(() => {
      const current = this.store.task(task.id);
      if (!current || (!['queued', 'running'].includes(current.status)) || this.records.get('executions', task.id)) return null;
      const meta = this.records.get('task-meta', task.id) || {};
      if ((meta.nodeId || 'local') !== nodeId) return null;
      const currentJob = meta.jobId && this.records.get('jobs', meta.jobId);
      if (currentJob && ['paused', 'cancelled', 'blocked', 'waiting_children', 'budget-exceeded'].includes(currentJob.status)) return null;
      if (currentJob && this.records.list('jobs').some(item => item.groupId === currentJob.groupId && (item.status === 'budget-exceeded' || item.budgetExceeded))) return null;
      if ((currentJob?.dependencies || []).some(id => this.records.get('jobs', id)?.status !== 'completed')) return null;
      if ((meta.dependencies || []).some(id => !this.dependencyComplete(id))) return null;
      const token = randomBytes(32).toString('hex');
      const execution = this.records.save('executions', {
        taskId: task.id, nodeId, agentId: task.role, groupId: this.taskGroup(task.id), batchId: meta.batchId || task.id,
        epoch: 1, status: 'running', tokenHash: hashToken(token), expiresAt: this.now() + this.leaseMs,
        requirementVersion: currentJob?.requirementVersion || meta.requirementVersion || 1,
        permissions: Array.isArray(meta.permissions) ? meta.permissions : [],
      }, task.id);
      this.updateTask(task.id, { status: 'running', error: '' });
      if (meta.jobId) {
        const job = this.records.get('jobs', meta.jobId);
        if (job) this.records.save('jobs', { ...job, status: 'running', taskId: task.id }, job.id);
      }
      for (const message of this.records.list('messages').filter(item => !item.toTaskId && item.toAgentId === task.role &&
        (!item.groupId || item.groupId === this.taskGroup(task.id)))) {
        this.records.save('messages', { ...message, toTaskId: task.id, groupId: this.taskGroup(task.id), batchId: execution.batchId }, message.id);
      }
      return { execution: publicRecord(execution), token };
    });
  }
  heartbeatLocal(taskId, epoch, nodeId = 'local') {
    const execution = this.records.get('executions', taskId);
    if (!execution || execution.nodeId !== nodeId || execution.epoch !== epoch || execution.status !== 'running' || execution.expiresAt <= this.now()) return false;
    this.records.save('executions', { ...execution, expiresAt: this.now() + this.leaseMs }, taskId);
    return true;
  }
  finishLocal(taskId, epoch, result = {}, nodeId = 'local') {
    return this.atomic(() => {
      const execution = this.records.get('executions', taskId);
      const eventId = result.eventId || `${taskId}:${epoch}:result`;
      if (execution?.resultEventId === eventId && execution.nodeId === nodeId) return { accepted: true, duplicate: true };
      if (!execution || execution.nodeId !== nodeId || execution.epoch !== epoch || execution.status !== 'running' || execution.expiresAt <= this.now()) {
        throw fail('执行租约已失效，迟到结果不能覆盖当前任务。', 409);
      }
      const status = ['completed', 'failed', 'cancelled', 'interrupted'].includes(result.status) ? result.status : 'failed';
      this.records.save('executions', { ...execution, status, tokenHash: null, resultEventId: eventId, finishedAt: this.now() }, taskId);
      this.updateTask(taskId, { status, result: String(result.result || '').slice(0, 500000), error: String(result.error || '').slice(0, 10000) });
      const task = this.store.task(taskId);
      const meta = this.records.get('task-meta', taskId);
      const job = meta?.jobId && this.records.get('jobs', meta.jobId);
      if (job?.taskId === taskId) this.completeJob(job, status);
      if (status === 'completed' && meta?.spaceId && result.result) {
        const space = this.store.teamSpace?.(meta.spaceId);
        if (space && task.role === space.pmRoleId) {
          const currentJob = job ? this.records.get('jobs', job.id) : null;
          const finalReply = !currentJob || currentJob.status === 'completed';
          this.records.save('space-messages', {
            spaceId: meta.spaceId,
            clientMessageId: null,
            kind: finalReply ? 'reply' : 'progress',
            senderType: 'agent',
            senderId: task.role,
            taskId,
            content: String(result.result).slice(0, 500000),
            status: finalReply ? 'answered' : 'sent',
          }, `reply:${taskId}`);
          if (finalReply && meta.sourceMessageId) {
            const source = this.records.get('space-messages', meta.sourceMessageId);
            if (source) this.records.save('space-messages', { ...source, status: 'answered' }, source.id);
          }
        }
      }
      return { accepted: true, duplicate: false };
    });
  }
  completeJob(job, status) {
    let updated = this.records.save('jobs', { ...job, status }, job.id);
    const children = this.records.list('jobs').filter(item => item.parentJobId === job.id);
    if (status === 'completed' && children.length && job.summaryTaskId !== job.taskId) {
      updated = this.records.save('jobs', { ...updated, status: 'waiting_children' }, job.id);
      this.summarizeWhenReady(updated);
    }
    const parent = job.parentJobId && this.records.get('jobs', job.parentJobId);
    const autoBlocked = parent?.status === 'blocked' && parent.blockedReason === 'child-failed' && this.records.get('attention', `children:${parent.id}`)?.status === 'open';
    if (parent?.status === 'waiting_children' || autoBlocked) this.summarizeWhenReady(parent);
  }
  summarizeWhenReady(job) {
    const children = this.records.list('jobs').filter(item => item.parentJobId === job.id);
    if (!children.length || children.some(item => ['queued', 'running', 'waiting_children'].includes(item.status))) return;
    if (children.some(item => item.status !== 'completed')) {
      this.records.save('jobs', { ...job, status: 'blocked', blockedReason: 'child-failed' }, job.id);
      this.attention({ taskId: job.taskId, groupId: job.groupId, kind: 'child-failed', title: '子任务未全部完成',
        detail: '请处理失败或暂停的子任务后再恢复汇总。' }, `children:${job.id}`);
      return;
    }
    if (job.summaryTaskId) return;
    const blocked = this.records.get('attention', `children:${job.id}`);
    if (blocked) this.records.save('attention', { ...blocked, status: 'resolved' }, blocked.id);
    const contextExtra = JSON.stringify({ goal: job.goal, acceptance: job.acceptance,
      children: children.map(item => ({ jobId: item.id, taskId: item.taskId, goal: item.goal,
        result: String(this.store.task(item.taskId)?.result || '').slice(0, 30000),
        artifacts: this.records.list('artifacts').filter(artifact => artifact.taskId === item.taskId) })),
      checkpoints: this.records.list('checkpoints').filter(item => item.groupId === job.groupId).slice(0, 20),
    });
    const parentMeta = this.records.get('task-meta', job.taskId) || {};
    const task = this.createTask({ role: job.role, prompt: `汇总已完成子任务，验证完成条件并交付最终成果。不得再次分派子任务。\n${job.goal}`,
      workspace: job.workspace, nodeId: job.nodeId, workspaceKey: job.workspaceKey, workspaceMode: 'isolated', jobId: job.id,
      spaceId: job.spaceId || undefined,
      teamId: job.teamId || job.spaceId || undefined,
      sourceMessageId: job.sourceMessageId || undefined,
      sourceTaskId: job.taskId, contextExtra, requirementVersion: job.requirementVersion,
      model: parentMeta.modelOverride || undefined,
      providerIds: parentMeta.allowedProviderIds || parentMeta.providerIds,
      assistantSnapshot: parentMeta.assistantSnapshot });
    this.records.save('task-meta', { ...this.records.get('task-meta', task.id), jobId: job.id, groupId: job.groupId,
      batchId: job.batchId, nodeId: job.nodeId, workspaceKey: job.workspaceKey, permissions: job.permissions,
      requirementVersion: job.requirementVersion, teamId: job.teamId || job.spaceId || null, summary: true }, task.id);
    this.records.save('jobs', { ...job, status: 'queued', blockedReason: null, taskId: task.id, summaryTaskId: task.id }, job.id);
  }
  revokeExecution(taskId, reason = 'cancelled') {
    const execution = this.records.get('executions', taskId);
    if (!execution || execution.status !== 'running') return;
    this.records.save('executions', { ...execution, status: reason, tokenHash: null, revokedAt: this.now() }, taskId);
  }
  createJob(body, principal = { type: 'owner' }) {
    this.ensureCurrent(principal);
    const role = required(body.role, '助手', 150), prompt = required(body.prompt || body.goal, '任务目标');
    const assistant = this.store.role(role);
    if (!assistant || assistant.archived) throw fail('助手不存在或已归档。');
    let parent;
    if (principal.type === 'instance') {
      const parentMeta = this.records.get('task-meta', principal.taskId) || {};
      const team = (parentMeta.teamId || parentMeta.spaceId)
        ? this.store.teamSpace(parentMeta.teamId || parentMeta.spaceId)
        : null;
      if (team?.recruitment.phase !== undefined && team.recruitment.phase !== 'confirmed')
        throw fail('团队招募方案尚未确认，请先完成澄清并等待用户确认创建。', 409);
      if (team && !team.memberRoleIds.includes(role))
        throw fail('只能向当前团队已确认的成员分派任务，请使用 read_team_roster 查看成员 ID。', 403);
      parent = parentMeta.jobId && this.records.get('jobs', parentMeta.jobId);
      if (!parent) throw fail('请先将当前执行关联逻辑任务。');
      if (parent.summaryTaskId === principal.taskId) throw fail('成果汇总实例不能再次分派子任务。');
      if (parent.depth >= 4) throw fail('子任务层级不能超过 4。');
      if (this.records.list('jobs').filter(job => job.groupId === parent.groupId).length >= 32) throw fail('任务组最多包含 32 个任务。');
    } else if (body.parentJobId) {
      parent = this.records.get('jobs', body.parentJobId);
      if (!parent) throw fail('父任务不存在。');
    }
    if (parent && parent.depth >= 4) throw fail('子任务层级不能超过 4。');
    if (parent && this.records.list('jobs').filter(job => job.groupId === parent.groupId).length >= 32) throw fail('任务组最多包含 32 个任务。');
    const parentTeam = parent && (parent.teamId || parent.spaceId)
      ? this.store.teamSpace(parent.teamId || parent.spaceId)
      : null;
    if (parentTeam?.recruitment.proposal && parentTeam.recruitment.phase !== 'confirmed')
      throw fail('团队招募方案尚未确认，请先完成澄清并等待用户确认创建。', 409);
    if (parentTeam && !parentTeam.memberRoleIds.includes(role))
      throw fail('只能向当前团队已确认的成员分派任务，请使用 read_team_roster 查看成员 ID。', 403);
    const groupId = parent?.groupId || randomUUID();
    const dependencies = Array.isArray(body.dependencies) ? [...new Set(body.dependencies)] : [];
    if (dependencies.length > 32 || dependencies.some(id => this.records.get('jobs', id)?.groupId !== groupId)) throw fail('依赖必须是当前任务组内已有任务。');
    const requestedPermissions = Array.isArray(body.permissions) ? body.permissions.filter(value => typeof value === 'string') : parent?.permissions || [];
    const permissions = parent ? requestedPermissions.filter(value => (parent.permissions || []).includes(value)) : requestedPermissions;
    const budgetTokens = parent?.budgetTokens ?? body.budgetTokens ?? 200000;
    const maxDurationMinutes = parent?.maxDurationMinutes ?? body.maxDurationMinutes ?? 30;
    if (!Number.isSafeInteger(budgetTokens) || budgetTokens < 1000 || budgetTokens > 100000000) throw fail('任务 Token 预算需要在 1000 至 100000000 之间。');
    if (!Number.isFinite(maxDurationMinutes) || maxDurationMinutes < 1 || maxDurationMinutes > 1440) throw fail('任务时限需要在 1 至 1440 分钟之间。');
    const job = this.records.save('jobs', { title: String(body.title || prompt.slice(0, 65)), goal: prompt, role,
      parentJobId: parent?.id || null, groupId, batchId: parent?.batchId || randomUUID(),
      depth: (parent?.depth ?? -1) + 1, dependencies, requirementVersion: parent?.requirementVersion || 1,
      acceptance: String(body.acceptance || '').slice(0, 20000), status: 'queued', permissions,
      budgetTokens, maxDurationMinutes,
      nodeId: parent?.nodeId || body.nodeId || 'local', workspaceKey: parent?.workspaceKey || body.workspaceKey || 'default',
      workspace: parent?.workspace || body.workspace || this.store.config.workspace,
      spaceId: parent?.spaceId || parent?.teamId || body.spaceId || body.teamId || null,
      teamId: parent?.teamId || parent?.spaceId || body.teamId || body.spaceId || null,
      sourceMessageId: parent?.sourceMessageId || body.sourceMessageId || null,
    });
    try {
      const task = this.createTask({ role, prompt, workspace: job.workspace, jobId: job.id,
        parentTaskId: principal.type === 'instance' ? principal.taskId : undefined,
        spaceId: job.spaceId || undefined,
        teamId: job.teamId || job.spaceId || undefined,
        sourceMessageId: job.sourceMessageId || undefined,
        nodeId: job.nodeId, workspaceKey: job.workspaceKey, workspaceMode: body.workspaceMode,
        sourceTaskId: body.sourceTaskId, providerIds: body.providerIds, requirementVersion: job.requirementVersion,
        assistantSnapshot: body.assistantSnapshot, contextExtra: body.contextExtra,
        capabilityCommand: body.capabilityCommand });
      this.records.save('task-meta', { ...this.records.get('task-meta', task.id), jobId: job.id, groupId, batchId: job.batchId,
        nodeId: job.nodeId, workspaceKey: job.workspaceKey, permissions, requirementVersion: job.requirementVersion,
        spaceId: job.spaceId || null, teamId: job.teamId || job.spaceId || null, sourceMessageId: job.sourceMessageId || null,
        parentTaskId: principal.type === 'instance' ? principal.taskId : undefined }, task.id);
      return this.records.save('jobs', { ...job, taskId: task.id }, job.id);
    } catch (error) { this.records.save('jobs', { ...job, status: 'failed', error: error.message }, job.id); throw error; }
  }
  currentTeam(principal) {
    if (principal?.type !== 'instance') throw fail('只有运行中的团队智能体可以发起跨团队协作。', 403);
    const task = this.store.task(principal.taskId);
    if (!task) throw fail('当前执行实例不存在。', 404);
    const meta = teamMeta(this.store, task.id);
    const team = findTeam(this.store, meta.teamId || meta.spaceId);
    if (!team || team.status !== 'active') throw fail('当前执行实例不属于可协作的活动团队。', 403);
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
    const { team } = this.recruitmentContext(principal);
    if (team.recruitment.phase === 'confirmed') throw fail('该团队已经开始协作，无需重复招募。请为新的需求建立新的招募空间。', 409);
    const teamName = required(body.teamName || body.name, '团队名称', 80);
    const goal = required(body.goal, '团队目标', 2000);
    const purpose = required(body.purpose || body.responsibility || goal, '团队职责', 2000);
    if (!Array.isArray(body.members) || body.members.length < 1 || body.members.length > 8)
      throw fail('团队成员需要在 1 至 8 个之间。');
    const seen = new Set();
    const capabilityRows = this.records.list('capabilities');
    const providerRows = this.records.list('providers');
    const members = body.members.map((member, index) => {
      if (!member || typeof member !== 'object' || Array.isArray(member)) throw fail(`第 ${index + 1} 个成员无效。`);
      const roleId = required(member.roleId, `第 ${index + 1} 个成员的助手`, 150);
      const role = this.store.role(roleId);
      if (!role || role.archived) throw fail(`成员助手 ${roleId} 不存在或已归档。`);
      const memberId = roleId === team.pmRoleId ? 'manager' : String(member.memberId || `member-${index + 1}`);
      if (!/^[a-zA-Z0-9_-]{1,64}$/.test(memberId) || (memberId === 'manager' && roleId !== team.pmRoleId)) throw fail('成员标识需要为 1 至 64 位字母、数字、下划线或连字符，manager 保留给项目经理。');
      if (seen.has(memberId)) throw fail(`成员标识 ${memberId} 重复。`);
      seen.add(memberId);
      const responsibility = required(member.responsibility, `${role.name || roleId} 的职责`, 1000);
      const list = value => Array.isArray(value)
        ? [...new Set(value.filter(item => typeof item === 'string' && item.trim()).map(item => item.trim().slice(0, 500)).slice(0, 12))]
        : [];
      const idList = value => [...new Set((Array.isArray(value) ? value : [])
        .filter(item => typeof item === 'string' && item.trim())
        .map(item => item.trim().slice(0, 160)).slice(0, 32))];
      const skillIds = idList(member.skillIds);
      if (skillIds.some(id => !SKILLS.some(skill => skill.id === id)))
        throw fail(`成员 ${memberId} 包含未知 Skill：${skillIds.filter(id => !SKILLS.some(skill => skill.id === id)).join('、')}`);
      const capabilityIds = idList(member.capabilityIds);
      if (capabilityIds.some(id => !capabilityRows.some(capability => capability.id === id)))
        throw fail(`成员 ${memberId} 包含未知能力：${capabilityIds.filter(id => !capabilityRows.some(capability => capability.id === id)).join('、')}`);
      const providerIds = idList(member.providerIds);
      if (providerIds.some(id => !providerRows.some(provider => provider.id === id)))
        throw fail(`成员 ${memberId} 包含未知模型供应商：${providerIds.filter(id => !providerRows.some(provider => provider.id === id)).join('、')}`);
      if (member.toolAccess !== undefined && (!member.toolAccess || typeof member.toolAccess !== 'object' || Array.isArray(member.toolAccess) ||
        ['files', 'web', 'terminal'].some(key => member.toolAccess[key] !== undefined && typeof member.toolAccess[key] !== 'boolean'))) {
        throw fail(`成员 ${memberId} 的工具权限必须使用 files、web、terminal 布尔值。`);
      }
      const toolAccess = member.toolAccess && typeof member.toolAccess === 'object'
        ? Object.fromEntries(['files', 'web', 'terminal'].filter(key => member.toolAccess[key] !== undefined).map(key => [key, member.toolAccess[key]]))
        : null;
      return {
        memberId,
        roleId,
        name: typeof member.name === 'string' && member.name.trim() ? member.name.trim().slice(0, 40) : role.name || roleId,
        responsibility,
        deliverables: list(member.deliverables),
        skills: list(member.skills),
        skillIds,
        capabilityIds,
        providerIds,
        tools: list(member.tools),
        toolAccess,
        modelHint: typeof member.modelHint === 'string' ? member.modelHint.trim().slice(0, 160) : '',
        dependencies: list(member.dependencies),
      };
    });
    if (!seen.has('manager')) {
      const pm = this.store.role(team.pmRoleId);
      members.unshift({ memberId: 'manager', roleId: team.pmRoleId, name: pm?.name || team.pmRoleId,
        responsibility: '持续澄清目标、协调成员、跟踪风险并汇总交付。', deliverables: ['Team Charter 和阶段性结论'], skills: [], skillIds: [], capabilityIds: [], providerIds: [], tools: [], toolAccess: null, modelHint: '', dependencies: [] });
    }
    if (members.length > 8) throw fail('团队成员（含项目经理）不能超过 8 个。');
    const memberIds = new Set(members.map(member => member.memberId));
    for (const member of members) {
      if (member.dependencies.some(id => !memberIds.has(id) || id === member.memberId)) throw fail('成员依赖必须使用方案内其他成员的 memberId。');
    }
    const visiting = new Set(), visited = new Set();
    const visit = member => {
      if (visiting.has(member.memberId)) throw fail('成员依赖不能形成循环。');
      if (visited.has(member.memberId)) return;
      visiting.add(member.memberId);
      member.dependencies.forEach(id => visit(members.find(candidate => candidate.memberId === id)));
      visiting.delete(member.memberId);
      visited.add(member.memberId);
    };
    members.forEach(visit);
    const openQuestions = Array.isArray(body.openQuestions)
      ? [...new Set(body.openQuestions.filter(item => typeof item === 'string' && item.trim()).map(item => item.trim().slice(0, 1000)).slice(0, 20))]
      : [];
    const proposal = {
      version: Number.isSafeInteger(team.recruitment?.proposal?.version)
        ? team.recruitment.proposal.version + 1
        : 1,
      teamName,
      goal,
      purpose,
      size: members.length,
      members,
      openQuestions,
      ready: openQuestions.length === 0,
      createdAt: new Date().toISOString(),
    };
    const saved = this.store.saveTeamSpace({
      ...team,
      name: team.name,
      recruitment: { ...team.recruitment, phase: 'proposed', brief: goal, proposal },
    }, team.id);
    return { teamId: saved.id, phase: saved.recruitment.phase, proposal: saved.recruitment.proposal };
  }
  confirmTeamRecruitment(spaceId, { version } = {}, principal = { type: 'owner' }) {
    if (principal.type !== 'owner') throw fail('团队方案需要由用户确认。', 403);
    const team = this.store.teamSpace(spaceId);
    if (!team) throw fail('团队空间不存在。', 404);
    if (team.status !== 'active') throw fail('团队当前不可创建成员。', 409);
    const recruitment = team.recruitment || {};
    if (recruitment.phase === 'confirmed') return team;
    const proposal = recruitment.proposal;
    if (!proposal || !Array.isArray(proposal.members) || !proposal.members.length)
      throw fail('团队还没有可确认的招募方案。');
    if (version !== undefined && version !== proposal.version) throw fail('招募方案已更新，请刷新并确认最新版本。', 409);
    if (proposal.openQuestions?.length) throw fail('请先回答 Team Charter 中的待确认问题。');
    const capabilityRows = this.records.list('capabilities');
    const providerRows = this.records.list('providers');
    const unavailableCapabilities = proposal.members.flatMap(member => (member.capabilityIds || [])
      .filter(id => !capabilityRows.some(capability => capability.id === id && capability.enabled !== false))
      .map(id => `${member.memberId || member.roleId}:${id}`));
    if (unavailableCapabilities.length)
      throw fail(`招募方案包含未启用的能力：${unavailableCapabilities.join('、')}。请先启用能力或移除该绑定。`, 409);
    const unavailableProviders = proposal.members.flatMap(member => (member.providerIds || [])
      .filter(id => !providerRows.some(provider => provider.id === id && provider.enabled !== false))
      .map(id => `${member.memberId || member.roleId}:${id}`));
    if (unavailableProviders.length)
      throw fail(`招募方案包含未启用的模型供应商：${unavailableProviders.join('、')}。请先启用供应商或移除该绑定。`, 409);
    const invalidModels = proposal.members.filter(member => {
      if (!member.modelHint) return false;
      const templateProviderIds = this.store.role(member.roleId)?.providerIds || [];
      const allowedProviderIds = member.providerIds?.length ? member.providerIds : templateProviderIds;
      const candidates = allowedProviderIds.length
        ? providerRows.filter(provider => allowedProviderIds.includes(provider.id) && provider.enabled !== false)
        : providerRows.filter(provider => provider.enabled !== false);
      return !candidates.some(provider => provider.models?.some(model => model.id === member.modelHint));
    }).map(member => `${member.memberId || member.roleId}:${member.modelHint}`);
    if (invalidModels.length)
      throw fail(`招募方案中的模型未在可用供应商中配置：${invalidModels.join('、')}。请先配置模型或移除该建议。`, 409);
    const incompatibleModels = proposal.members.flatMap(member => {
      if (!member.modelHint) return [];
      const template = this.store.role(member.roleId);
      const effectiveTools = { ...template?.tools, ...member.toolAccess };
      const requiresToolCalling = Object.values(effectiveTools).some(Boolean) || (member.capabilityIds || []).length > 0;
      if (!requiresToolCalling) return [];
      const templateProviderIds = template?.providerIds || [];
      const allowedProviderIds = member.providerIds?.length ? member.providerIds : templateProviderIds;
      const candidates = allowedProviderIds.length
        ? providerRows.filter(provider => allowedProviderIds.includes(provider.id) && provider.enabled !== false)
        : providerRows.filter(provider => provider.enabled !== false);
      const model = candidates.flatMap(provider => provider.models || [])
        .find(candidate => candidate.id === member.modelHint && (!requiresToolCalling || candidate.tools === true));
      return model ? [] : [`${member.memberId || member.roleId}:${member.modelHint}`];
    });
    if (incompatibleModels.length)
      throw fail(`招募方案中的模型不支持成员所需的工具或能力：${incompatibleModels.join('、')}。请更换支持工具调用的模型，或明确关闭该成员的工具权限。`, 409);
    const unavailable = proposal.members
      .map(member => member.roleId)
      .filter(roleId => {
        const role = this.store.role(roleId);
        return !role || role.archived;
      });
    if (unavailable.length) throw fail(`招募方案中的助手不可用：${[...new Set(unavailable)].join('、')}`);
    return this.atomic(() => {
      const fresh = this.store.teamSpace(spaceId);
      if (fresh.recruitment.phase === 'confirmed') return fresh;
      if (fresh.recruitment.proposal?.version !== proposal.version) throw fail('招募方案已更新，请刷新并确认最新版本。', 409);
      const members = proposal.members.map((member, index) => {
        const template = this.store.role(member.roleId);
        const memberId = member.memberId || `member-${index + 1}`;
        if (member.roleId === fresh.pmRoleId) return { ...member, memberId, agentId: fresh.pmRoleId };
        const requestedSkillIds = Array.isArray(member.skillIds) ? member.skillIds : [];
        const requestedCapabilityIds = Array.isArray(member.capabilityIds) ? member.capabilityIds : [];
        const tools = {
          ...template.tools,
          ...member.toolAccess,
        };
        const role = this.store.saveRole({
          ...template,
          name: member.name,
          desc: member.responsibility.slice(0, 240),
          skillIds: [...new Set([...(template.skillIds || []), ...requestedSkillIds])].slice(0, 3),
          capabilityIds: [...new Set([...(template.capabilityIds || []), ...requestedCapabilityIds])],
          providerIds: member.providerIds?.length ? member.providerIds : template.providerIds,
          tools,
          ...(member.modelHint ? { model: member.modelHint } : {}),
          instructions: `${template.instructions.slice(0, 7000)}\n\n团队：${proposal.teamName}\n团队目标：${proposal.goal}\n你的职责：${member.responsibility}\n验收产物：${member.deliverables.join('；')}\n建议技能：${member.skills.join('、')}\n建议工具：${member.tools.join('、')}\n建议模型：${member.modelHint || '沿用角色配置'}`.slice(0, 12000),
        });
        return { ...member, memberId, agentId: role.id };
      });
      const memberRoleIds = members.map(member => member.agentId);
      const responsibilities = Object.fromEntries(members.map(member => [member.agentId, member.responsibility]));
      const memberSettings = Object.fromEntries(members.map(member => [member.agentId, {
        label: member.name,
        responsibility: member.responsibility,
        memberId: member.memberId,
        templateRoleId: member.roleId,
        modelHint: member.modelHint,
        skills: member.skills,
        skillIds: member.skillIds,
        capabilityIds: member.capabilityIds,
        providerIds: member.providerIds,
        tools: member.tools,
        toolAccess: member.toolAccess,
        dependencies: member.dependencies,
      }]));
      return this.store.saveTeamSpace({
      ...fresh,
      name: proposal.teamName,
      goal: proposal.goal,
      purpose: proposal.purpose,
      memberRoleIds,
      responsibilities,
      memberSettings,
      recruitment: { ...fresh.recruitment, proposal: { ...proposal, members }, phase: 'confirmed', confirmedAt: new Date().toISOString() },
      }, team.id);
    });
  }
  readTeamRoster(principal) {
    const { team } = this.currentTeam(principal);
    const roles = this.store.roles().filter(role => !role.archived);
    const rosterRoleIds = team.recruitment.phase === 'confirmed' ? team.memberRoleIds : [team.pmRoleId];
    const dynamicRoleIds = new Set(this.store.teamSpaces().flatMap(space => Object.entries(space.memberSettings || {})
      .filter(([roleId, settings]) => settings?.templateRoleId && roleId !== space.pmRoleId)
      .map(([roleId]) => roleId)));
    return { teamId: team.id, name: team.name, recruitment: team.recruitment,
      members: roles.filter(role => rosterRoleIds.includes(role.id)).map(role => ({
        id: role.id, name: team.memberSettings[role.id]?.label || role.name,
        responsibility: team.responsibilities[role.id] || '', model: role.model,
        templateRoleId: team.memberSettings[role.id]?.templateRoleId || null,
        memberId: team.memberSettings[role.id]?.memberId || null,
        modelHint: team.memberSettings[role.id]?.modelHint || null,
        skills: team.memberSettings[role.id]?.skills || [],
        tools: team.memberSettings[role.id]?.tools || [],
        skillIds: role.skillIds || [],
        capabilityIds: role.capabilityIds || [],
        providerIds: role.providerIds || [],
        runtimeTools: role.tools || { files: false, web: false, terminal: false },
        toolAccess: team.memberSettings[role.id]?.toolAccess || null,
        dependencies: team.memberSettings[role.id]?.dependencies || [],
      })),
      templates: roles.filter(role => !dynamicRoleIds.has(role.id)).map(role => ({ id: role.id, name: role.name, desc: role.desc, model: role.model, skillIds: role.skillIds, tools: role.tools })),
    };
  }
  collaborationAllowed(source, target) {
    const allowed = Array.isArray(source.collaboration?.allowedTeamIds)
      ? source.collaboration.allowedTeamIds
      : [];
    if (source.collaboration?.autoHandoff === false) return false;
    if (!allowed.length) return true;
    const targetId = teamKey(target);
    return allowed.includes(target.id) || allowed.includes(targetId) || allowed.includes(target.chatId);
  }
  listTeamSpaces(principal) {
    const { team: source } = this.currentTeam(principal);
    const teams = this.store.teamSpaces()
      .filter(team => team.status === 'active' && team.id !== source.id && this.collaborationAllowed(source, team));
    return {
      current: { id: source.id, teamId: teamKey(source), chatId: source.chatId || source.id, name: source.name },
      items: teams.map(team => ({
        id: team.id,
        teamId: teamKey(team),
        chatId: team.chatId || team.id,
        name: team.name,
        purpose: team.purpose || team.goal || '',
        teamType: team.teamType || 'custom',
        pmRoleId: team.pmRoleId,
        memberCount: team.recruitment?.phase === 'confirmed'
          ? (Array.isArray(team.memberRoleIds) ? team.memberRoleIds.length : 0)
          : (team.pmRoleId ? 1 : 0),
        status: team.status,
      })),
    };
  }
  delegateToTeam(body, principal) {
    const { task: sourceTask, meta: sourceMeta, team: source } = this.currentTeam(principal);
    if (source.recruitment.proposal && source.recruitment.phase !== 'confirmed') throw fail('团队招募方案尚未确认，不能发起跨团队任务。', 409);
    const target = findTeam(this.store, body.targetTeamId || body.teamId);
    if (!target || target.status !== 'active') throw fail('目标团队不存在或未启用。', 404);
    if (target.recruitment.phase !== 'confirmed') throw fail('目标团队尚未完成招募。', 409);
    if (target.id === source.id) throw fail('目标团队不能是当前团队。');
    if (!this.collaborationAllowed(source, target)) throw fail('当前团队未允许与目标团队协作。', 403);
    const prompt = required(body.prompt || body.goal, '协作目标');
    const idempotencyKey = required(body.idempotencyKey, '协作幂等键', 200);
    const clientMessageId = `mcp:${sourceTask.id}:${idempotencyKey}`;
    const existing = this.store.teamMessages(target.id)
      .find(message => message.kind === 'handoff' && message.clientMessageId === clientMessageId);
    if (existing?.taskId) {
      const existingTask = this.store.task(existing.taskId);
      const existingMeta = existingTask && teamMeta(this.store, existingTask.id);
      return {
        duplicate: true,
        messageId: existing.id,
        taskId: existing.taskId,
        jobId: existingMeta?.jobId || null,
        sourceTeamId: source.id,
        targetTeamId: target.id,
        status: existingTask?.status || 'unknown',
      };
    }
    const targetJobs = this.records.list('jobs').filter(job => (job.teamId || job.spaceId) === target.id);
    const maxJobs = target.autonomy?.maxJobs || 32;
    if (targetJobs.length >= maxJobs) throw fail('目标团队已达到任务上限。', 409);
    const content = `${prompt}${body.acceptance ? `\n\n验收标准：\n${required(body.acceptance, '验收标准', 20000)}` : ''}`;
    const message = this.store.saveTeamMessage({
      spaceId: target.id,
      teamId: target.id,
      clientMessageId,
      kind: 'handoff',
      senderType: 'team',
      senderId: source.id,
      fromTeamId: source.id,
      toTeamId: target.id,
      content,
      status: 'sent',
    }, `handoff:${source.id}:${target.id}:${idempotencyKey}`);
    const activeTargetTask = this.store.tasks().find(candidate => {
      const candidateMeta = teamMeta(this.store, candidate.id);
      return candidateMeta.teamId === target.id && candidate.role === target.pmRoleId && ['queued', 'running'].includes(candidate.status);
    });
    try {
      const child = this.createTask({
        role: target.pmRoleId,
        prompt: `团队「${source.name}」请求本团队协作。请先阅读协作消息，判断目标与验收标准，必要时向来源团队说明阻塞；目标明确后由本团队项目经理负责拆解、执行和汇总。\n\n${content}`,
        sessionId: activeTargetTask?.sessionId,
        workspace: target.workspace,
        teamId: target.id,
        spaceId: target.id,
        sourceMessageId: message.id,
        contextExtra: JSON.stringify({ sourceTeamId: source.id, sourceTaskId: sourceTask.id, sourceJobId: sourceMeta.jobId || null }),
      });
      const linked = this.store.saveTeamMessage({ ...message, taskId: child.id }, message.id);
      const childMeta = teamMeta(this.store, child.id);
      return {
        duplicate: false,
        messageId: linked.id,
        taskId: child.id,
        jobId: childMeta.jobId || null,
        sourceTeamId: source.id,
        targetTeamId: target.id,
        status: child.status,
      };
    } catch (error) {
      this.records.save('space-messages', { ...message, status: 'blocked', error: error.message }, message.id);
      throw error;
    }
  }
  readTeamTask(body, principal) {
    const { team: source } = this.currentTeam(principal);
    const taskId = required(body.taskId, '目标任务', 150);
    const task = this.store.task(taskId);
    if (!task) throw fail('目标任务不存在。', 404);
    const meta = teamMeta(this.store, taskId);
    const target = findTeam(this.store, meta.teamId || meta.spaceId);
    if (!target || target.status !== 'active' || target.id === source.id || !this.collaborationAllowed(source, target))
      throw fail('当前团队无权读取该任务。', 403);
    const job = meta.jobId ? this.records.get('jobs', meta.jobId) : null;
    return {
      taskId: task.id,
      jobId: meta.jobId || null,
      teamId: target.id,
      status: task.status,
      title: task.title,
      result: String(task.result || '').slice(0, 50000),
      error: String(task.error || '').slice(0, 10000),
      jobStatus: job?.status || null,
      messages: this.store.teamMessages(target.id).filter(message => message.taskId === task.id).slice(-20),
    };
  }
  sendMessage(body, principal) {
    this.ensureCurrent(principal);
    let receiver;
    if (body.toTaskId) receiver = this.authorizeTask(principal, body.toTaskId);
    else if (principal.type === 'owner') {
      const role = this.store.role(required(body.toAgentId, '收件助手', 150));
      if (!role) throw fail('收件助手不存在。', 404);
      receiver = this.store.tasks().find(task => task.role === role.id && task.status === 'running') || { id: null, role: role.id };
    } else throw fail('实例消息必须指定收件执行实例。');
    if (body.toAgentId && body.toAgentId !== receiver.role) throw fail('收件助手与执行实例不匹配。');
    const idempotencyKey = required(body.idempotencyKey || (principal.type === 'owner' ? randomUUID() : ''), '消息幂等键', 200);
    const senderId = principal.type === 'instance' ? principal.taskId : 'owner';
    const id = hashToken(`${senderId}:${idempotencyKey}`);
    const existing = this.records.get('messages', id);
    const payload = { toTaskId: receiver.id, toAgentId: receiver.role, kind: body.kind || 'notice',
      content: required(body.content, '消息内容'), replyTo: body.replyTo || null };
    if (!messageKinds.has(payload.kind)) throw fail('消息类型不支持。');
    if (existing) {
      if (JSON.stringify(existing.payload) !== JSON.stringify(payload)) throw fail('同一幂等键不能用于不同消息。', 409);
      return existing;
    }
    if (payload.replyTo) {
      const original = this.records.get('messages', payload.replyTo);
      if (!original || original.toTaskId !== principal.taskId || original.fromTaskId !== receiver.id) throw fail('回复关联不属于当前通信双方。', 403);
    }
    const meta = (receiver.id && this.records.get('task-meta', receiver.id)) || {};
    const job = meta.jobId && this.records.get('jobs', meta.jobId);
    return this.records.save('messages', { ...payload, payload, fromTaskId: principal.taskId || null, fromAgentId: principal.agentId || 'owner',
      groupId: receiver.id ? this.taskGroup(receiver.id) : null, batchId: meta.batchId || receiver.id,
      requirementVersion: body.requirementVersion || principal.requirementVersion || job?.requirementVersion || 1,
      requirementUpdate: principal.type === 'owner' && body.requirementUpdate === true,
      stale: !!body.requirementVersion && !!job && body.requirementVersion !== job.requirementVersion,
      status: 'sent', idempotencyKey }, id);
  }
  readMessages(taskId, principal) {
    if (principal.type === 'instance' && taskId !== principal.taskId) throw fail('只能领取自己的收件箱。', 403);
    this.authorizeTask(principal, taskId);
    const messages = this.records.list('messages').filter(item => item.toTaskId === taskId).reverse().slice(-100);
    const meta = this.records.get('task-meta', taskId) || {};
    const job = meta.jobId && this.records.get('jobs', meta.jobId);
    return messages.map(message => {
      const updated = { ...message, stale: !!job && message.requirementVersion < job.requirementVersion };
      return message.status === 'sent' ? this.records.save('messages', { ...updated, status: 'received', receivedAt: this.now() }, message.id) : updated;
    });
  }
  acknowledge(id, body, principal) {
    this.ensureCurrent(principal);
    const message = this.records.get('messages', id);
    if (!message) throw fail('消息不存在。', 404);
    if (principal.type === 'instance' && message.toTaskId !== principal.taskId) throw fail('不能确认其他实例的消息。', 403);
    if (!['received', 'processing', 'processed'].includes(body.status)) throw fail('回执状态不支持。');
    const rank = { sent: 0, received: 1, processing: 2, processed: 3 };
    if (rank[body.status] < rank[message.status]) return message;
    if (body.status === 'processed' && message.requirementUpdate && message.fromAgentId === 'owner') {
      const execution = this.records.get('executions', message.toTaskId);
      if (execution?.status === 'running' && message.requirementVersion > (execution.requirementVersion || 1)) {
        this.records.save('executions', { ...execution, requirementVersion: message.requirementVersion }, execution.id);
      }
    }
    return this.records.save('messages', { ...message, status: body.status, acknowledgedAt: this.now() }, id);
  }
  saveScoped(collection, body, principal, id) {
    this.ensureCurrent(principal);
    const taskId = principal.type === 'instance' ? principal.taskId : required(body.taskId, '执行实例', 150);
    this.authorizeTask(principal, taskId);
    const groupId = this.taskGroup(taskId);
    const current = id && this.records.get(collection, id);
    if (current && current.groupId !== groupId) throw fail('记录不属于当前任务组。', 403);
    if (current && principal.type === 'instance' && current.taskId !== taskId && collection !== 'board') throw fail('不能修改其他实例的记录。', 403);
    const input = { taskId, groupId, agentId: principal.agentId || 'owner',
      title: required(body.title || body.kind || collection, '标题', 200),
      content: String(body.content || body.detail || '').slice(0, 100000),
      requirementVersion: body.requirementVersion || principal.requirementVersion || 1,
    };
    if (collection === 'checkpoints') Object.assign(input, { constraints: body.constraints || [], decisions: body.decisions || [],
      artifacts: body.artifacts || [], operations: body.operations || [], nextSteps: body.nextSteps || [] });
    if (collection === 'artifacts') Object.assign(input, { location: required(body.location, '产物位置', 3000),
      commit: String(body.commit || '').slice(0, 150), evidence: String(body.evidence || '').slice(0, 100000), status: 'submitted' });
    if (collection === 'artifacts') {
      const meta = this.records.get('task-meta', taskId) || {};
      const job = meta.jobId && this.records.get('jobs', meta.jobId);
      if (job && input.requirementVersion < job.requirementVersion) input.status = 'needs-review';
    }
    if (collection === 'attention') Object.assign(input, { status: body.status === 'resolved' ? 'resolved' : 'open', kind: String(body.kind || 'decision') });
    if (collection === 'board' && current && body.expectedRevision === undefined) throw fail('修改任务板需要提供 expectedRevision。', 409);
    return this.records.save(collection, { ...current, ...input }, id, body.expectedRevision);
  }
  operation(body, principal) {
    this.ensureCurrent(principal);
    const taskId = principal.type === 'instance' ? principal.taskId : body.taskId;
    this.authorizeTask(principal, taskId);
    const action = required(body.action, '操作类型', 100);
    if (principal.type === 'instance' && !principal.permissions.includes(action)) throw fail('此实例没有该外部操作的授权。', 403);
    const key = required(body.idempotencyKey, '操作幂等键', 200);
    const id = hashToken(`${this.taskGroup(taskId)}:${action}:${key}`);
    const existing = this.records.get('operations', id);
    if (existing) return { ...existing, canExecute: false };
    const operation = this.records.save('operations', { taskId, groupId: this.taskGroup(taskId), action,
      title: String(body.title || action).slice(0, 200), status: 'pending', intent: required(body.intent, '操作意图'), key }, id);
    return { ...operation, canExecute: true };
  }
  async handle({ method, parts, body = {}, req, principal = { type: 'owner' }, query }) {
    if (parts[0] === 'api') parts = parts.slice(1);
    const [collection, id, action] = parts;
    if (collection !== 'nodes' && !collections.has(collection)) return null;
    try {
      if (collection === 'nodes') return await this.handleNodes({ method, id, action, body, req, principal, query });
      this.ensureCurrent(principal);
      if (method === 'GET') {
        if (id) {
          const record = this.records.get(collection, id);
          if (!record) throw fail('记录不存在。', 404);
          if (principal.type === 'instance' && record.groupId !== principal.groupId) throw fail('没有访问权限。', 403);
          if (collection === 'jobs') return { status: 200, body: { ...record,
            tasks: this.store.tasks().filter(task => this.records.get('task-meta', task.id)?.jobId === id).map(({ context: _context, log: _log, ...task }) => task),
            children: this.records.list('jobs').filter(job => job.parentJobId === id),
            checkpoints: this.records.list('checkpoints').filter(item => item.groupId === record.groupId).slice(0, 50),
            artifacts: this.records.list('artifacts').filter(item => item.groupId === record.groupId).slice(0, 50),
          } };
          return { status: 200, body: record };
        }
        let records = this.records.list(collection);
        if (principal.type === 'instance') records = records.filter(item => item.groupId === principal.groupId);
        const taskId = query?.get?.('taskId');
        if (taskId) records = records.filter(item => (collection === 'messages' ? item.toTaskId : item.taskId) === taskId);
        return { status: 200, body: bounded(records, query) };
      }
      if (collection === 'jobs') {
        if (method === 'POST' && !id) return { status: 201, body: this.createJob(body, principal) };
        const job = this.records.get('jobs', id);
        if (!job) throw fail('任务不存在。', 404);
        if (principal.type !== 'owner') throw fail('任务控制和需求修改由所有者执行。', 403);
        if (method === 'PUT' && !action) {
          const goal = required(body.goal || job.goal, '任务目标');
          const changed = goal !== job.goal || (body.acceptance !== undefined && body.acceptance !== job.acceptance);
          const groupJobs = this.records.list('jobs').filter(item => item.groupId === job.groupId);
          const budgetChanged = body.budgetTokens !== undefined || body.maxDurationMinutes !== undefined;
          if (budgetChanged && job.parentJobId) throw fail('请在主任务上调整整个任务组的预算和时限。');
          const budgetTokens = body.budgetTokens ?? job.budgetTokens ?? 200000;
          const maxDurationMinutes = body.maxDurationMinutes ?? job.maxDurationMinutes ?? 30;
          if (!Number.isSafeInteger(budgetTokens) || budgetTokens < 1000 || budgetTokens > 100000000) throw fail('任务 Token 预算需要在 1000 至 100000000 之间。');
          if (!Number.isFinite(maxDurationMinutes) || maxDurationMinutes < 1 || maxDurationMinutes > 1440) throw fail('任务时限需要在 1 至 1440 分钟之间。');
          const spent = this.records.list('usage').filter(item => item.groupId === job.groupId ||
            (item.taskId && this.taskGroup(item.taskId) === job.groupId)).reduce((sum, item) => sum +
              (Number(item.totalTokens) || (Number(item.inputTokens) || 0) + (Number(item.outputTokens) || 0)), 0);
          const budgetPatch = member => !budgetChanged ? {} : { budgetTokens, maxDurationMinutes, budgetExceeded: spent >= budgetTokens,
            status: spent >= budgetTokens ? 'budget-exceeded' : member.budgetExceeded || member.status === 'budget-exceeded' ? 'paused' : member.status };
          const version = changed ? Math.max(...groupJobs.map(item => item.requirementVersion || 1)) + 1 : job.requirementVersion;
          const updated = this.records.save('jobs', { ...job, goal, acceptance: body.acceptance ?? job.acceptance,
            ...budgetPatch(job), requirementVersion: version }, id, body.expectedRevision);
          if (changed || budgetChanged) for (const member of groupJobs) if (member.id !== job.id) {
            this.records.save('jobs', { ...member, ...budgetPatch(member), requirementVersion: version }, member.id);
          }
          if (budgetChanged && spent >= budgetTokens) {
            for (const member of groupJobs) {
              this.revokeExecution(member.taskId, 'budget-exceeded');
              if (this.store.task(member.taskId)?.status === 'running') await this.stopTask?.(member.taskId);
              const current = this.records.get('jobs', member.id);
              this.records.save('jobs', { ...current, status: 'budget-exceeded', budgetExceeded: true }, member.id);
            }
            this.attention({ kind: 'budget', jobId: job.id, groupId: job.groupId, title: '任务组已达到用量预算',
              detail: `已报告 ${spent} tokens，预算 ${budgetTokens}。` }, `budget:${job.id}`);
          } else if (budgetChanged) {
            const attention = this.records.get('attention', `budget:${job.id}`);
            if (attention) this.records.save('attention', { ...attention, status: 'resolved' }, attention.id);
          }
          if (changed) {
            for (const artifact of this.records.list('artifacts').filter(item => item.groupId === job.groupId)) {
              this.records.save('artifacts', { ...artifact, status: 'needs-review' }, artifact.id);
            }
            for (const execution of this.records.list('executions').filter(item => item.groupId === job.groupId && item.status === 'running')) {
              this.sendMessage({ toTaskId: execution.taskId, content: `需求已更新至版本 ${updated.requirementVersion}：${goal}`,
                kind: 'notice', requirementUpdate: true, requirementVersion: updated.requirementVersion, idempotencyKey: `requirement:${id}:${updated.requirementVersion}:${execution.id}` }, principal);
            }
          }
          return { status: 200, body: this.records.get('jobs', updated.id) };
        }
        if (method === 'POST' && ['pause', 'cancel'].includes(action)) {
          const all = this.records.list('jobs'), ids = new Set([id]);
          for (let pass = 0; pass < 5; pass++) for (const item of all) if (ids.has(item.parentJobId)) ids.add(item.id);
          const affected = all.filter(item => ids.has(item.id));
          for (const target of affected) {
            this.revokeExecution(target.taskId, action === 'pause' ? 'interrupted' : 'cancelled');
            let stopped;
            try { stopped = await this.stopTask?.(target.taskId); } catch { stopped = { status: 'state_unknown' }; }
            const task = this.store.task(target.taskId);
            if (task && !terminal.has(task.status)) this.updateTask(task.id, { status: stopped?.status || 'interrupted' });
            this.records.save('jobs', { ...target, status: action === 'pause' ? 'paused' : 'cancelled' }, target.id);
          }
          return { status: 200, body: this.records.get('jobs', id) };
        }
        if (method === 'POST' && ['retry', 'resume'].includes(action)) {
          if (!['paused', 'failed', 'cancelled', 'interrupted', 'state_unknown', 'blocked'].includes(job.status)) throw fail('当前任务不能恢复。', 409);
          const previous = this.store.task(job.taskId);
          const previousMeta = this.records.get('task-meta', job.taskId) || {};
          const providerIds = body.providerIds ?? previousMeta.allowedProviderIds ?? previousMeta.providerIds;
          if (providerIds !== undefined && (!Array.isArray(providerIds) || providerIds.some(value => typeof value !== 'string'))) throw fail('模型路由必须是供应商 ID 列表。');
          const checkpoint = this.records.list('checkpoints').find(item => item.taskId === job.taskId);
          const task = this.createTask({ role: job.role, prompt: job.goal, workspace: job.workspace, nodeId: job.nodeId,
            workspaceKey: job.workspaceKey, workspaceMode: 'isolated', jobId: job.id, sourceTaskId: previous?.id,
            spaceId: job.spaceId || undefined, teamId: job.teamId || job.spaceId || undefined, sourceMessageId: job.sourceMessageId || undefined,
            providerIds, assistantSnapshot: previousMeta.assistantSnapshot, requirementVersion: job.requirementVersion,
            contextExtra: checkpoint ? JSON.stringify(checkpoint) : '' });
          this.records.save('task-meta', { ...this.records.get('task-meta', task.id), jobId: job.id, groupId: job.groupId,
            batchId: randomUUID(), nodeId: job.nodeId, workspaceKey: job.workspaceKey, permissions: job.permissions,
            requirementVersion: job.requirementVersion, spaceId: job.spaceId || null, teamId: job.teamId || job.spaceId || null,
            sourceMessageId: job.sourceMessageId || null }, task.id);
          return { status: 201, body: this.records.save('jobs', { ...job, taskId: task.id, status: 'queued' }, job.id) };
        }
      }
      if (collection === 'messages') {
        if (method === 'POST' && !id) return { status: 201, body: this.sendMessage(body, principal) };
        if (method === 'POST' && id === 'receive') return { status: 200, body: { items: this.readMessages(body.taskId || principal.taskId, principal) } };
        if (method === 'POST' && action === 'ack') return { status: 200, body: this.acknowledge(id, body, principal) };
      }
      if (collection === 'operations') {
        if (method === 'POST' && !id) return { status: 201, body: this.operation(body, principal) };
        if (method === 'POST' && action === 'result') {
          const record = this.records.get('operations', id);
          if (!record) throw fail('操作不存在。', 404);
          if (principal.type === 'instance' && record.taskId !== principal.taskId) throw fail('不能更新其他实例的操作。', 403);
          if (!['succeeded', 'failed', 'unknown'].includes(body.status)) throw fail('操作结果状态不支持。');
          if (record.status !== 'pending' && principal.type !== 'owner') return { status: 200, body: record };
          return { status: 200, body: this.records.save('operations', { ...record, status: body.status,
            evidence: required(body.evidence, '执行证据'), reportedAt: this.now() }, id) };
        }
      }
      if (['checkpoints', 'artifacts', 'attention', 'board'].includes(collection) && ['POST', 'PUT'].includes(method)) {
        return { status: id ? 200 : 201, body: this.saveScoped(collection, body, principal, id) };
      }
      return { status: 404, body: { error: '接口不存在。' } };
    } catch (error) { return { status: error.status || 400, body: { error: error.message } }; }
  }
  async handleNodes({ method, id, action, body, req, principal, query }) {
    if (method === 'POST' && id === 'pair') {
      const code = required(body.code, '配对码', 100);
      const name = required(body.name, '节点名称', 120);
      const workspaces = Array.isArray(body.workspaces) ? body.workspaces.filter(value => typeof value === 'string' && /^[a-zA-Z0-9_-]{1,100}$/.test(value)) : [];
      if (!workspaces.length || workspaces.length > 100) throw fail('至少声明一个有效的工作目录映射名称。');
      return this.atomic(() => {
        const pairing = this.records.get('node-pairings', hashToken(code));
        if (!pairing || pairing.usedAt || pairing.expiresAt <= this.now()) throw fail('配对码已失效。', 401);
        const token = randomBytes(32).toString('hex');
        const node = this.records.save('nodes', { name, tokenHash: hashToken(token), workspaces,
          platform: String(body.platform || '').slice(0, 100), lastSeenAt: this.now(), status: 'online' });
        this.records.save('node-pairings', { ...pairing, usedAt: this.now(), nodeId: node.id }, pairing.id);
        return { status: 201, body: { node: publicRecord(node), token, leaseMs: this.leaseMs, heartbeatMs: 10000 } };
      });
    }
    if (method === 'POST' && ['claim', 'heartbeat', 'report'].includes(id)) {
      const node = this.nodeFromToken(bearer(req));
      this.records.save('nodes', { ...node, lastSeenAt: this.now(), status: 'online' }, node.id);
      if (id === 'heartbeat') {
        if (!Array.isArray(body.executions) || body.executions.length > 100) throw fail('执行心跳格式错误。');
        const leases = body.executions.map(item => ({ taskId: item.taskId, epoch: item.epoch,
          active: this.heartbeatLocal(item.taskId, item.epoch, node.id), expiresAt: this.records.get('executions', item.taskId)?.expiresAt }));
        return { status: 200, body: { leases, serverTime: this.now() } };
      }
      if (id === 'report') {
        const execution = this.records.get('executions', body.taskId);
        if (!execution || execution.nodeId !== node.id) throw fail('任务不属于此节点。', 403);
        if (body.kind === 'event') {
          if (execution.status !== 'running' || execution.expiresAt <= this.now() || execution.epoch !== body.epoch) throw fail('租约已失效。', 409);
          const eventId = required(body.eventId, '事件 ID', 250);
          if (!body.event || typeof body.event !== 'object' || Array.isArray(body.event) || JSON.stringify(body.event).length > 64000) throw fail('运行事件格式无效或超过大小限制。');
          const receiptId = hashToken(`${body.taskId}:${body.epoch}:${eventId}`);
          if (this.records.get('node-event-receipts', receiptId)) return { status: 200, body: { accepted: true, duplicate: true } };
          if (this.records.list('node-event-receipts').filter(item => item.taskId === body.taskId).length >= 2000) throw fail('当前执行实例的事件数量超过限制。', 409);
          const task = this.store.task(body.taskId);
          this.atomic(() => {
            if (this.onEvent) this.onEvent(task, body.event);
            else this.records.save('task-events', { taskId: body.taskId, ...body.event });
            if (String(body.event.type || '').startsWith('tool/')) {
              const meta = this.records.get('task-meta', body.taskId) || {};
              this.records.save('task-meta', { ...meta, toolActivity: true }, body.taskId);
            }
            this.records.save('node-event-receipts', { taskId: body.taskId, eventId }, receiptId);
          });
          return { status: 200, body: { accepted: true, duplicate: false } };
        }
        if (body.kind === 'log') {
          if (execution.status !== 'running' || execution.expiresAt <= this.now() || execution.epoch !== body.epoch) throw fail('租约已失效。', 409);
          const sequence = Number(body.sequence);
          if (!Number.isSafeInteger(sequence) || sequence < 1) throw fail('日志序号无效。');
          if (sequence > (execution.logSequence || 0)) {
            const task = this.store.task(body.taskId);
            this.updateTask(task.id, { log: `${task.log || ''}${String(body.text || '').slice(0, 20000)}\n`.slice(-48000) });
            this.records.save('executions', { ...execution, logSequence: sequence }, execution.id);
          }
          return { status: 200, body: { accepted: true } };
        }
        const result = this.finishLocal(body.taskId, body.epoch, body, node.id);
        if (!result.duplicate && this.onRemoteDone) await this.onRemoteDone(this.store.task(body.taskId), body);
        return { status: 200, body: result };
      }
      this.reconcile();
      const active = this.records.list('executions').filter(execution => execution.status === 'running');
      const maxConcurrent = this.store.config.maxConcurrent || 3;
      if (active.length >= maxConcurrent) return { status: 200, body: { assignment: null } };
      const task = this.store.tasks().reverse().find(item => {
        const meta = this.records.get('task-meta', item.id) || {};
        return this.eligible(item, node.id) && node.workspaces.includes(meta.workspaceKey || 'default');
      });
      if (!task) return { status: 200, body: { assignment: null } };
      const claimed = this.claimLocal(task, node.id);
      if (!claimed) return { status: 200, body: { assignment: null } };
      try {
        const meta = this.records.get('task-meta', task.id) || {};
        const assignment = this.buildAssignment ? await this.buildAssignment({ task, node: publicRecord(node), ...claimed }) : {
          task, assistant: this.store.role(task.role), config: { model: this.store.config.model, maxConcurrent },
        };
        return { status: 200, body: { assignment: { ...assignment, ...claimed, workspaceKey: meta.workspaceKey || 'default' }, serverTime: this.now() } };
      } catch (error) {
        this.finishLocal(task.id, claimed.execution.epoch, { status: 'failed', error: error.message }, node.id);
        throw error;
      }
    }
    if (principal.type !== 'owner') throw fail('需要所有者权限。', 403);
    if (method === 'GET') {
      if (id) {
        const node = this.records.get('nodes', id);
        if (!node) throw fail('节点不存在。', 404);
        return { status: 200, body: publicRecord(node) };
      }
      return { status: 200, body: bounded(this.records.list('nodes').map(node => ({ ...publicRecord(node),
        status: node.revokedAt ? 'revoked' : this.now() - node.lastSeenAt > this.leaseMs ? 'offline' : 'online' })), query) };
    }
    if (method === 'POST' && id === 'pairing') {
      const code = randomBytes(16).toString('hex');
      const expiresAt = this.now() + 10 * 60_000;
      for (const pairing of this.records.list('node-pairings')) if (pairing.expiresAt <= this.now()) this.records.remove('node-pairings', pairing.id);
      this.records.save('node-pairings', { expiresAt }, hashToken(code));
      return { status: 201, body: { code, expiresAt } };
    }
    if (method === 'POST' && action === 'revoke') {
      const node = this.records.get('nodes', id);
      if (!node) throw fail('节点不存在。', 404);
      this.records.save('nodes', { ...node, revokedAt: this.now(), status: 'revoked', tokenHash: null }, id);
      for (const execution of this.records.list('executions').filter(item => item.nodeId === id && item.status === 'running')) {
        this.revokeExecution(execution.taskId, 'state_unknown');
        this.updateTask(execution.taskId, { status: 'state_unknown', error: '节点已撤销，等待确认旧执行停止。' });
        this.attention({ taskId: execution.taskId, title: '节点撤销后的任务需确认', kind: 'node-revoked' });
      }
      return { status: 200, body: { ok: true } };
    }
    return { status: 404, body: { error: '节点接口不存在。' } };
  }
}

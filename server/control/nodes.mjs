import { randomBytes } from 'node:crypto';
import { bearer, hashToken } from '../auth.mjs';
import {
  bounded,
  fail,
  publicRecord,
  required,
  terminal,
} from './primitives.mjs';

export const isMachineRequest = ({ method, parts }) => {
  if (parts[0] === 'api') parts = parts.slice(1);
  return (
    method === 'POST' &&
    parts[0] === 'nodes' &&
    ['pair', 'claim', 'heartbeat', 'report'].includes(parts[1])
  );
};

export const nodeFromToken = (control, token) => {
  if (!token) throw fail('缺少节点认证。', 401);
  const node = control.records
    .list('nodes')
    .find((item) => item.tokenHash === hashToken(token));
  if (!node || node.revokedAt) throw fail('节点凭据无效或已撤销。', 401);
  return node;
};

export const nodeView = (control, node) => {
  if (!node) return node;
  const activeExecutions = control.records
    .list('executions')
    .filter(
      (execution) =>
        execution.nodeId === node.id && execution.status === 'running',
    )
    .map((execution) => {
      const task = control.store.task(execution.taskId);
      return {
        taskId: execution.taskId,
        title: task?.title || task?.prompt || execution.taskId,
        status: task?.status || execution.status,
        startedAt: execution.startedAt || null,
        expiresAt: execution.expiresAt || null,
      };
    });
  return {
    ...publicRecord(node),
    status: node.revokedAt
      ? 'revoked'
      : control.now() - Number(node.lastSeenAt || 0) > control.leaseMs
        ? 'offline'
        : 'online',
    activeExecutions,
  };
};

export const validateInstanceToken = (control, token) => {
  if (!token) throw fail('缺少执行实例认证。', 401);
  const execution = control.records
    .list('executions')
    .find((item) => item.tokenHash === hashToken(token));
  if (
    !execution ||
    execution.status !== 'running' ||
    execution.expiresAt <= control.now()
  )
    throw fail('执行实例已过期或被撤销。', 401);
  const task = control.store.task(execution.taskId);
  if (!task || task.role !== execution.agentId || terminal.has(task.status))
    throw fail('执行实例已结束。', 401);
  const meta = control.records.get('task-meta', task.id) || {};
  const job = meta.jobId && control.records.get('jobs', meta.jobId);
  if (
    job &&
    (['paused', 'cancelled', 'budget-exceeded'].includes(job.status) ||
      job.budgetExceeded)
  )
    throw fail('任务已暂停、取消或达到预算。', 403);
  return {
    type: 'instance',
    taskId: task.id,
    agentId: task.role,
    jobId: meta.jobId,
    groupId: execution.groupId,
    batchId: execution.batchId,
    epoch: execution.epoch,
    permissions: execution.permissions || [],
    requirementVersion:
      execution.requirementVersion || job?.requirementVersion || 1,
  };
};

export async function handleNodes(
  control,
  { method, id, action, body, req, principal, query },
) {
  if (method === 'POST' && id === 'pair') {
    const code = required(body.code, '配对码', 100);
    const name = required(body.name, '节点名称', 120);
    const workspaces = Array.isArray(body.workspaces)
      ? body.workspaces.filter(
          (value) =>
            typeof value === 'string' && /^[a-zA-Z0-9_-]{1,100}$/.test(value),
        )
      : [];
    if (!workspaces.length || workspaces.length > 100)
      throw fail('至少声明一个有效的工作目录映射名称。');
    return control.atomic(() => {
      const pairing = control.records.get('node-pairings', hashToken(code));
      if (!pairing || pairing.usedAt || pairing.expiresAt <= control.now())
        throw fail('配对码已失效。', 401);
      const token = randomBytes(32).toString('hex');
      const node = control.records.save('nodes', {
        name,
        tokenHash: hashToken(token),
        workspaces,
        platform: String(body.platform || '').slice(0, 100),
        lastSeenAt: control.now(),
        status: 'online',
      });
      control.records.save(
        'node-pairings',
        { ...pairing, usedAt: control.now(), nodeId: node.id },
        pairing.id,
      );
      return {
        status: 201,
        body: {
          node: publicRecord(node),
          token,
          leaseMs: control.leaseMs,
          heartbeatMs: 10000,
        },
      };
    });
  }
  if (method === 'POST' && ['claim', 'heartbeat', 'report'].includes(id)) {
    const node = nodeFromToken(control, bearer(req));
    if (control.markNodeOnline) control.markNodeOnline(node);
    else
      control.records.save(
        'nodes',
        { ...node, lastSeenAt: control.now(), status: 'online' },
        node.id,
      );
    if (id === 'heartbeat') {
      if (!Array.isArray(body.executions) || body.executions.length > 100)
        throw fail('执行心跳格式错误。');
      const leases = body.executions.map((item) => ({
        taskId: item.taskId,
        epoch: item.epoch,
        active: control.heartbeatLocal(item.taskId, item.epoch, node.id),
        expiresAt: control.records.get('executions', item.taskId)?.expiresAt,
      }));
      return { status: 200, body: { leases, serverTime: control.now() } };
    }
    if (id === 'report') {
      const execution = control.records.get('executions', body.taskId);
      if (!execution || execution.nodeId !== node.id)
        throw fail('任务不属于此节点。', 403);
      if (body.kind === 'event') {
        if (
          execution.status !== 'running' ||
          execution.expiresAt <= control.now() ||
          execution.epoch !== body.epoch
        )
          throw fail('租约已失效。', 409);
        const eventId = required(body.eventId, '事件 ID', 250);
        if (
          !body.event ||
          typeof body.event !== 'object' ||
          Array.isArray(body.event) ||
          JSON.stringify(body.event).length > 64000
        )
          throw fail('运行事件格式无效或超过大小限制。');
        const receiptId = hashToken(`${body.taskId}:${body.epoch}:${eventId}`);
        if (control.records.get('node-event-receipts', receiptId))
          return { status: 200, body: { accepted: true, duplicate: true } };
        if (
          control.records
            .list('node-event-receipts')
            .filter((item) => item.taskId === body.taskId).length >= 2000
        )
          throw fail('当前执行实例的事件数量超过限制。', 409);
        const task = control.store.task(body.taskId);
        control.atomic(() => {
          if (control.onEvent) control.onEvent(task, body.event);
          else
            control.records.save('task-events', {
              taskId: body.taskId,
              ...body.event,
            });
          if (String(body.event.type || '').startsWith('tool/')) {
            const meta = control.records.get('task-meta', body.taskId) || {};
            control.records.save(
              'task-meta',
              { ...meta, toolActivity: true },
              body.taskId,
            );
          }
          control.records.save(
            'node-event-receipts',
            { taskId: body.taskId, eventId },
            receiptId,
          );
        });
        return { status: 200, body: { accepted: true, duplicate: false } };
      }
      if (body.kind === 'log') {
        if (
          execution.status !== 'running' ||
          execution.expiresAt <= control.now() ||
          execution.epoch !== body.epoch
        )
          throw fail('租约已失效。', 409);
        const sequence = Number(body.sequence);
        if (!Number.isSafeInteger(sequence) || sequence < 1)
          throw fail('日志序号无效。');
        if (sequence > (execution.logSequence || 0)) {
          const task = control.store.task(body.taskId);
          control.updateTask(task.id, {
            log: `${task.log || ''}${String(body.text || '').slice(0, 20000)}\n`.slice(
              -48000,
            ),
          });
          control.records.save(
            'executions',
            { ...execution, logSequence: sequence },
            execution.id,
          );
        }
        return { status: 200, body: { accepted: true } };
      }
      const result = control.finishLocal(
        body.taskId,
        body.epoch,
        body,
        node.id,
      );
      if (!result.duplicate && control.onRemoteDone)
        await control.onRemoteDone(control.store.task(body.taskId), body);
      return { status: 200, body: result };
    }
    control.reconcile();
    const active = control.records
      .list('executions')
      .filter((execution) => execution.status === 'running');
    const maxConcurrent = control.store.config.maxConcurrent || 3;
    if (active.length >= maxConcurrent)
      return { status: 200, body: { assignment: null } };
    const task = control.store
      .tasks()
      .reverse()
      .find((item) => {
        const meta = control.records.get('task-meta', item.id) || {};
        return (
          control.eligible(item, node.id) &&
          node.workspaces.includes(meta.workspaceKey || 'default')
        );
      });
    if (!task) return { status: 200, body: { assignment: null } };
    const claimed = control.claimLocal(task, node.id);
    if (!claimed) return { status: 200, body: { assignment: null } };
    try {
      const meta = control.records.get('task-meta', task.id) || {};
      const assignment = control.buildAssignment
        ? await control.buildAssignment({
            task,
            node: publicRecord(node),
            ...claimed,
          })
        : {
            task,
            assistant: control.store.role(task.role),
            config: { model: control.store.config.model, maxConcurrent },
          };
      return {
        status: 200,
        body: {
          assignment: {
            ...assignment,
            ...claimed,
            workspaceKey: meta.workspaceKey || 'default',
          },
          serverTime: control.now(),
        },
      };
    } catch (error) {
      control.finishLocal(
        task.id,
        claimed.execution.epoch,
        { status: 'failed', error: error.message },
        node.id,
      );
      throw error;
    }
  }
  if (principal.type !== 'owner') throw fail('需要所有者权限。', 403);
  if (method === 'GET') {
    if (control.reconcileNodes) control.reconcileNodes();
    if (id) {
      const node = control.records.get('nodes', id);
      if (!node) throw fail('节点不存在。', 404);
      return { status: 200, body: nodeView(control, node) };
    }
    return {
      status: 200,
      body: bounded(
        control.records.list('nodes').map((node) => nodeView(control, node)),
        query,
      ),
    };
  }
  if (method === 'POST' && id === 'pairing') {
    const code = randomBytes(16).toString('hex');
    const expiresAt = control.now() + 10 * 60_000;
    for (const pairing of control.records.list('node-pairings'))
      if (pairing.expiresAt <= control.now())
        control.records.remove('node-pairings', pairing.id);
    control.records.save('node-pairings', { expiresAt }, hashToken(code));
    return { status: 201, body: { code, expiresAt } };
  }
  if (method === 'POST' && action === 'revoke') {
    const node = control.records.get('nodes', id);
    if (!node) throw fail('节点不存在。', 404);
    control.records.save(
      'nodes',
      { ...node, revokedAt: control.now(), status: 'revoked', tokenHash: null },
      id,
    );
    for (const execution of control.records
      .list('executions')
      .filter((item) => item.nodeId === id && item.status === 'running')) {
      control.revokeExecution(execution.taskId, 'state_unknown');
      control.updateTask(execution.taskId, {
        status: 'state_unknown',
        error: '节点已撤销，等待确认旧执行停止。',
      });
      control.attention({
        taskId: execution.taskId,
        title: '节点撤销后的任务需确认',
        kind: 'node-revoked',
      });
    }
    return { status: 200, body: { ok: true } };
  }
  return { status: 404, body: { error: '节点接口不存在。' } };
}

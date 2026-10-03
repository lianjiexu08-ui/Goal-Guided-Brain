import { hashToken } from '../auth.mjs';
import { fail, required } from './primitives.mjs';

export function saveScopedRecord(plane, collection, body, principal, id) {
  plane.ensureCurrent(principal);
  const taskId =
    principal.type === 'instance'
      ? principal.taskId
      : required(body.taskId, '执行实例', 150);
  plane.authorizeTask(principal, taskId);
  const groupId = plane.taskGroup(taskId);
  const current = id && plane.records.get(collection, id);
  if (current && current.groupId !== groupId)
    throw fail('记录不属于当前任务组。', 403);
  if (
    current &&
    principal.type === 'instance' &&
    current.taskId !== taskId &&
    collection !== 'board'
  )
    throw fail('不能修改其他实例的记录。', 403);
  const input = {
    taskId,
    groupId,
    agentId: principal.agentId || 'owner',
    title: required(body.title || body.kind || collection, '标题', 200),
    content: String(body.content || body.detail || '').slice(0, 100000),
    requirementVersion:
      body.requirementVersion || principal.requirementVersion || 1,
  };
  if (collection === 'checkpoints')
    Object.assign(input, {
      constraints: body.constraints || [],
      decisions: body.decisions || [],
      artifacts: body.artifacts || [],
      operations: body.operations || [],
      nextSteps: body.nextSteps || [],
    });
  if (collection === 'artifacts')
    Object.assign(input, {
      location: required(body.location, '产物位置', 3000),
      commit: String(body.commit || '').slice(0, 150),
      evidence: String(body.evidence || '').slice(0, 100000),
      status: 'submitted',
    });
  if (collection === 'artifacts') {
    const meta = plane.records.get('task-meta', taskId) || {};
    const job = meta.jobId && plane.records.get('jobs', meta.jobId);
    if (job && input.requirementVersion < job.requirementVersion)
      input.status = 'needs-review';
  }
  if (collection === 'attention')
    Object.assign(input, {
      status: body.status === 'resolved' ? 'resolved' : 'open',
      kind: String(body.kind || 'decision'),
    });
  if (collection === 'board' && current && body.expectedRevision === undefined)
    throw fail('修改任务板需要提供 expectedRevision。', 409);
  return plane.records.save(
    collection,
    { ...current, ...input },
    id,
    body.expectedRevision,
  );
}

export function createOperation(plane, body, principal) {
  plane.ensureCurrent(principal);
  const taskId = principal.type === 'instance' ? principal.taskId : body.taskId;
  plane.authorizeTask(principal, taskId);
  const action = required(body.action, '操作类型', 100);
  if (principal.type === 'instance' && !principal.permissions.includes(action))
    throw fail('此实例没有该外部操作的授权。', 403);
  const key = required(body.idempotencyKey, '操作幂等键', 200);
  const id = hashToken(`${plane.taskGroup(taskId)}:${action}:${key}`);
  const existing = plane.records.get('operations', id);
  if (existing) return { ...existing, canExecute: false };
  const operation = plane.records.save(
    'operations',
    {
      taskId,
      groupId: plane.taskGroup(taskId),
      action,
      title: String(body.title || action).slice(0, 200),
      status: 'pending',
      intent: required(body.intent, '操作意图'),
      key,
    },
    id,
  );
  return { ...operation, canExecute: true };
}

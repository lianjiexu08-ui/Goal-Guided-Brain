import { StoreReadIndex } from './store/read-index.mjs';

export function validHandoffSource(read, row) {
  if (row?.kind !== 'handoff' || row.spaceId !== row.fromTeamId) return false;
  const peer = read.get('space-messages', row.relatedMessageId);
  const meta = read.get('task-meta', row.taskId);
  return (
    peer?.kind === 'handoff' &&
    peer.spaceId === row.toTeamId &&
    peer.fromTeamId === row.fromTeamId &&
    peer.toTeamId === row.toTeamId &&
    peer.taskId === row.taskId &&
    meta?.sourceMessageId === peer.id &&
    (meta.teamId || meta.spaceId) === row.toTeamId &&
    Boolean(read.task(row.taskId))
  );
}

function taskBelongsToHandoff(read, taskId, upstream) {
  if (taskId === upstream.taskId) return true;
  const meta = read.get('task-meta', taskId);
  const upstreamMeta = read.get('task-meta', upstream.taskId);
  const root = upstreamMeta?.jobId && read.get('jobs', upstreamMeta.jobId);
  let job = meta?.jobId && read.get('jobs', meta.jobId);
  if (!root || !job || !root.groupId) return false;
  const visited = new Set();
  while (job && !visited.has(job.id)) {
    visited.add(job.id);
    if (
      (job.teamId || job.spaceId) !== upstream.toTeamId ||
      job.groupId !== root.groupId ||
      job.sourceMessageId !== upstream.relatedMessageId
    )
      return false;
    // Retried attempts retain their logical job even when its current task changes.
    if (job.id === root.id) return true;
    job = job.parentJobId && read.get('jobs', job.parentJobId);
  }
  return false;
}

function deriveOrigin(read, teamId, taskId) {
  const task = read.task(taskId);
  const meta = read.get('task-meta', taskId);
  if (!task || (meta?.teamId || meta?.spaceId) !== teamId) return null;
  const origin = {
    initiatorTaskId: taskId,
    initiatorJobId: meta.jobId || null,
    parentMessageId: null,
    status: 'root',
  };
  if (!meta.sourceMessageId) return origin;
  const incoming = read.get('space-messages', meta.sourceMessageId);
  if (incoming && incoming.kind !== 'handoff' && incoming.spaceId === teamId)
    return origin;
  const upstream =
    incoming && read.get('space-messages', `${incoming.id}:source`);
  if (
    !validHandoffSource(read, upstream) ||
    upstream.toTeamId !== teamId ||
    !taskBelongsToHandoff(read, taskId, upstream)
  )
    return { ...origin, status: 'unresolved' };
  return { ...origin, parentMessageId: upstream.id, status: 'linked' };
}

// The caller supplies a lease-authenticated task ID, never a model's request field.
export function captureHandoffOrigin(store, teamId, taskId) {
  const result = deriveOrigin(new StoreReadIndex(store), teamId, taskId);
  if (!result)
    throw Object.assign(
      new Error('无法确认发起任务所属团队，请重新读取当前执行。'),
      { status: 409 },
    );
  return result;
}

export function readHandoffOrigin(read, row) {
  const saved = read.get('handoff-origins', row.id);
  if (!saved)
    return {
      status: 'legacy',
      parentMessageId: null,
      initiatorTaskId: null,
    };
  const current =
    saved.status === 'owner' && saved.initiatorTaskId === null
      ? {
          status: 'owner',
          initiatorTaskId: null,
          initiatorJobId: null,
          parentMessageId: null,
        }
      : deriveOrigin(read, row.fromTeamId, saved.initiatorTaskId);
  if (
    !current ||
    saved.version !== 1 ||
    saved.messageId !== row.id ||
    saved.sourceTeamId !== row.fromTeamId ||
    saved.targetTeamId !== row.toTeamId ||
    saved.targetTaskId !== row.taskId ||
    saved.initiatorJobId !== current.initiatorJobId ||
    saved.status !== current.status ||
    saved.parentMessageId !== current.parentMessageId
  ) {
    return {
      status: 'unresolved',
      parentMessageId: null,
      initiatorTaskId: null,
    };
  }
  return current;
}

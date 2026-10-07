import { createHash } from 'node:crypto';
import { StoreReadIndex } from './store/read-index.mjs';
import { atomicHandoff } from './team-handoff-store.mjs';
import { consumeCollaborationDraft } from './collaboration-drafts.mjs';

const terminal = new Set(['completed', 'failed', 'cancelled', 'interrupted']);
const fail = (message, status = 409) =>
  Object.assign(new Error(message), { status });

function sourceHandoff(read, message) {
  if (!message) return null;
  const source =
    message.kind === 'reply'
      ? read.get('space-messages', message.relatedMessageId)
      : message.spaceId === message.fromTeamId
        ? message
        : read.get('space-messages', `${message.id}:source`);
  const target = source?.relatedMessageId
    ? read.get('space-messages', source.relatedMessageId)
    : null;
  const meta = source?.taskId ? read.get('task-meta', source.taskId) : null;
  if (
    !target ||
    !meta ||
    source?.kind !== 'handoff' ||
    source.spaceId !== source.fromTeamId ||
    target?.spaceId !== source.toTeamId ||
    target.taskId !== source.taskId ||
    meta?.sourceMessageId !== target.id ||
    (meta.teamId || meta.spaceId) !== target.spaceId
  )
    return null;
  return source;
}

export function collaborationReview(read, message) {
  const source = sourceHandoff(read, message);
  const task = source?.taskId ? read.task(source.taskId) : null;
  if (!source || !task) return null;
  // Cache only within this synchronous projection, shared by request/reply rows.
  read.collaborationReviews ??= new Map();
  if (read.collaborationReviews.has(source.id))
    return read.collaborationReviews.get(source.id);
  const saved = read.get('handoff-reviews', source.id);
  const delivery = read.taskDelivery(task);
  const fingerprint = createHash('sha256')
    .update(
      JSON.stringify([
        task.id,
        task.status,
        task.updatedAt,
        task.result,
        task.error,
        delivery.currentRequirementVersion,
        delivery.deliveryStatus,
        delivery.latestVerificationId,
        delivery.latestVerificationAt,
        delivery.acceptance?.revision,
        delivery.acceptance?.updatedAt,
      ]),
    )
    .digest('hex');
  const result = {
    messageId: source.id,
    taskId: task.id,
    sourceTeamId: source.spaceId,
    targetTeamId: source.toTeamId,
    status:
      saved?.status === 'closed'
        ? saved.fingerprint === fingerprint
          ? 'closed'
          : 'stale'
        : 'open',
    action: saved?.action || null,
    note: saved?.note || '',
    revision: saved?.revision || 0,
    fingerprint,
    updatedAt: saved?.updatedAt || null,
    canComplete: delivery.deliveryStatus === 'accepted',
    canEnd: terminal.has(task.status),
    deliveryStatus: delivery.deliveryStatus,
  };
  read.collaborationReviews.set(source.id, result);
  return result;
}

export function readCollaborationReview(store, teamId, messageId) {
  const read = new StoreReadIndex(store);
  const message = read.get('space-messages', messageId);
  const review = collaborationReview(read, message);
  if (
    !review ||
    review.messageId !== messageId ||
    review.sourceTeamId !== teamId
  )
    throw fail('这条协作不属于当前来源团队。', 404);
  return {
    ...review,
    history: read
      .group('handoff-review-events', 'messageId', messageId)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .slice(0, 20),
  };
}

export function saveCollaborationReview(store, teamId, messageId, body) {
  const { action, fingerprint, revision, requestId } = body;
  const note = typeof body.note === 'string' ? body.note.trim() : '';
  if (
    !['complete', 'end', 'reopen'].includes(action) ||
    typeof requestId !== 'string' ||
    !/^[\w-]{1,100}$/.test(requestId) ||
    !Number.isSafeInteger(revision) ||
    revision < 0 ||
    typeof fingerprint !== 'string' ||
    note.length > 2000
  )
    throw fail('协作处理参数无效，请重新打开处理面板。', 400);
  if (action !== 'complete' && !note)
    throw fail('请填写结束跟进或重新打开的原因。', 400);
  return atomicHandoff(store, () => {
    const current = readCollaborationReview(store, teamId, messageId);
    const eventId = `${messageId}:${requestId}`;
    const previous = store.records.get('handoff-review-events', eventId);
    if (previous) {
      if (previous.action !== action || previous.note !== note)
        throw fail('同一处理请求的内容不能修改。');
      consumeCollaborationDraft(store, teamId, messageId, body, true);
      return current;
    }
    if (store.teamSpace(teamId)?.status !== 'active')
      throw fail('来源团队已暂停或归档，请先恢复团队。');
    if (current.revision !== revision || current.fingerprint !== fingerprint)
      throw fail('协作或验收状态已更新，请重新读取后再处理。');
    if (action === 'reopen' && current.status === 'open')
      throw fail('这条协作已经处于跟进中。');
    if (action !== 'reopen' && current.status !== 'open')
      throw fail('请先重新打开协作，再作新的处理决定。');
    if (action === 'complete' && !current.canComplete)
      throw fail('请先在任务详情中完成当前交付的验收。');
    if (action === 'end' && !current.canEnd)
      throw fail('原任务仍在执行或状态不明，请先处理原任务。');
    const entry = {
      messageId,
      taskId: current.taskId,
      spaceId: teamId,
      targetTeamId: current.targetTeamId,
      status: action === 'reopen' ? 'open' : 'closed',
      action,
      note,
      fingerprint,
      actor: 'owner',
      requestId,
    };
    store.records.save('handoff-reviews', entry, messageId);
    store.records.save('handoff-review-events', entry, eventId);
    consumeCollaborationDraft(store, teamId, messageId, body);
    return readCollaborationReview(store, teamId, messageId);
  });
}

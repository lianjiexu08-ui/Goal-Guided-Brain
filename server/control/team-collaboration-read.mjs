import { StoreReadIndex } from '../store/read-index.mjs';
import { collaborationReview } from '../team-handoff-review.mjs';
import { fail, findTeam, required } from './primitives.mjs';

const settled = new Set(['completed', 'failed', 'cancelled', 'interrupted']);
const states = ['open', 'closed', 'stale', 'unlinked'];
const compare = (a, b) => (a === b ? 0 : a < b ? -1 : 1);

function currentTeam(control, principal) {
  control.ensureCurrent(principal);
  const { team } = control.currentTeam(principal);
  if (team.recruitment?.phase !== 'confirmed')
    throw fail('团队尚未完成招募，不能读取协作任务。', 409);
  return team;
}

function permitted(control, source, target) {
  return Boolean(
    target &&
    target.status === 'active' &&
    target.recruitment?.phase === 'confirmed' &&
    control.collaborationAllowed(source, target),
  );
}

function publicReview(review) {
  if (!review) return null;
  return {
    sourceMessageId: review.messageId,
    status: review.status,
    action: review.action,
    note: review.note,
    updatedAt: review.updatedAt,
    decisionAuthority: 'owner',
    ownerCanComplete: review.canComplete,
    ownerCanEnd: review.canEnd,
  };
}

function sharedReplies(read, sourceMessageId, taskId, sourceId, targetId) {
  return read
    .group('space-messages', 'relatedMessageId', sourceMessageId)
    .filter(
      (message) =>
        message.kind === 'reply' &&
        message.taskId === taskId &&
        message.spaceId === sourceId &&
        message.fromTeamId === targetId &&
        message.toTeamId === sourceId,
    )
    .sort(
      (a, b) =>
        a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id),
    );
}

export function readTeamTask(control, body, principal) {
  const source = currentTeam(control, principal);
  const taskId = required(body.taskId, '目标任务', 150);
  const read = new StoreReadIndex(control.store);
  const task = read.task(taskId);
  const meta = read.get('task-meta', taskId);
  const target = meta
    ? findTeam(control.store, meta.teamId || meta.spaceId)
    : null;
  const original = meta?.sourceMessageId
    ? read.get('space-messages', meta.sourceMessageId)
    : null;
  const review = collaborationReview(read, original);
  if (
    !task ||
    !review ||
    review.taskId !== task.id ||
    review.sourceTeamId !== source.id ||
    review.targetTeamId !== target?.id ||
    target.id === source.id ||
    !permitted(control, source, target)
  )
    throw fail('当前团队只能读取自己委派且仍获准的协作任务。', 403);
  const job = meta.jobId ? read.get('jobs', meta.jobId) : null;
  const delivery = read.taskDelivery(task);
  return {
    taskId: task.id,
    jobId: meta.jobId || null,
    teamId: target.id,
    status: task.status,
    title: task.title,
    result: String(task.result || '').slice(0, 50000),
    error: String(task.error || '').slice(0, 10000),
    jobStatus: job?.status || null,
    collaboration: publicReview(review),
    canFollowUp: review.status === 'open' && settled.has(task.status),
    delivery: {
      deliveryStatus: delivery.deliveryStatus,
      verificationStatus: delivery.acceptanceStatus,
      acceptanceDecision: delivery.acceptanceDecision,
      acceptanceNote: delivery.acceptanceNote,
      currentRequirementVersion: delivery.currentRequirementVersion,
      verificationRequirementVersion: delivery.verificationRequirementVersion,
      hasCurrentVerificationEvidence: delivery.hasCurrentVerificationEvidence,
      latestVerificationId: delivery.latestVerificationId,
      latestVerificationAt: delivery.latestVerificationAt,
    },
    messages: [
      original,
      ...sharedReplies(
        read,
        review.messageId,
        task.id,
        source.id,
        target.id,
      ).slice(-19),
    ],
  };
}

function nextAction(status, direction, allowed, task, deliveryStatus) {
  if (status === 'closed') return 'none';
  if (status === 'unlinked') return 'ask_owner_repair';
  if (status === 'stale') return 'ask_owner_review';
  if (direction === 'incoming') return 'observe_incoming';
  if (!allowed) return 'review_permissions';
  if (task.status === 'state_unknown') return 'reconcile_task';
  if (!settled.has(task.status)) return 'wait';
  if (task.status !== 'completed') return 'review_failure';
  return deliveryStatus === 'accepted' ? 'ask_owner_close' : 'review_delivery';
}

export function listTeamCollaborations(control, body, principal) {
  const team = currentTeam(control, principal);
  const direction = body.direction ?? 'outgoing';
  const status = body.status ?? 'all';
  const limit = body.limit ?? 20;
  if (
    !['outgoing', 'incoming', 'all'].includes(direction) ||
    !['all', ...states].includes(status) ||
    !Number.isInteger(limit) ||
    limit < 1 ||
    limit > 50
  )
    throw fail('协作筛选或分页参数无效。');
  let cursor = null;
  if (body.before !== undefined) {
    try {
      if (typeof body.before !== 'string' || body.before.length > 3000)
        throw new Error();
      cursor = JSON.parse(
        Buffer.from(body.before, 'base64url').toString('utf8'),
      );
      if (
        cursor.v !== 1 ||
        cursor.teamId !== team.id ||
        cursor.direction !== direction ||
        cursor.status !== status ||
        typeof cursor.at !== 'string' ||
        typeof cursor.id !== 'string'
      )
        throw new Error();
    } catch {
      throw fail('协作游标不匹配，请按当前团队和筛选重新读取。');
    }
  }
  const read = new StoreReadIndex(control.store);
  const counts = Object.fromEntries(states.map((state) => [state, 0]));
  const candidates = [];
  for (const message of read.group('space-messages', 'spaceId', team.id)) {
    if (message.kind !== 'handoff') continue;
    const side = message.fromTeamId === team.id ? 'outgoing' : 'incoming';
    if (side === 'incoming' && message.toTeamId !== team.id) continue;
    if (direction !== 'all' && direction !== side) continue;
    const review = collaborationReview(read, message);
    const state = review?.status || 'unlinked';
    counts[state]++;
    if (status !== 'all' && status !== state) continue;
    candidates.push({ message, review, side, state });
  }
  candidates.sort(
    (a, b) =>
      compare(b.message.createdAt, a.message.createdAt) ||
      compare(b.message.id, a.message.id),
  );
  const remaining = candidates.filter(
    ({ message }) =>
      !cursor ||
      message.createdAt < cursor.at ||
      (message.createdAt === cursor.at && message.id < cursor.id),
  );
  const selected = remaining.slice(0, limit);
  const items = selected.map(({ message, review, side, state }) => {
    const peerId = side === 'outgoing' ? message.toTeamId : message.fromTeamId;
    const peer = peerId ? findTeam(control.store, peerId) : null;
    const task = review ? read.task(review.taskId) : null;
    const allowed =
      side === 'outgoing' && Boolean(review) && permitted(control, team, peer);
    const reply =
      review && side === 'outgoing'
        ? sharedReplies(
            read,
            review.messageId,
            review.taskId,
            team.id,
            peerId,
          ).at(-1)
        : null;
    return {
      messageId: message.id,
      sourceMessageId: review?.messageId || null,
      followupMessageId: message.followupMessageId || null,
      direction: side,
      createdAt: message.createdAt,
      status: state,
      peer: {
        id: peerId,
        name: peer?.name || '历史协作团队',
        status: peer?.status || 'unavailable',
      },
      goal: message.content.slice(0, 4000),
      goalTruncated: message.content.length > 4000,
      taskId: review?.taskId || null,
      taskStatus: task?.status || null,
      deliveryStatus: review?.deliveryStatus || null,
      returnedResult: reply ? reply.content.slice(0, 4000) : null,
      resultTruncated: Boolean(reply && reply.content.length > 4000),
      collaboration: publicReview(review),
      canReadTask: allowed,
      canFollowUp: allowed && state === 'open' && settled.has(task.status),
      nextAction: nextAction(
        state,
        side,
        allowed,
        task,
        review?.deliveryStatus,
      ),
    };
  });
  const last = selected.at(-1)?.message;
  const hasMore = remaining.length > limit;
  return {
    teamId: team.id,
    direction,
    status,
    counts,
    total: candidates.length,
    items,
    hasMore,
    nextCursor:
      hasMore && last
        ? Buffer.from(
            JSON.stringify({
              v: 1,
              teamId: team.id,
              direction,
              status,
              at: last.createdAt,
              id: last.id,
            }),
          ).toString('base64url')
        : null,
    decisionAuthority: 'owner',
  };
}

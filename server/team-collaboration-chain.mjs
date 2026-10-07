import { createHash } from 'node:crypto';
import { StoreReadIndex } from './store/read-index.mjs';
import { collaborationReview } from './team-handoff-review.mjs';

const fail = (message, status = 409) =>
  Object.assign(new Error(message), { status });
const settled = new Set(['completed', 'failed', 'cancelled', 'interrupted']);
const compare = (a, b) =>
  a.createdAt < b.createdAt
    ? -1
    : a.createdAt > b.createdAt
      ? 1
      : a.id < b.id
        ? -1
        : a.id > b.id
          ? 1
          : 0;

function validSource(read, row) {
  if (row.kind !== 'handoff' || row.spaceId !== row.fromTeamId) return false;
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

function sharedReply(read, row) {
  const reply = read.get('space-messages', `handoff-reply:${row.taskId}`);
  return reply?.kind === 'reply' &&
    reply.spaceId === row.spaceId &&
    reply.relatedMessageId === row.id &&
    reply.taskId === row.taskId &&
    reply.fromTeamId === row.toTeamId &&
    reply.toTeamId === row.fromTeamId
    ? { content: reply.content, createdAt: reply.createdAt }
    : null;
}

export function readCollaborationChain(store, teamId, messageId, query = {}) {
  const limit = query.limit === undefined ? 20 : Number(query.limit);
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 50)
    throw fail('链路分页数量需要为 1 至 50。', 400);
  const read = new StoreReadIndex(store);
  // Only shared, paired requests involving this team can participate in a chain.
  const candidates = read
    .list('space-messages')
    .filter(
      (row) =>
        (row.fromTeamId === teamId || row.toTeamId === teamId) &&
        validSource(read, row),
    );
  const requested = read.get('space-messages', messageId);
  const selected = candidates.find(
    (row) =>
      row.id === messageId ||
      row.relatedMessageId === messageId ||
      (requested?.kind === 'reply' &&
        requested.spaceId === row.spaceId &&
        requested.relatedMessageId === row.id &&
        requested.taskId === row.taskId &&
        requested.fromTeamId === row.toTeamId &&
        requested.toTeamId === row.fromTeamId),
  );
  if (!selected) throw fail('当前团队没有这条协作的有效共享记录。', 404);
  const rows = candidates.filter(
    (row) =>
      row.fromTeamId === selected.fromTeamId &&
      row.toTeamId === selected.toTeamId,
  );
  const byId = new Map(rows.map((row) => [row.id, row]));
  let root = selected;
  const ancestors = new Set();
  while (root.followupMessageId && byId.has(root.followupMessageId)) {
    if (ancestors.has(root.id))
      throw fail('协作引用存在循环，请核对原始记录。');
    ancestors.add(root.id);
    root = byId.get(root.followupMessageId);
  }
  const children = new Map();
  for (const row of rows) {
    const parent = row.followupMessageId;
    if (!children.has(parent)) children.set(parent, []);
    children.get(parent).push(row);
  }
  for (const list of children.values()) list.sort(compare);
  const ordered = [];
  const stack = [root];
  const seen = new Set();
  while (stack.length) {
    const row = stack.pop();
    if (seen.has(row.id)) throw fail('协作引用存在循环，请核对原始记录。');
    seen.add(row.id);
    ordered.push(row);
    for (const child of (children.get(row.id) || []).toReversed())
      stack.push(child);
  }
  const revision = createHash('sha256')
    .update(
      JSON.stringify(
        ordered.map((row) => [
          row.id,
          row.taskId,
          row.followupMessageId || null,
          row.createdAt,
        ]),
      ),
    )
    .digest('hex');
  let offset = 0;
  if (query.after) {
    try {
      if (typeof query.after !== 'string' || query.after.length > 4096)
        throw new Error();
      const cursor = JSON.parse(
        Buffer.from(query.after, 'base64url').toString(),
      );
      if (
        cursor.teamId !== teamId ||
        cursor.rootId !== root.id ||
        cursor.revision !== revision ||
        !Number.isSafeInteger(cursor.offset) ||
        cursor.offset < 1 ||
        cursor.offset >= ordered.length
      )
        throw new Error();
      offset = cursor.offset;
    } catch {
      throw fail('协作链路已变化或游标无效，请刷新链路后继续。');
    }
  }
  const reviews = new Map(
    ordered.map((row) => [row.id, collaborationReview(read, row)]),
  );
  const counts = {
    total: ordered.length,
    active: 0,
    accepted: 0,
    open: 0,
    closed: 0,
    stale: 0,
  };
  for (const row of ordered) {
    const review = reviews.get(row.id);
    if (!settled.has(read.task(row.taskId).status)) counts.active++;
    if (review.deliveryStatus === 'accepted') counts.accepted++;
    counts[review.status]++;
  }
  const indices = new Map(ordered.map((row, index) => [row.id, index + 1]));
  const next = offset + limit;
  return {
    rootMessageId: root.id,
    selectedMessageId: selected.id,
    selectedIndex: indices.get(selected.id),
    sourceTeamId: root.fromTeamId,
    targetTeamId: root.toTeamId,
    sourceTeamName: store.teamSpace(root.fromTeamId)?.name || '历史来源团队',
    targetTeamName: store.teamSpace(root.toTeamId)?.name || '历史目标团队',
    // A missing/cross-team ancestor is not followed or presented as a complete chain.
    incomplete: Boolean(root.followupMessageId),
    revision,
    counts,
    items: ordered.slice(offset, next).map((row) => {
      const task = read.task(row.taskId);
      const review = reviews.get(row.id);
      return {
        messageId: row.id,
        index: indices.get(row.id),
        parentIndex: indices.get(row.followupMessageId) || null,
        createdAt: row.createdAt,
        content: row.content,
        reply: sharedReply(read, row),
        task: {
          id: task.id,
          status: task.status,
          deliveryStatus: review.deliveryStatus,
        },
        review: {
          status: review.status,
          action: review.action,
          note: review.note,
        },
      };
    }),
    nextCursor:
      next < ordered.length
        ? Buffer.from(
            JSON.stringify({ teamId, rootId: root.id, revision, offset: next }),
          ).toString('base64url')
        : null,
  };
}

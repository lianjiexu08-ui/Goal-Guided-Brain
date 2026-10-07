import { createHash } from 'node:crypto';
import { StoreReadIndex } from './store/read-index.mjs';
import { collaborationReview } from './team-handoff-review.mjs';
import { buildHandoffGraph } from './team-handoff-graph.mjs';

const fail = (message, status = 409) =>
  Object.assign(new Error(message), { status });
const settled = new Set(['completed', 'failed', 'cancelled', 'interrupted']);

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
  const {
    selected,
    ordered,
    origins,
    links,
    root,
    roots,
    incomplete,
    omittedLinks,
  } = buildHandoffGraph(read, teamId, messageId);
  const revision = createHash('sha256')
    .update(
      JSON.stringify(
        ordered.map((row) => [
          row.id,
          row.taskId,
          row.fromTeamId,
          row.toTeamId,
          links.get(row.id).parents,
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
    visibility: 'owner-workflow',
    rootCount: roots.length,
    omittedLinks,
    teamCount: new Set(ordered.flatMap((row) => [row.fromTeamId, row.toTeamId]))
      .size,
    rootMessageId: root.id,
    selectedMessageId: selected.id,
    selectedIndex: indices.get(selected.id),
    sourceTeamId: root.fromTeamId,
    targetTeamId: root.toTeamId,
    sourceTeamName: store.teamSpace(root.fromTeamId)?.name || '历史来源团队',
    targetTeamName: store.teamSpace(root.toTeamId)?.name || '历史目标团队',
    // Unverifiable provenance is never reconstructed from free-form context.
    incomplete,
    revision,
    counts,
    items: ordered.slice(offset, next).map((row) => {
      const task = read.task(row.taskId);
      const review = reviews.get(row.id);
      return {
        messageId: row.id,
        index: indices.get(row.id),
        parentIndex: indices.get(links.get(row.id).parents[0]?.id) || null,
        parentLinks: links.get(row.id).parents.map((parent) => ({
          index: indices.get(parent.id),
          kind: parent.kind,
        })),
        originStatus: origins.get(row.id).status,
        initiatorTaskId: origins.get(row.id).initiatorTaskId,
        sourceTeamId: row.fromTeamId,
        targetTeamId: row.toTeamId,
        sourceTeamName: store.teamSpace(row.fromTeamId)?.name || '历史来源团队',
        targetTeamName: store.teamSpace(row.toTeamId)?.name || '历史目标团队',
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

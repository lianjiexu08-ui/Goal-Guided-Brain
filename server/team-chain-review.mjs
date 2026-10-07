import { createHash } from 'node:crypto';
import { StoreReadIndex } from './store/read-index.mjs';
import { buildHandoffGraph } from './team-handoff-graph.mjs';
import { collaborationReview } from './team-handoff-review.mjs';
import { atomicHandoff } from './team-handoff-store.mjs';
import {
  chainReviewScope,
  consumeChainReviewDraft,
  validateChainDecision,
} from './chain-review-drafts.mjs';

const fail = (message, status = 409) =>
  Object.assign(new Error(message), { status });
const hash = (value) =>
  createHash('sha256').update(JSON.stringify(value)).digest('hex');
const actions = ['complete', 'end', 'reopen'];
function changes(review, action) {
  return action === 'reopen'
    ? review.status !== 'open'
    : review.status !== 'closed' ||
        (action === 'complete' && review.action !== 'complete');
}
export function previewChainReview(store, teamId, messageId) {
  const read = new StoreReadIndex(store);
  const graph = buildHandoffGraph(read, teamId, messageId);
  const items = graph.ordered.map((row, index) => {
    const review = collaborationReview(read, row);
    const source = store.teamSpace(row.fromTeamId);
    return {
      index: index + 1,
      messageId: row.id,
      taskId: row.taskId,
      sourceTeamName: source?.name || '历史来源团队',
      targetTeamName: store.teamSpace(row.toTeamId)?.name || '历史目标团队',
      content: row.content,
      taskStatus: read.task(row.taskId).status,
      reviewStatus: review.status,
      reviewAction: review.action,
      deliveryStatus: review.deliveryStatus,
      decisions: Object.fromEntries(
        actions.map((action) => {
          const affected = changes(review, action);
          const reason = !affected
            ? ''
            : source?.status !== 'active'
              ? '来源团队已归档，请先恢复团队。'
              : action === 'complete' && (!review.canComplete || !review.canEnd)
                ? '任务尚未结束或当前交付尚未验收。'
                : action === 'end' && !review.canEnd
                  ? '任务仍在执行或状态不明，请先处理任务。'
                  : '';
          return [action, { affected, reason }];
        }),
      ),
      // Included in the versioned snapshot, never trusted from the client.
      reviewRevision: review.revision,
      reviewFingerprint: review.fingerprint,
    };
  });
  const options = Object.fromEntries(
    actions.map((action) => {
      const affected = items.filter((item) => item.decisions[action].affected);
      const reason = graph.incomplete
        ? '链路来源不完整，请先核对关联记录或逐条处理。'
        : !affected.length
          ? '当前没有需要此操作的请求。'
          : affected.some((item) => item.decisions[action].reason)
            ? '请先处理下方标出的阻塞项。'
            : '';
      return [action, { affected: affected.length, allowed: !reason, reason }];
    }),
  );
  return {
    messageId: graph.selected.id,
    rootMessageId: graph.root.id,
    rootCount: graph.roots.length,
    teamCount: new Set(
      graph.ordered.flatMap((row) => [row.fromTeamId, row.toTeamId]),
    ).size,
    incomplete: graph.incomplete,
    items,
    options,
    fingerprint: hash([
      items,
      options,
      graph.ordered.map((row) => [
        row.id,
        row.relatedMessageId,
        row.fromTeamId,
        row.toTeamId,
        graph.links.get(row.id).parents,
        read.get('space-messages', `handoff-reply:${row.taskId}`),
      ]),
      graph.omittedLinks,
    ]),
  };
}
export function saveChainReview(store, teamId, messageId, body) {
  const decision = validateChainDecision(body);
  return atomicHandoff(store, () => {
    const scope = chainReviewScope(store, teamId, messageId);
    const receiptId = hash([scope, decision.requestId]);
    const previous = store.records.get('chain-review-receipts', receiptId);
    if (previous) {
      if (
        ['action', 'note', 'fingerprint'].some(
          (field) => previous[field] !== decision[field],
        )
      )
        throw fail('同一链路处理请求不能更改内容。');
      consumeChainReviewDraft(
        store,
        scope,
        { ...decision, draftRevision: body.draftRevision },
        true,
      );
      return previous;
    }
    const preview = previewChainReview(store, teamId, messageId);
    if (preview.fingerprint !== decision.fingerprint)
      throw fail('链路范围、任务或验收状态已变化，请重新预览后确认。');
    const option = preview.options[decision.action];
    if (!option.allowed) throw fail(option.reason);
    const affected = preview.items.filter(
      (item) => item.decisions[decision.action].affected,
    );
    for (const item of affected) {
      const row = store.records.get('space-messages', item.messageId);
      const entry = {
        messageId: item.messageId,
        taskId: item.taskId,
        spaceId: row.fromTeamId,
        targetTeamId: row.toTeamId,
        status: decision.action === 'reopen' ? 'open' : 'closed',
        action: decision.action,
        note: decision.note,
        fingerprint: item.reviewFingerprint,
        actor: 'owner',
        requestId: receiptId,
        chainReceiptId: receiptId,
      };
      store.records.save('handoff-reviews', entry, item.messageId);
      store.records.save(
        'handoff-review-events',
        entry,
        `${item.messageId}:chain:${receiptId}`,
      );
    }
    consumeChainReviewDraft(store, scope, {
      ...decision,
      draftRevision: body.draftRevision,
    });
    return store.records.save(
      'chain-review-receipts',
      {
        ...decision,
        scope,
        messageIds: affected.map((item) => item.messageId),
        actor: 'owner',
      },
      receiptId,
    );
  });
}

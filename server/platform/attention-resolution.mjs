import { fail, required } from '../control/primitives.mjs';
import { runAtomic } from '../control/transactions.mjs';

/** Record an owner's decision without restarting or accepting any task. */
export function resolveAttention(store, id, body, principal) {
  if (principal?.type !== 'owner')
    throw fail('只有所有者可以处理此事项。', 403);
  return runAtomic(store, () => {
    const { records } = store;
    const item = records.get('attention', id);
    if (!item) throw fail('待处理事项不存在。', 404);
    if (item.kind === 'tool-approval')
      throw fail('工具审批必须使用专门的批准或拒绝流程。', 409);
    if (['resolved', 'dismissed'].includes(item.status)) return item;
    const resolution = required(body.resolution, '处理结果', 4000);
    const resolvedAt = new Date().toISOString();
    // Save notifications first; only the final attention write emits a team
    // event, so a notification failure cannot publish a false resolution.
    for (const notification of records.list('notifications')) {
      if (notification.attentionId !== id || notification.read === true)
        continue;
      records.save(
        'notifications',
        {
          ...notification,
          read: true,
          readAt: notification.readAt || resolvedAt,
        },
        notification.id,
      );
    }
    return records.save(
      'attention',
      {
        ...item,
        status: 'resolved',
        resolution,
        resolvedAt,
        resolvedBy: 'owner',
      },
      id,
    );
  });
}

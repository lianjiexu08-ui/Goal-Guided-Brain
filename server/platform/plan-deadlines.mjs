/**
 * Keep overdue team plans visible in the existing attention and notification
 * stream. The check is synchronous so the scheduler, tests, and CLI can share
 * the same deterministic behavior.
 */
export function checkPlanDeadlines({ store, control, now = () => Date.now() }) {
  const nowValue = now();
  const nowDate = new Date(nowValue);
  const today = nowDate.toISOString().slice(0, 10);
  const resolvedAt = nowDate.toISOString();
  let overdue = 0;
  let resolved = 0;

  for (const team of store.teamSpaces()) {
    const attentionId = `plan-overdue:${team.id}`;
    const previous = store.records.get('attention', attentionId);
    const plan = store.teamPlan(team.id);
    const confirmed = team.recruitment?.phase === 'confirmed';
    const isOverdue =
      confirmed &&
      team.status !== 'archived' &&
      plan &&
      plan.status !== 'completed' &&
      typeof plan.dueAt === 'string' &&
      /^\d{4}-\d{2}-\d{2}$/.test(plan.dueAt) &&
      plan.dueAt < today;

    if (isOverdue) {
      control.attention(
        {
          kind: 'plan-overdue',
          teamId: team.id,
          spaceId: team.id,
          title: '团队计划已逾期',
          detail: `「${team.name}」的计划截止日为 ${plan.dueAt}，请更新计划或确认下一步。`,
        },
        attentionId,
      );
      // A plan can become overdue again after the owner resolves the first
      // reminder by moving its deadline. Reopen the notification in that
      // case so the new risk is visible instead of remaining silently read.
      if (previous && previous.status !== 'open') {
        const notificationId = `attention:${attentionId}`;
        const notification = store.records.get('notifications', notificationId);
        if (notification) {
          store.records.save(
            'notifications',
            {
              ...notification,
              read: false,
              readAt: null,
              occurredAt: resolvedAt,
            },
            notificationId,
          );
        }
      }
      overdue += 1;
    } else if (previous?.status === 'open') {
      store.records.save(
        'attention',
        {
          ...previous,
          status: 'resolved',
          resolvedAt,
          resolvedReason: '计划已完成、归档或更新了截止日。',
        },
        attentionId,
      );
      const notificationId = `attention:${attentionId}`;
      const notification = store.records.get('notifications', notificationId);
      if (notification && !notification.readAt) {
        store.records.save(
          'notifications',
          { ...notification, read: true, readAt: resolvedAt },
          notificationId,
        );
      }
      resolved += 1;
    }
  }
  return { overdue, resolved };
}

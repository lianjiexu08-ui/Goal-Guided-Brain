import { collaborationReview } from '../team-handoff-review.mjs';

function matchesKind(item, kind) {
  if (kind === 'collaboration')
    return (
      item.type === 'message' &&
      (item.kind === 'handoff' ||
        (item.kind === 'reply' &&
          Boolean(item.relatedMessageId || item.fromTeamId)))
    );
  if (kind === 'messages') return item.type === 'message';
  if (kind === 'execution') return ['task', 'task-event'].includes(item.type);
  if (kind === 'evidence')
    return ['artifact', 'verification', 'acceptance'].includes(item.type);
  if (kind === 'risk') {
    if (item.type === 'message')
      return item.status === 'blocked' || Boolean(item.error);
    if (item.type === 'task')
      return (
        [
          'blocked',
          'failed',
          'interrupted',
          'state_unknown',
          'budget-exceeded',
          'budget_exceeded',
        ].includes(item.status) ||
        item.deliveryStatus === 'rejected' ||
        Boolean(item.error)
      );
    if (item.type === 'task-event')
      return /fail|error|block|interrupt|budget/i.test(item.eventType || '');
    if (item.type === 'acceptance')
      return item.acceptanceDecision === 'rejected';
    return false;
  }
  return true;
}

export function buildTeamTimeline(
  read,
  spaceId,
  limit = 120,
  before = null,
  kind = 'all',
) {
  if (!read.get('spaces', spaceId)) return [];
  const tasks = read.tasksForSpace(spaceId);
  const taskById = new Map(tasks.map((task) => [task.id, task]));
  const items = [];
  for (const message of read.group('space-messages', 'spaceId', spaceId)) {
    items.push({
      id: `message:${message.id}`,
      type: 'message',
      at: message.createdAt,
      messageId: message.id,
      clientMessageId: message.clientMessageId || null,
      senderType: message.senderType,
      senderId: message.senderId,
      fromTeamId: message.fromTeamId || null,
      toTeamId: message.toTeamId || null,
      relatedMessageId: message.relatedMessageId || null,
      followupMessageId: message.followupMessageId || null,
      collaborationReview: ['handoff', 'reply'].includes(message.kind)
        ? collaborationReview(read, message)
        : null,
      kind: message.kind,
      taskId: message.taskId || null,
      content: message.content,
      status: message.status,
      error: message.error || null,
      attachmentIds: Array.isArray(message.attachmentIds)
        ? message.attachmentIds
        : [],
    });
  }
  for (const task of tasks) {
    const meta = read.get('task-meta', task.id) || {};
    const artifacts = read.group('artifacts', 'taskId', task.id);
    const delivery = read.taskDelivery(task);
    items.push({
      id: `task:${task.id}`,
      type: 'task',
      at: task.updatedAt || task.createdAt,
      taskId: task.id,
      role: task.role,
      title: task.title,
      status: task.status,
      result: String(task.result || '').slice(0, 360),
      error: String(task.error || '').slice(0, 360),
      workspaceMode: meta.workspaceMode || null,
      artifactCount: artifacts.length,
      verificationStatus: delivery.hasVerificationEvidence
        ? delivery.acceptanceStatus
        : null,
      deliveryStatus: delivery.deliveryStatus,
      acceptanceDecision: delivery.acceptanceDecision,
    });
  }
  for (const event of tasks.flatMap((task) =>
    read.group('task-events', 'taskId', task.id),
  )) {
    items.push({
      id: `event:${event.id}`,
      type: 'task-event',
      at:
        event.at ||
        event.updatedAt ||
        event.createdAt ||
        taskById.get(event.taskId)?.updatedAt ||
        taskById.get(event.taskId)?.createdAt,
      taskId: event.taskId,
      eventType: event.type || 'event',
      data: event.data || null,
    });
  }
  for (const artifact of tasks.flatMap((task) =>
    read.group('artifacts', 'taskId', task.id),
  )) {
    items.push({
      id: `artifact:${artifact.id}`,
      type: artifact.kind === 'verification' ? 'verification' : 'artifact',
      at:
        artifact.finishedAt ||
        artifact.updatedAt ||
        artifact.createdAt ||
        taskById.get(artifact.taskId)?.updatedAt ||
        taskById.get(artifact.taskId)?.createdAt,
      taskId: artifact.taskId,
      kind: artifact.kind || 'artifact',
      name: artifact.name || '未命名产物',
      status: artifact.status || null,
      verified: artifact.verified === true,
    });
  }
  for (const acceptance of tasks.flatMap((task) =>
    read.group('task-acceptance', 'taskId', task.id),
  )) {
    items.push({
      id: `acceptance:${acceptance.id}`,
      type: 'acceptance',
      at:
        acceptance.decidedAt ||
        acceptance.updatedAt ||
        acceptance.createdAt ||
        taskById.get(acceptance.taskId)?.updatedAt ||
        taskById.get(acceptance.taskId)?.createdAt,
      taskId: acceptance.taskId,
      status: acceptance.status || 'active',
      acceptanceDecision: acceptance.decision || null,
      acceptanceNote: String(acceptance.note || '').slice(0, 360),
      currentRequirementVersion: Number(acceptance.requirementVersion || 1),
    });
  }
  const cursor =
    typeof before === 'string' && before.trim() ? before.split('|') : [];
  const beforeAt = cursor[0] || null;
  const beforeId = cursor.slice(1).join('|') || null;
  return items
    .filter(
      (item) =>
        typeof item.at === 'string' && item.at && matchesKind(item, kind),
    )
    .sort((a, b) => a.at.localeCompare(b.at) || a.id.localeCompare(b.id))
    .filter(
      (item) =>
        !beforeAt ||
        item.at < beforeAt ||
        (item.at === beforeAt && Boolean(beforeId && item.id < beforeId)),
    )
    .slice(-Math.max(1, Math.min(200, Number(limit) || 120)));
}

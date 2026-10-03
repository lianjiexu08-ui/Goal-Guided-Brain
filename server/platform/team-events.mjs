const LIVE_COLLECTIONS = new Set([
  'space-messages',
  'task-events',
  'artifacts',
  'task-acceptance',
  'attention',
  'jobs',
]);

/**
 * Own the live event fan-out used by the platform and team workspace.
 *
 * Keeping this state outside the platform factory makes the HTTP surface
 * smaller while preserving the existing event payloads and subscriptions.
 */
export function createTeamEventHub({ records, store, attachments, nowIso }) {
  const taskSubscribers = new Map();
  const teamSubscribers = new Map();

  function teamForTask(taskId) {
    if (!taskId) return null;
    const meta = records.get('task-meta', taskId) || {};
    const job = meta.jobId ? records.get('jobs', meta.jobId) : null;
    return meta.spaceId || meta.teamId || job?.spaceId || job?.teamId || null;
  }

  function teamForRecord(collection, record) {
    if (!record) return null;
    if (collection === 'space-messages' || collection === 'jobs')
      return record.spaceId || record.teamId || null;
    if (collection === 'attention')
      return record.spaceId || record.teamId || teamForTask(record.taskId);
    return teamForTask(record.taskId);
  }

  function timelineEvent(collection, record) {
    if (!record) return null;
    const at =
      record.at ||
      record.updatedAt ||
      record.finishedAt ||
      record.decidedAt ||
      record.createdAt ||
      nowIso();
    if (collection === 'space-messages') {
      return {
        id: `message:${record.id}`,
        type: 'message',
        at,
        messageId: record.id,
        clientMessageId: record.clientMessageId || null,
        senderType: record.senderType || 'owner',
        senderId: record.senderId || 'owner',
        fromTeamId: record.fromTeamId || null,
        toTeamId: record.toTeamId || record.spaceId || null,
        relatedMessageId: record.relatedMessageId || null,
        kind: record.kind || 'request',
        taskId: record.taskId || null,
        content: record.content || '',
        status: record.status || 'sent',
        error: record.error || null,
        attachmentIds: Array.isArray(record.attachmentIds)
          ? record.attachmentIds
          : [],
        attachments: attachments.list(record.attachmentIds),
      };
    }
    if (collection === 'task-events') {
      return {
        id: `event:${record.id}`,
        type: 'task-event',
        at,
        taskId: record.taskId,
        eventType: record.type || 'event',
        data: record.data || null,
      };
    }
    if (collection === 'artifacts') {
      return {
        id: `artifact:${record.id}`,
        type: record.kind === 'verification' ? 'verification' : 'artifact',
        at,
        taskId: record.taskId,
        kind: record.kind || 'artifact',
        name: record.name || '未命名产物',
        status: record.status || null,
        verified: record.verified === true,
      };
    }
    if (collection === 'task-acceptance') {
      return {
        id: `acceptance:${record.id}`,
        type: 'acceptance',
        at,
        taskId: record.taskId,
        status: record.status || 'active',
        acceptanceDecision: record.decision || null,
        acceptanceNote: String(record.note || '').slice(0, 360),
        currentRequirementVersion: Number(record.requirementVersion || 1),
      };
    }
    // Jobs and attention records change a derived task or risk summary.
    // Send a refresh marker so clients update without duplicate derived rows.
    return {
      id: `update:${collection}:${record.id}`,
      type: 'team-update',
      at,
      source: collection,
      recordId: record.id,
      taskId: record.taskId || null,
      status: record.status || null,
      title: record.title || record.name || null,
    };
  }

  function publishTeamEvent(teamId, event) {
    const subscribers = teamSubscribers.get(teamId);
    if (!subscribers) return;
    for (const subscriber of subscribers) {
      try {
        subscriber(event);
      } catch {}
    }
  }

  function publishTeamRecord(change) {
    if (!change || !LIVE_COLLECTIONS.has(change.collection)) return;
    const teamId = teamForRecord(change.collection, change.record);
    if (!teamId) return;
    const event = timelineEvent(change.collection, change.record);
    if (event) publishTeamEvent(teamId, { ...event, teamId });
  }

  function publishTeamTask(change) {
    const task = change?.task;
    const teamId = task ? teamForTask(task.id) : null;
    if (!task || !teamId) return;
    const meta = records.get('task-meta', task.id) || {};
    const delivery = store.taskDelivery(task);
    const artifacts = records
      .list('artifacts')
      .filter((artifact) => artifact.taskId === task.id);
    publishTeamEvent(teamId, {
      id: `task:${task.id}`,
      type: 'task',
      at: task.updatedAt || task.createdAt || nowIso(),
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
      teamId,
    });
  }

  function notifyTaskEvent(taskId, event) {
    const subscribers = taskSubscribers.get(taskId);
    if (!subscribers) return;
    for (const subscriber of subscribers) {
      try {
        subscriber(event);
      } catch {}
    }
  }

  function subscribeTaskEvents(taskId, subscriber) {
    if (!taskSubscribers.has(taskId)) taskSubscribers.set(taskId, new Set());
    const subscribers = taskSubscribers.get(taskId);
    subscribers.add(subscriber);
    return () => {
      subscribers.delete(subscriber);
      if (!subscribers.size) taskSubscribers.delete(taskId);
    };
  }

  function subscribeTeamEvents(teamId, subscriber) {
    if (!teamSubscribers.has(teamId)) teamSubscribers.set(teamId, new Set());
    const subscribers = teamSubscribers.get(teamId);
    subscribers.add(subscriber);
    return () => {
      subscribers.delete(subscriber);
      if (!subscribers.size) teamSubscribers.delete(teamId);
    };
  }

  function clear() {
    taskSubscribers.clear();
    teamSubscribers.clear();
  }

  return {
    clear,
    notifyTaskEvent,
    publishTeamEvent,
    publishTeamRecord,
    publishTeamTask,
    subscribeTaskEvents,
    subscribeTeamEvents,
  };
}

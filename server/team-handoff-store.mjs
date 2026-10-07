// Persist a handoff identically for the owner HTTP API and the agent MCP API.
// Authorization and task construction remain the responsibility of each caller.
export function commitTeamHandoff(options) {
  return atomicHandoff(options.store, () => persistHandoff(options));
}

function atomicHandoff(store, operation) {
  const onRecord = store.records.onSave;
  const onTask = store.onTaskUpdate;
  const changes = new Map();
  const defer = (key, callback) => {
    changes.delete(key);
    changes.set(key, callback);
  };
  store.db.exec('SAVEPOINT team_handoff');
  store.records.onSave = (change) =>
    defer(`record:${change.collection}:${change.record.id}`, () =>
      onRecord?.(change),
    );
  store.onTaskUpdate = (change) =>
    defer(`task:${change.task?.id}`, () => onTask?.(change));
  let result;
  try {
    result = operation();
    store.db.exec('RELEASE SAVEPOINT team_handoff');
  } catch (error) {
    store.db.exec(
      'ROLLBACK TO SAVEPOINT team_handoff; RELEASE SAVEPOINT team_handoff',
    );
    throw error;
  } finally {
    store.records.onSave = onRecord;
    store.onTaskUpdate = onTask;
  }
  for (const publish of changes.values()) {
    try {
      publish();
    } catch {
      /* A notification cannot undo a committed handoff. */
    }
  }
  return result;
}

const conflict = () =>
  Object.assign(new Error('协作记录关联不一致，请检查原任务后再重试。'), {
    status: 409,
  });

function persistHandoff({
  store,
  source,
  target,
  clientMessageId,
  content,
  createTask,
  legacyMessageId,
  followupMessageId = null,
}) {
  const matches = (message) =>
    message?.kind === 'handoff' &&
    message.clientMessageId === clientMessageId &&
    message.fromTeamId === source.id &&
    message.toTeamId === target.id &&
    (message.followupMessageId || null) === followupMessageId &&
    message.spaceId === target.id;
  let messageId = `handoff:${source.id}:${target.id}:${clientMessageId}`;
  let previous = store.records.get('space-messages', messageId);
  if (!previous && legacyMessageId) {
    const legacy = store.records.get('space-messages', legacyMessageId);
    // Older MCP IDs omitted source-task identity. Never reuse a legacy row
    // belonging to another invocation, even when its raw key is the same.
    if (matches(legacy)) {
      previous = legacy;
      messageId = legacy.id;
    }
  }
  if (previous && !matches(previous)) throw conflict();
  let task = previous?.taskId ? store.task(previous.taskId) : null;
  if (task) {
    const meta = store.records.get('task-meta', task.id);
    if (
      (meta?.teamId || meta?.spaceId) !== target.id ||
      meta?.sourceMessageId !== messageId
    )
      throw conflict();
  } else if (previous) {
    const candidates = store.records
      .list('task-meta')
      .filter(
        (meta) =>
          meta.sourceMessageId === messageId &&
          (meta.teamId || meta.spaceId) === target.id &&
          store.task(meta.id),
      );
    if (candidates.length > 1) throw conflict();
    if (candidates.length === 1) task = store.task(candidates[0].id);
  }
  const duplicate = Boolean(task);
  let message = previous;
  if (!task) {
    message = store.saveTeamMessage(
      {
        spaceId: target.id,
        teamId: target.id,
        clientMessageId,
        kind: 'handoff',
        senderType: 'team',
        senderId: source.id,
        fromTeamId: source.id,
        toTeamId: target.id,
        content,
        status: 'sent',
        followupMessageId,
      },
      messageId,
    );
    task = createTask(message);
    if (!task?.id) throw new Error('协作任务未创建，请重试。');
  }
  if (message.taskId !== task.id || message.status === 'blocked')
    message = store.saveTeamMessage(
      { ...message, taskId: task.id, status: 'sent' },
      messageId,
    );
  const sourceMessageId = `${messageId}:source`;
  const sourceMessage = store.records.get('space-messages', sourceMessageId);
  if (
    sourceMessage &&
    (sourceMessage.clientMessageId !== clientMessageId ||
      sourceMessage.spaceId !== source.id)
  )
    throw conflict();
  if (
    !sourceMessage ||
    sourceMessage.taskId !== task.id ||
    sourceMessage.relatedMessageId !== messageId
  )
    store.saveTeamMessage(
      {
        ...message,
        spaceId: source.id,
        teamId: source.id,
        relatedMessageId: messageId,
        taskId: task.id,
      },
      sourceMessageId,
    );
  return { duplicate, message, task, sourceMessageId };
}

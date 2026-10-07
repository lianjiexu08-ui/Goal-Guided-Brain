import { randomUUID } from 'node:crypto';

// The handoff, task, job and both teams' traces must commit together. Buffer
// live notifications until commit so a failed write never publishes success.
export function createTeamHandoff(deps) {
  const { store } = deps;
  const onRecord = store.records.onSave;
  const onTask = store.onTaskUpdate;
  const changes = new Map();
  store.db.exec('SAVEPOINT team_handoff');
  const defer = (key, callback) => {
    changes.delete(key);
    changes.set(key, callback);
  };
  store.records.onSave = (change) =>
    defer(`record:${change.collection}:${change.record.id}`, () =>
      onRecord?.(change),
    );
  store.onTaskUpdate = (change) =>
    defer(`task:${change.task?.id || change.id}`, () => onTask?.(change));
  let result;
  try {
    result = createHandoff(deps);
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
      /* Notification failures cannot undo a committed handoff. */
    }
  }
  return result;
}

function createHandoff({ store, space, body, newTask, required }) {
  if (space.status !== 'active') throw new Error('团队空间当前不可发起协作。');
  if (space.recruitment?.phase !== 'confirmed')
    throw Object.assign(new Error('当前团队尚未完成招募。'), {
      status: 409,
    });
  if (space.collaboration?.enabled === false)
    throw Object.assign(new Error('当前团队未启用跨团队协作。'), {
      status: 409,
    });
  const targetId = required(body.targetTeamId || body.teamId, '目标团队');
  const target = store
    .teamSpaces()
    .find(
      (candidate) => candidate.id === targetId || candidate.chatId === targetId,
    );
  if (!target || target.status !== 'active')
    throw new Error('目标团队不存在或已暂停。');
  if (target.recruitment.phase !== 'confirmed')
    throw Object.assign(new Error('目标团队尚未完成招募。'), {
      status: 409,
    });
  if (target.id === space.id) throw new Error('目标团队不能是当前团队。');
  const allowed = Array.isArray(space.collaboration?.allowedTeamIds)
    ? space.collaboration.allowedTeamIds
    : [];
  if (
    allowed.length &&
    !allowed.includes(target.id) &&
    !allowed.includes(target.chatId)
  )
    throw new Error('当前团队未允许与目标团队协作。');
  const prompt = required(body.content, '协作目标', 32000);
  const acceptance =
    typeof body.acceptance === 'string' ? body.acceptance.trim() : '';
  if (acceptance.length > 20000)
    throw new Error('验收标准不能超过 20000 个字符。');
  const content = acceptance
    ? `${prompt}\n\n验收标准：\n${acceptance}`
    : prompt;
  if (content.length > 32000)
    throw new Error('协作目标和验收标准合计不能超过 32000 个字符。');
  const clientMessageId = required(
    body.clientMessageId || randomUUID(),
    '消息 ID',
    200,
  );
  const handoffId = `handoff:${space.id}:${target.id}:${clientMessageId}`;
  let previous = store.records.get('space-messages', handoffId);
  if (previous && !previous.taskId) {
    const meta = store.records
      .list('task-meta')
      .find((item) => item.sourceMessageId === handoffId);
    if (meta && store.task(meta.id))
      previous = store.saveTeamMessage(
        { ...previous, taskId: meta.id },
        handoffId,
      );
  }
  if (
    previous &&
    previous.status !== 'blocked' &&
    store.task(previous.taskId)
  ) {
    const sourceMessageId = `${handoffId}:source`;
    if (!store.records.get('space-messages', sourceMessageId)) {
      store.saveTeamMessage(
        {
          ...previous,
          spaceId: space.id,
          teamId: space.id,
          relatedMessageId: previous.id,
          taskId: previous.taskId,
        },
        sourceMessageId,
      );
    }
    return {
      status: 200,
      body: {
        ...previous,
        sourceTeamId: space.id,
        targetTeamId: target.id,
        sourceMessageId,
      },
    };
  }
  const message = store.saveTeamMessage(
    {
      spaceId: target.id,
      teamId: target.id,
      clientMessageId,
      kind: 'handoff',
      senderType: 'team',
      senderId: space.id,
      fromTeamId: space.id,
      toTeamId: target.id,
      content,
      status: 'sent',
    },
    handoffId,
  );
  const task = newTask({
    role: target.pmRoleId,
    prompt: `团队「${space.name}」向本团队发起协作请求。请阅读请求并自主判断是否接受、拆解和安排执行。\n\n协作目标：\n${content}`,
    workspace: target.workspace,
    teamId: target.id,
    spaceId: target.id,
    sourceMessageId: message.id,
    acceptance,
  });
  const linked = store.saveTeamMessage(
    { ...message, taskId: task.id },
    message.id,
  );
  const sourceLinked = store.saveTeamMessage(
    {
      ...message,
      spaceId: space.id,
      teamId: space.id,
      relatedMessageId: message.id,
      taskId: task.id,
    },
    `${handoffId}:source`,
  );
  return {
    status: 201,
    body: {
      ...linked,
      taskId: task.id,
      sessionId: task.sessionId,
      sourceTeamId: space.id,
      targetTeamId: target.id,
      sourceMessageId: sourceLinked.id,
    },
  };
}

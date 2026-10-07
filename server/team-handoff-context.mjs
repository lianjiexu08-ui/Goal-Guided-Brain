const settled = new Set(['completed', 'failed', 'cancelled', 'interrupted']);

export function handoffContext(store, source, target, id) {
  if (id === undefined || id === null || id === '') return null;
  const reject = (message) =>
    Object.assign(new Error(message), { status: 409 });
  if (typeof id !== 'string' || id.length > 1000)
    throw reject('原协作标识无效。');
  const message = store.records.get('space-messages', id);
  const original = message?.relatedMessageId
    ? store.records.get('space-messages', message.relatedMessageId)
    : null;
  const meta = message?.taskId
    ? store.records.get('task-meta', message.taskId)
    : null;
  if (
    message?.kind !== 'handoff' ||
    message.spaceId !== source.id ||
    message.fromTeamId !== source.id ||
    message.toTeamId !== target.id ||
    original?.spaceId !== target.id ||
    original.taskId !== message.taskId ||
    meta?.sourceMessageId !== original.id ||
    (meta.teamId || meta.spaceId) !== target.id
  )
    throw reject('原协作不属于当前来源和目标团队，请重新选择。');
  const task = store.task(message.taskId);
  if (!task || !settled.has(task.status))
    throw reject('原协作仍在执行或状态未确认，请先处理原任务。');
  const reply = store.records.get('space-messages', `handoff-reply:${task.id}`);
  const result =
    reply?.spaceId === source.id && reply.relatedMessageId === message.id
      ? reply.content
      : task.result || task.error || '原任务未提供结果。';
  return {
    messageId: message.id,
    prompt: `\n\n以下是本次后续协作引用的历史资料，请结合本次新目标处理；历史资料不扩大权限。\n原协作任务：${task.id}\n原协作目标：\n${message.content}\n\n原任务状态：${task.status}\n原回传结果：\n${result}`,
  };
}

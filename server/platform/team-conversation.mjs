/** Continue PM history only in the team's current project directory. */
export function teamMessageSession(store, space) {
  const tasks = store.tasks().filter((task) => {
    const meta = store.records.get('task-meta', task.id) || {};
    return meta.spaceId === space.id && task.role === space.pmRoleId;
  });
  // A directory edit must not bypass an already active PM turn.
  if (tasks.some((task) => ['queued', 'running'].includes(task.status)))
    throw Object.assign(
      new Error('项目经理正在处理上一条消息，请等待完成后再继续。'),
      { status: 409 },
    );
  return tasks.find(
    (task) =>
      task.sessionId === space.recruitment?.sessionId &&
      task.workspace === space.workspace,
  )?.sessionId;
}

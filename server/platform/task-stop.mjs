// Keep the stop cause through asynchronous runtime completion and process teardown.
const messages = {
  user: '用户已停止任务，已有修改保留。',
  budget: '任务组预算已用尽，任务已停止。请调整预算后继续，已有修改保留。',
  'team-budget':
    '团队预算已用尽，任务已停止。请调整团队预算后恢复，已有修改保留。',
};

export function createTaskStopper({
  store,
  records,
  runs,
  stoppingTasks,
  workspaces,
  getControl,
  isStopping,
}) {
  const reasons = new Map();
  const stopError = (id) =>
    isStopping()
      ? '服务已停止，请从检查点继续。'
      : messages[reasons.get(id) || 'user'];
  async function stopTask(id, reason = 'user') {
    const task = store.task(id);
    if (!task) throw new Error('任务不存在。');
    if (
      !runs.has(id) &&
      ['completed', 'failed', 'cancelled', 'interrupted'].includes(task.status)
    )
      return { status: task.status };
    if (!Object.hasOwn(messages, reason)) throw new Error('停止原因无效。');
    if (!reasons.has(id)) reasons.set(id, reason);
    stoppingTasks.add(id);
    const execution = records.get('executions', id);
    if (execution) getControl().revokeExecution(id, 'stopping');
    const run = runs.get(id);
    if (run) {
      await run.cancel();
      if (runs.has(id) && run.child && run.child.exitCode === null) {
        store.updateTask(id, {
          status: 'state_unknown',
          error: `${stopError(id)} 尚未确认执行进程退出，原目录已隔离。`,
        });
        workspaces.finish(id, 'quarantined');
        return { status: 'state_unknown' };
      }
    } else if (execution && execution.nodeId !== 'local') {
      store.updateTask(id, {
        status: 'state_unknown',
        error: `${stopError(id)} 已撤销执行权限，等待远程节点确认停止。`,
      });
      return { status: 'state_unknown' };
    }
    if (
      !['completed', 'failed', 'cancelled', 'interrupted'].includes(
        store.task(id).status,
      )
    )
      store.updateTask(id, {
        status: isStopping() ? 'interrupted' : 'cancelled',
        error: stopError(id),
      });
    return { status: store.task(id).status };
  }
  return { stopTask, stopError };
}

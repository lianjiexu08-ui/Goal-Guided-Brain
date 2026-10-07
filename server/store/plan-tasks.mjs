/** Validate links at the store boundary; a plan cannot borrow another team's tasks. */
export function normalizePlanTaskIds(store, teamId, input) {
  if (input === undefined) return [];
  if (
    !Array.isArray(input) ||
    input.some((id) => typeof id !== 'string' || !id.trim())
  )
    throw new Error('里程碑关联任务必须是任务 ID 列表。');
  const ids = [...new Set(input.map((id) => id.trim()))];
  if (ids.length > 40) throw new Error('每个里程碑最多关联 40 项任务。');
  for (const id of ids) {
    const task = store.task(id);
    const meta = store.records.get('task-meta', id) || {};
    const job = meta.jobId ? store.records.get('jobs', meta.jobId) : null;
    const scope = meta.spaceId || meta.teamId || job?.spaceId || job?.teamId;
    if (!task || scope !== teamId)
      throw new Error('里程碑只能关联本团队中存在的任务。');
  }
  return ids;
}

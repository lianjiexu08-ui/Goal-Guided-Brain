// Validate recovery scope before persisting a new attempt or scheduling work.
export function resolveResumeSource(
  store,
  runs,
  workspaces,
  { id, role, workspace, teamId, nodeId },
) {
  if (!id) return null;
  const previous = store.task(id);
  const meta = store.records.get('task-meta', id) || {};
  if (
    !previous ||
    previous.role !== role ||
    previous.workspace !== workspace ||
    (meta.teamId || meta.spaceId || null) !== teamId ||
    (meta.nodeId || 'local') !== nodeId ||
    !['failed', 'cancelled', 'interrupted', 'completed'].includes(
      previous.status,
    ) ||
    runs.has(previous.id)
  )
    throw new Error('原执行尚未安全停止或与当前恢复范围不一致。');
  if (nodeId === 'local') {
    // Failures before workspace preparation have no generated files to restore.
    if (!store.records.get('workspaces', id)) return null;
    workspaces.resumeSource({ workspace }, id);
  }
  return id;
}

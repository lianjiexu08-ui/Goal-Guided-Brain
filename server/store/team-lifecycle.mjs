const ACTIVE_TASK_STATUSES = new Set(['queued', 'running', 'state_unknown']);

const ACTIVE_JOB_STATUSES = new Set([
  'queued',
  'running',
  'waiting_children',
  'paused',
  'blocked',
]);

function scopeId(meta = {}, job = null) {
  return meta.teamId || meta.spaceId || job?.teamId || job?.spaceId || null;
}

function lifecycleError(message, status = 409) {
  return Object.assign(new Error(message), { status });
}

export const teamLifecycleMethods = {
  archiveTeamSpace(id, archived) {
    const team = this.teamSpace(id);
    if (!team) throw lifecycleError('团队空间不存在。', 404);
    if (archived !== true) {
      if (team.status !== 'archived') return team;
      if (team.recruitment?.phase !== 'confirmed')
        throw lifecycleError('只有已确认的团队才能恢复。');
      return this.saveTeamSpace(
        {
          ...team,
          status: 'active',
          archivedAt: null,
          archivedFromStatus: null,
        },
        team.id,
      );
    }
    if (team.status === 'archived') return team;
    if (team.recruitment?.phase !== 'confirmed')
      throw lifecycleError('只有已确认的团队才能归档。');
    const taskBlockers = this.tasks().filter((task) => {
      const meta = this.records.get('task-meta', task.id) || {};
      const job = meta.jobId ? this.records.get('jobs', meta.jobId) : null;
      return (
        scopeId(meta, job) === team.id && ACTIVE_TASK_STATUSES.has(task.status)
      );
    });
    const jobBlockers = this.records
      .list('jobs')
      .filter(
        (job) =>
          scopeId(job, job) === team.id && ACTIVE_JOB_STATUSES.has(job.status),
      );
    if (taskBlockers.length || jobBlockers.length)
      throw lifecycleError(
        `团队仍有 ${taskBlockers.length + jobBlockers.length} 项进行中的任务，请完成、停止或暂停后再归档。`,
      );
    return this.saveTeamSpace(
      {
        ...team,
        status: 'archived',
        archivedAt: new Date().toISOString(),
        archivedFromStatus: team.status,
      },
      team.id,
    );
  },
};

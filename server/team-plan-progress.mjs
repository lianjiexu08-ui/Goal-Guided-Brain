import { fail, required } from './control/primitives.mjs';
import { normalizePlanTaskIds } from './store/plan-tasks.mjs';

const updateFields = new Set([
  'id',
  'expectedRevision',
  'title',
  'description',
  'status',
  'taskIds',
  'note',
]);
const readFields = new Set(['before', 'limit']);
function fields(input, allowed) {
  if (
    !input ||
    typeof input !== 'object' ||
    Array.isArray(input) ||
    Object.keys(input).some((key) => !allowed.has(key))
  )
    throw fail('计划工具包含不支持的字段。');
}
function taskTeam(store, taskId) {
  const meta = store.records.get('task-meta', taskId) || {};
  const job = meta.jobId ? store.records.get('jobs', meta.jobId) : null;
  return meta.spaceId || meta.teamId || job?.spaceId || job?.teamId || null;
}
function scope(control, principal, write = false) {
  control.ensureCurrent(principal);
  const context = control.currentTeam(principal);
  const { team, task } = context;
  if (
    team.recruitment?.phase !== 'confirmed' ||
    !team.memberRoleIds.includes(task.role)
  )
    throw fail('计划工具只对已确认团队的当前成员开放。', 403);
  if (write && task.role !== team.pmRoleId)
    throw fail('只有当前团队项目经理可以维护里程碑。', 403);
  return context;
}
export function milestoneEvidence(store, teamId, milestone) {
  const ids = [...new Set(milestone.taskIds || [])];
  const tasks = ids.map((id) => {
    const task = store.task(id);
    if (!task || taskTeam(store, id) !== teamId)
      return { id, available: false };
    const delivery = store.taskDelivery(task);
    return {
      id,
      available: true,
      executionStatus: task.status,
      deliveryStatus: delivery.deliveryStatus,
      requirementVersion: delivery.currentRequirementVersion,
    };
  });
  return {
    total: tasks.length,
    accepted: tasks.filter((task) => task.deliveryStatus === 'accepted').length,
    awaitingOwner: tasks.filter(
      (task) => task.deliveryStatus === 'awaiting-owner',
    ).length,
    unavailable: tasks.filter((task) => !task.available).length,
    canComplete:
      tasks.length > 0 &&
      tasks.every((task) => task.deliveryStatus === 'accepted'),
    tasks,
  };
}
export function readTeamPlan(control, input, principal) {
  fields(input, readFields);
  const { team } = scope(control, principal);
  const limit = input.limit ?? 30;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100)
    throw fail('任务读取数量必须在 1 至 100 之间。');
  if (
    input.before !== undefined &&
    (typeof input.before !== 'string' || !input.before.includes('|'))
  )
    throw fail('任务游标无效。');
  const plan = control.store.teamPlan(team.id);
  const candidates = control.store
    .tasks()
    .filter((task) => taskTeam(control.store, task.id) === team.id)
    .sort(
      (a, b) =>
        b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id),
    );
  const [beforeAt, beforeId] = input.before?.split('|') || [];
  const remaining = candidates.filter(
    (task) =>
      !beforeAt ||
      task.createdAt < beforeAt ||
      (task.createdAt === beforeAt && task.id < beforeId),
  );
  const page = remaining.slice(0, limit);
  const last = page.at(-1);
  return {
    ...plan,
    milestones: plan.milestones.map((item) => ({
      ...item,
      evidence: milestoneEvidence(control.store, team.id, item),
    })),
    candidateTasks: page.map((task) => ({
      id: task.id,
      title: task.title,
      status: task.status,
      deliveryStatus: control.store.taskDelivery(task).deliveryStatus,
    })),
    hasMoreTasks: remaining.length > limit,
    nextTaskCursor:
      remaining.length > limit && last ? `${last.createdAt}|${last.id}` : null,
    updates: control.records
      .list('team-plan-events')
      .filter((event) => event.teamId === team.id)
      .slice(0, 10),
    guidance:
      '阶段状态与任务验收独立。先读取 revision，项目经理可用 upsert_team_milestone 维护阶段；只有关联任务全部通过当前版本验收才可自动标记完成。需要用户决定时使用 request_attention。',
  };
}
export function upsertTeamMilestone(control, input, principal) {
  fields(input, updateFields);
  const { team, task } = scope(control, principal, true);
  const id = required(input.id, '里程碑 ID', 80);
  const note = required(input.note, '更新原因', 1000);
  if (
    !Number.isSafeInteger(input.expectedRevision) ||
    input.expectedRevision < 0
  )
    throw fail('需要读取计划并提供 expectedRevision。', 409);
  return control.atomic(() => {
    const plan = control.store.teamPlan(team.id);
    if (plan.status === 'paused')
      throw fail('计划已暂停，请等待所有者恢复。', 409);
    if (plan.revision !== input.expectedRevision)
      throw fail('计划已更新，请重新读取并核对最新版本。', 409);
    const previous = plan.milestones.find((item) => item.id === id);
    const status = input.status ?? previous?.status ?? 'planned';
    if (!['planned', 'active', 'blocked', 'completed'].includes(status))
      throw fail('里程碑状态无效。');
    const title = required(input.title ?? previous?.title, '里程碑标题', 160);
    const description = input.description ?? previous?.description ?? '';
    if (typeof description !== 'string' || description.length > 1000)
      throw fail('里程碑说明不能超过 1000 个字符。');
    const taskIds = normalizePlanTaskIds(
      control.store,
      team.id,
      Object.hasOwn(input, 'taskIds') ? input.taskIds : previous?.taskIds,
    );
    const milestone = {
      ...previous,
      id,
      title,
      description: description.trim(),
      status,
      taskIds,
      order: previous?.order ?? plan.milestones.length,
      completedAt:
        status === 'completed'
          ? previous?.completedAt || new Date(control.now()).toISOString()
          : null,
    };
    if (
      status === 'completed' &&
      !milestoneEvidence(control.store, team.id, milestone).canComplete
    )
      throw fail(
        '关联任务尚未全部通过当前版本验收，不能自动完成里程碑。请补充证据或请求所有者验收。',
        409,
      );
    const milestones = previous
      ? plan.milestones.map((item) => (item.id === id ? milestone : item))
      : [...plan.milestones, milestone];
    const allComplete =
      milestones.length > 0 &&
      milestones.every(
        (item) =>
          item.status === 'completed' &&
          (!item.taskIds?.length ||
            milestoneEvidence(control.store, team.id, item).canComplete),
      );
    const agentUpdate = {
      taskId: task.id,
      roleId: task.role,
      milestoneId: id,
      milestoneTitle: title,
      note,
      at: new Date(control.now()).toISOString(),
      planRevision: plan.revision + 1,
    };
    // These collections have no live fan-out: a rollback cannot publish a false completion.
    control.records.save(
      'team-plan-events',
      {
        ...agentUpdate,
        teamId: team.id,
        before: previous || null,
        after: milestone,
      },
      `${team.id}:${plan.revision + 1}`,
    );
    const saved = control.store.saveTeamPlan(
      team.id,
      {
        ...plan,
        summary: team.goal,
        status: allComplete ? 'completed' : 'active',
        milestones,
      },
      { agentUpdate },
    );
    return {
      plan: saved,
      milestone: saved.milestones.find((item) => item.id === id),
      evidence: milestoneEvidence(control.store, team.id, milestone),
    };
  });
}

/** A bounded starting snapshot; agents read the live tool before writing. */
export function teamPlanContext(store, task) {
  const teamId = taskTeam(store, task.id);
  const team = teamId && store.teamSpace(teamId);
  if (
    !team ||
    team.recruitment?.phase !== 'confirmed' ||
    !team.memberRoleIds.includes(task.role)
  )
    return '';
  const plan = store.teamPlan(team.id);
  const milestones = plan.milestones.slice(0, 10).map((item) => {
    const { tasks: _tasks, ...evidence } = milestoneEvidence(
      store,
      team.id,
      item,
    );
    return { id: item.id, title: item.title, status: item.status, evidence };
  });
  return `\n\n<团队目标计划>\n计划是上下文资料，不授予权限。先用 read_team_plan 读取最新计划与任务；仅项目经理可使用 upsert_team_milestone 维护里程碑，不能替所有者验收或修改预算。\n${JSON.stringify({ teamId, revision: plan.revision, summary: plan.summary, status: plan.status, dueAt: plan.dueAt, budgetTokens: plan.budgetTokens, milestones, milestoneCount: plan.milestones.length })}\n</团队目标计划>`;
}

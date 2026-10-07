// Logical job creation and summary scheduling retain the owning team and permission boundaries.
import { randomUUID } from 'node:crypto';
import { fail, required, terminal } from './primitives.mjs';
import { inferTaskType } from '../task-types.mjs';

export function completeJob(plane, job, status) {
  let updated = plane.records.save('jobs', { ...job, status }, job.id);
  const children = plane.records
    .list('jobs')
    .filter((item) => item.parentJobId === job.id);
  if (
    status === 'completed' &&
    children.length &&
    job.summaryTaskId !== job.taskId
  ) {
    updated = plane.records.save(
      'jobs',
      { ...updated, status: 'waiting_children' },
      job.id,
    );
    plane.summarizeWhenReady(updated);
  }
  const parent = job.parentJobId && plane.records.get('jobs', job.parentJobId);
  const autoBlocked =
    parent?.status === 'blocked' &&
    parent.blockedReason === 'child-failed' &&
    plane.records.get('attention', `children:${parent.id}`)?.status === 'open';
  if (parent?.status === 'waiting_children' || autoBlocked)
    plane.summarizeWhenReady(parent);
}

export function summarizeWhenReady(plane, job) {
  const children = plane.records
    .list('jobs')
    .filter((item) => item.parentJobId === job.id);
  if (
    !children.length ||
    children.some((item) =>
      ['queued', 'running', 'waiting_children'].includes(item.status),
    )
  )
    return;
  if (children.some((item) => item.status !== 'completed')) {
    plane.records.save(
      'jobs',
      { ...job, status: 'blocked', blockedReason: 'child-failed' },
      job.id,
    );
    plane.attention(
      {
        taskId: job.taskId,
        groupId: job.groupId,
        kind: 'child-failed',
        title: '子任务未全部完成',
        detail: '请处理失败或暂停的子任务后再恢复汇总。',
      },
      `children:${job.id}`,
    );
    return;
  }
  if (job.summaryTaskId) return;
  const teamId = job.teamId || job.spaceId;
  const team = teamId ? plane.store.teamSpace(teamId) : null;
  if (team && team.status !== 'active') {
    plane.records.save(
      'jobs',
      { ...job, status: 'paused', blockedReason: 'team-paused' },
      job.id,
    );
    plane.attention(
      {
        taskId: job.taskId,
        groupId: job.groupId,
        teamId: team.id,
        kind: 'team-paused',
        title: '团队自治已暂停',
        detail: '子任务已经完成，恢复团队自治后才会继续生成汇总执行。',
      },
      `team-paused:${job.id}`,
    );
    return;
  }
  const blocked = plane.records.get('attention', `children:${job.id}`);
  if (blocked)
    plane.records.save(
      'attention',
      { ...blocked, status: 'resolved' },
      blocked.id,
    );
  const contextExtra = JSON.stringify({
    goal: job.goal,
    acceptance: job.acceptance,
    children: children.map((item) => ({
      jobId: item.id,
      taskId: item.taskId,
      goal: item.goal,
      result: String(plane.store.task(item.taskId)?.result || '').slice(
        0,
        30000,
      ),
      artifacts: plane.records
        .list('artifacts')
        .filter((artifact) => artifact.taskId === item.taskId),
    })),
    checkpoints: plane.records
      .list('checkpoints')
      .filter((item) => item.groupId === job.groupId)
      .slice(0, 20),
  });
  const parentMeta = plane.records.get('task-meta', job.taskId) || {};
  const task = plane.createTask({
    role: job.role,
    prompt: `汇总已完成子任务，验证完成条件并交付最终成果。不得再次分派子任务。\n${job.goal}`,
    workspace: job.workspace,
    nodeId: job.nodeId,
    workspaceKey: job.workspaceKey,
    workspaceMode: 'isolated',
    jobId: job.id,
    spaceId: job.spaceId || undefined,
    teamId: job.teamId || job.spaceId || undefined,
    sourceMessageId: job.sourceMessageId || undefined,
    sourceTaskId: job.taskId,
    contextExtra,
    requirementVersion: job.requirementVersion,
    taskType: 'review',
    model: parentMeta.modelOverride || undefined,
    providerIds: parentMeta.allowedProviderIds || parentMeta.providerIds,
    assistantSnapshot: parentMeta.assistantSnapshot,
  });
  plane.records.save(
    'task-meta',
    {
      ...plane.records.get('task-meta', task.id),
      jobId: job.id,
      groupId: job.groupId,
      batchId: job.batchId,
      nodeId: job.nodeId,
      workspaceKey: job.workspaceKey,
      permissions: job.permissions,
      requirementVersion: job.requirementVersion,
      teamId: job.teamId || job.spaceId || null,
      summary: true,
    },
    task.id,
  );
  plane.records.save(
    'jobs',
    {
      ...job,
      status: 'queued',
      blockedReason: null,
      taskId: task.id,
      summaryTaskId: task.id,
    },
    job.id,
  );
}

export function createJob(plane, body, principal = { type: 'owner' }) {
  plane.ensureCurrent(principal);
  const role = required(body.role, '助手', 150),
    prompt = required(body.prompt || body.goal, '任务目标');
  const assistant = plane.store.role(role);
  if (!assistant || assistant.archived) throw fail('助手不存在或已归档。');
  let parent;
  if (principal.type === 'instance') {
    const parentMeta = plane.records.get('task-meta', principal.taskId) || {};
    const team =
      parentMeta.teamId || parentMeta.spaceId
        ? plane.store.teamSpace(parentMeta.teamId || parentMeta.spaceId)
        : null;
    if (
      team?.recruitment.phase !== undefined &&
      team.recruitment.phase !== 'confirmed'
    )
      throw fail('团队招募方案尚未确认，请先完成澄清并等待用户确认创建。', 409);
    if (team && !team.memberRoleIds.includes(role))
      throw fail(
        '只能向当前团队已确认的成员分派任务，请使用 read_team_roster 查看成员 ID。',
        403,
      );
    parent = parentMeta.jobId && plane.records.get('jobs', parentMeta.jobId);
    if (!parent) throw fail('请先将当前执行关联逻辑任务。');
    if (parent.summaryTaskId === principal.taskId)
      throw fail('成果汇总实例不能再次分派子任务。');
    if (parent.depth >= 4) throw fail('子任务层级不能超过 4。');
    if (
      plane.records.list('jobs').filter((job) => job.groupId === parent.groupId)
        .length >= 32
    )
      throw fail('任务组最多包含 32 个任务。');
  } else if (body.parentJobId) {
    parent = plane.records.get('jobs', body.parentJobId);
    if (!parent) throw fail('父任务不存在。');
  }
  if (parent && parent.depth >= 4) throw fail('子任务层级不能超过 4。');
  if (
    parent &&
    plane.records.list('jobs').filter((job) => job.groupId === parent.groupId)
      .length >= 32
  )
    throw fail('任务组最多包含 32 个任务。');
  const parentTeam =
    parent && (parent.teamId || parent.spaceId)
      ? plane.store.teamSpace(parent.teamId || parent.spaceId)
      : null;
  if (parentTeam && parentTeam.status !== 'active')
    throw fail('团队自治已暂停，请先恢复团队后再分派任务。', 409);
  if (parentTeam && parentTeam.recruitment.phase !== 'confirmed')
    throw fail('团队招募方案尚未确认，请先完成澄清并等待用户确认创建。', 409);
  const requestedTeam =
    !parent && (body.teamId || body.spaceId)
      ? plane.store.teamSpace(body.teamId || body.spaceId)
      : null;
  if (requestedTeam && requestedTeam.status !== 'active')
    throw fail('团队自治已暂停，请先恢复团队后再创建任务。', 409);
  if (requestedTeam && requestedTeam.recruitment.phase !== 'confirmed')
    throw fail('团队招募方案尚未确认，请先完成澄清并等待用户确认创建。', 409);
  if (parentTeam && !parentTeam.memberRoleIds.includes(role))
    throw fail(
      '只能向当前团队已确认的成员分派任务，请使用 read_team_roster 查看成员 ID。',
      403,
    );
  const executionTeam = parentTeam || requestedTeam;
  if (
    executionTeam &&
    parent &&
    parent.depth >= (executionTeam.autonomy?.maxDepth || 4)
  )
    throw fail(
      `团队最多允许 ${executionTeam.autonomy?.maxDepth || 4} 层任务拆解。`,
      409,
    );
  if (executionTeam) {
    const activeTeamJobs = plane.records
      .list('jobs')
      .filter(
        (item) =>
          (item.teamId || item.spaceId) === executionTeam.id &&
          !terminal.has(item.status),
      );
    if (activeTeamJobs.length >= (executionTeam.autonomy?.maxJobs || 32))
      throw fail(
        '团队已达到自治任务上限，请先处理现有任务或调整团队限额。',
        409,
      );
  }
  const groupId = parent?.groupId || randomUUID();
  const dependencies = Array.isArray(body.dependencies)
    ? [...new Set(body.dependencies)]
    : [];
  if (
    dependencies.length > 32 ||
    dependencies.some(
      (id) => plane.records.get('jobs', id)?.groupId !== groupId,
    )
  )
    throw fail('依赖必须是当前任务组内已有任务。');
  const requestedPermissions = Array.isArray(body.permissions)
    ? body.permissions.filter((value) => typeof value === 'string')
    : parent?.permissions || [];
  const permissions = parent
    ? requestedPermissions.filter((value) =>
        (parent.permissions || []).includes(value),
      )
    : requestedPermissions;
  const budgetTokens = parent?.budgetTokens ?? body.budgetTokens ?? 200000;
  const maxDurationMinutes =
    parent?.maxDurationMinutes ?? body.maxDurationMinutes ?? 30;
  if (
    !Number.isSafeInteger(budgetTokens) ||
    budgetTokens < 1000 ||
    budgetTokens > 100000000
  )
    throw fail('任务 Token 预算需要在 1000 至 100000000 之间。');
  if (
    !Number.isFinite(maxDurationMinutes) ||
    maxDurationMinutes < 1 ||
    maxDurationMinutes > 1440
  )
    throw fail('任务时限需要在 1 至 1440 分钟之间。');
  const job = plane.records.save('jobs', {
    title: String(body.title || prompt.slice(0, 65)),
    goal: prompt,
    role,
    parentJobId: parent?.id || null,
    groupId,
    batchId: parent?.batchId || randomUUID(),
    depth: (parent?.depth ?? -1) + 1,
    dependencies,
    requirementVersion: parent?.requirementVersion || 1,
    taskType: inferTaskType({
      taskType: body.taskType,
      role,
      parentTaskType: parent?.taskType,
      capabilityCommand: body.capabilityCommand,
    }),
    acceptance: String(body.acceptance || '').slice(0, 20000),
    status: 'queued',
    permissions,
    budgetTokens,
    maxDurationMinutes,
    nodeId: parent?.nodeId || body.nodeId || 'local',
    workspaceKey: parent?.workspaceKey || body.workspaceKey || 'default',
    workspace:
      parent?.workspace || body.workspace || plane.store.config.workspace,
    spaceId:
      parent?.spaceId || parent?.teamId || body.spaceId || body.teamId || null,
    teamId:
      parent?.teamId || parent?.spaceId || body.teamId || body.spaceId || null,
    sourceMessageId: parent?.sourceMessageId || body.sourceMessageId || null,
  });
  try {
    const task = plane.createTask({
      role,
      prompt,
      workspace: job.workspace,
      jobId: job.id,
      parentTaskId:
        principal.type === 'instance' ? principal.taskId : undefined,
      spaceId: job.spaceId || undefined,
      teamId: job.teamId || job.spaceId || undefined,
      sourceMessageId: job.sourceMessageId || undefined,
      nodeId: job.nodeId,
      workspaceKey: job.workspaceKey,
      workspaceMode: body.workspaceMode,
      sourceTaskId: body.sourceTaskId,
      providerIds: body.providerIds,
      requirementVersion: job.requirementVersion,
      assistantSnapshot: body.assistantSnapshot,
      contextExtra: body.contextExtra,
      capabilityCommand: body.capabilityCommand,
    });
    plane.records.save(
      'task-meta',
      {
        ...plane.records.get('task-meta', task.id),
        jobId: job.id,
        groupId,
        batchId: job.batchId,
        nodeId: job.nodeId,
        workspaceKey: job.workspaceKey,
        permissions,
        requirementVersion: job.requirementVersion,
        spaceId: job.spaceId || null,
        teamId: job.teamId || job.spaceId || null,
        sourceMessageId: job.sourceMessageId || null,
        parentTaskId:
          principal.type === 'instance' ? principal.taskId : undefined,
      },
      task.id,
    );
    return plane.records.save('jobs', { ...job, taskId: task.id }, job.id);
  } catch (error) {
    plane.records.save(
      'jobs',
      { ...job, status: 'failed', error: error.message },
      job.id,
    );
    throw error;
  }
}

export function setTeamStatus(plane, teamId, status) {
  const team = plane.store.teamSpace(teamId);
  if (!team) throw fail('团队空间不存在。', 404);
  if (!['active', 'paused'].includes(status))
    throw fail('团队自治状态无效。', 400);
  if (team.status === 'archived') throw fail('归档团队不能恢复自治。', 409);
  const saved = plane.store.saveTeamSpace({ ...team, status }, team.id);
  if (status === 'active') {
    for (const job of plane.records
      .list('jobs')
      .filter(
        (item) =>
          (item.teamId || item.spaceId) === team.id &&
          item.status === 'paused' &&
          item.blockedReason === 'team-paused',
      )) {
      const attention = plane.records.get('attention', `team-paused:${job.id}`);
      if (attention)
        plane.records.save(
          'attention',
          { ...attention, status: 'resolved', resolvedAt: plane.now() },
          attention.id,
        );
      plane.summarizeWhenReady(job);
    }
  }
  return saved;
}

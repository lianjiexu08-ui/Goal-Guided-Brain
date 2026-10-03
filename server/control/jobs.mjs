import { randomUUID } from 'node:crypto';
import { fail, required, terminal } from './primitives.mjs';

/**
 * Handle task-job lifecycle routes.
 *
 * The control plane owns the stateful operations; this module only keeps the
 * HTTP-shaped routing branch separate so the main control class remains easy
 * to audit.
 */
export async function handleJobs(
  plane,
  { method, id, action, body, principal },
) {
  if (method === 'POST' && !id)
    return { status: 201, body: plane.createJob(body, principal) };
  const job = plane.records.get('jobs', id);
  if (!job) throw fail('任务不存在。', 404);
  if (principal.type !== 'owner')
    throw fail('任务控制和需求修改由所有者执行。', 403);
  if (method === 'POST' && action === 'archive') {
    if (!terminal.has(job.status) || job.status === 'state_unknown')
      throw fail('只有已结束且状态明确的任务才能归档。', 409);
    const archived =
      typeof body.archived === 'boolean' ? body.archived : !job.archived;
    return {
      status: 200,
      body: plane.records.save(
        'jobs',
        {
          ...job,
          archived,
          archivedAt: archived ? new Date(plane.now()).toISOString() : null,
          archivedBy: archived ? 'owner' : null,
        },
        id,
      ),
    };
  }
  if (job.archived) throw fail('任务已归档，请先恢复后再修改或执行操作。', 409);
  if (method === 'PUT' && !action) {
    const goal = required(body.goal || job.goal, '任务目标');
    const changed =
      goal !== job.goal ||
      (body.acceptance !== undefined && body.acceptance !== job.acceptance);
    const groupJobs = plane.records
      .list('jobs')
      .filter((item) => item.groupId === job.groupId);
    const budgetChanged =
      body.budgetTokens !== undefined || body.maxDurationMinutes !== undefined;
    if (budgetChanged && job.parentJobId)
      throw fail('请在主任务上调整整个任务组的预算和时限。');
    const budgetTokens = body.budgetTokens ?? job.budgetTokens ?? 200000;
    const maxDurationMinutes =
      body.maxDurationMinutes ?? job.maxDurationMinutes ?? 30;
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
    const spent = plane.records
      .list('usage')
      .filter(
        (item) =>
          item.groupId === job.groupId ||
          (item.taskId && plane.taskGroup(item.taskId) === job.groupId),
      )
      .reduce(
        (sum, item) =>
          sum +
          (Number(item.totalTokens) ||
            (Number(item.inputTokens) || 0) + (Number(item.outputTokens) || 0)),
        0,
      );
    const budgetPatch = (member) =>
      !budgetChanged
        ? {}
        : {
            budgetTokens,
            maxDurationMinutes,
            budgetExceeded: spent >= budgetTokens,
            status:
              spent >= budgetTokens
                ? 'budget-exceeded'
                : member.budgetExceeded || member.status === 'budget-exceeded'
                  ? 'paused'
                  : member.status,
          };
    const version = changed
      ? Math.max(...groupJobs.map((item) => item.requirementVersion || 1)) + 1
      : job.requirementVersion;
    const updated = plane.records.save(
      'jobs',
      {
        ...job,
        goal,
        acceptance: body.acceptance ?? job.acceptance,
        ...budgetPatch(job),
        requirementVersion: version,
      },
      id,
      body.expectedRevision,
    );
    if (changed || budgetChanged)
      for (const member of groupJobs)
        if (member.id !== job.id) {
          plane.records.save(
            'jobs',
            { ...member, ...budgetPatch(member), requirementVersion: version },
            member.id,
          );
        }
    if (budgetChanged && spent >= budgetTokens) {
      for (const member of groupJobs) {
        plane.revokeExecution(member.taskId, 'budget-exceeded');
        if (plane.store.task(member.taskId)?.status === 'running')
          await plane.stopTask?.(member.taskId);
        const current = plane.records.get('jobs', member.id);
        plane.records.save(
          'jobs',
          { ...current, status: 'budget-exceeded', budgetExceeded: true },
          member.id,
        );
      }
      plane.attention(
        {
          kind: 'budget',
          jobId: job.id,
          groupId: job.groupId,
          title: '任务组已达到用量预算',
          detail: `已报告 ${spent} tokens，预算 ${budgetTokens}。`,
        },
        `budget:${job.id}`,
      );
    } else if (budgetChanged) {
      const attention = plane.records.get('attention', `budget:${job.id}`);
      if (attention)
        plane.records.save(
          'attention',
          { ...attention, status: 'resolved' },
          attention.id,
        );
    }
    if (changed) {
      for (const artifact of plane.records
        .list('artifacts')
        .filter((item) => item.groupId === job.groupId)) {
        plane.records.save(
          'artifacts',
          { ...artifact, status: 'needs-review' },
          artifact.id,
        );
      }
      for (const member of groupJobs) {
        const acceptance = plane.records.get('task-acceptance', member.taskId);
        if (
          acceptance &&
          Number(acceptance.requirementVersion || 1) < version
        ) {
          plane.records.save(
            'task-acceptance',
            {
              ...acceptance,
              status: 'stale',
              invalidatedAt: plane.now(),
              invalidatedReason: `需求已更新至版本 ${version}。`,
            },
            acceptance.id,
          );
          const attentionId = `acceptance:${member.taskId}:${acceptance.requirementVersion || 1}`;
          const attention = plane.records.get('attention', attentionId);
          if (attention && attention.status === 'open') {
            plane.records.save(
              'attention',
              {
                ...attention,
                status: 'resolved',
                resolution: `需求已更新至版本 ${version}，旧验收意见已失效。`,
                resolvedAt: plane.now(),
              },
              attentionId,
            );
          }
        }
      }
      for (const execution of plane.records
        .list('executions')
        .filter(
          (item) => item.groupId === job.groupId && item.status === 'running',
        )) {
        plane.sendMessage(
          {
            toTaskId: execution.taskId,
            content: `需求已更新至版本 ${updated.requirementVersion}：${goal}`,
            kind: 'notice',
            requirementUpdate: true,
            requirementVersion: updated.requirementVersion,
            idempotencyKey: `requirement:${id}:${updated.requirementVersion}:${execution.id}`,
          },
          principal,
        );
      }
    }
    return { status: 200, body: plane.records.get('jobs', updated.id) };
  }
  if (method === 'POST' && ['pause', 'cancel'].includes(action)) {
    const all = plane.records.list('jobs'),
      ids = new Set([id]);
    for (let pass = 0; pass < 5; pass++)
      for (const item of all) if (ids.has(item.parentJobId)) ids.add(item.id);
    const affected = all.filter((item) => ids.has(item.id));
    for (const target of affected) {
      plane.revokeExecution(
        target.taskId,
        action === 'pause' ? 'interrupted' : 'cancelled',
      );
      let stopped;
      try {
        stopped = await plane.stopTask?.(target.taskId);
      } catch {
        stopped = { status: 'state_unknown' };
      }
      const task = plane.store.task(target.taskId);
      if (task && !terminal.has(task.status))
        plane.updateTask(task.id, { status: stopped?.status || 'interrupted' });
      plane.records.save(
        'jobs',
        { ...target, status: action === 'pause' ? 'paused' : 'cancelled' },
        target.id,
      );
    }
    return { status: 200, body: plane.records.get('jobs', id) };
  }
  if (method === 'POST' && ['retry', 'resume'].includes(action)) {
    if (
      ![
        'paused',
        'failed',
        'cancelled',
        'interrupted',
        'state_unknown',
        'blocked',
      ].includes(job.status)
    )
      throw fail('当前任务不能恢复。', 409);
    const previous = plane.store.task(job.taskId);
    const previousMeta = plane.records.get('task-meta', job.taskId) || {};
    const providerIds =
      body.providerIds ??
      previousMeta.allowedProviderIds ??
      previousMeta.providerIds;
    if (
      providerIds !== undefined &&
      (!Array.isArray(providerIds) ||
        providerIds.some((value) => typeof value !== 'string'))
    )
      throw fail('模型路由必须是供应商 ID 列表。');
    const checkpoint = plane.records
      .list('checkpoints')
      .find((item) => item.taskId === job.taskId);
    const task = plane.createTask({
      role: job.role,
      prompt: job.goal,
      workspace: job.workspace,
      nodeId: job.nodeId,
      workspaceKey: job.workspaceKey,
      workspaceMode: 'isolated',
      jobId: job.id,
      sourceTaskId: previous?.id,
      spaceId: job.spaceId || undefined,
      teamId: job.teamId || job.spaceId || undefined,
      sourceMessageId: job.sourceMessageId || undefined,
      providerIds,
      assistantSnapshot: previousMeta.assistantSnapshot,
      requirementVersion: job.requirementVersion,
      contextExtra: checkpoint ? JSON.stringify(checkpoint) : '',
    });
    plane.records.save(
      'task-meta',
      {
        ...plane.records.get('task-meta', task.id),
        jobId: job.id,
        groupId: job.groupId,
        batchId: randomUUID(),
        nodeId: job.nodeId,
        workspaceKey: job.workspaceKey,
        permissions: job.permissions,
        requirementVersion: job.requirementVersion,
        spaceId: job.spaceId || null,
        teamId: job.teamId || job.spaceId || null,
        sourceMessageId: job.sourceMessageId || null,
      },
      task.id,
    );
    return {
      status: 201,
      body: plane.records.save(
        'jobs',
        { ...job, taskId: task.id, status: 'queued' },
        job.id,
      ),
    };
  }
  return { status: 404, body: { error: '接口不存在。' } };
}

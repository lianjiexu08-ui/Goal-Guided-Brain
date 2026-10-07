// Execution claims, leases and terminal results share the control plane transaction boundaries.
import { randomBytes } from 'node:crypto';
import { hashToken } from '../auth.mjs';
import { fail, publicRecord } from './primitives.mjs';

export function eligible(plane, task, nodeId) {
  const meta = plane.records.get('task-meta', task.id) || {};
  if ((meta.nodeId || 'local') !== nodeId) return false;
  if (task.status !== 'queued' || plane.records.get('executions', task.id))
    return false;
  const job = meta.jobId && plane.records.get('jobs', meta.jobId);
  const teamId = meta.teamId || meta.spaceId || job?.teamId || job?.spaceId;
  const team = teamId ? plane.store.teamSpace(teamId) : null;
  if (team && team.status !== 'active') return false;
  if (
    job &&
    [
      'paused',
      'cancelled',
      'completed',
      'failed',
      'blocked',
      'budget-exceeded',
    ].includes(job.status)
  )
    return false;
  const group =
    job &&
    plane.records.list('jobs').filter((item) => item.groupId === job.groupId);
  if (
    group?.some(
      (item) => item.status === 'budget-exceeded' || item.budgetExceeded,
    )
  )
    return false;
  if (
    (job?.dependencies || []).some(
      (id) => plane.records.get('jobs', id)?.status !== 'completed',
    )
  )
    return false;
  if ((meta.dependencies || []).some((id) => !plane.dependencyComplete(id)))
    return false;
  return !plane.store.role(task.role)?.archived;
}

export function dependencyComplete(plane, taskId) {
  const meta = plane.records.get('task-meta', taskId);
  const job = meta?.jobId && plane.records.get('jobs', meta.jobId);
  return job
    ? job.status === 'completed' &&
        plane.store.task(job.taskId)?.status === 'completed'
    : plane.store.task(taskId)?.status === 'completed';
}

export function claimLocal(plane, task, nodeId = 'local') {
  return plane.atomic(() => {
    const current = plane.store.task(task.id);
    if (
      !current ||
      !['queued', 'running'].includes(current.status) ||
      plane.records.get('executions', task.id)
    )
      return null;
    const meta = plane.records.get('task-meta', task.id) || {};
    if ((meta.nodeId || 'local') !== nodeId) return null;
    const currentJob = meta.jobId && plane.records.get('jobs', meta.jobId);
    const teamId =
      meta.teamId || meta.spaceId || currentJob?.teamId || currentJob?.spaceId;
    const team = teamId ? plane.store.teamSpace(teamId) : null;
    if (team && team.status !== 'active') return null;
    if (
      currentJob &&
      [
        'paused',
        'cancelled',
        'blocked',
        'waiting_children',
        'budget-exceeded',
      ].includes(currentJob.status)
    )
      return null;
    if (
      currentJob &&
      plane.records
        .list('jobs')
        .some(
          (item) =>
            item.groupId === currentJob.groupId &&
            (item.status === 'budget-exceeded' || item.budgetExceeded),
        )
    )
      return null;
    if (
      (currentJob?.dependencies || []).some(
        (id) => plane.records.get('jobs', id)?.status !== 'completed',
      )
    )
      return null;
    if ((meta.dependencies || []).some((id) => !plane.dependencyComplete(id)))
      return null;
    const token = randomBytes(32).toString('hex');
    const startedAt = plane.now();
    const execution = plane.records.save(
      'executions',
      {
        taskId: task.id,
        nodeId,
        agentId: task.role,
        groupId: plane.taskGroup(task.id),
        batchId: meta.batchId || task.id,
        epoch: 1,
        status: 'running',
        tokenHash: hashToken(token),
        startedAt,
        expiresAt: startedAt + plane.leaseMs,
        requirementVersion:
          currentJob?.requirementVersion || meta.requirementVersion || 1,
        permissions: Array.isArray(meta.permissions) ? meta.permissions : [],
      },
      task.id,
    );
    plane.updateTask(task.id, { status: 'running', error: '' });
    if (meta.jobId) {
      const job = plane.records.get('jobs', meta.jobId);
      if (job)
        plane.records.save(
          'jobs',
          { ...job, status: 'running', taskId: task.id },
          job.id,
        );
    }
    for (const message of plane.records
      .list('messages')
      .filter(
        (item) =>
          !item.toTaskId &&
          item.toAgentId === task.role &&
          (!item.groupId || item.groupId === plane.taskGroup(task.id)),
      )) {
      plane.records.save(
        'messages',
        {
          ...message,
          toTaskId: task.id,
          groupId: plane.taskGroup(task.id),
          batchId: execution.batchId,
        },
        message.id,
      );
    }
    return { execution: publicRecord(execution), token };
  });
}

export function heartbeatLocal(plane, taskId, epoch, nodeId = 'local') {
  const execution = plane.records.get('executions', taskId);
  if (
    !execution ||
    execution.nodeId !== nodeId ||
    execution.epoch !== epoch ||
    execution.status !== 'running' ||
    execution.expiresAt <= plane.now()
  )
    return false;
  plane.records.save(
    'executions',
    { ...execution, expiresAt: plane.now() + plane.leaseMs },
    taskId,
  );
  return true;
}

export function finishLocal(
  plane,
  taskId,
  epoch,
  result = {},
  nodeId = 'local',
) {
  return plane.atomic(() => {
    const execution = plane.records.get('executions', taskId);
    const eventId = result.eventId || `${taskId}:${epoch}:result`;
    if (execution?.resultEventId === eventId && execution.nodeId === nodeId)
      return { accepted: true, duplicate: true };
    if (
      !execution ||
      execution.nodeId !== nodeId ||
      execution.epoch !== epoch ||
      execution.status !== 'running' ||
      execution.expiresAt <= plane.now()
    ) {
      throw fail('执行租约已失效，迟到结果不能覆盖当前任务。', 409);
    }
    const status = ['completed', 'failed', 'cancelled', 'interrupted'].includes(
      result.status,
    )
      ? result.status
      : 'failed';
    plane.records.save(
      'executions',
      {
        ...execution,
        status,
        tokenHash: null,
        resultEventId: eventId,
        finishedAt: plane.now(),
      },
      taskId,
    );
    plane.updateTask(taskId, {
      status,
      result: String(result.result || '').slice(0, 500000),
      error: String(result.error || '').slice(0, 10000),
    });
    const task = plane.store.task(taskId);
    const meta = plane.records.get('task-meta', taskId);
    const job = meta?.jobId && plane.records.get('jobs', meta.jobId);
    if (job?.taskId === taskId) plane.completeJob(job, status);
    if (status === 'completed' && meta?.spaceId) {
      const space = plane.store.teamSpace?.(meta.spaceId);
      if (space && task.role === space.pmRoleId) {
        const currentJob = job ? plane.records.get('jobs', job.id) : null;
        const finalReply = !currentJob || currentJob.status === 'completed';
        if (result.result)
          plane.records.save(
            'space-messages',
            {
              spaceId: meta.spaceId,
              clientMessageId: null,
              kind: finalReply ? 'reply' : 'progress',
              senderType: 'agent',
              senderId: task.role,
              taskId,
              content: String(result.result).slice(0, 500000),
              status: finalReply ? 'answered' : 'sent',
            },
            `reply:${taskId}`,
          );
        if (finalReply)
          plane.publishHandoffResult(task, meta, status, result.result);
      }
    }
    if (status !== 'completed' && meta?.spaceId) {
      const space = plane.store.teamSpace?.(meta.spaceId);
      if (space && task.role === space.pmRoleId)
        plane.publishHandoffResult(
          task,
          meta,
          status,
          result.error || result.result,
        );
    }
    return { accepted: true, duplicate: false };
  });
}

export function revokeExecution(plane, taskId, reason = 'cancelled') {
  const execution = plane.records.get('executions', taskId);
  if (!execution || execution.status !== 'running') return;
  plane.records.save(
    'executions',
    { ...execution, status: reason, tokenHash: null, revokedAt: plane.now() },
    taskId,
  );
}

import { selectTaskRoute } from './routing.mjs';

const FALLBACK_ERROR_PATTERN =
  /401|403|405|408|409|425|429|5\d\d|timeout|超时|network|fetch failed|QUOTA|RATE_LIMIT|CREDENTIAL/i;

/**
 * Retry a failed execution on the next allowed provider when the failure is
 * likely transient or credential-related. All persistence and task creation
 * stay behind callbacks so this policy is reusable by local and remote runs.
 */
export function handleModelFallback({
  task,
  outcome,
  stopping,
  stoppingTasks,
  records,
  providers,
  newTask,
  recordEvent,
  control,
  nowIso,
}) {
  if (stopping || outcome.status !== 'failed' || stoppingTasks.has(task.id))
    return;
  const route = records.get('runtime-snapshots', task.id)?.route;
  const current = records.get('task-meta', task.id);
  const currentJob = current && records.get('jobs', current.jobId);
  if (
    !currentJob ||
    currentJob.taskId !== task.id ||
    currentJob.budgetExceeded ||
    ['paused', 'cancelled', 'budget-exceeded'].includes(currentJob.status)
  )
    return;
  const error = outcome.error || '';
  if (!route || current?.toolActivity || !FALLBACK_ERROR_PATTERN.test(error))
    return;
  if (/401|403|CREDENTIAL/.test(error)) {
    const provider = records.get('providers', route.providerId);
    if (provider)
      records.save(
        'providers',
        {
          ...provider,
          enabled: false,
          health: { ok: false, error: '模型认证失败。', checkedAt: nowIso() },
        },
        provider.id,
      );
  }
  const excluded = [
    ...new Set([...(current.excludedProviders || []), route.providerId]),
  ];
  try {
    const next = selectTaskRoute({
      providers,
      assistant: current.assistantSnapshot,
      providerIds: current.allowedProviderIds ?? current.providerIds,
      allowWithoutTools: current.allowModelWithoutTools,
      exclude: excluded,
    });
    if (next) {
      recordEvent(
        task,
        {
          type: 'routing/fallback',
          data: {
            from: {
              providerId: route.providerId,
              providerName: route.providerName,
              model: route.model,
            },
            to: {
              providerId: next.providerId,
              providerName: next.providerName,
              model: next.model,
            },
            reason: error.slice(0, 500),
            excludedProviders: excluded,
          },
        },
        [route?.secret],
      );
      const retry = newTask({
        ...current,
        role: task.role,
        prompt: task.prompt,
        workspace: task.workspace,
        sessionId: task.sessionId,
        sourceTaskId: task.sourceTaskId,
        providerIds: [next.providerId],
        jobId: current.jobId,
      });
      records.save(
        'task-meta',
        {
          ...records.get('task-meta', retry.id),
          excludedProviders: excluded,
        },
        retry.id,
      );
      const job = records.get('jobs', current.jobId);
      records.save(
        'jobs',
        { ...job, taskId: retry.id, status: 'queued' },
        job.id,
      );
    }
  } catch {
    recordEvent(
      task,
      {
        type: 'routing/fallback-unavailable',
        data: {
          from: {
            providerId: route.providerId,
            providerName: route.providerName,
            model: route.model,
          },
          reason: error.slice(0, 500),
          excludedProviders: excluded,
          message: '没有可用的降级模型。',
        },
      },
      [route?.secret],
    );
    control.attention(
      {
        kind: 'model',
        taskId: task.id,
        title: '没有可用的降级模型',
        detail: '请检查模型配置后继续。',
      },
      `model:${task.id}`,
    );
  }
}

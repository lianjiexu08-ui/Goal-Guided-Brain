import fs from 'node:fs';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { findDsh } from './runtime.mjs';

let loading;
export function loadUsageMeter() {
  loading ??= (async () => {
    const executable = findDsh();
    if (!executable) return null;
    try {
      const require = createRequire(fs.realpathSync(executable));
      const nativeMeter = await import(
        pathToFileURL(require.resolve('@deepseek-ai/dsh-token-meter/client'))
          .href
      );
      return typeof nativeMeter.deriveTurnTokenUsage === 'function'
        ? nativeMeter.deriveTurnTokenUsage
        : null;
    } catch {
      return null;
    }
  })();
  return loading;
}

export function measureUsage(records, taskId, event, derive) {
  if (!derive || !['step/end', 'turn/end'].includes(event.type)) return null;
  const turn = event.data?.turn;
  if (turn === undefined) return null;
  const events = records
    .list('task-events')
    .filter((row) => row.taskId === taskId && row.data?.turn === turn)
    .reverse()
    .map((row) => ({ type: row.type, data: row.data }));
  if (event.type !== 'turn/end')
    events.push({ type: 'turn/end', data: { turn } });
  let usage;
  try {
    usage = derive(events);
  } catch {
    return null;
  }
  if (!usage) return null;
  const previous = records.get('usage', `${taskId}:${turn}`);
  if (previous && !previous.partial && event.type !== 'turn/end')
    return previous;
  const snapshot = records.get('runtime-snapshots', taskId),
    meta = records.get('task-meta', taskId);
  const route = snapshot?.route;
  const model = route?.modelSpec;
  const inputTokens = usage.totalTokens - usage.outputTokens;
  return records.save(
    'usage',
    {
      taskId,
      groupId: meta?.groupId,
      jobId: meta?.jobId,
      turn,
      inputTokens,
      outputTokens: usage.outputTokens,
      totalTokens: usage.totalTokens,
      uncachedInputTokens: usage.uncachedInputTokens,
      cacheReadTokens: usage.cacheReadTokens,
      cacheWriteTokens: usage.cacheWriteTokens,
      partial: event.type !== 'turn/end',
      cost:
        model?.inputPrice != null && model?.outputPrice != null
          ? (inputTokens * model.inputPrice +
              usage.outputTokens * model.outputPrice) /
            1e6
          : null,
      estimated: true,
      currency: 'USD',
      providerId: route?.providerId,
      model: route?.model || usage.routes?.[0]?.model,
    },
    `${taskId}:${turn}`,
  );
}

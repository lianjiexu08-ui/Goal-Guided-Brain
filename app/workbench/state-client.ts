import { applyStateDelta } from '../../lib/state-delta.mjs';
import { parseApiResponse } from '../workbench-api';
import type { State } from './model';

export async function readWorkbenchState(
  signal: AbortSignal,
  etag: string | null,
  previous: State | null = null,
) {
  const response = await fetch('/api/state', {
    credentials: 'same-origin',
    cache: 'no-store',
    signal,
    headers: {
      'X-GGB-State-View': 'workbench',
      ...(etag ? { 'If-None-Match': etag } : {}),
      ...(etag && previous ? { 'X-GGB-State-Delta': '1' } : {}),
    },
  });
  const nextEtag = response.headers.get('etag');
  if (response.status === 304) {
    if (!etag || nextEtag !== etag)
      throw new Error('服务返回了无法匹配的状态版本，请重试。');
    return { snapshot: null, etag };
  }
  const body = await parseApiResponse<State>(response, 'state');
  const format = response.headers.get('x-ggb-state-format');
  let snapshot = body;
  if (format) {
    if (
      format !== 'delta-v1' ||
      !previous ||
      !etag ||
      !nextEtag ||
      nextEtag === etag
    )
      throw new Error('无法应用状态更新，请重试。');
    snapshot = applyStateDelta(previous, body, etag) as State;
  }
  if (
    !snapshot ||
    !snapshot.config ||
    typeof snapshot.config !== 'object' ||
    [
      'roles',
      'skillCatalog',
      'capabilities',
      'providers',
      'tasks',
      'sessions',
      'knowledge',
      'spaces',
      'teamTemplates',
    ].some((key) => !Array.isArray(snapshot[key as keyof State]))
  )
    throw new Error('服务返回的工作台状态不完整，请重试。');
  return {
    snapshot,
    etag: nextEtag,
  };
}

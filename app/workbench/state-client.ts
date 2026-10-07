import { parseApiResponse } from '../workbench-api';
import type { State } from './model';

export async function readWorkbenchState(
  signal: AbortSignal,
  etag: string | null,
) {
  const response = await fetch('/api/state', {
    credentials: 'same-origin',
    cache: 'no-store',
    signal,
    headers: etag ? { 'If-None-Match': etag } : {},
  });
  const nextEtag = response.headers.get('etag');
  if (response.status === 304) {
    if (!etag || nextEtag !== etag)
      throw new Error('服务返回了无法匹配的状态版本，请重试。');
    return { snapshot: null, etag };
  }
  return {
    snapshot: await parseApiResponse<State>(response, 'state'),
    etag: nextEtag,
  };
}

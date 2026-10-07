import { createHash } from 'node:crypto';
import { createStateDelta } from '../lib/state-delta.mjs';

// Per-workbench cache, bounded by serialized bytes and age. It is only a diff
// base: every request still reads and hashes fresh public state after auth.
export function createStateResponder({
  maxEntries = 8,
  maxBytes = 8 * 1024 * 1024,
  ttlMs = 60_000,
  now = Date.now,
} = {}) {
  const snapshots = new Map();
  let bytes = 0;
  const discard = (etag) => {
    bytes -= snapshots.get(etag).bytes;
    snapshots.delete(etag);
  };
  const remember = (etag, body, size) => {
    if (snapshots.has(etag)) discard(etag);
    if (size > maxBytes) return;
    snapshots.set(etag, { body, bytes: size, at: now() });
    bytes += size;
    while (snapshots.size > maxEntries || bytes > maxBytes)
      discard(snapshots.keys().next().value);
  };
  return function sendState(req, res, state) {
    const body = JSON.stringify(state);
    const size = Buffer.byteLength(body);
    const etag = `"${createHash('sha256').update(body).digest('base64url')}"`;
    res.setHeader('ETag', etag);
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Vary', 'X-GGB-State-Delta, If-None-Match');
    for (const [key, snapshot] of snapshots)
      if (now() - snapshot.at > ttlMs) discard(key);
    const validators = String(req.headers['if-none-match'] || '')
      .split(',')
      .map((value) => value.trim().replace(/^W\//, ''));
    if (validators.includes('*') || validators.includes(etag)) {
      remember(etag, body, size);
      res.writeHead(304);
      return res.end();
    }
    let payload = body;
    if (req.headers['x-ggb-state-delta'] === '1' && validators.length === 1) {
      const baseEtag = validators[0];
      const previous = snapshots.get(baseEtag);
      if (previous) {
        const delta = JSON.stringify(
          createStateDelta(
            JSON.parse(previous.body),
            JSON.parse(body),
            baseEtag,
          ),
        );
        // Tiny changes should pay for the envelope; large changes keep the
        // simpler complete representation when the delta would be larger.
        if (Buffer.byteLength(delta) < size) {
          payload = delta;
          res.setHeader('X-GGB-State-Format', 'delta-v1');
        }
      }
    }
    remember(etag, body, size);
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    return res.end(payload);
  };
}

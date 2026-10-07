import { createHash } from 'node:crypto';

// Derive the validator from the current public representation, not a process
// revision counter: other SQLite writers and time-based knowledge expiry must
// remain observable. Authentication is checked by the caller before this runs.
export function sendState(req, res, state) {
  const body = JSON.stringify(state);
  const etag = `"${createHash('sha256').update(body).digest('base64url')}"`;
  res.setHeader('ETag', etag);
  res.setHeader('Cache-Control', 'no-store');
  const unchanged = String(req.headers['if-none-match'] || '')
    .split(',')
    .some(
      (value) =>
        value.trim() === '*' || value.trim().replace(/^W\//, '') === etag,
    );
  if (unchanged) {
    res.writeHead(304);
    return res.end();
  }
  res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
  return res.end(body);
}

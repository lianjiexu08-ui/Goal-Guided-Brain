import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Records } from '../server/records.mjs';
import { createWorkbench } from '../server/index.mjs';
import { seedStateLoad } from './fixtures/state-load.mjs';

async function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ggb-state-http-'));
  const app = createWorkbench({
    dataDir: path.join(dir, 'data'),
    workspace: path.join(dir, 'project'),
    requireCredential: false,
  });
  t.after(async () => {
    await app.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  await app.platform.ready;
  await new Promise((resolve) => app.server.listen(0, '127.0.0.1', resolve));
  const read = (etag) =>
    fetch(`http://127.0.0.1:${app.server.address().port}/api/state`, {
      headers: etag ? { 'If-None-Match': etag } : {},
    });
  return { app, read };
}

test('unchanged state returns an empty 304, while unconditional reads keep the complete representation', async (t) => {
  const { app, read } = await fixture(t);
  seedStateLoad(app.store, { teams: 4, tasksPerTeam: 10 });
  const initial = await read();
  const etag = initial.headers.get('etag');
  assert.match(etag, /^"[A-Za-z0-9_-]+"$/);
  const body = await initial.json();
  assert.equal(body.tasks.length, 40);
  for (const validator of [etag, `W/${etag}`, `"unrelated", ${etag}`, '*']) {
    const unchanged = await read(validator);
    assert.equal(unchanged.status, 304);
    assert.equal(unchanged.headers.get('etag'), etag);
    assert.equal(unchanged.headers.get('cache-control'), 'no-store');
    assert.equal((await unchanged.arrayBuffer()).byteLength, 0);
  }
  for (const validator of [undefined, '"unrelated"']) {
    const complete = await read(validator);
    assert.equal(complete.status, 200);
    assert.deepEqual(await complete.json(), body);
  }
  app.platform.auth.requireAuth = true;
  const unauthorized = await read(etag);
  assert.equal(unauthorized.status, 401);
  assert.equal(unauthorized.headers.get('etag'), null);
});

test('conditional reads observe another writer and deletions without process-local invalidation', async (t) => {
  const { app, read } = await fixture(t);
  const { tasks } = seedStateLoad(app.store, { teams: 1, tasksPerTeam: 1 });
  let response = await read();
  let etag = response.headers.get('etag');
  await response.arrayBuffer();
  const db = new DatabaseSync(path.join(app.store.dir, 'workspace.sqlite'));
  try {
    const records = new Records(db);
    records.save(
      'task-acceptance',
      {
        taskId: tasks[0].id,
        requirementVersion: 1,
        verificationId: `${tasks[0].id}-0`,
        decision: 'accepted',
      },
      tasks[0].id,
    );
    response = await read(etag);
    assert.equal(response.status, 200);
    assert.notEqual(response.headers.get('etag'), etag);
    assert.equal((await response.json()).tasks[0].deliveryStatus, 'accepted');
    etag = response.headers.get('etag');
    records.remove('task-acceptance', tasks[0].id);
    response = await read(etag);
    assert.equal(response.status, 200);
    assert.equal(
      (await response.json()).tasks[0].deliveryStatus,
      'awaiting-owner',
    );
  } finally {
    db.close();
  }
});

test('time-based knowledge expiry changes the state validator even without database writes', async (t) => {
  const { app, read } = await fixture(t);
  const now = Date.now();
  app.store.saveKnowledge({
    title: 'Expiring knowledge',
    content: 'Review before reuse',
    scope: 'personal',
    state: 'active',
    source: 'owner',
    expiresAt: new Date(now + 86400000).toISOString(),
  });
  const initial = await read();
  const etag = initial.headers.get('etag');
  assert.equal((await initial.json()).knowledge[0].expired, false);
  t.mock.method(Date, 'now', () => now + 2 * 86400000);
  const expired = await read(etag);
  assert.equal(expired.status, 200);
  assert.notEqual(expired.headers.get('etag'), etag);
  assert.equal((await expired.json()).knowledge[0].expired, true);
});

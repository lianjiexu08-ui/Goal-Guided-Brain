import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createWorkbench } from '../server/index.mjs';
import { applyStateDelta } from '../lib/state-delta.mjs';
import { seedStateLoad } from './fixtures/state-load.mjs';

const wire = (value) => JSON.parse(JSON.stringify(value));
const withoutAttachments = (items) =>
  items.map(({ attachments: _attachments, ...item }) => item);

async function fixture(t) {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), 'ggb-lazy-timeline-'),
  );
  const app = createWorkbench({
    dataDir: path.join(directory, 'data'),
    workspace: path.join(directory, 'project'),
    requireCredential: false,
  });
  await app.platform.ready;
  await new Promise((resolve) => app.server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    await app.close();
    fs.rmSync(directory, { recursive: true, force: true });
  });
  const get = (route, headers = {}) =>
    fetch(`http://127.0.0.1:${app.server.address().port}/api/${route}`, {
      headers,
    });
  return { app, get };
}

void test('workbench projection defers team activity without losing tasks, counts or metadata, and skips activity collection reads', async (t) => {
  const { app, get } = await fixture(t);
  seedStateLoad(app.store, { teams: 4, tasksPerTeam: 10 });
  const complete = app.getState();
  const reads = {};
  const original = app.store.records.list.bind(app.store.records);
  app.store.records.list = (name) => {
    reads[name] = (reads[name] || 0) + 1;
    return original(name);
  };
  const compact = app.getState({ includeTeamActivity: false });
  app.store.records.list = original;
  assert.equal(reads['space-messages'] || 0, 0);
  assert.equal(reads['task-events'] || 0, 0);
  const expected = {
    ...complete,
    teamActivityDeferred: true,
    spaces: complete.spaces.map(
      ({ messages: _messages, timeline: _timeline, ...space }) => space,
    ),
  };
  assert.deepEqual(compact, expected);
  assert.ok(
    Buffer.byteLength(JSON.stringify(compact)) <
      Buffer.byteLength(JSON.stringify(complete)) * 0.6,
  );
  assert.deepEqual(await (await get('state')).json(), wire(complete));
  const first = await get('state', { 'X-GGB-State-View': 'workbench' });
  assert.deepEqual(await first.json(), wire(expected));
  const etag = first.headers.get('etag');
  app.store.updateTask(compact.tasks[0].id, { result: '任务正文仍完整更新' });
  const delta = await get('state', {
    'X-GGB-State-View': 'workbench',
    'X-GGB-State-Delta': '1',
    'If-None-Match': etag,
  });
  assert.equal(delta.headers.get('x-ggb-state-format'), 'delta-v1');
  assert.deepEqual(
    applyStateDelta(wire(compact), await delta.json(), etag),
    wire(app.getState({ includeTeamActivity: false })),
  );
});

void test('team timeline filters before pagination and returns every matching record once across cursors', async (t) => {
  const { app, get } = await fixture(t);
  const { spaces, tasks } = seedStateLoad(app.store, {
    teams: 2,
    tasksPerTeam: 2,
  });
  const team = spaces[0];
  app.store.saveTeamMessage({
    spaceId: team.id,
    kind: 'handoff',
    fromTeamId: spaces[1].id,
    content: '旧协作请求',
  });
  app.store.updateTask(tasks[0].id, {
    status: 'failed',
    error: '旧任务的失败原因',
  });
  for (let i = 0; i < 135; i++)
    app.store.saveTeamMessage({
      spaceId: team.id,
      senderType: 'agent',
      senderId: 'project_manager',
      content: `新消息 ${i}`,
      status: 'sent',
    });
  const all = app.store.teamTimeline(team.id, 200);
  const evidence = await (
    await get(`spaces/${team.id}/timeline?kind=evidence&limit=120`)
  ).json();
  assert.ok(evidence.items.length > 0);
  assert.ok(
    evidence.items.every((item) =>
      ['artifact', 'verification', 'acceptance'].includes(item.type),
    ),
  );
  assert.equal(
    (await get(`spaces/${team.id}/timeline?kind=unknown`)).status,
    400,
  );
  const risk = await (await get(`spaces/${team.id}/timeline?kind=risk`)).json();
  assert.ok(
    risk.items.some(
      (item) => item.taskId === tasks[0].id && item.type === 'task',
    ),
  );
  const collaboration = await (
    await get(`spaces/${team.id}/timeline?kind=collaboration&limit=8`)
  ).json();
  assert.deepEqual(
    collaboration.items.map((item) => item.content),
    ['旧协作请求'],
  );
  for (const kind of [
    'all',
    'messages',
    'execution',
    'evidence',
    'risk',
    'collaboration',
  ]) {
    let before = '';
    const items = [];
    for (let page = 0; page < 20; page++) {
      const result = await (
        await get(
          `spaces/${team.id}/timeline?kind=${kind}&limit=11${before ? `&before=${encodeURIComponent(before)}` : ''}`,
        )
      ).json();
      items.unshift(...result.items);
      if (!result.hasMore) break;
      assert.ok(result.items.length);
      before = `${result.items[0].at}|${result.items[0].id}`;
    }
    assert.equal(new Set(items.map((item) => item.id)).size, items.length);
    assert.deepEqual(
      withoutAttachments(items),
      app.store.teamTimeline(team.id, 200, null, undefined, kind),
    );
    if (kind === 'all') assert.deepEqual(withoutAttachments(items), all);
  }
  app.platform.auth.requireAuth = true;
  assert.equal(
    (await get('state', { 'X-GGB-State-View': 'workbench' })).status,
    401,
  );
  assert.equal((await get(`spaces/${team.id}/timeline`)).status, 401);
});

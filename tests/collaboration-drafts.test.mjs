import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createWorkbench } from '../server/index.mjs';
import { seedConfirmedDefaultTeam } from './fixtures/confirmed-default-team.mjs';

async function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ggb-collab-draft-'));
  const app = createWorkbench({
    dataDir: directory,
    workspace: directory,
    requireCredential: false,
  });
  await app.platform.ready;
  const { store } = app;
  const source = seedConfirmedDefaultTeam(store);
  store.records.save(
    'nodes',
    { name: 'Draft fixture', status: 'offline' },
    'draft-offline',
  );
  const role = store.saveRole({
    ...store.role('project_manager'),
    id: undefined,
    name: 'Draft receiver',
    nodeId: 'draft-offline',
  });
  const target = store.saveTeamSpace({
    ...source,
    id: undefined,
    chatId: undefined,
    name: 'Draft target',
    pmRoleId: role.id,
    memberRoleIds: [role.id],
  });
  await new Promise((resolve) => app.server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    await app.close();
    fs.rmSync(directory, { recursive: true, force: true });
  });
  async function request(route, method = 'GET', body, token) {
    const r = await fetch(
      `http://127.0.0.1:${app.server.address().port}/api/${route}`,
      {
        method,
        headers: {
          'Content-Type': 'application/json',
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
      },
    );
    return { status: r.status, body: await r.json() };
  }
  const endpoint = `teams/${source.id}/collaboration-draft`;
  const value = {
    targetTeamId: target.id,
    content: '检查部署',
    acceptance: '回传验证证据',
  };
  const save = (value, revision, route = endpoint) =>
    request(route, 'PUT', { value, revision });
  const send = (extra = {}) =>
    request(`teams/${source.id}/collaborate`, 'POST', {
      ...value,
      clientMessageId: 'pending-one',
      ...extra,
    });
  return { app, store, source, target, request, endpoint, value, save, send };
}

test('collaboration drafts are versioned per source and stale offline writes cannot resurrect cleared data', async (t) => {
  const { endpoint, value, save, request, target } = await fixture(t);
  assert.equal((await request(endpoint)).body.revision, 0);
  assert.equal((await save(value, 0)).body.revision, 1);
  assert.equal(
    (await save({ ...value, content: '另一设备覆盖' }, 0)).status,
    409,
  );
  assert.deepEqual((await request(endpoint)).body.value, value);
  assert.equal(
    (await request(`teams/${target.id}/collaboration-draft`)).body.value
      .content,
    '',
  );
  const cleared = { targetTeamId: '', content: '', acceptance: '' };
  assert.equal((await save(cleared, 1)).body.revision, 2);
  assert.equal((await save(value, 0)).status, 409);
  assert.equal((await save(value, 1)).status, 409);
  assert.deepEqual((await request(endpoint)).body.value, cleared);
  for (const invalid of [
    { ...value, content: 'x'.repeat(32001) },
    { ...value, followup: { messageId: 'x' } },
    { ...value, clientMessageId: '<bad>' },
  ])
    assert.equal((await save(invalid, 2)).status, 400);
  assert.equal((await save(value, -1)).status, 400);
  assert.equal((await request(endpoint)).body.revision, 2);
});

test('handoff creation consumes only the reviewed pending version atomically and replay preserves a newer draft', async (t) => {
  const { store, endpoint, value, save, send, request } = await fixture(t);
  const pending = { ...value, clientMessageId: 'pending-one' };
  await save(pending, 0);
  const before = store.tasks().length;
  assert.equal((await send({ draftRevision: 0 })).status, 409);
  assert.equal(store.tasks().length, before);
  assert.equal((await request(endpoint)).body.revision, 1);
  const saveRecord = store.records.save.bind(store.records);
  store.records.save = (name, ...args) => {
    if (name === 'collaboration-drafts')
      throw new Error('Injected draft clear failure');
    return saveRecord(name, ...args);
  };
  assert.notEqual((await send({ draftRevision: 1 })).status, 201);
  store.records.save = saveRecord;
  assert.equal(store.tasks().length, before);
  assert.equal(store.records.list('handoff-origins').length, 0);
  assert.equal(
    (await request(endpoint)).body.value.clientMessageId,
    'pending-one',
  );
  const sent = await send({ draftRevision: 1 });
  assert.equal(sent.status, 201);
  assert.equal(store.tasks().length, before + 1);
  const cleared = (await request(endpoint)).body;
  assert.equal(cleared.revision, 2);
  assert.equal(cleared.value.content, '');
  const newer = { ...value, content: '下一项工作' };
  await save(newer, 2);
  const replay = await send({ draftRevision: 1 });
  assert.equal(replay.status, 200);
  assert.equal(replay.body.taskId, sent.body.taskId);
  assert.deepEqual((await request(endpoint)).body.value, newer);
  assert.equal(store.tasks().length, before + 1);
});

test('review draft is scoped to the source request; stale draft prevents a decision and atomic consumption preserves replay', async (t) => {
  const { store, source, target, request, send, save } = await fixture(t);
  const sent = (await send()).body;
  store.updateTask(sent.taskId, { status: 'cancelled' });
  const reviewPath = `teams/${source.id}/collaboration-review/${encodeURIComponent(sent.sourceMessageId)}`;
  const draftPath = `teams/${source.id}/collaboration-draft?messageId=${encodeURIComponent(sent.sourceMessageId)}`;
  const review = (await request(reviewPath)).body;
  const pending = {
    action: 'end',
    note: '改期执行',
    fingerprint: review.fingerprint,
    revision: review.revision,
    requestId: 'review-one',
  };
  const value = { action: 'end', note: pending.note, pending };
  assert.equal((await save(value, 0, draftPath)).status, 200);
  assert.equal(
    (
      await request(
        `teams/${target.id}/collaboration-draft?messageId=${encodeURIComponent(sent.sourceMessageId)}`,
      )
    ).status,
    404,
  );
  assert.equal(
    (await request(`teams/${source.id}/collaboration-draft?messageId=missing`))
      .status,
    404,
  );
  assert.equal(
    (
      await save(
        { ...value, pending: { ...pending, note: 'changed' } },
        1,
        draftPath,
      )
    ).status,
    400,
  );
  assert.equal(
    (await request(reviewPath, 'POST', { ...pending, draftRevision: 0 }))
      .status,
    409,
  );
  assert.equal(store.records.list('handoff-reviews').length, 0);
  assert.equal(store.records.list('handoff-review-events').length, 0);
  assert.equal(
    (await request(reviewPath, 'POST', { ...pending, draftRevision: 1 }))
      .status,
    200,
  );
  assert.equal((await request(draftPath)).body.revision, 2);
  const newer = { action: 'reopen', note: '新的计划' };
  await save(newer, 2, draftPath);
  assert.equal(
    (await request(reviewPath, 'POST', { ...pending, draftRevision: 1 }))
      .status,
    200,
  );
  assert.equal(store.records.list('handoff-review-events').length, 1);
  assert.deepEqual((await request(draftPath)).body.value, newer);
});

test('draft payload cannot change after review and instance authentication cannot read owner drafts', async (t) => {
  const { app, store, source, endpoint, value, save, send, request } =
    await fixture(t);
  await save({ ...value, clientMessageId: 'pending-one' }, 0);
  assert.equal(
    (await send({ content: 'unreviewed replacement', draftRevision: 1 }))
      .status,
    409,
  );
  const task = store.createTask({
    role: source.pmRoleId,
    prompt: 'Instance',
    workspace: source.workspace,
  });
  store.records.save(
    'task-meta',
    { teamId: source.id, spaceId: source.id },
    task.id,
  );
  const lease = app.platform.control.claimLocal(task, 'local');
  app.platform.auth.requireAuth = true;
  assert.equal(
    (await request(endpoint, 'GET', undefined, lease.token)).status,
    401,
  );
});

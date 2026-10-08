import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { createWorkbench } from '../server/index.mjs';
import { seedConfirmedDefaultTeam } from './fixtures/confirmed-default-team.mjs';

async function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ggb-review-'));
  const app = createWorkbench({
    dataDir: path.join(directory, 'data'),
    workspace: directory,
    requireCredential: false,
  });
  await app.platform.ready;
  const { store } = app;
  const source = seedConfirmedDefaultTeam(store);
  store.records.save(
    'nodes',
    { name: 'Review fixture', status: 'offline' },
    'review-offline',
  );
  const role = store.saveRole({
    ...store.role('project_manager'),
    id: undefined,
    name: 'Review manager',
    nodeId: 'review-offline',
  });
  const target = store.saveTeamSpace({
    ...source,
    id: undefined,
    chatId: undefined,
    name: 'Review target',
    pmRoleId: role.id,
    memberRoleIds: [role.id],
  });
  await new Promise((resolve) => app.server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    await app.close();
    fs.rmSync(directory, { recursive: true, force: true });
  });
  async function request(url, body, token) {
    const response = await fetch(
      `http://127.0.0.1:${app.server.address().port}/api/${url}`,
      {
        method: body ? 'POST' : 'GET',
        headers: {
          'Content-Type': 'application/json',
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
      },
    );
    return { status: response.status, body: await response.json() };
  }
  const sent = await request(`teams/${source.id}/collaborate`, {
    targetTeamId: target.id,
    content: 'Validate the delivery',
    clientMessageId: 'original',
  });
  assert.equal(sent.status, 201);
  const messageId = sent.body.sourceMessageId;
  const endpoint = `teams/${source.id}/collaboration-review/${encodeURIComponent(messageId)}`;
  function settle(status = 'completed') {
    const task = store.updateTask(sent.body.taskId, {
      status,
      result: 'Review output',
    });
    const meta = store.records.get('task-meta', task.id);
    const job = store.records.get('jobs', meta.jobId);
    store.records.save('jobs', { ...job, status }, job.id);
    return task;
  }
  async function decision(action, note = 'Owner review', snapshot) {
    const current = snapshot || (await request(endpoint)).body;
    const payload = {
      action,
      note,
      revision: current.revision,
      fingerprint: current.fingerprint,
      requestId: randomUUID(),
    };
    return { payload, response: await request(endpoint, payload) };
  }
  return {
    app,
    store,
    source,
    target,
    sent: sent.body,
    messageId,
    endpoint,
    request,
    settle,
    decision,
  };
}

void test('completion requires actual current owner acceptance and stale evidence invalidates the closure', async (t) => {
  const { store, source, target, sent, endpoint, request, settle, decision } =
    await fixture(t);
  const task = settle();
  assert.equal((await decision('complete')).response.status, 409);
  const evidence = store.records.save('artifacts', {
    taskId: task.id,
    kind: 'verification',
    status: 'verified',
    verified: true,
    requirementVersion: 1,
  });
  assert.equal((await decision('complete')).response.status, 409);
  assert.equal(
    (await request(`tasks/${task.id}/accept`, { note: 'Checked the evidence' }))
      .status,
    200,
  );
  const closed = await decision('complete');
  assert.equal(closed.response.status, 200);
  assert.equal(closed.response.body.status, 'closed');
  assert.equal(closed.response.body.action, 'complete');
  for (const team of [source, target]) {
    const row = store
      .teamTimeline(team.id)
      .find((item) => item.taskId === sent.taskId && item.type === 'message');
    assert.equal(row.collaborationReview.status, 'closed');
  }
  // Another writer may replace output without advancing the millisecond timestamp.
  store.db
    .prepare('UPDATE tasks SET result=? WHERE id=?')
    .run('Revised result', task.id);
  assert.equal((await request(endpoint)).body.status, 'stale');
  store.records.save(
    'artifacts',
    { ...evidence, status: 'failed', verified: false },
    evidence.id,
  );
  assert.equal((await request(endpoint)).body.status, 'stale');
  assert.equal(
    (await decision('reopen', 'Evidence changed')).response.body.status,
    'open',
  );
  assert.equal((await decision('complete')).response.status, 409);
});

void test('ending follow-up retains failed delivery and reopening restores follow-up without rerunning tasks', async (t) => {
  const {
    store,
    source,
    target,
    endpoint,
    request,
    settle,
    decision,
    messageId,
  } = await fixture(t);
  settle('failed');
  assert.equal((await decision('end', '')).response.status, 400);
  const ended = await decision('end', 'No longer needed');
  assert.equal(ended.response.body.status, 'closed');
  assert.equal(ended.response.body.deliveryStatus, 'failed');
  const followup = {
    targetTeamId: target.id,
    content: 'Follow up',
    clientMessageId: 'next',
    followupMessageId: messageId,
  };
  assert.equal(
    (await request(`teams/${source.id}/collaborate`, followup)).status,
    409,
  );
  const taskCount = store.tasks().length;
  assert.equal(
    (await decision('reopen', 'Need another attempt')).response.body.status,
    'open',
  );
  assert.equal(store.tasks().length, taskCount);
  const next = await request(`teams/${source.id}/collaborate`, followup);
  assert.equal(next.status, 201);
  await decision('end', 'Close this request only');
  const retried = await request(`teams/${source.id}/collaborate`, followup);
  assert.equal(retried.status, 200);
  assert.equal(retried.body.taskId, next.body.taskId);
  assert.equal((await request(endpoint)).body.history.length, 3);
});

void test('concurrent decisions reject stale revision and lost receipts retry without duplicate audit entries', async (t) => {
  const { store, endpoint, request, settle, decision } = await fixture(t);
  settle('cancelled');
  const snapshot = (await request(endpoint)).body;
  const first = await decision('end', 'Explicitly withdrawn', snapshot);
  assert.equal(first.response.status, 200);
  assert.equal((await request(endpoint, first.payload)).status, 200);
  assert.equal(store.records.list('handoff-review-events').length, 1);
  assert.equal(
    (await decision('end', 'Other tab', snapshot)).response.status,
    409,
  );
  assert.equal(
    (await request(endpoint, { ...first.payload, note: 'Changed retry' }))
      .status,
    409,
  );
  const fresh = (await request(endpoint)).body;
  settle('failed');
  assert.equal(
    (await decision('reopen', 'Stale result snapshot', fresh)).response.status,
    409,
  );
});

void test('late audit failure rolls back closure and publishes no team success; retry commits both team refreshes', async (t) => {
  const { app, store, source, target, endpoint, request, settle, decision } =
    await fixture(t);
  settle('cancelled');
  const events = [];
  const unsubscribers = [source, target].map((team) =>
    app.platform.subscribeTeamEvents(team.id, (event) => events.push(event)),
  );
  t.after(() => unsubscribers.forEach((stop) => stop()));
  const original = store.records.save.bind(store.records);
  store.records.save = (collection, ...args) => {
    if (collection === 'handoff-review-events')
      throw new Error('Injected audit failure');
    return original(collection, ...args);
  };
  const attempted = await decision('end');
  store.records.save = original;
  assert.notEqual(attempted.response.status, 200);
  assert.equal(store.records.list('handoff-reviews').length, 0);
  assert.equal(events.length, 0);
  assert.equal((await request(endpoint, attempted.payload)).status, 200);
  assert.deepEqual(
    new Set(events.map((event) => event.teamId)),
    new Set([source.id, target.id]),
  );
});

void test('review is source-owner scoped and cannot end running, unknown or paused-team work', async (t) => {
  const {
    app,
    store,
    source,
    target,
    endpoint,
    messageId,
    sent,
    request,
    settle,
    decision,
  } = await fixture(t);
  for (const status of ['queued', 'running', 'state_unknown']) {
    settle(status);
    assert.equal((await decision('end')).response.status, 409);
  }
  assert.equal(
    (
      await request(
        `teams/${target.id}/collaboration-review/${encodeURIComponent(messageId)}`,
      )
    ).status,
    404,
  );
  assert.equal(
    (
      await request(
        `teams/${source.id}/collaboration-review/${encodeURIComponent(sent.id)}`,
      )
    ).status,
    404,
  );
  const caller = store.createTask({
    role: source.pmRoleId,
    teamId: source.id,
    prompt: 'Instance',
    workspace: source.workspace,
  });
  store.records.save(
    'task-meta',
    { teamId: source.id, spaceId: source.id },
    caller.id,
  );
  const lease = app.platform.control.claimLocal(caller);
  const snapshot = (await request(endpoint)).body;
  assert.notEqual(
    (
      await request(
        endpoint,
        {
          action: 'end',
          note: 'Agent attempt',
          revision: snapshot.revision,
          fingerprint: snapshot.fingerprint,
          requestId: randomUUID(),
        },
        lease.token,
      )
    ).status,
    200,
  );
  settle('cancelled');
  store.saveTeamSpace({ ...source, status: 'paused' }, source.id);
  assert.equal((await decision('end')).response.status, 409);
  assert.equal(store.records.list('handoff-reviews').length, 0);
});

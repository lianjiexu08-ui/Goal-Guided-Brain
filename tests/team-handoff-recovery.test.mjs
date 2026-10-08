import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createWorkbench } from '../server/index.mjs';
import { seedConfirmedDefaultTeam } from './fixtures/confirmed-default-team.mjs';

async function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ggb-handoff-recovery-'));
  const app = createWorkbench({
    dataDir: path.join(dir, 'data'),
    workspace: dir,
    requireCredential: false,
    runtimeFactory: (options) => ({
      start() {},
      cancel() {
        options.onDone('cancelled', '');
      },
    }),
  });
  await app.platform.ready;
  const source = seedConfirmedDefaultTeam(app.store);
  const target = app.store.saveTeamSpace({
    ...source,
    id: undefined,
    name: 'Recovery target',
    chatId: undefined,
    autonomy: { ...source.autonomy, maxJobs: 1 },
  });
  await new Promise((resolve) => app.server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    await app.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const payload = {
    targetTeamId: target.id,
    content: '检查发布与回滚',
    acceptance: '交付检查清单',
    clientMessageId: 'stable-request',
  };
  const send = async (body = payload) => {
    const response = await fetch(
      `http://127.0.0.1:${app.server.address().port}/api/teams/${source.id}/collaborate`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      },
    );
    return { status: response.status, body: await response.json() };
  };
  return { app, source, target, payload, send };
}

void test('handoff rolls back task, job, sessions and messages after late write failure without publishing success; retry creates exactly one task', async (t) => {
  const { app, source, target, send } = await fixture(t);
  const records = app.store.records;
  const original = records.save.bind(records);
  const events = [];
  const unsubscribe = app.platform.subscribeTeamEvents(target.id, (event) =>
    events.push(event),
  );
  t.after(unsubscribe);
  const before = {
    tasks: app.store.tasks().length,
    sessions: app.store.sessions().length,
    jobs: records.list('jobs').length,
    metadata: records.list('task-meta').length,
  };
  records.save = (collection, input, id, revision) => {
    if (collection === 'space-messages' && id?.endsWith(':source'))
      throw new Error('injected source trace failure');
    return original(collection, input, id, revision);
  };
  const failed = await send();
  records.save = original;
  assert.notEqual(failed.status, 201);
  assert.match(failed.body.error, /injected source trace/);
  assert.equal(app.store.tasks().length, before.tasks);
  assert.equal(app.store.sessions().length, before.sessions);
  assert.equal(records.list('jobs').length, before.jobs);
  assert.equal(records.list('task-meta').length, before.metadata);
  assert.equal(
    records
      .list('space-messages')
      .filter((item) => item.fromTeamId === source.id).length,
    0,
  );
  assert.equal(events.length, 0);
  const created = await send();
  assert.equal(created.status, 201);
  const retried = await send();
  assert.equal(retried.status, 200);
  assert.equal(retried.body.taskId, created.body.taskId);
  assert.equal(app.store.tasks().length, before.tasks + 1);
  assert.equal(
    records.list('space-messages').filter((item) => item.kind === 'handoff')
      .length,
    2,
  );
  assert.ok(
    events
      .filter((event) => event.type === 'message')
      .every((event) => event.taskId === created.body.taskId),
  );
  const messageEvents = events.filter((event) => event.type === 'message');
  // Later execution may publish an "answered" update. The commit itself
  // publishes one linked "sent" version, never the intermediate taskless row.
  assert.equal(
    messageEvents.filter((event) => event.status === 'sent').length,
    1,
  );
});

void test('legacy handoff without a linked task is repaired, completed jobs do not consume active-job capacity', async (t) => {
  const { app, source, target, payload, send } = await fixture(t);
  app.store.records.save('jobs', { teamId: target.id, status: 'completed' });
  const id = `handoff:${source.id}:${target.id}:${payload.clientMessageId}`;
  app.store.saveTeamMessage(
    {
      spaceId: target.id,
      kind: 'handoff',
      clientMessageId: payload.clientMessageId,
      fromTeamId: source.id,
      content: payload.content,
    },
    id,
  );
  const result = await send();
  assert.equal(result.status, 201);
  assert.ok(result.body.taskId);
  assert.equal(
    app.store.records.get('space-messages', id).taskId,
    result.body.taskId,
  );
  assert.equal((await send()).body.taskId, result.body.taskId);
});

void test('legacy task metadata repairs a missing message link without creating a second task', async (t) => {
  const { app, source, target, payload, send } = await fixture(t);
  const first = await send();
  assert.equal(first.status, 201);
  const id = `handoff:${source.id}:${target.id}:${payload.clientMessageId}`;
  const message = app.store.records.get('space-messages', id);
  app.store.saveTeamMessage({ ...message, taskId: null }, id);
  app.store.records.remove('space-messages', `${id}:source`);
  const retried = await send();
  assert.equal(retried.status, 200);
  assert.equal(retried.body.taskId, first.body.taskId);
  assert.equal(app.store.tasks().length, 1);
  assert.equal(
    app.store.records.get('space-messages', `${id}:source`).taskId,
    first.body.taskId,
  );
});

void test('follow-up carries the original request and returned result in a new session, persists its link and retries once', async (t) => {
  const { app, source, target, payload, send } = await fixture(t);
  const first = await send();
  const task = app.store.updateTask(first.body.taskId, {
    status: 'completed',
    result: '必须补充数据库迁移回滚步骤。',
  });
  const meta = app.store.records.get('task-meta', task.id);
  const job = app.store.records.get('jobs', meta.jobId);
  app.store.records.save('jobs', { ...job, status: 'completed' }, job.id);
  app.platform.control.publishHandoffResult(
    task,
    meta,
    'completed',
    task.result,
  );
  const followup = {
    ...payload,
    content: '请补齐数据库迁移回滚步骤。',
    clientMessageId: 'follow-up',
    followupMessageId: first.body.sourceMessageId,
  };
  const next = await send(followup);
  assert.equal(next.status, 201);
  assert.equal(next.body.followupMessageId, first.body.sourceMessageId);
  const created = app.store.task(next.body.taskId);
  assert.notEqual(created.sessionId, task.sessionId);
  assert.match(created.prompt, /检查发布与回滚/);
  assert.match(created.prompt, /必须补充数据库迁移回滚步骤/);
  assert.match(created.prompt, /请补齐数据库迁移回滚步骤/);
  assert.equal((await send(followup)).body.taskId, created.id);
  for (const id of [next.body.id, next.body.sourceMessageId])
    assert.equal(
      app.store.records.get('space-messages', id).followupMessageId,
      first.body.sourceMessageId,
    );
  for (const team of [source, target])
    assert.ok(
      app.store
        .teamTimeline(team.id)
        .some((item) => item.followupMessageId === first.body.sourceMessageId),
    );
  const changedIdentity = await send({
    ...followup,
    followupMessageId: undefined,
  });
  assert.equal(changedIdentity.status, 409);
});

void test('follow-up rejects foreign records, changed target and unsettled tasks without persisting work', async (t) => {
  const { app, source, target, payload, send } = await fixture(t);
  const first = await send();
  const before = app.store.tasks().length;
  const body = {
    ...payload,
    clientMessageId: 'invalid-follow-up',
    followupMessageId: first.body.sourceMessageId,
  };
  for (const status of ['running', 'queued', 'state_unknown']) {
    app.store.updateTask(first.body.taskId, { status });
    const result = await send(body);
    assert.equal(result.status, 409);
    assert.match(result.body.error, /仍在执行或状态未确认/);
  }
  app.store.updateTask(first.body.taskId, { status: 'completed' });
  for (const id of [first.body.id, 'missing-record'])
    assert.equal((await send({ ...body, followupMessageId: id })).status, 409);
  const third = app.store.saveTeamSpace({
    ...target,
    id: undefined,
    chatId: undefined,
    name: 'Other target',
  });
  assert.equal((await send({ ...body, targetTeamId: third.id })).status, 409);
  const trace = app.store.records.get(
    'space-messages',
    first.body.sourceMessageId,
  );
  app.store.records.save(
    'space-messages',
    { ...trace, spaceId: third.id },
    trace.id,
  );
  assert.equal((await send(body)).status, 409);
  assert.equal(app.store.tasks().length, before);
  assert.equal(
    app.store
      .teamMessages(source.id)
      .some((message) => message.clientMessageId === body.clientMessageId),
    false,
  );
});

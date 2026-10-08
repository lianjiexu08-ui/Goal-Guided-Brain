import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { createWorkbench } from '../server/index.mjs';
import { seedConfirmedDefaultTeam } from './fixtures/confirmed-default-team.mjs';

async function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ggb-mcp-recovery-'));
  const app = createWorkbench({
    dataDir: path.join(directory, 'data'),
    workspace: directory,
    requireCredential: false,
  });
  await app.platform.ready;
  const { store } = app;
  const control = app.platform.control;
  const source = seedConfirmedDefaultTeam(store);
  store.records.save(
    'nodes',
    { name: 'Isolated offline node', status: 'offline' },
    'fixture-node',
  );
  const role = store.saveRole({
    ...store.role('project_manager'),
    id: undefined,
    name: 'Target manager',
    nodeId: 'fixture-node',
  });
  const target = store.saveTeamSpace({
    ...source,
    id: undefined,
    chatId: undefined,
    name: 'Target team',
    pmRoleId: role.id,
    memberRoleIds: [role.id],
    model: 'target-model',
    workspace: path.join(directory, 'target'),
  });
  const clients = [];
  await new Promise((resolve) => app.server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    await Promise.allSettled(clients.map((client) => client.close()));
    await app.close();
    fs.rmSync(directory, { recursive: true, force: true });
  });
  async function caller() {
    // A real lease and MCP transport without starting a model process.
    const task = store.createTask({
      role: source.pmRoleId,
      prompt: 'Delegate work',
      workspace: source.workspace,
    });
    const jobId = randomUUID();
    store.records.save(
      'jobs',
      { taskId: task.id, teamId: source.id, groupId: jobId, status: 'queued' },
      jobId,
    );
    store.records.save(
      'task-meta',
      { teamId: source.id, spaceId: source.id, jobId, groupId: jobId },
      task.id,
    );
    const lease = control.claimLocal(task);
    assert.ok(lease);
    const principal = control.validateInstanceToken(lease.token);
    const client = new Client({ name: 'handoff-recovery-test', version: '1' });
    clients.push(client);
    await client.connect(
      new StreamableHTTPClientTransport(
        new URL(`http://127.0.0.1:${app.server.address().port}/api/mcp`),
        {
          requestInit: { headers: { Authorization: `Bearer ${lease.token}` } },
        },
      ),
    );
    const invoke = async (extra = {}) => {
      const result = await client.callTool({
        name: 'delegate_to_team',
        arguments: {
          teamId: target.id,
          prompt: 'Return a verifiable implementation',
          acceptance: 'Include checks',
          idempotencyKey: 'same-key',
          ...extra,
        },
      });
      return result.isError
        ? { error: result.content[0].text }
        : JSON.parse(result.content[0].text);
    };
    return { task, jobId, principal, invoke };
  }
  const snapshot = () => ({
    tasks: store.tasks().length,
    sessions: store.sessions().length,
    jobs: store.records.list('jobs').length,
    metadata: store.records.list('task-meta').length,
    messages: store.records.list('space-messages').length,
  });
  return { app, store, control, source, target, caller, snapshot };
}

void test('MCP scopes identical keys to the source task and creates independent target sessions and groups', async (t) => {
  const { store, target, caller } = await fixture(t);
  const first = await caller();
  const second = await caller();
  const a = await first.invoke();
  const b = await second.invoke();
  assert.equal(a.duplicate, false);
  assert.equal(b.duplicate, false);
  assert.notEqual(a.taskId, b.taskId);
  assert.notEqual(a.messageId, b.messageId);
  assert.notEqual(a.sourceMessageId, b.sourceMessageId);
  assert.equal((await first.invoke()).taskId, a.taskId);
  assert.equal((await second.invoke()).taskId, b.taskId);
  const taskA = store.task(a.taskId);
  const taskB = store.task(b.taskId);
  assert.notEqual(taskA.sessionId, taskB.sessionId);
  for (const [result, origin] of [
    [a, first],
    [b, second],
  ]) {
    const meta = store.records.get('task-meta', result.taskId);
    assert.equal(meta.teamId, target.id);
    assert.equal(meta.modelOverride, 'target-model');
    assert.equal(store.task(result.taskId).workspace, target.workspace);
    assert.notEqual(meta.groupId, origin.principal.groupId);
    assert.equal(JSON.parse(meta.contextExtra).sourceTaskId, origin.task.id);
    assert.equal(
      store.records.get('space-messages', result.sourceMessageId)
        .relatedMessageId,
      result.messageId,
    );
  }
  assert.equal(
    store.records.list('space-messages').filter((row) => row.kind === 'handoff')
      .length,
    4,
  );
});

void test('MCP late write failure rolls back the entire delegation and emits no success; replay creates one job', async (t) => {
  const { app, store, target, caller, snapshot } = await fixture(t);
  const origin = await caller();
  const before = snapshot();
  const events = [];
  const unsubscribe = app.platform.subscribeTeamEvents(target.id, (event) =>
    events.push(event),
  );
  t.after(unsubscribe);
  const save = store.records.save.bind(store.records);
  store.records.save = (collection, value, id, revision) => {
    if (collection === 'space-messages' && id?.endsWith(':source'))
      throw new Error('injected MCP source trace failure');
    return save(collection, value, id, revision);
  };
  const failed = await origin.invoke();
  store.records.save = save;
  assert.match(failed.error, /injected MCP source trace failure/);
  assert.deepEqual(snapshot(), before);
  assert.equal(events.length, 0);
  const accepted = await origin.invoke();
  const duplicate = await origin.invoke();
  assert.equal(accepted.duplicate, false);
  assert.equal(duplicate.duplicate, true);
  assert.equal(accepted.taskId, duplicate.taskId);
  assert.equal(store.records.list('jobs').length, before.jobs + 1);
  const messages = events.filter((event) => event.type === 'message');
  assert.equal(messages.length, 1);
  assert.equal(messages[0].taskId, accepted.taskId);
});

void test('MCP repairs a legacy blocked message with a persisted task instead of creating another task', async (t) => {
  const { app, store, source, target, caller } = await fixture(t);
  const origin = await caller();
  const legacyId = `handoff:${source.id}:${target.id}:same-key`;
  const message = store.saveTeamMessage(
    {
      spaceId: target.id,
      kind: 'handoff',
      clientMessageId: `mcp:${origin.task.id}:same-key`,
      fromTeamId: source.id,
      toTeamId: target.id,
      content: 'Legacy accepted goal',
      status: 'blocked',
    },
    legacyId,
  );
  const child = app.platform.newTask({
    role: target.pmRoleId,
    prompt: message.content,
    teamId: target.id,
    sourceMessageId: legacyId,
  });
  const before = store.tasks().length;
  const repaired = await origin.invoke();
  assert.equal(repaired.duplicate, true);
  assert.equal(repaired.messageId, legacyId);
  assert.equal(repaired.taskId, child.id);
  assert.equal(store.tasks().length, before);
  assert.equal(store.records.get('space-messages', legacyId).status, 'sent');
  assert.equal(
    store.records.get('space-messages', repaired.sourceMessageId).taskId,
    child.id,
  );
  const other = await caller();
  const independent = await other.invoke();
  assert.notEqual(independent.messageId, legacyId);
  assert.equal(store.records.get('space-messages', legacyId).taskId, child.id);
});

void test('MCP counts active capacity rather than lifetime jobs and leaves no handoff when capacity is exhausted', async (t) => {
  const { store, target, caller, snapshot } = await fixture(t);
  const origin = await caller();
  store.saveTeamSpace(
    { ...target, autonomy: { ...target.autonomy, maxJobs: 1 } },
    target.id,
  );
  store.records.save('jobs', { teamId: target.id, status: 'completed' });
  const accepted = await origin.invoke();
  assert.equal(accepted.duplicate, false);
  const before = snapshot();
  assert.match(
    (await origin.invoke({ idempotencyKey: 'another-key' })).error,
    /任务上限/,
  );
  assert.deepEqual(snapshot(), before);
  assert.equal((await origin.invoke()).taskId, accepted.taskId);
});

void test('MCP delegation retains whitelist, auto-handoff, recruitment, team pause and lease revocation boundaries', async (t) => {
  const { store, control, source, target, caller, snapshot } = await fixture(t);
  const origin = await caller();
  const before = snapshot();
  const deny = async (patch, pattern) => {
    store.saveTeamSpace({ ...source, ...patch }, source.id);
    assert.match((await origin.invoke()).error, pattern);
    assert.deepEqual(snapshot(), before);
  };
  await deny(
    {
      collaboration: {
        ...source.collaboration,
        allowedTeamIds: ['unrelated-team'],
      },
    },
    /未允许/,
  );
  await deny(
    { collaboration: { ...source.collaboration, autoHandoff: false } },
    /未允许/,
  );
  await deny(
    { recruitment: { ...source.recruitment, phase: 'discovery' } },
    /尚未确认/,
  );
  await deny({ status: 'paused' }, /活动团队/);
  store.saveTeamSpace(source, source.id);
  store.saveTeamSpace(
    { ...target, recruitment: { ...target.recruitment, phase: 'discovery' } },
    target.id,
  );
  assert.match((await origin.invoke()).error, /尚未完成招募/);
  store.saveTeamSpace(target, target.id);
  const execution = store.records.get('executions', origin.task.id);
  store.records.save(
    'executions',
    { ...execution, status: 'cancelled' },
    execution.id,
  );
  await assert.rejects(origin.invoke());
  assert.throws(
    () =>
      control.delegateToTeam(
        { teamId: target.id, prompt: 'Rejected', idempotencyKey: 'revoked' },
        origin.principal,
      ),
    /撤销/,
  );
  assert.deepEqual(snapshot(), before);
});

void test('authenticated MCP follow-up reads original team context and preserves idempotent task isolation', async (t) => {
  const { store, caller } = await fixture(t);
  const origin = await caller();
  const first = await origin.invoke();
  const task = store.updateTask(first.taskId, {
    status: 'completed',
    result: 'Returned migration findings',
  });
  const job = store.records.get('jobs', first.jobId);
  store.records.save('jobs', { ...job, status: 'completed' }, job.id);
  const request = {
    idempotencyKey: 'followup',
    prompt: 'Address those findings',
    followupMessageId: first.sourceMessageId,
  };
  const next = await origin.invoke(request);
  assert.equal(next.duplicate, false);
  assert.match(
    store.task(next.taskId).prompt,
    /Return a verifiable implementation/,
  );
  assert.match(store.task(next.taskId).prompt, /Returned migration findings/);
  assert.notEqual(store.task(next.taskId).sessionId, task.sessionId);
  assert.equal(
    store.records.get('space-messages', next.messageId).followupMessageId,
    first.sourceMessageId,
  );
  assert.equal((await origin.invoke(request)).taskId, next.taskId);
  assert.match(
    (
      await origin.invoke({
        ...request,
        idempotencyKey: 'invalid',
        followupMessageId: first.messageId,
      })
    ).error,
    /不属于/,
  );
});

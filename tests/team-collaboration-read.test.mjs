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
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), 'ggb-collaboration-read-'),
  );
  const app = createWorkbench({
    dataDir: path.join(directory, 'data'),
    workspace: directory,
    requireCredential: false,
  });
  await app.platform.ready;
  const { store } = app;
  store.records.save(
    'nodes',
    { name: 'Offline reading fixture', status: 'offline' },
    'read-fixture-node',
  );
  const role = store.saveRole({
    ...store.role('project_manager'),
    id: undefined,
    name: 'Reading manager',
    nodeId: 'read-fixture-node',
  });
  const seeded = seedConfirmedDefaultTeam(store);
  const source = store.saveTeamSpace(
    { ...seeded, pmRoleId: role.id, memberRoleIds: [role.id] },
    seeded.id,
  );
  const target = store.saveTeamSpace({
    ...source,
    id: undefined,
    chatId: undefined,
    name: 'Target team',
  });
  const other = store.saveTeamSpace({
    ...source,
    id: undefined,
    chatId: undefined,
    name: 'Unrelated source',
  });
  await new Promise((resolve) => app.server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${app.server.address().port}/api`;
  const clients = [];
  t.after(async () => {
    await Promise.allSettled(clients.map((client) => client.close()));
    await app.close();
    fs.rmSync(directory, { recursive: true, force: true });
  });
  async function caller(team = source) {
    const task = store.createTask({
      role: role.id,
      teamId: team.id,
      prompt: 'Read collaboration state',
      workspace: directory,
    });
    const jobId = randomUUID();
    store.records.save(
      'jobs',
      {
        teamId: team.id,
        spaceId: team.id,
        taskId: task.id,
        status: 'queued',
        groupId: jobId,
      },
      jobId,
    );
    store.records.save(
      'task-meta',
      { teamId: team.id, spaceId: team.id, jobId, groupId: jobId },
      task.id,
    );
    const lease = app.platform.control.claimLocal(task);
    const principal = app.platform.control.validateInstanceToken(lease.token);
    const client = new Client({ name: 'collaboration-reader', version: '1' });
    clients.push(client);
    await client.connect(
      new StreamableHTTPClientTransport(new URL(`${base}/mcp`), {
        requestInit: { headers: { Authorization: `Bearer ${lease.token}` } },
      }),
    );
    const call = async (name, args = {}) => {
      const result = await client.callTool({ name, arguments: args });
      return result.isError
        ? { error: result.content[0].text }
        : JSON.parse(result.content[0].text);
    };
    return {
      task,
      principal,
      client,
      call,
      delegate: (extra = {}) =>
        call('delegate_to_team', {
          teamId: target.id,
          prompt: 'Shared original request',
          idempotencyKey: randomUUID(),
          ...extra,
        }),
    };
  }
  function settle(
    receipt,
    status = 'completed',
    result = 'Returned public result',
  ) {
    const task = store.updateTask(receipt.taskId, { status, result });
    const meta = store.records.get('task-meta', task.id);
    const job = store.records.get('jobs', meta.jobId);
    store.records.save('jobs', { ...job, status }, job.id);
    app.platform.control.publishHandoffResult(task, meta, status, result);
  }
  async function close(receipt) {
    const endpoint = `${base}/teams/${source.id}/collaboration-review/${encodeURIComponent(receipt.sourceMessageId)}`;
    const current = await (await fetch(endpoint)).json();
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        action: 'end',
        note: 'Owner ended follow-up',
        revision: current.revision,
        fingerprint: current.fingerprint,
        requestId: randomUUID(),
      }),
    });
    assert.equal(response.status, 200);
  }
  return { app, store, source, target, other, caller, settle, close };
}

test('MCP only reads actual source-owned delegations, excluding unrelated tasks and target-private messages', async (t) => {
  const { store, source, target, other, caller, settle } = await fixture(t);
  const origin = await caller();
  const stranger = await caller(other);
  const mine = await origin.delegate();
  const theirs = await stranger.delegate({ prompt: 'OTHER_SOURCE_SECRET' });
  settle(mine);
  const privateTask = store.createTask({
    role: target.pmRoleId,
    teamId: target.id,
    prompt: 'PRIVATE_TEAM_WORK',
    workspace: target.workspace,
  });
  store.records.save(
    'task-meta',
    { teamId: target.id, spaceId: target.id },
    privateTask.id,
  );
  store.saveTeamMessage({
    spaceId: target.id,
    kind: 'notice',
    content: 'TARGET_PRIVATE_NOTE',
    taskId: mine.taskId,
  });
  store.saveTeamMessage({
    spaceId: source.id,
    kind: 'reply',
    content: 'UNRELATED_REPLY',
    taskId: mine.taskId,
    relatedMessageId: 'not-this-handoff',
    fromTeamId: target.id,
    toTeamId: source.id,
  });
  const result = await origin.call('read_team_task', { taskId: mine.taskId });
  assert.equal(result.collaboration.status, 'open');
  assert.equal(result.collaboration.decisionAuthority, 'owner');
  assert.equal(result.canFollowUp, true);
  assert.match(JSON.stringify(result.messages), /Returned public result/);
  assert.doesNotMatch(
    JSON.stringify(result),
    /TARGET_PRIVATE_NOTE|OTHER_SOURCE_SECRET|UNRELATED_REPLY/,
  );
  for (const taskId of [theirs.taskId, privateTask.id, 'missing-task'])
    assert.match(
      (await origin.call('read_team_task', { taskId })).error,
      /自己委派/,
    );
  assert.equal('fingerprint' in result.collaboration, false);
  assert.equal(
    (await origin.client.listTools()).tools.some(
      (tool) => tool.name === 'list_team_collaborations',
    ),
    true,
  );
});

test('collaboration list paginates with tied timestamps, filters before paging, and rejects cross-team/filter cursors', async (t) => {
  const { store, target, caller, settle, close } = await fixture(t);
  const origin = await caller();
  const rows = [];
  for (const key of ['a', 'A', '_', '中', 'z'])
    rows.push(
      await origin.delegate({ prompt: `Request ${key}`, idempotencyKey: key }),
    );
  for (const row of rows)
    store.db
      .prepare('UPDATE records SET createdAt=? WHERE collection=? AND id=?')
      .run('2026-01-01T00:00:00.000Z', 'space-messages', row.sourceMessageId);
  settle(rows[0]);
  await close(rows[0]);
  const first = await origin.call('list_team_collaborations', { limit: 2 });
  const second = await origin.call('list_team_collaborations', {
    limit: 2,
    before: first.nextCursor,
  });
  const third = await origin.call('list_team_collaborations', {
    limit: 2,
    before: second.nextCursor,
  });
  assert.equal(first.total, 5);
  assert.deepEqual(first.counts, { open: 4, closed: 1, stale: 0, unlinked: 0 });
  assert.equal(
    new Set(
      [...first.items, ...second.items, ...third.items].map(
        (item) => item.messageId,
      ),
    ).size,
    5,
  );
  assert.equal(third.hasMore, false);
  assert.deepEqual(
    [...first.items, ...second.items, ...third.items].map(
      (item) => item.messageId,
    ),
    [3, 4, 0, 2, 1].map((index) => rows[index].sourceMessageId),
  );
  assert.equal(third.nextCursor, null);
  const closed = await origin.call('list_team_collaborations', {
    status: 'closed',
    limit: 1,
  });
  assert.equal(closed.items[0].sourceMessageId, rows[0].sourceMessageId);
  assert.equal(closed.items[0].nextAction, 'none');
  assert.equal(closed.items[0].canFollowUp, false);
  assert.match(
    (
      await origin.call('list_team_collaborations', {
        status: 'closed',
        before: first.nextCursor,
      })
    ).error,
    /游标/,
  );
  const peer = await caller(target);
  assert.match(
    (await peer.call('list_team_collaborations', { before: first.nextCursor }))
      .error,
    /游标/,
  );
  assert.equal(
    (await peer.call('list_team_collaborations', { direction: 'incoming' }))
      .total,
    5,
  );
  for (const limit of [0, 51, 1.5])
    assert.ok((await origin.call('list_team_collaborations', { limit })).error);
});

test('owner closure and changed output are visible to agents without granting write authority or leaking raw output into history', async (t) => {
  const { store, target, caller, settle, close } = await fixture(t);
  const origin = await caller();
  const receipt = await origin.delegate();
  settle(receipt);
  await close(receipt);
  let detail = await origin.call('read_team_task', { taskId: receipt.taskId });
  assert.equal(detail.collaboration.status, 'closed');
  assert.equal(detail.collaboration.action, 'end');
  assert.equal(detail.collaboration.note, 'Owner ended follow-up');
  assert.equal(detail.canFollowUp, false);
  const before = store.records.list('handoff-review-events').length;
  store.db
    .prepare('UPDATE tasks SET result=? WHERE id=?')
    .run('CHANGED_TARGET_OUTPUT', receipt.taskId);
  detail = await origin.call('read_team_task', { taskId: receipt.taskId });
  assert.equal(detail.collaboration.status, 'stale');
  const listed = await origin.call('list_team_collaborations', {
    status: 'stale',
  });
  assert.equal(listed.items[0].nextAction, 'ask_owner_review');
  assert.equal(
    listed.items[0].returnedResult.includes('Returned public result'),
    true,
  );
  assert.doesNotMatch(JSON.stringify(listed), /CHANGED_TARGET_OUTPUT/);
  const peer = await caller(target);
  assert.equal(
    (
      await peer.call('list_team_collaborations', {
        direction: 'incoming',
        status: 'stale',
      })
    ).items[0].collaboration.status,
    'stale',
  );
  assert.equal(store.records.list('handoff-review-events').length, before);
});

test('revoked peer access preserves only locally held history and rejects new detail reads; unlinked history cannot grant access', async (t) => {
  const { store, source, target, caller, settle } = await fixture(t);
  const origin = await caller();
  const receipt = await origin.delegate();
  settle(receipt);
  store.saveTeamSpace(
    {
      ...source,
      collaboration: { ...source.collaboration, autoHandoff: false },
    },
    source.id,
  );
  store.updateTask(receipt.taskId, { result: 'UNSHARED_TARGET_CHANGE' });
  const listed = await origin.call('list_team_collaborations');
  assert.equal(listed.items[0].canReadTask, false);
  assert.equal(listed.items[0].nextAction, 'review_permissions');
  assert.doesNotMatch(JSON.stringify(listed), /UNSHARED_TARGET_CHANGE/);
  assert.match(
    (await origin.call('read_team_task', { taskId: receipt.taskId })).error,
    /自己委派/,
  );
  store.saveTeamMessage(
    {
      spaceId: source.id,
      kind: 'handoff',
      fromTeamId: source.id,
      toTeamId: target.id,
      content: 'Legacy taskless request',
    },
    'legacy-unlinked',
  );
  const legacy = await origin.call('list_team_collaborations', {
    status: 'unlinked',
  });
  assert.equal(legacy.items[0].taskId, null);
  assert.equal(legacy.items[0].nextAction, 'ask_owner_repair');
  assert.equal(legacy.items[0].canFollowUp, false);
});

test('collaboration reads reject unconfirmed or paused source teams and expired execution leases', async (t) => {
  const { app, store, source, caller } = await fixture(t);
  const origin = await caller();
  const receipt = await origin.delegate();
  for (const patch of [
    { recruitment: { ...source.recruitment, phase: 'discovery' } },
    { status: 'paused' },
  ]) {
    store.saveTeamSpace({ ...source, ...patch }, source.id);
    assert.ok((await origin.call('list_team_collaborations')).error);
    assert.ok(
      (await origin.call('read_team_task', { taskId: receipt.taskId })).error,
    );
  }
  store.saveTeamSpace(source, source.id);
  const execution = store.records.get('executions', origin.task.id);
  store.records.save(
    'executions',
    { ...execution, status: 'cancelled' },
    execution.id,
  );
  await assert.rejects(origin.call('list_team_collaborations'));
  assert.throws(
    () => app.platform.control.listTeamCollaborations({}, origin.principal),
    /撤销/,
  );
  assert.throws(
    () =>
      app.platform.control.readTeamTask(
        { taskId: receipt.taskId },
        origin.principal,
      ),
    /撤销/,
  );
});

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { createWorkbench } from '../server/index.mjs';

async function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ggb-onward-'));
  const app = createWorkbench({
    dataDir: path.join(directory, 'data'),
    workspace: directory,
    requireCredential: false,
  });
  await app.platform.ready;
  const { store } = app;
  const control = app.platform.control;
  store.records.save(
    'nodes',
    { name: 'Onward fixture', status: 'offline' },
    'onward-offline',
  );
  const role = store.saveRole({
    ...store.role('project_manager'),
    id: undefined,
    name: 'Onward PM',
    nodeId: 'onward-offline',
  });
  const makeTeam = (name) =>
    store.saveTeamSpace({
      name,
      goal: 'Verify traceable onward work',
      pmRoleId: role.id,
      memberRoleIds: [role.id],
      workspace: directory,
      recruitment: {
        phase: 'confirmed',
        confirmedAt: new Date().toISOString(),
      },
      collaboration: { enabled: true, autoHandoff: true, allowedTeamIds: [] },
    });
  const [a, b, c] = ['Planning', 'Development', 'Operations'].map(makeTeam);
  await new Promise((resolve) => app.server.listen(0, '127.0.0.1', resolve));
  const baseUrl = `http://127.0.0.1:${app.server.address().port}/api`;
  const clients = [];
  t.after(async () => {
    await Promise.allSettled(clients.map((client) => client.close()));
    await app.close();
    fs.rmSync(directory, { recursive: true, force: true });
  });
  async function request(route, body, token) {
    const response = await fetch(`${baseUrl}/${route}`, {
      method: body ? 'POST' : 'GET',
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    return { status: response.status, body: await response.json() };
  }
  let sequence = 0;
  async function handoff(source = a, target = b, extra = {}) {
    const response = await request(`teams/${source.id}/collaborate`, {
      targetTeamId: target.id,
      content: 'Original work',
      clientMessageId: `owner-${++sequence}`,
      ...extra,
    });
    assert.equal(response.status, 201, JSON.stringify(response.body));
    return response.body;
  }
  async function caller(taskId) {
    const meta = store.records.get('task-meta', taskId);
    const claim = control.claimLocal(store.task(taskId), meta.nodeId);
    assert.ok(claim);
    const client = new Client({ name: 'onward-test', version: '1' });
    clients.push(client);
    await client.connect(
      new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp`), {
        requestInit: { headers: { Authorization: `Bearer ${claim.token}` } },
      }),
    );
    const invoke = async (name, args) => {
      const result = await client.callTool({ name, arguments: args });
      return result.isError
        ? { error: result.content[0].text }
        : JSON.parse(result.content[0].text);
    };
    return {
      claim,
      invoke,
      delegate: (target = c, key = 'onward', extra = {}) =>
        invoke('delegate_to_team', {
          teamId: target.id,
          prompt: `Onward work ${key}`,
          idempotencyKey: key,
          ...extra,
        }),
    };
  }
  const chain = (row, team = a, query = '') =>
    request(
      `teams/${team.id}/collaboration-chain/${encodeURIComponent(row.sourceMessageId)}${query}`,
    );
  const snapshot = () =>
    JSON.stringify([
      store.tasks(),
      store.sessions(),
      ...['jobs', 'task-meta', 'space-messages', 'handoff-origins'].map(
        (name) => store.records.list(name),
      ),
    ]);
  return {
    app,
    store,
    control,
    a,
    b,
    c,
    role,
    request,
    handoff,
    caller,
    chain,
    snapshot,
  };
}

void test('authenticated onward MCP delegation traces three teams while agent reads retain direct-delegation boundaries', async (t) => {
  const { app, store, a, b, c, request, handoff, caller, chain, snapshot } =
    await fixture(t);
  const root = await handoff();
  const developer = await caller(root.taskId);
  const onward = await developer.delegate();
  const operator = await caller(onward.taskId);
  const returned = await operator.delegate(a, 'return-to-planning');
  const sibling = await developer.delegate(c, 'parallel-check');
  assert.equal((await developer.delegate()).taskId, onward.taskId);
  const origin = store.records.get('handoff-origins', onward.sourceMessageId);
  assert.equal(origin.initiatorTaskId, root.taskId);
  assert.equal(origin.parentMessageId, root.sourceMessageId);
  assert.equal(origin.status, 'linked');
  store.updateTask(onward.taskId, { result: 'Private operations detail' });
  const before = snapshot();
  const result = (await chain(root)).body;
  assert.equal(result.visibility, 'owner-workflow');
  assert.equal(result.teamCount, 3);
  assert.equal(result.rootCount, 1);
  assert.equal(result.incomplete, false);
  assert.deepEqual(
    result.items.map((row) => row.messageId),
    [root, onward, returned, sibling].map((row) => row.sourceMessageId),
  );
  assert.deepEqual(
    result.items.map((row) => row.parentLinks),
    [
      [],
      [{ index: 1, kind: 'delegation' }],
      [{ index: 2, kind: 'delegation' }],
      [{ index: 1, kind: 'delegation' }],
    ],
  );
  assert.equal(
    JSON.stringify(result).includes('Private operations detail'),
    false,
  );
  assert.deepEqual((await chain(onward, c)).body.items, result.items);
  assert.equal(snapshot(), before);
  // A now has its own executing instance, but that does not grant access to B→C.
  const planner = await caller(returned.taskId);
  assert.match(
    (await planner.invoke('read_team_task', { taskId: onward.taskId })).error,
    /只能读取自己委派/,
  );
  const visible = await planner.invoke('list_team_collaborations', {
    direction: 'all',
  });
  assert.equal(JSON.stringify(visible).includes(onward.sourceMessageId), false);
  app.platform.auth.requireAuth = true;
  assert.equal(
    (
      await request(
        `teams/${a.id}/collaboration-chain/${encodeURIComponent(root.sourceMessageId)}`,
        null,
        planner.claim.token,
      )
    ).status,
    401,
  );
  assert.ok(b.id);
});

void test('member jobs and retried attempts retain verifiable inbound origin without trusting free-form context', async (t) => {
  const { store, control, role, request, handoff, caller, chain } =
    await fixture(t);
  const root = await handoff();
  const manager = await caller(root.taskId);
  const job = await manager.invoke('delegate_task', {
    role: role.id,
    prompt: 'Member checks',
  });
  assert.ok(job.taskId, JSON.stringify(job));
  const member = await caller(job.taskId);
  const first = await member.delegate();
  assert.equal(
    store.records.get('handoff-origins', first.sourceMessageId).parentMessageId,
    root.sourceMessageId,
  );
  control.finishLocal(
    job.taskId,
    member.claim.execution.epoch,
    { status: 'failed', error: 'Retry fixture' },
    'onward-offline',
  );
  const retried = await request(`tasks/${job.taskId}/retry`, {});
  assert.equal(retried.status, 201, JSON.stringify(retried.body));
  const replacement = await caller(retried.body.id);
  const second = await replacement.delegate();
  const trace = store.records.get('handoff-origins', second.sourceMessageId);
  assert.equal(trace.parentMessageId, root.sourceMessageId);
  assert.equal(trace.initiatorTaskId, retried.body.id);
  assert.equal(trace.initiatorJobId, job.id);
  assert.equal((await chain(root)).body.counts.total, 3);
  const meta = store.records.get('task-meta', retried.body.id);
  store.records.save(
    'task-meta',
    {
      ...meta,
      contextExtra: JSON.stringify({
        sourceTaskId: 'forged-source',
        sourceMessageId: 'forged-parent',
      }),
    },
    retried.body.id,
  );
  assert.equal((await chain(root)).body.counts.total, 3);
});

void test('origin write failure rolls back task, messages and trace together; retries and legacy receipts stay idempotent', async (t) => {
  const { app, store, a, b, c, handoff, caller, snapshot, chain } =
    await fixture(t);
  const root = await handoff();
  const agent = await caller(root.taskId);
  const before = snapshot();
  const events = [];
  const unsubscribe = app.platform.subscribeTeamEvents(c.id, (event) =>
    events.push(event),
  );
  t.after(unsubscribe);
  const save = store.records.save.bind(store.records);
  store.records.save = (name, value, id, revision) => {
    if (name === 'handoff-origins')
      throw new Error('Injected provenance failure');
    return save(name, value, id, revision);
  };
  const rejected = await agent.delegate();
  store.records.save = save;
  assert.match(rejected.error, /Injected provenance failure/);
  assert.equal(snapshot(), before);
  assert.equal(events.length, 0);
  const accepted = await agent.delegate();
  assert.equal(accepted.duplicate, false);
  const stored = store.records.get('handoff-origins', accepted.sourceMessageId);
  assert.equal((await agent.delegate()).duplicate, true);
  assert.deepEqual(
    store.records.get('handoff-origins', accepted.sourceMessageId),
    stored,
  );
  store.records.remove('handoff-origins', accepted.sourceMessageId);
  assert.equal((await agent.delegate()).taskId, accepted.taskId);
  assert.equal(
    store.records.get('handoff-origins', accepted.sourceMessageId),
    null,
  );
  const legacy = (await chain(accepted, b)).body;
  assert.equal(legacy.incomplete, true);
  assert.equal(legacy.items[0].originStatus, 'legacy');
  assert.equal(legacy.counts.total, 1);
  // Explicit HTTP fields cannot manufacture an agent-origin edge.
  const standalone = await handoff(b, c, {
    initiatorTaskId: root.taskId,
    parentMessageId: root.sourceMessageId,
  });
  assert.equal((await chain(standalone, b)).body.counts.total, 1);
  store.records.remove('handoff-origins', standalone.sourceMessageId);
  const unclassified = (await chain(standalone, b)).body;
  assert.equal(unclassified.items[0].originStatus, 'legacy');
  assert.equal(unclassified.incomplete, true);
  assert.equal((await chain(root, a)).body.counts.total, 1);
});

void test('follow-up and initiator relationships retain both roots and deduplicate their shared successor', async (t) => {
  const { store, a, b, c, control, handoff, caller, chain } = await fixture(t);
  const firstRoot = await handoff();
  const secondRoot = await handoff();
  const firstAgent = await caller(firstRoot.taskId);
  const first = await firstAgent.delegate();
  const receiver = await caller(first.taskId);
  control.finishLocal(
    first.taskId,
    receiver.claim.execution.epoch,
    { status: 'completed', result: 'Shared completed check' },
    'onward-offline',
  );
  const secondAgent = await caller(secondRoot.taskId);
  const followup = await secondAgent.delegate(c, 'revisit', {
    followupMessageId: first.sourceMessageId,
  });
  const trace = store.records.get('handoff-origins', followup.sourceMessageId);
  assert.equal(trace.parentMessageId, secondRoot.sourceMessageId);
  const firstView = (await chain(firstRoot, a)).body;
  const secondView = (await chain(secondRoot, a)).body;
  assert.deepEqual(firstView.items, secondView.items);
  assert.equal(firstView.rootCount, 2);
  assert.equal(firstView.counts.total, 4);
  assert.equal(new Set(firstView.items.map((row) => row.messageId)).size, 4);
  const item = firstView.items.find(
    (row) => row.messageId === followup.sourceMessageId,
  );
  assert.deepEqual(
    item.parentLinks.map((link) => link.kind),
    ['followup', 'delegation'],
  );
  assert.equal(item.initiatorTaskId, secondRoot.taskId);
  assert.equal(
    (await chain(followup, b)).body.rootMessageId,
    firstView.rootMessageId,
  );
});

void test('damaged provenance never pulls foreign work into a chain and removed targets make the owner view incomplete', async (t) => {
  const { store, b, c, handoff, caller, chain } = await fixture(t);
  const root = await handoff();
  const agent = await caller(root.taskId);
  const first = await agent.delegate();
  const page = (await chain(root, undefined, '?limit=1')).body;
  const second = await agent.delegate(c, 'next');
  assert.equal(
    (
      await chain(
        root,
        undefined,
        `?after=${encodeURIComponent(page.nextCursor)}`,
      )
    ).status,
    409,
  );
  const origin = store.records.get('handoff-origins', first.sourceMessageId);
  const foreign = await handoff(b, c);
  store.records.save(
    'handoff-origins',
    { ...origin, parentMessageId: foreign.sourceMessageId },
    origin.id,
  );
  const invalid = (await chain(first, b)).body;
  assert.equal(invalid.counts.total, 1);
  assert.equal(invalid.incomplete, true);
  assert.equal(invalid.items[0].initiatorTaskId, null);
  assert.equal(JSON.stringify(invalid).includes(foreign.taskId), false);
  store.records.save('handoff-origins', origin, origin.id);
  store.records.remove('space-messages', second.sourceMessageId);
  const partial = (await chain(root)).body;
  assert.equal(partial.counts.total, 2);
  assert.equal(partial.omittedLinks, 1);
  assert.equal(partial.incomplete, true);
  // Copying sourceMessageId alone does not make a foreign job a descendant.
  const meta = store.records.get('task-meta', first.taskId);
  store.records.save(
    'task-meta',
    { ...meta, teamId: b.id, spaceId: b.id, sourceMessageId: root.id },
    first.taskId,
  );
  assert.equal((await chain(root)).body.incomplete, true);
});

void test('a copied inbound message ID from another logical job is not enough to manufacture onward ancestry', async (t) => {
  const { store, b, handoff, caller, chain } = await fixture(t);
  const firstRoot = await handoff();
  const unrelatedRoot = await handoff();
  const actor = await caller(unrelatedRoot.taskId);
  const meta = store.records.get('task-meta', unrelatedRoot.taskId);
  store.records.save(
    'task-meta',
    {
      ...meta,
      sourceMessageId: firstRoot.id,
      contextExtra: JSON.stringify({ sourceTaskId: firstRoot.taskId }),
    },
    unrelatedRoot.taskId,
  );
  const onward = await actor.delegate();
  const trace = store.records.get('handoff-origins', onward.sourceMessageId);
  assert.equal(trace.status, 'unresolved');
  assert.equal(trace.parentMessageId, null);
  assert.equal(trace.initiatorTaskId, unrelatedRoot.taskId);
  assert.equal((await chain(firstRoot)).body.counts.total, 1);
  const isolated = (await chain(onward, b)).body;
  assert.equal(isolated.counts.total, 1);
  assert.equal(isolated.incomplete, true);
});

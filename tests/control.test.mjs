import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { Store } from '../server/store.mjs';
import { ControlPlane } from '../server/control.mjs';
import { AuthService } from '../server/auth.mjs';
import { NodeClient, validateControlUrl, runNodeCheck } from '../server/node-client.mjs';
import { createOrchestrationServer } from '../server/orchestration-mcp.mjs';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';

function setup(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-control-'));
  const workspace = path.join(directory, 'project');
  fs.mkdirSync(workspace);
  const store = new Store(path.join(directory, 'data'), workspace);
  let time = 1000000;
  const control = new ControlPlane({ store, now: () => time });
  t.after(() => { store.close(); fs.rmSync(directory, { recursive: true, force: true }); });
  const request = (route, body = {}, token, method = 'POST') => control.handle({
    method, parts: route.split('/'), body, req: { headers: token ? { authorization: `Bearer ${token}` } : {} },
  });
  return { store, control, request, directory, workspace, advance: value => { time += value; } };
}
async function pair(request) {
  const pairing = await request('nodes/pairing');
  const result = await request('nodes/pair', { code: pairing.body.code, name: 'Test node', workspaces: ['default'], platform: 'test' });
  assert.equal(result.status, 201);
  return { ...result.body, code: pairing.body.code };
}

test('pair codes are single use, node tokens are hashed and revoked nodes cannot claim', async t => {
  const { store, request } = setup(t);
  const paired = await pair(request);
  assert.equal((await request('nodes/pair', { code: paired.code, name: 'Duplicate', workspaces: ['default'] })).status, 401);
  assert.equal(JSON.stringify(store.records.list('nodes')).includes(paired.token), false);
  const list = await request('nodes', {}, undefined, 'GET');
  assert.equal(JSON.stringify(list.body).includes('tokenHash'), false);
  await request(`nodes/${paired.node.id}/revoke`);
  assert.equal((await request('nodes/claim', {}, paired.token)).status, 401);
});

test('remote leases claim once, reject wrong nodes, accept a result exactly once and reject late results', async t => {
  const { store, request, control, advance } = setup(t);
  const first = await pair(request), other = await pair(request);
  const job = control.createJob({ role: 'developer', prompt: 'Inspect code', nodeId: first.node.id });
  const response = await request('nodes/claim', {}, first.token);
  const assignment = response.body.assignment;
  assert.equal(assignment.task.id, job.taskId);
  assert.equal((await request('nodes/claim', {}, first.token)).body.assignment, null);
  const report = { taskId: job.taskId, epoch: 1, eventId: 'result-1', status: 'completed', result: 'done' };
  assert.equal((await request('nodes/report', report, other.token)).status, 403);
  assert.equal((await request('nodes/report', report, first.token)).body.duplicate, false);
  assert.equal((await request('nodes/report', report, first.token)).body.duplicate, true);
  assert.equal(store.task(job.taskId).result, 'done');
  const expired = control.createJob({ role: 'assistant', prompt: 'More work', nodeId: first.node.id });
  await request('nodes/claim', {}, first.token);
  advance(61000);
  control.reconcile();
  assert.equal(store.task(expired.taskId).status, 'state_unknown');
  assert.equal((await request('nodes/report', { ...report, taskId: expired.taskId }, first.token)).status, 409);
  assert.equal((await request('nodes/claim', {}, first.token)).body.assignment, null);
});

test('remote event receipts deduplicate tool activity before the completion hook runs', async t => {
  const { store, control, request } = setup(t);
  const paired = await pair(request);
  const job = control.createJob({ role: 'developer', prompt: 'Remote tool', nodeId: paired.node.id });
  await request('nodes/claim', {}, paired.token);
  let events = 0, completions = 0;
  control.onEvent = () => { events++; };
  control.onRemoteDone = task => { completions++; assert.equal(store.records.get('task-meta', task.id).toolActivity, true); };
  const event = { taskId: job.taskId, epoch: 1, kind: 'event', eventId: 'tool1', event: { type: 'tool/call', data: { name: 'read_file' } } };
  assert.equal((await request('nodes/report', event, paired.token)).body.duplicate, false);
  assert.equal((await request('nodes/report', event, paired.token)).body.duplicate, true);
  const result = { taskId: job.taskId, epoch: 1, status: 'completed', eventId: 'final', result: 'done' };
  await request('nodes/report', result, paired.token);
  await request('nodes/report', result, paired.token);
  assert.equal(events, 1);
  assert.equal(completions, 1);
});

test('child budgets inherit group limits and exhausted groups cannot claim new work', t => {
  const { store, control } = setup(t);
  const parent = control.createJob({ role: 'product', prompt: 'Budgeted project', budgetTokens: 5000, maxDurationMinutes: 10 });
  const claimed = control.claimLocal(store.task(parent.taskId));
  const child = control.createJob({ role: 'developer', prompt: 'Implement', budgetTokens: 500000 }, control.validateInstanceToken(claimed.token));
  assert.equal(child.budgetTokens, 5000);
  assert.equal(child.maxDurationMinutes, 10);
  store.records.save('jobs', { ...store.records.get('jobs', parent.id), status: 'budget-exceeded' }, parent.id);
  assert.equal(control.eligible(store.task(child.taskId), 'local'), false);
  assert.equal(control.claimLocal(store.task(child.taskId)), null);
});

test('owner budget increase pauses an exhausted group until explicit resume and propagates limits', async t => {
  const { store, control, request } = setup(t);
  const parent = control.createJob({ role: 'product', prompt: 'Budgeted project', budgetTokens: 1000 });
  const claimed = control.claimLocal(store.task(parent.taskId));
  const child = control.createJob({ role: 'developer', prompt: 'Implement' }, control.validateInstanceToken(claimed.token));
  for (const job of [parent, child]) store.records.save('jobs', { ...store.records.get('jobs', job.id), status: 'budget-exceeded', budgetExceeded: true }, job.id);
  store.records.save('usage', { taskId: parent.taskId, groupId: parent.groupId, totalTokens: 1200 });
  const before = store.tasks().length;
  assert.equal((await request(`jobs/${parent.id}`, { budgetTokens: 3000, maxDurationMinutes: 15 }, undefined, 'PUT')).status, 200);
  for (const job of [parent, child]) {
    const updated = store.records.get('jobs', job.id);
    assert.equal(updated.budgetTokens, 3000);
    assert.equal(updated.maxDurationMinutes, 15);
    assert.equal(updated.budgetExceeded, false);
    assert.equal(updated.status, 'paused');
  }
  assert.equal(store.tasks().length, before);
  assert.equal((await request(`jobs/${child.id}`, { budgetTokens: 5000 }, undefined, 'PUT')).status, 400);
  assert.equal((await request(`jobs/${parent.id}`, { budgetTokens: 999 }, undefined, 'PUT')).status, 400);
});

test('workflow dependencies follow the latest successful attempt after a failed provider attempt', t => {
  const { store, control } = setup(t);
  const dependency = control.createJob({ role: 'assistant', prompt: 'Research' });
  control.claimLocal(store.task(dependency.taskId));
  control.finishLocal(dependency.taskId, 1, { status: 'failed', error: '401' });
  const next = control.createJob({ role: 'developer', prompt: 'Implement' });
  store.records.save('task-meta', { ...store.records.get('task-meta', next.taskId), dependencies: [dependency.taskId] }, next.taskId);
  assert.equal(control.eligible(store.task(next.taskId), 'local'), false);
  const retry = store.createTask({ role: 'assistant', prompt: 'Research', sourceTaskId: dependency.taskId });
  store.records.save('task-meta', { jobId: dependency.id, groupId: dependency.groupId }, retry.id);
  store.records.save('jobs', { ...store.records.get('jobs', dependency.id), taskId: retry.id, status: 'queued' }, dependency.id);
  control.claimLocal(retry);
  control.finishLocal(retry.id, 1, { status: 'completed', result: 'Research ready' });
  assert.equal(control.eligible(store.task(next.taskId), 'local'), true);
  assert.ok(control.claimLocal(store.task(next.taskId)));
});

test('successful child retry clears only automatic child-failure blocking and schedules parent summary', async t => {
  const { store, control, request } = setup(t);
  const parent = control.createJob({ role: 'product', prompt: 'Deliver' });
  const claimed = control.claimLocal(store.task(parent.taskId));
  const child = control.createJob({ role: 'developer', prompt: 'Implement' }, control.validateInstanceToken(claimed.token));
  control.claimLocal(store.task(child.taskId));
  control.finishLocal(parent.taskId, 1, { status: 'completed', result: 'Delegated' });
  control.finishLocal(child.taskId, 1, { status: 'failed', error: 'Provider unavailable' });
  assert.equal(store.records.get('jobs', parent.id).status, 'blocked');
  const retry = await request(`jobs/${child.id}/retry`);
  control.claimLocal(store.task(retry.body.taskId));
  control.finishLocal(retry.body.taskId, 1, { status: 'completed', result: 'Implementation ready' });
  assert.equal(store.records.get('jobs', parent.id).status, 'queued');
  assert.ok(store.records.get('jobs', parent.id).summaryTaskId);
  assert.equal(store.records.get('attention', `children:${parent.id}`).status, 'resolved');
});

test('resume uses a new isolated attempt and retains the requested route and frozen assistant', async t => {
  const { store, control, request } = setup(t);
  const job = control.createJob({ role: 'assistant', prompt: 'Research' });
  const snapshot = store.role('assistant');
  store.records.save('task-meta', { ...store.records.get('task-meta', job.taskId), allowedProviderIds: ['provider-one'], assistantSnapshot: snapshot }, job.taskId);
  store.records.save('jobs', { ...job, status: 'paused', requirementVersion: 3 }, job.id);
  let received;
  control.createTask = input => { received = input; return store.createTask(input); };
  assert.equal((await request(`jobs/${job.id}/resume`, { providerIds: ['provider-two'] })).status, 201);
  assert.equal(received.workspaceMode, 'isolated');
  assert.deepEqual(received.providerIds, ['provider-two']);
  assert.equal(received.requirementVersion, 3);
  assert.deepEqual(received.assistantSnapshot, snapshot);
});

test('instance inbox is scoped, idempotent and survives reconnection without exposing another group', async t => {
  const { control, store } = setup(t);
  const parent = control.createJob({ role: 'product', prompt: 'Plan' });
  const parentClaim = control.claimLocal(store.task(parent.taskId));
  const sender = control.validateInstanceToken(parentClaim.token);
  const child = control.createJob({ role: 'developer', prompt: 'Implement', permissions: ['deploy'] }, sender);
  const childClaim = control.claimLocal(store.task(child.taskId));
  const receiver = control.validateInstanceToken(childClaim.token);
  assert.deepEqual(receiver.permissions, []);
  const body = { toTaskId: child.taskId, content: 'Use version one', idempotencyKey: 'contract-1', kind: 'notice' };
  const message = control.sendMessage(body, sender);
  assert.equal(control.sendMessage(body, sender).id, message.id);
  assert.throws(() => control.sendMessage({ ...body, content: 'Different content' }, sender), /幂等键/);
  assert.equal(control.readMessages(child.taskId, receiver)[0].status, 'received');
  assert.throws(() => control.readMessages(child.taskId, sender), /自己的/);
  assert.equal(control.acknowledge(message.id, { status: 'processed' }, receiver).status, 'processed');
  assert.equal(control.acknowledge(message.id, { status: 'received' }, receiver).status, 'processed');
  const outside = control.createJob({ role: 'assistant', prompt: 'Private task' });
  assert.throws(() => control.sendMessage({ ...body, toTaskId: outside.taskId }, sender), /其他任务组/);
  control.revokeExecution(parent.taskId);
  assert.throws(() => control.validateInstanceToken(parentClaim.token), /撤销/);
});

test('stable assistant mailbox waits for a new instance without waking an archived assistant', t => {
  const { control, store } = setup(t);
  store.archiveRole('assistant', true);
  const message = control.sendMessage({ toAgentId: 'assistant', content: 'For the next run' }, { type: 'owner' });
  assert.equal(message.toTaskId, null);
  assert.equal(store.tasks().length, 0);
  store.archiveRole('assistant', false);
  const job = control.createJob({ role: 'assistant', prompt: 'Continue' });
  const claim = control.claimLocal(store.task(job.taskId));
  const principal = control.validateInstanceToken(claim.token);
  assert.equal(control.readMessages(job.taskId, principal)[0].id, message.id);
});

test('shared board detects concurrent edits and external operation grants cannot be escalated', async t => {
  const { control, store } = setup(t);
  const job = control.createJob({ role: 'developer', prompt: 'Implement', permissions: ['push'] });
  const claim = control.claimLocal(store.task(job.taskId));
  const principal = control.validateInstanceToken(claim.token);
  const board = control.saveScoped('board', { title: 'Contract', content: 'v1' }, principal);
  control.saveScoped('board', { title: 'Contract', content: 'v2', expectedRevision: board.revision }, principal, board.id);
  assert.throws(() => control.saveScoped('board', { title: 'Contract', content: 'v3', expectedRevision: board.revision }, principal, board.id), /已更新/);
  assert.throws(() => control.operation({ action: 'deploy', idempotencyKey: 'deploy1', intent: 'production' }, principal), /没有/);
  const operation = { action: 'push', idempotencyKey: 'push1', intent: 'review branch' };
  const started = control.operation(operation, principal);
  assert.equal(started.canExecute, true);
  assert.equal(control.operation(operation, principal).canExecute, false);
  await control.handle({ method: 'POST', parts: ['operations', started.id, 'result'], principal,
    body: { status: 'unknown', evidence: 'Connection dropped after submission' } });
  assert.equal(control.operation(operation, principal).status, 'unknown');
  assert.equal(control.operation(operation, principal).canExecute, false);
});

test('parent waits for children and enqueues one summary attempt after all children complete', t => {
  const { control, store } = setup(t);
  const parent = control.createJob({ role: 'product', prompt: 'Deliver feature' });
  const claimed = control.claimLocal(store.task(parent.taskId));
  const principal = control.validateInstanceToken(claimed.token);
  const one = control.createJob({ role: 'developer', prompt: 'Backend' }, principal);
  const two = control.createJob({ role: 'assistant', prompt: 'Review' }, principal);
  control.claimLocal(store.task(one.taskId));
  control.claimLocal(store.task(two.taskId));
  control.finishLocal(parent.taskId, 1, { status: 'completed', result: 'Delegated' });
  assert.equal(store.records.get('jobs', parent.id).status, 'waiting_children');
  control.finishLocal(one.taskId, 1, { status: 'completed', result: 'Backend ready' });
  assert.equal(store.records.get('jobs', parent.id).status, 'waiting_children');
  control.finishLocal(two.taskId, 1, { status: 'completed', result: 'Review ready' });
  const summary = store.records.get('jobs', parent.id);
  assert.notEqual(summary.taskId, parent.taskId);
  assert.equal(summary.taskId, summary.summaryTaskId);
  const summaryClaim = control.claimLocal(store.task(summary.taskId));
  assert.throws(() => control.createJob({ role: 'developer', prompt: 'Infinite loop' }, control.validateInstanceToken(summaryClaim.token)), /汇总/);
  control.finishLocal(summary.taskId, 1, { status: 'completed', result: 'Verified delivery' });
  assert.equal(store.records.get('jobs', parent.id).status, 'completed');
  assert.equal(store.tasks().length, 4);
});

test('pause revokes descendants and resume creates a new instance preserving checkpoint context', async t => {
  const { control, store, request } = setup(t);
  const job = control.createJob({ role: 'developer', prompt: 'Implement' });
  const claim = control.claimLocal(store.task(job.taskId));
  const principal = control.validateInstanceToken(claim.token);
  const child = control.createJob({ role: 'assistant', prompt: 'Research' }, principal);
  const childClaim = control.claimLocal(store.task(child.taskId));
  control.saveScoped('checkpoints', { title: 'Halfway', content: 'Tests remain', nextSteps: ['Test'] }, principal);
  assert.equal((await request(`jobs/${job.id}/pause`)).status, 200);
  assert.throws(() => control.validateInstanceToken(childClaim.token), /撤销/);
  const resumed = await request(`jobs/${job.id}/resume`);
  assert.equal(resumed.status, 201);
  assert.notEqual(resumed.body.taskId, job.taskId);
  assert.equal(store.task(resumed.body.taskId).sourceTaskId, job.taskId);
});

test('requirement changes notify the whole group and older artifacts stay marked until the agent acknowledges', async t => {
  const { control, store, request } = setup(t);
  const job = control.createJob({ role: 'product', prompt: 'Version one' });
  const parent = control.claimLocal(store.task(job.taskId));
  const child = control.createJob({ role: 'developer', prompt: 'Implementation' }, control.validateInstanceToken(parent.token));
  const claimed = control.claimLocal(store.task(child.taskId));
  await request(`jobs/${job.id}`, { goal: 'Version two' }, undefined, 'PUT');
  let principal = control.validateInstanceToken(claimed.token);
  assert.equal(principal.requirementVersion, 1);
  assert.equal(store.records.get('jobs', child.id).requirementVersion, 2);
  const artifact = control.saveScoped('artifacts', { title: 'Old result', location: 'output.md', evidence: 'Tested v1' }, principal);
  assert.equal(artifact.status, 'needs-review');
  const inbox = control.readMessages(child.taskId, principal);
  const update = inbox.find(message => message.requirementUpdate);
  assert.equal(update.requirementVersion, 2);
  control.acknowledge(update.id, { status: 'processed' }, principal);
  principal = control.validateInstanceToken(claimed.token);
  assert.equal(principal.requirementVersion, 2);
  const current = control.saveScoped('artifacts', { title: 'Current result', location: 'output-v2.md', evidence: 'Tested v2' }, principal);
  assert.equal(current.status, 'submitted');
});

test('owner auth has no public setup endpoint and sessions expire and are revoked on password change', async t => {
  const { store, advance } = setup(t);
  let now = 10000;
  const auth = new AuthService({ store, requireAuth: true, ownerPassword: 'correct horse battery staple', secureCookies: true, now: () => now });
  await auth.init();
  const req = { headers: {}, socket: { remoteAddress: '203.0.113.1' } };
  assert.equal(auth.authorize(req).authorized, false);
  assert.equal((await auth.handle({ method: 'POST', parts: ['auth', 'setup'], body: {}, req })).status, 404);
  assert.equal((await auth.handle({ method: 'POST', parts: ['auth', 'login'], body: { password: 'wrong' }, req })).status, 401);
  const login = await auth.handle({ method: 'POST', parts: ['auth', 'login'], body: { password: 'correct horse battery staple' }, req });
  assert.equal(login.status, 200);
  assert.match(login.headers['Set-Cookie'], /HttpOnly; SameSite=Strict.*Secure/);
  const authenticated = { ...req, headers: { cookie: login.headers['Set-Cookie'].split(';')[0] } };
  assert.equal(auth.authorize(authenticated).authorized, true);
  await auth.setPassword('another sufficiently long password');
  assert.equal(auth.authorize(authenticated).authorized, false);
  now += 13 * 60 * 60_000;
  advance(1);
  assert.equal(auth.authorize(authenticated).authorized, false);
});

test('MCP tools derive sender identity from a revocable instance token', async t => {
  const { control, store } = setup(t);
  const job = control.createJob({ role: 'assistant', prompt: 'Research' });
  const claim = control.claimLocal(store.task(job.taskId));
  const server = createOrchestrationServer({ control, token: claim.token });
  const client = new Client({ name: 'test', version: '1' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  t.after(async () => { await client.close(); await server.close(); });
  assert.ok((await client.listTools()).tools.some(tool => tool.name === 'read_inbox'));
  const response = await client.callTool({ name: 'save_checkpoint', arguments: { title: 'Progress', content: 'Read sources' } });
  const checkpoint = JSON.parse(response.content[0].text);
  assert.equal(checkpoint.agentId, 'assistant');
  assert.equal(checkpoint.taskId, job.taskId);
  control.revokeExecution(job.taskId);
  assert.equal((await client.callTool({ name: 'read_inbox', arguments: {} })).isError, true);
});

test('MCP capability listing is scoped to the running assistant and omits secrets', async t => {
  const { control, store } = setup(t);
  store.records.save('capabilities', {
    name: 'Private docs', kind: 'mcp', version: '1.2.3', digest: 'sha256-fixture',
    enabled: true, tools: ['read_docs'], credentialId: 'secret-ref',
    envRefs: { DOCS_TOKEN: 'secret-ref' }, url: 'https://docs.example.test/mcp',
    health: { ok: true, checkedAt: '2026-09-20T00:00:00.000Z', tools: [{ name: 'read_docs', description: 'Read docs' }] },
  }, 'cap-private-docs');
  store.saveRole({ name: 'Scoped assistant', instructions: 'Inspect docs.', skillIds: ['personal-workflow'], capabilityIds: ['cap-private-docs'] }, 'assistant');
  const job = control.createJob({ role: 'assistant', prompt: 'Inspect docs' });
  const claim = control.claimLocal(store.task(job.taskId));
  const server = createOrchestrationServer({ control, token: claim.token });
  const client = new Client({ name: 'capability-list-test', version: '1' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  t.after(async () => { await client.close(); await server.close(); });
  const response = await client.callTool({ name: 'list_capabilities', arguments: {} });
  assert.equal(response.isError, undefined);
  const result = JSON.parse(response.content[0].text);
  assert.deepEqual(result.skills, [{ id: 'personal-workflow', name: '资料与行动计划', role: 'assistant' }]);
  assert.equal(result.capabilities[0].name, 'Private docs');
  assert.deepEqual(result.capabilities[0].tools, ['read_docs']);
  assert.equal(JSON.stringify(result).includes('credentialId'), false);
  assert.equal(JSON.stringify(result).includes('secret-ref'), false);
  assert.equal(JSON.stringify(result).includes('docs.example.test'), false);
});

test('MCP capability commands require a bound plugin and enqueue a controlled child task', async t => {
  const { control, store } = setup(t);
  store.saveRole({ ...store.role('assistant'), capabilityIds: ['cap-plugin'] }, 'assistant');
  const parent = control.createJob({ role: 'assistant', prompt: 'Run the approved command' });
  const claim = control.claimLocal(store.task(parent.taskId));
  let received;
  control.createTask = input => {
    received = input;
    return store.createTask(input);
  };
  const capabilities = {
    commandTask(capabilityId, commandId, input) {
      assert.equal(capabilityId, 'cap-plugin');
      assert.equal(commandId, 'summarize');
      assert.equal(input.arguments, 'docs');
      return {
        role: input.role,
        prompt: 'Summarize docs',
        nodeId: input.nodeId,
        workspaceKey: input.workspaceKey,
        workspaceMode: input.workspaceMode,
        assistantSnapshot: { ...store.role(input.role), capabilityIds: ['cap-plugin'] },
        contextExtra: 'plugin command context',
        capabilityCommand: { capabilityId, commandId, digest: 'sha256-fixture' },
      };
    },
  };
  const server = createOrchestrationServer({ control, token: claim.token, capabilities });
  const client = new Client({ name: 'capability-command-test', version: '1' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  t.after(async () => { await client.close(); await server.close(); });
  const response = await client.callTool({ name: 'run_capability_command', arguments: {
    capabilityId: 'cap-plugin', commandId: 'summarize', arguments: 'docs',
  } });
  assert.equal(response.isError, undefined);
  const child = JSON.parse(response.content[0].text);
  assert.equal(child.parentJobId, parent.id);
  assert.equal(child.role, 'assistant');
  assert.equal(received.capabilityCommand.commandId, 'summarize');
  assert.equal(received.contextExtra, 'plugin command context');
  const denied = await client.callTool({ name: 'run_capability_command', arguments: {
    capabilityId: 'cap-other', commandId: 'summarize', arguments: 'docs',
  } });
  assert.equal(denied.isError, true);
  assert.match(denied.content[0].text, /未绑定/);
});

test('worker rejects insecure remote control, resolves local workspace mapping and retains rejected results', async t => {
  const { directory, workspace } = setup(t);
  assert.throws(() => validateControlUrl('http://example.com'), /HTTPS/);
  assert.throws(() => validateControlUrl('https://user:secret@example.com'), /HTTPS/);
  const client = new NodeClient({ controlUrl: 'http://127.0.0.1:3089', dataDir: path.join(directory, 'node'), workspaces: { default: workspace },
    runtimeFactory: () => ({}), fetchImpl: async () => new Response(JSON.stringify({ error: 'Lease expired' }), { status: 409 }) });
  t.after(() => client.close());
  const task = { task: { id: 'example-task', workspace: '/arbitrary/remote/path' }, workspaceKey: 'default' };
  const prepared = await client.isolatedWorkspace(task);
  assert.ok(prepared.workspace.startsWith(path.join(directory, 'node')));
  assert.notEqual(prepared.workspace, task.task.workspace);
  await assert.rejects(client.isolatedWorkspace(task), /已经存在/);
  await assert.rejects(client.isolatedWorkspace({ ...task, workspaceKey: 'missing' }), /映射/);
  client.enqueueResult('example-task', 1, { status: 'completed', result: 'done' });
  client.enqueueResult('example-task', 1, { status: 'completed', result: 'duplicate' });
  assert.equal(client.db.prepare('SELECT COUNT(*) AS n FROM outbox').get().n, 1);
  await client.flushOutbox();
  assert.equal(client.db.prepare('SELECT COUNT(*) AS n FROM outbox').get().n, 0);
  assert.equal(client.db.prepare('SELECT COUNT(*) AS n FROM rejected_results').get().n, 1);
});

test('worker self-stops an expired lease even without a successful controller heartbeat', async t => {
  const { directory, workspace } = setup(t);
  let time = 10000, cancelled = 0;
  const client = new NodeClient({ controlUrl: 'http://localhost:3089', dataDir: path.join(directory, 'node-stop'), workspaces: { default: workspace },
    runtimeFactory: () => ({}), now: () => time, fetchImpl: async () => { throw new Error('offline'); } });
  t.after(() => client.close());
  client.active.set('task', { taskId: 'task', epoch: 1, deadline: 11000, done: false, stopping: false,
    run: { cancel: async () => { cancelled++; } } });
  time = 12000;
  await client.stopExpired();
  assert.equal(cancelled, 1);
  assert.equal(client.active.size, 0);
  assert.equal(client.db.prepare('SELECT COUNT(*) AS n FROM outbox').get().n, 1);
});

test('HTTP and TCP monitors execute deterministically without a model', async t => {
  const server = http.createServer((_req, res) => res.end('ok'));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const port = server.address().port;
  assert.equal((await runNodeCheck({ kind: 'http', url: `http://127.0.0.1:${port}` })).status, 'completed');
  assert.equal((await runNodeCheck({ kind: 'tcp', host: '127.0.0.1', port })).status, 'completed');
  assert.equal((await runNodeCheck({ kind: 'tcp', host: '127.0.0.1', port: 0 })).status, 'failed');
});

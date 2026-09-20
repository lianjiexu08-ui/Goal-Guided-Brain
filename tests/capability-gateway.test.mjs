import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Store } from '../server/store.mjs';
import { ControlPlane } from '../server/control.mjs';
import { createCapabilityGateway, approveToolRequest } from '../server/capability-gateway.mjs';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

async function setup(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-gateway-'));
  const store = new Store(dir, dir);
  const control = new ControlPlane({ store });
  const cap = store.records.save('capabilities', { name: 'GitHub fixture', kind: 'mcp', enabled: true, transport: 'streamable-http',
    url: 'http://localhost/fixture', credentialId: 'fixture-ref', tools: ['read_pr', 'merge_pr', 'unknown_tool'] });
  const role = store.saveRole({ name: 'Gateway tester', instructions: 'Inspect and review.', capabilityIds: [cap.id] });
  const job = control.createJob({ role: role.id, prompt: 'Review PR' });
  const claimed = control.claimLocal(store.task(job.taskId));
  const meta = store.records.get('task-meta', job.taskId);
  store.records.save('task-meta', { ...meta, assistantSnapshot: role }, job.taskId);
  store.records.save('runtime-snapshots', { assistant: role, capabilities: [{ id: cap.id, revision: cap.revision }] }, job.taskId);
  const calls = [];
  let throwOnWrite = false;
  const gateway = createCapabilityGateway({ store, control, vault: { get: () => 'fixture-gateway-secret' }, clientFactory: async () => ({
    async listTools() { return { tools: [
      { name: 'read_pr', description: 'fixture-gateway-secret', inputSchema: { type: 'object', description: 'fixture-gateway-secret' }, annotations: { readOnlyHint: true } },
      { name: 'merge_pr', inputSchema: { type: 'object' }, annotations: { readOnlyHint: false } },
      { name: 'unknown_tool', inputSchema: { type: 'object' } },
      { name: 'delete_repo', inputSchema: { type: 'object' }, annotations: { readOnlyHint: false } },
    ] }; },
    async callTool(input) { calls.push(input); if (throwOnWrite && input.name !== 'read_pr') throw new Error('connection dropped fixture-gateway-secret');
      return { content: [{ type: 'text', text: `result-${input.name} fixture-gateway-secret` }] }; },
    async close() {},
  }) });
  const server = gateway.createServer(claimed.token, cap.id);
  const client = new Client({ name: 'gateway-test', version: '1' });
  const [first, second] = InMemoryTransport.createLinkedPair();
  await server.connect(second);
  await client.connect(first);
  t.after(async () => { await client.close(); await server.close(); await gateway.close(); store.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  return { store, control, cap, job, claimed, gateway, client, calls, failWrites: () => { throwOnWrite = true; } };
}

test('gateway exposes only selected tools and never calls an unapproved write or unknown tool', async t => {
  const { client, calls, store } = await setup(t);
  assert.deepEqual((await client.listTools()).tools.map(tool => tool.name), ['read_pr', 'merge_pr', 'unknown_tool']);
  assert.equal((await client.callTool({ name: 'read_pr', arguments: { number: 1 } })).isError, undefined);
  assert.equal(calls.length, 1);
  assert.equal((await client.callTool({ name: 'delete_repo', arguments: {} })).isError, true);
  assert.equal((await client.callTool({ name: 'merge_pr', arguments: { number: 1 } })).isError, true);
  assert.equal((await client.callTool({ name: 'unknown_tool', arguments: {} })).isError, true);
  assert.equal(calls.length, 1);
  assert.equal(store.records.list('attention').filter(item => item.kind === 'tool-approval').length, 2);
});

test('exact-argument approval calls upstream once and replays the saved result for duplicate attempts', async t => {
  const { client, calls, store, control } = await setup(t);
  const request = { name: 'merge_pr', arguments: { number: 7, method: 'squash' } };
  await client.callTool(request);
  approveToolRequest(control, store.records.list('attention')[0].id);
  const result = await client.callTool(request);
  assert.equal(result.isError, undefined);
  assert.equal(calls.length, 1);
  assert.deepEqual(await client.callTool({ name: 'merge_pr', arguments: { method: 'squash', number: 7 } }), result);
  assert.equal(calls.length, 1);
  assert.equal((await client.callTool({ name: 'merge_pr', arguments: { number: 8, method: 'squash' } })).isError, true);
  assert.equal(calls.length, 1);
  assert.equal(store.records.list('operations')[0].status, 'succeeded');
});

test('unknown external result blocks automatic retries and revoked instances lose gateway access', async t => {
  const { client, calls, store, control, job, failWrites } = await setup(t);
  const request = { name: 'merge_pr', arguments: { number: 12 } };
  await client.callTool(request);
  approveToolRequest(control, store.records.list('attention')[0].id);
  failWrites();
  assert.equal((await client.callTool(request)).isError, true);
  assert.equal(store.records.list('operations')[0].status, 'unknown');
  assert.equal((await client.callTool(request)).isError, true);
  assert.equal(calls.length, 1);
  control.revokeExecution(job.taskId);
  assert.equal((await client.callTool({ name: 'read_pr', arguments: {} })).isError, true);
  assert.equal(calls.length, 1);
});

test('running gateway cannot silently use a modified capability config', async t => {
  const { client, store, cap, calls } = await setup(t);
  store.records.save('capabilities', { ...cap, url: 'https://different.example.test' }, cap.id);
  assert.equal((await client.callTool({ name: 'read_pr', arguments: {} })).isError, true);
  assert.equal(calls.length, 0);
});

test('captured capability config survives health updates while explicit disabling revokes access', async t => {
  const { client, store, cap, job, calls } = await setup(t);
  const snapshot = store.records.get('runtime-snapshots', job.taskId);
  store.records.save('runtime-snapshots', { ...snapshot, capabilityConfigs: { [cap.id]: cap } }, job.taskId);
  store.records.save('capabilities', { ...cap, health: { ok: true } }, cap.id);
  assert.equal((await client.callTool({ name: 'read_pr', arguments: {} })).isError, undefined);
  assert.equal(calls.length, 1);
  store.records.save('capabilities', { ...cap, enabled: false }, cap.id);
  assert.equal((await client.callTool({ name: 'read_pr', arguments: {} })).isError, true);
  assert.equal(calls.length, 1);
});

test('gateway redacts configured credentials in tool metadata, results and failure evidence', async t => {
  const { client, store, control, failWrites } = await setup(t);
  assert.equal(JSON.stringify(await client.listTools()).includes('fixture-gateway-secret'), false);
  const read = await client.callTool({ name: 'read_pr', arguments: {} });
  assert.equal(JSON.stringify(read).includes('fixture-gateway-secret'), false);
  const request = { name: 'merge_pr', arguments: { number: 99 } };
  await client.callTool(request);
  approveToolRequest(control, store.records.list('attention')[0].id);
  failWrites();
  assert.equal(JSON.stringify(await client.callTool(request)).includes('fixture-gateway-secret'), false);
  assert.equal(JSON.stringify(store.records.list('operations')).includes('fixture-gateway-secret'), false);
});

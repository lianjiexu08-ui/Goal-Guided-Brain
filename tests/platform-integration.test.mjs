import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { createWorkbench } from '../server/index.mjs';
import { NodeClient } from '../server/node-client.mjs';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

async function until(predicate) {
  for (let attempt = 0; attempt < 150; attempt++) {
    if (predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.fail('Expected state was not reached');
}
function environment(t, values) {
  const previous = Object.fromEntries(Object.keys(values).map(key => [key, process.env[key]]));
  for (const [key, value] of Object.entries(values)) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
  t.after(() => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  });
}
async function fixture(t, env = {}) {
  environment(t, { WORKBENCH_PUBLIC_URL: undefined, WORKBENCH_REQUIRE_AUTH: undefined, WORKBENCH_BIND_HOST: undefined,
    WORKBENCH_OWNER_PASSWORD: undefined, DEEPSEEK_API_KEY: 'fixture-integration-model-key', ...env });
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-platform-'));
  const workspace = path.join(directory, 'source');
  fs.mkdirSync(workspace);
  const runtimes = [];
  const runtimeFactory = options => {
    const run = {
      options,
      start(prompt) { this.prompt = prompt; runtimes.push(run); },
      complete(result = 'verified result') { options.onResult(result); options.onDone('completed', ''); },
      async cancel() { options.onDone('cancelled', ''); },
    };
    return run;
  };
  const app = createWorkbench({ dataDir: path.join(directory, 'controller'), workspace, requireCredential: false, runtimeFactory });
  await app.platform.ready;
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${app.server.address().port}`;
  const clients = [];
  t.after(async () => {
    for (const client of clients) await client.close();
    await app.close();
    fs.rmSync(directory, { recursive: true, force: true });
  });
  const request = async (route, body, method = 'POST', headers = {}) => {
    const response = await fetch(`${url}/api/${route}`, { method, headers: { 'Content-Type': 'application/json', ...headers },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: response.status, body: await response.json(), headers: response.headers };
  };
  return { app, url, request, directory, workspace, runtimes, runtimeFactory, clients };
}

test('HTTP tasks preserve legacy endpoints and expose a real authenticated orchestration MCP', async t => {
  const { app, request, runtimes, clients } = await fixture(t);
  const result = await request('tasks', { role: 'assistant', prompt: 'Research and verify', workspaceMode: 'shared' });
  assert.equal(result.status, 201);
  await until(() => runtimes.length === 1);
  const patch = runtimes[0].options.capabilityPatch.find(item => item.id === 'workbench-orchestration');
  assert.ok(patch.config.headers.Authorization.startsWith('Bearer '));
  const client = new Client({ name: 'platform-test', version: '1.0' });
  clients.push(client);
  const transport = new StreamableHTTPClientTransport(new URL(patch.config.url), { requestInit: { headers: patch.config.headers } });
  await client.connect(transport);
  const inbox = await client.callTool({ name: 'read_inbox', arguments: {} });
  assert.deepEqual(JSON.parse(inbox.content[0].text).items, []);
  await client.callTool({ name: 'save_checkpoint', arguments: { title: 'Research done', content: 'Evidence checked' } });
  const metadata = app.store.records.get('task-meta', result.body.id);
  assert.ok(metadata.jobId);
  const job = await request(`jobs/${metadata.jobId}`, undefined, 'GET');
  assert.equal(job.body.tasks[0].id, result.body.id);
  assert.equal(job.body.checkpoints[0].content, 'Evidence checked');
  runtimes[0].complete();
  await until(() => app.store.task(result.body.id).status === 'completed');
  await assert.rejects(client.listTools(), /401|Unauthorized|撤销|过期/);
  const state = await request('state', undefined, 'GET');
  assert.equal(state.status, 200);
  assert.equal(JSON.stringify(state.body).includes('fixture-integration-model-key'), false);
});

test('a configured public origin requires login even through a loopback reverse proxy', async t => {
  const { request } = await fixture(t, { WORKBENCH_PUBLIC_URL: 'https://workbench.example.test', WORKBENCH_OWNER_PASSWORD: 'fixture-owner-password-12345' });
  assert.equal((await request('manage', undefined, 'GET')).status, 401);
  const login = await request('auth/login', { password: 'fixture-owner-password-12345' });
  assert.equal(login.status, 200);
  const cookie = login.headers.get('set-cookie');
  assert.match(cookie, /Secure/);
  assert.equal((await request('manage', undefined, 'GET', { Cookie: cookie.split(';')[0] })).status, 200);
  assert.equal((await request('nodes/pairing', {})).status, 401);
  assert.equal((await request('nodes/claim', {})).status, 401);
});

test('real HTTP node pair claim mapped workspace MCP and durable report complete a remote attempt', async t => {
  const { app, request, url, directory, workspace, clients } = await fixture(t);
  const remote = [];
  const node = new NodeClient({ controlUrl: url, dataDir: path.join(directory, 'remote-node'), workspaces: { project: workspace },
    runtimeFactory: options => {
      const run = { options, start(prompt) { run.prompt = prompt; remote.push(run); },
        complete() { options.onResult('remote evidence'); options.onDone('completed', ''); },
        cancel() { options.onDone('cancelled', ''); } };
      return run;
    } });
  clients.push(node);
  const code = await request('nodes/pairing', {});
  const paired = await node.pair({ code: code.body.code, name: 'Remote fixture' });
  const task = await request('tasks', { role: 'developer', prompt: 'Remote development', nodeId: paired.id, workspaceKey: 'project', workspaceMode: 'isolated' });
  assert.equal(task.status, 201);
  await node.tick();
  await until(() => remote.length === 1);
  assert.equal(app.store.records.get('task-meta', task.body.id).workspaceKey, 'project');
  assert.ok(remote[0].options.task.workspace.startsWith(path.join(directory, 'remote-node')));
  assert.notEqual(remote[0].options.task.workspace, workspace);
  assert.ok(remote[0].options.capabilityPatch.some(patch => patch.id === 'workbench-orchestration'));
  const patch = remote[0].options.capabilityPatch.find(patch => patch.id === 'workbench-orchestration');
  const mcp = new Client({ name: 'remote-test', version: '1' });
  await mcp.connect(new StreamableHTTPClientTransport(new URL(patch.config.url), { requestInit: { headers: patch.config.headers } }));
  const agents = await mcp.callTool({ name: 'list_agents', arguments: {} });
  assert.equal(JSON.parse(agents.content[0].text).items[0].taskId, task.body.id);
  await mcp.close();
  remote[0].complete();
  await node.flushOutbox();
  assert.equal(app.store.task(task.body.id).status, 'completed');
  assert.equal(app.store.task(task.body.id).result, 'remote evidence');
  assert.equal(node.db.prepare('SELECT COUNT(*) AS n FROM outbox').get().n, 0);
});

test('remote cancellation revokes tools and rejects a late result without overwriting unknown state', async t => {
  const { app, request, url, directory, workspace, clients } = await fixture(t);
  let run;
  const node = new NodeClient({ controlUrl: url, dataDir: path.join(directory, 'cancel-node'), workspaces: { default: workspace },
    runtimeFactory: options => (run = { options, start() {}, cancel() { options.onDone('cancelled', ''); } }) });
  clients.push(node);
  const code = await request('nodes/pairing', {});
  const paired = await node.pair({ code: code.body.code, name: 'Cancellation fixture' });
  const task = await request('tasks', { role: 'assistant', prompt: 'Long remote task', nodeId: paired.id });
  await node.tick();
  await until(() => !!run);
  assert.equal((await request(`tasks/${task.body.id}/cancel`, {})).status, 200);
  assert.equal(app.store.task(task.body.id).status, 'state_unknown');
  await node.heartbeat();
  assert.equal(node.active.size, 0);
  await node.flushOutbox();
  assert.equal(app.store.task(task.body.id).status, 'state_unknown');
  assert.equal(node.db.prepare('SELECT COUNT(*) AS n FROM rejected_results').get().n, 1);
});

test('remote capability bundles are verified and remapped to node-local content-addressed paths', async t => {
  const { directory, workspace, url, clients } = await fixture(t);
  const node = new NodeClient({ controlUrl: url, dataDir: path.join(directory, 'bundle-node'), workspaces: { default: workspace }, runtimeFactory: () => ({}) });
  clients.push(node);
  const content = Buffer.from('---\nname: review\ndescription: Review source.\n---\nVerify the code.\n');
  const digest = createHash('sha256').update('SKILL.md').update('\0').update(content).digest('hex');
  const assignment = { bundles: [{ digest, sourceRoot: '/controller/skills/review', files: [{ path: 'SKILL.md', base64: content.toString('base64') }] }],
    capabilityPatch: [{ id: 'skill-filesystem', config: { customSkillDirs: ['/controller/skills/review'] } }] };
  const patches = node.installBundles(assignment);
  assert.equal(patches[0].config.customSkillDirs[0], path.join(directory, 'bundle-node', 'capabilities', digest));
  assert.ok(fs.existsSync(path.join(patches[0].config.customSkillDirs[0], 'SKILL.md')));
  assert.deepEqual(node.installBundles(assignment), patches);
  assert.throws(() => node.installBundles({ ...assignment, bundles: [{ ...assignment.bundles[0], digest: '0'.repeat(64) }] }), /摘要/);
  assert.throws(() => node.installBundles({ ...assignment, bundles: [{ ...assignment.bundles[0], files: [{ path: '../escape', base64: '' }] }] }), /路径/);
});

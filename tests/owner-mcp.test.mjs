import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { createWorkbench } from '../server/index.mjs';
import { OWNER_TOOLS, createOwnerToolHandler } from '../server/owner-mcp.mjs';

const cli = path.resolve('scripts/cli.mjs');

async function startWorkbench(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ggb-owner-mcp-'));
  const workspace = path.join(dir, 'project');
  fs.mkdirSync(workspace);
  fs.writeFileSync(path.join(workspace, 'README.md'), '# demo\n');
  const runs = [];
  const app = createWorkbench({
    dir, dataDir: path.join(dir, 'data'), workspace,
    requireCredential: false,
    runtimeFactory: options => ({
      options,
      start(prompt) { this.prompt = prompt; runs.push(this); },
      cancel() { options.onDone('cancelled', ''); },
      complete(result = '已完成。') { options.onResult(result); options.onDone('completed', ''); },
    }),
  });
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  t.after(async () => { await app.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  return { app, base, runs, dir, workspace };
}

async function connect(t, base) {
  const sessionDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ggb-owner-mcp-sess-'));
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [cli, 'mcp', '--api', base],
    env: { ...process.env, DSH_SESSION_DIR: sessionDir, GGB_NO_AUTOSTART: '1' },
    stderr: 'pipe',
  });
  const client = new Client({ name: 'owner-mcp-test', version: '1.0.0' });
  await client.connect(transport);
  t.after(async () => {
    await client.close().catch(() => {});
    fs.rmSync(sessionDir, { recursive: true, force: true });
  });
  const call = async (name, args = {}) => {
    const response = await client.callTool({ name, arguments: args });
    const text = response.content?.[0]?.text || '';
    if (response.isError) return { error: text };
    return JSON.parse(text);
  };
  return { client, call };
}

const waitFor = async (predicate, timeoutMs = 3000) => {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) throw new Error('等待超时');
    await new Promise(resolve => setTimeout(resolve, 20));
  }
};

test('ggb mcp 通过 stdio 暴露所有者工具，且不提供凭据类工具', async t => {
  const { base } = await startWorkbench(t);
  const { client, call } = await connect(t, base);
  const { tools } = await client.listTools();
  const names = tools.map(tool => tool.name).sort();
  assert.deepEqual(names, OWNER_TOOLS.map(tool => tool.name).sort());
  assert.ok(!names.some(name => /vault|credential|login|secret|key/i.test(name)));

  const status = await call('ggb_status');
  assert.equal(status.health.ok, true);
  assert.ok(status.roles.some(role => role.id === 'developer'));
  assert.ok(status.roles.some(role => role.id === 'project_manager'));

  const unknown = await client.callTool({ name: 'ggb_nope', arguments: {} });
  assert.equal(unknown.isError, true);
});

test('大脑流程：建团队 → 交代目标 → 等待项目经理 → 读取团队动态', async t => {
  const { base, runs, workspace } = await startWorkbench(t);
  const { call } = await connect(t, base);

  const bad = await call('ggb_create_team', { name: 'x', goal: 'y', workspace: 'relative/path' });
  assert.match(bad.error, /绝对路径/);

  const created = await call('ggb_create_team', { name: '前端重构组', goal: '重构用户端样式', workspace });
  const teamId = created.team.id;
  assert.equal(created.team.autonomous, true);
  assert.equal(created.team.workspace, workspace);

  const listed = await call('ggb_list_teams');
  assert.ok(listed.some(team => team.id === teamId));

  const sent = await call('ggb_message_team', { teamId, content: '按 docs/spec.md 重写 store.css；验收：1. smoke 通过 2. 无 !important' });
  assert.ok(sent.taskId);
  await waitFor(() => runs.length === 1);
  assert.match(runs[0].prompt, /store\.css/);

  const busy = await call('ggb_wait', { teamId, timeoutSeconds: 1, pollSeconds: 1 });
  assert.equal(busy.done, false);
  assert.equal(busy.timedOut, true);
  assert.equal(busy.activeTasks.length, 1);

  runs[0].complete('需求已理解，等待确认。');
  const settled = await call('ggb_wait', { teamId, timeoutSeconds: 10, pollSeconds: 1 });
  assert.equal(settled.done, true);
  assert.equal(settled.activeTasks.length, 0);

  const team = await call('ggb_get_team', { teamId });
  assert.equal(team.id, teamId);
  assert.ok(team.messages.some(message => message.from === 'owner' && /store\.css/.test(message.content)));
  assert.ok(team.tasks.some(task => task.id === sent.taskId && task.status === 'completed'));

  const updated = await call('ggb_update_team', { teamId, model: 'gpt-5.6' });
  assert.equal(updated.model, 'gpt-5.6');
});

test('点对点派活：dispatch → wait → get_task；验收门禁与参数校验由服务端/工具保留', async t => {
  const { base, runs } = await startWorkbench(t);
  const { call } = await connect(t, base);

  const dispatched = await call('ggb_dispatch_task', { role: 'developer', prompt: '给 README 加一行用法说明', autoVerify: false });
  const taskId = dispatched.task.id;
  await waitFor(() => runs.length === 1);
  runs[0].complete('已在 README 增加用法。');

  const waited = await call('ggb_wait', { taskId, timeoutSeconds: 10, pollSeconds: 1 });
  assert.equal(waited.done, true);
  assert.equal(waited.task.status, 'completed');

  const detail = await call('ggb_get_task', { taskId });
  assert.equal(detail.status, 'completed');
  assert.match(detail.result, /README/);
  assert.equal(detail.role, 'developer');

  const listed = await call('ggb_list_tasks', {});
  assert.ok(Array.isArray(listed));

  const rejectWithoutNote = await call('ggb_decide_delivery', { taskId, decision: 'reject' });
  assert.match(rejectWithoutNote.error, /note/);

  // 没有验证证据的任务不能被验收：服务端门禁原样透传，不被 MCP 绕过。
  const accept = await call('ggb_decide_delivery', { taskId, decision: 'accept', note: '看起来不错' });
  assert.match(accept.error || '', /验收证据/, '缺少验证证据时验收应被服务端门禁拒绝');

  const both = await call('ggb_wait', { taskId, teamId: 'x' });
  assert.match(both.error, /二选一/);

  const attention = await call('ggb_attention', {});
  assert.ok(Array.isArray(attention));
});

test('ggb_wait 超时与轮询逻辑（注入时钟，无真实等待）', async () => {
  let clock = 0;
  const statuses = ['running', 'running', 'completed'];
  const api = async route => {
    assert.equal(route, 'tasks/t1');
    return { id: 't1', status: statuses.shift() ?? 'completed' };
  };
  const handle = createOwnerToolHandler(api, { now: () => clock, wait: async ms => { clock += ms; } });
  const result = await handle('ggb_wait', { taskId: 't1', timeoutSeconds: 60, pollSeconds: 5 });
  assert.equal(result.done, true);
  assert.equal(result.waitedSeconds, 10);

  clock = 0;
  const stuck = createOwnerToolHandler(async () => ({ id: 't2', status: 'running' }), { now: () => clock, wait: async ms => { clock += ms; } });
  const timedOut = await stuck('ggb_wait', { taskId: 't2', timeoutSeconds: 7, pollSeconds: 3 });
  assert.equal(timedOut.timedOut, true);
  assert.equal(timedOut.done, false);
});

test('ggb_decide_delivery 在 ackImpact 时先确认影响面再验收，审核操作要求理由', async () => {
  const calls = [];
  const api = async (route, options = {}) => { calls.push([route, options.method, options.body]); return { ok: true }; };
  const handle = createOwnerToolHandler(api);
  await handle('ggb_decide_delivery', { taskId: 'abc', decision: 'accept', ackImpact: true, note: '证据齐全' });
  assert.deepEqual(calls.map(([route, method]) => [route, method]), [
    ['tasks/abc/impact/ack', 'POST'],
    ['tasks/abc/accept', 'POST'],
  ]);
  await assert.rejects(() => handle('ggb_review_operation', { operationId: 'op1', decision: 'approve' }), /rationale/);
  await handle('ggb_review_operation', { operationId: 'op1', decision: 'approve', rationale: '已核对回滚方案' });
  assert.deepEqual(calls.at(-1), ['operations/op1/review', 'POST', { decision: 'approve', rationale: '已核对回滚方案' }]);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { createWorkbench } from '../server/index.mjs';

const cli = path.resolve('scripts/cli.mjs');

function runCli(args, { env = {} } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cli, ...args], {
      env: { ...process.env, PATH: process.env.PATH, ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '', stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', code => resolve({ code, stdout, stderr }));
  });
}

const waitFor = async (check, timeoutMs = 10000) => {
  const started = Date.now();
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() - started > timeoutMs) return null;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
};

async function startWorkbench(t, runtimeFactory) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ggb-cli-task-'));
  const workspace = path.join(dir, 'project');
  fs.mkdirSync(workspace, { recursive: true });
  const git = (...args) => execFileSync('git', args, { cwd: workspace, stdio: 'pipe' }).toString().trim();
  git('init', '-q');
  git('config', 'user.email', 't@t');
  git('config', 'user.name', 't');
  fs.mkdirSync(path.join(workspace, 'src'), { recursive: true });
  fs.writeFileSync(path.join(workspace, 'src', 'app.js'), 'export const a = 1;\n');
  fs.writeFileSync(path.join(workspace, 'package.json'), JSON.stringify({ scripts: { test: 'node -e "process.exit(0)"' } }));
  git('add', '-A');
  git('commit', '-qm', 'init');

  const app = createWorkbench({
    dir,
    dataDir: path.join(dir, 'data'),
    workspace,
    requireCredential: false,
    runtimeFactory,
  });
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const sessionDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ggb-cli-sess-'));
  t.after(async () => {
    await app.close();
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(sessionDir, { recursive: true, force: true });
  });
  return { app, base, env: { DSH_SESSION_DIR: sessionDir }, workspace };
}

async function hubReachable() {
  // 与 hubCatalog 相同的回退顺序；GitHub API 被限流时 jsDelivr 仍可用。
  for (const url of [
    'https://api.github.com/repos/lianjiexu08-ui/skills-hub/contents/catalog.json?ref=main',
    'https://cdn.jsdelivr.net/gh/lianjiexu08-ui/skills-hub@main/catalog.json',
    'https://raw.githubusercontent.com/lianjiexu08-ui/skills-hub/main/catalog.json',
  ]) {
    try {
      const response = await fetch(url, {
        headers: url.includes('api.github.com') ? { Accept: 'application/vnd.github.raw' } : {},
        signal: AbortSignal.timeout(8000),
      });
      if (response.status === 403 || response.status === 429) continue; // 限流，试下一个源
      if (response.ok) return true;
    } catch {}
  }
  return false;
}

test('ggb skill recommend 输出三类来源与绑定指引', async t => {
  if (!(await hubReachable())) return t.skip('无法连接自维护 Hub');
  const { base, env } = await startWorkbench(t, options => ({
    options,
    start() { options.onDone('cancelled', ''); },
    cancel() { options.onDone('cancelled', ''); },
  }));
  const result = await runCli(['skill', 'recommend', '审阅合同风险', '--api', base], { env });
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /contract-review/);
  assert.match(result.stdout, /Hub/);
  assert.match(result.stdout, /ggb skill install/);

  const json = await runCli(['skill', 'recommend', '代码审查', '--api', base, '--json'], { env });
  assert.equal(json.code, 0, json.stderr);
  const items = JSON.parse(json.stdout);
  assert.ok(Array.isArray(items) && items.length > 0);
  for (const item of items) assert.ok(['builtin', 'installed', 'hub'].includes(item.source));
});

test('ggb skill install 按技能 ID 从自维护 Hub 安装', async t => {
  if (!(await hubReachable())) return t.skip('无法连接自维护 Hub');
  const { app, base, env } = await startWorkbench(t, options => ({
    options,
    start() { options.onDone('cancelled', ''); },
    cancel() { options.onDone('cancelled', ''); },
  }));
  const result = await runCli(['skill', 'install', 'code-review', '--api', base], { env });
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /已安装/);
  const installed = app.platform.capabilities.list().find(item => Array.isArray(item.skills) && item.skills.some(skill => skill.name === 'code-review'));
  assert.ok(installed, '应安装到能力中心');
  assert.equal(installed.enabled, false, '安装后默认不启用');

  const listed = await runCli(['skill', 'list', '--api', base], { env });
  assert.match(listed.stdout, /code-review|代码审查/);
});

test('ggb task 显示影响与验证，且高风险需 ack 后才能验收', async t => {
  const { app, base, env, workspace } = await startWorkbench(t, options => ({
    options,
    start() {
      // 迁移文件 → 高风险；测试脚本可通过 → 有验收证据
      fs.mkdirSync(path.join(options.task.workspace, 'migrations'), { recursive: true });
      fs.writeFileSync(path.join(options.task.workspace, 'migrations', '001.sql'), 'CREATE TABLE t(id int);\n');
      fs.mkdirSync(path.join(options.task.workspace, 'node_modules'), { recursive: true });
      options.onResult('完成迁移。');
      options.onDone('completed', '');
    },
    cancel() { options.onDone('cancelled', ''); },
  }));
  const created = await (await fetch(`${base}/api/tasks`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ role: 'developer', prompt: '加迁移', workspaceMode: 'worktree' }),
  })).json();

  const ready = await waitFor(() => {
    const delivery = app.platform.control.store.taskDelivery(app.platform.control.store.task(created.id));
    return delivery.hasCurrentVerificationEvidence && delivery.impact?.requiresAck ? delivery : null;
  });
  assert.ok(ready, '应同时具备验证证据与高风险影响分析');

  const detail = await runCli(['task', created.id, '--api', base], { env });
  assert.equal(detail.code, 0, detail.stderr);
  assert.match(detail.stdout, /变更影响：高风险（待确认）/);
  assert.match(detail.stdout, /验证：verified/);
  assert.match(detail.stdout, new RegExp(`ggb task ack ${created.id}`));

  // 未确认时验收应失败
  const blocked = await runCli(['task', 'accept', created.id, '--api', base], { env });
  assert.notEqual(blocked.code, 0);
  assert.match(blocked.stderr + blocked.stdout, /高风险|影响面/);

  const ack = await runCli(['task', 'ack', created.id, '--api', base], { env });
  assert.equal(ack.code, 0, ack.stderr);

  const accepted = await runCli(['task', 'accept', created.id, '--api', base, '--note', '通过'], { env });
  assert.equal(accepted.code, 0, accepted.stderr);
  assert.match(accepted.stdout, /已验收通过/);

  // 影响确认后详情应显示已确认
  const after = await runCli(['task', created.id, '--api', base, '--json'], { env });
  const parsed = JSON.parse(after.stdout);
  assert.equal(parsed.impactAcknowledged, true);
  assert.equal(parsed.delivery.acceptanceDecision, 'accepted');
  assert.ok(workspace);
});

test('ggb task reject 需要 --note', async t => {
  const { base, env } = await startWorkbench(t, options => ({
    options,
    start() { options.onDone('cancelled', ''); },
    cancel() { options.onDone('cancelled', ''); },
  }));
  const created = await (await fetch(`${base}/api/tasks`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ role: 'developer', prompt: '随便', workspaceMode: 'shared' }),
  })).json();
  const result = await runCli(['task', 'reject', created.id, '--api', base], { env });
  assert.notEqual(result.code, 0);
  assert.match(result.stderr + result.stdout, /需改什么|--note/);
});

// ---- steer / fork / session：CLI 新子命令 ----

test('ggb task steer 向运行中任务插话', async t => {
  let steered = null;
  const { base, env, app } = await startWorkbench(t, options => ({
    options,
    start() { /* 保持 running */ },
    cancel() { options.onDone('cancelled', ''); },
    enqueue(text) {
      steered = text;
      return { queued: true, id: `q-${Date.now()}` };
    },
  }));
  const created = await (await fetch(`${base}/api/tasks`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ role: 'developer', prompt: '长任务' }),
  })).json();
  const ready = await waitFor(() => app.runs.get(created.id));
  assert.ok(ready, '执行实例应已启动');

  const result = await runCli(['task', 'steer', created.id, '优先处理登录页', '--api', base], { env });
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /已插话/);
  assert.equal(steered, '优先处理登录页');

  const json = await runCli(['task', 'steer', created.id, '--text', '第二条', '--api', base, '--json'], { env });
  assert.equal(json.code, 0, json.stderr);
  assert.equal(JSON.parse(json.stdout).queued, true);
});

test('ggb task session 查看 fork 创建分支', async t => {
  let started = '';
  const { base, env, app } = await startWorkbench(t, options => ({
    options,
    start(prompt) {
      started = options.task.id; /* 保持 running */
      // 通过平台提供的 sessionLog 回调写入追加式会话条目（模拟 DSH 事件）。
      const at = new Date().toISOString();
      options.sessionLog?.({ id: 'e1', parentId: null, taskId: options.task.id, type: 'message', data: { text: prompt.slice(0, 80) }, at });
      options.sessionLog?.({ id: 'e2', parentId: 'e1', taskId: options.task.id, type: 'tool_call', data: { name: 'read', arguments: {} }, at });
    },
    cancel() { options.onDone('cancelled', ''); },
    enqueue() { return { queued: true, id: 'q' }; },
  }));
  const created = await (await fetch(`${base}/api/tasks`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ role: 'developer', prompt: '会话树测试' }),
  })).json();
  await waitFor(() => started);
  await waitFor(() => (app.store.records.listByTask('session-entries', created.id).length >= 2));

  const list = await runCli(['task', 'session', created.id, '--api', base], { env });
  assert.equal(list.code, 0, list.stderr);
  assert.match(list.stdout, /会话条目/);
  assert.match(list.stdout, /message|turn_start|tool_call/);

  const json = await runCli(['task', 'session', created.id, '--api', base, '--json'], { env });
  const parsed = JSON.parse(json.stdout);
  assert.ok(Array.isArray(parsed.entries) && parsed.entries.length > 0);

  const fork = await runCli(['task', 'fork', created.id, '--title', '分支继续', '--api', base], { env });
  assert.equal(fork.code, 0, fork.stderr);
  assert.match(fork.stdout, /已分叉/);
  const forkedTaskId = fork.stdout.match(/新任务 ([\w-]+)/)?.[1];
  assert.ok(forkedTaskId);
  const forkedMeta = app.store.records.get('task-meta', forkedTaskId);
  assert.equal(forkedMeta.forkedFrom, created.id);
  assert.match(String(forkedMeta.contextExtra || ''), /分支摘要/);
});

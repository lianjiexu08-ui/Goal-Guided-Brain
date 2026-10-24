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
  try {
    const response = await fetch('https://api.github.com/repos/lianjiexu08-ui/skills-hub/contents/catalog.json?ref=main', {
      headers: { Accept: 'application/vnd.github.raw' },
      signal: AbortSignal.timeout(8000),
    });
    return response.ok;
  } catch {
    return false;
  }
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

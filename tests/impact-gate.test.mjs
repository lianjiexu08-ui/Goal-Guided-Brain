import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createWorkbench } from '../server/index.mjs';

const waitFor = async (check, timeoutMs = 8000) => {
  const started = Date.now();
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() - started > timeoutMs) return null;
    await new Promise(resolve => setTimeout(resolve, 40));
  }
};

function project(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ggb-impact-e2e-'));
  const workspace = path.join(dir, 'project');
  fs.mkdirSync(workspace, { recursive: true });
  const git = (...args) => execFileSync('git', args, { cwd: workspace, stdio: 'pipe' }).toString().trim();
  git('init', '-q');
  git('config', 'user.email', 't@t');
  git('config', 'user.name', 't');
  fs.mkdirSync(path.join(workspace, 'src'), { recursive: true });
  fs.writeFileSync(path.join(workspace, 'src', 'app.js'), 'export const a = 1;\n');
  // 预先提交 package.json：验证脚本可见，但不算本次改动，避免影响面被判为中风险。
  fs.writeFileSync(path.join(workspace, 'package.json'), JSON.stringify({ scripts: { test: 'node -e "process.exit(0)"' } }));
  git('add', '-A');
  git('commit', '-qm', 'init');
  const base = git('rev-parse', 'HEAD');
  // 目录清理由 start() 的 after 钩子负责（先关应用再删除，避免 Windows 句柄占用）。
  return { dir, workspace, base };
}

function start(t, fixture, runtimeFactory) {
  const app = createWorkbench({
    dir: fixture.dir,
    dataDir: path.join(fixture.dir, 'data'),
    workspace: fixture.workspace,
    requireCredential: false,
    runtimeFactory,
  });
  // after 钩子按注册顺序执行：project() 的目录清理先注册先执行。
  // 在这里先关应用再删目录，避免 Windows 上 SQLite 句柄未释放导致 EBUSY。
  t.after(async () => {
    await app.close();
    // worktree 目录可能被刚退出的 git/验证子进程持续短暂占用（Windows 语义），
    // 清理为尽力而为：断言已全部完成，残留临时目录由系统 temp 策略回收。
    try {
      fs.rmSync(fixture.dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
    } catch (error) {
      console.warn(`[impact-gate] 临时目录清理失败（无碍断言）：${error.message}`);
    }
  });
  return app;
}

const runScript = body => options => ({
  options,
  start() {
    body(options.task.workspace);
    options.onResult('完成。');
    options.onDone('completed', '');
  },
  cancel() { options.onDone('cancelled', ''); },
});

async function createTask(base, body) {
  const response = await fetch(`${base}/api/tasks`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return response.json();
}

test('高风险变更：生成影响证据、产生待处理事项，并阻止验收直到确认', async t => {
  const fixture = project(t);
  // 改动迁移文件 → 高风险
  const app = start(t, fixture, runScript(dir => {
    fs.mkdirSync(path.join(dir, 'migrations'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'migrations', '001_add.sql'), 'CREATE TABLE t(id int);\n');
    fs.mkdirSync(path.join(dir, 'node_modules'), { recursive: true });
  }));
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const task = await createTask(base, { role: 'developer', prompt: '加一个迁移', workspaceMode: 'worktree' });

  const impact = await waitFor(() => app.platform.control.records.get('task-meta', task.id)?.impact);
  assert.ok(impact, '应生成影响分析');
  assert.equal(impact.risk, 'high');
  assert.equal(impact.requiresAck, true);

  const attention = await waitFor(() => app.platform.control.records.get('attention', `impact:${task.id}`));
  assert.ok(attention, '高风险应产生待处理事项');
  assert.equal(attention.kind, 'impact');

  // 等到自动验证完成（避免验收被“缺少验证证据”抢先拦截）
  await waitFor(() => app.platform.control.store.taskDelivery(app.platform.control.store.task(task.id)).hasCurrentVerificationEvidence);

  const blocked = await fetch(`${base}/api/tasks/${task.id}/accept`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ note: '通过' }),
  });
  assert.equal(blocked.status, 409);
  assert.match((await blocked.json()).error, /高风险变更|影响面/);

  const ack = await fetch(`${base}/api/tasks/${task.id}/impact/ack`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ note: '已评估，可接受' }),
  });
  assert.equal(ack.status, 200);

  const accepted = await fetch(`${base}/api/tasks/${task.id}/accept`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ note: '通过' }),
  });
  assert.equal(accepted.status, 200);
  const detail = await (await fetch(`${base}/api/tasks/${task.id}`)).json();
  assert.equal(detail.impactAcknowledged, true);
  assert.equal(detail.delivery.impact.risk, 'high');
});

test('低风险变更不打扰：无待处理事项，可直接验收', async t => {
  const fixture = project(t);
  const app = start(t, fixture, runScript(dir => {
    fs.writeFileSync(path.join(dir, 'src', 'app.js'), 'export const a = 2;\n');
    fs.mkdirSync(path.join(dir, 'node_modules'), { recursive: true });
  }));
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const task = await createTask(base, { role: 'developer', prompt: '改一行', workspaceMode: 'worktree' });

  const impact = await waitFor(() => app.platform.control.records.get('task-meta', task.id)?.impact);
  assert.equal(impact.risk, 'low');
  assert.equal(impact.requiresAck, false);
  assert.equal(app.platform.control.records.get('attention', `impact:${task.id}`), null);

  await waitFor(() => app.platform.control.store.taskDelivery(app.platform.control.store.task(task.id)).hasCurrentVerificationEvidence);
  const accepted = await fetch(`${base}/api/tasks/${task.id}/accept`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ note: '通过' }),
  });
  assert.equal(accepted.status, 200);
});

test('跨团队通知：双向协作团队收到高风险变更通知，且不重复发送', async t => {
  const fixture = project(t);
  const app = start(t, fixture, runScript(dir => {
    fs.mkdirSync(path.join(dir, 'migrations'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'migrations', '002.sql'), 'ALTER TABLE t ADD c int;\n');
  }));
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const store = app.platform.control.store;

  const team = store.saveTeamSpace({ name: '甲团队', goal: 'g', purpose: 'p', workspace: fixture.workspace, pmRoleId: 'project_manager' });
  const other = store.saveTeamSpace({ name: '乙团队', goal: 'g', purpose: 'p', workspace: fixture.workspace, pmRoleId: 'project_manager' });
  for (const id of [team.id, other.id])
    store.saveTeamSpace({ ...store.teamSpace(id), collaboration: { enabled: true, autoHandoff: true, sharedBoard: true, allowedTeamIds: [] } }, id);

  const task = await createTask(base, { role: 'project_manager', prompt: '迁移变更', teamId: team.id, workspaceMode: 'worktree' });
  await waitFor(() => app.platform.control.records.get('task-meta', task.id)?.impact?.requiresNotice);
  const message = await waitFor(() => store.teamMessages(other.id).find(item => item.kind === 'notice' && item.taskId === task.id));
  assert.ok(message, '协作团队应收到通知');
  assert.match(message.content, /高风险变更/);

  // 重复分析不重复通知
  await app.platform.control.handle({ method: 'POST', parts: ['workspaces', task.id, 'verify'], body: { auto: true } });
  assert.equal(store.teamMessages(other.id).filter(item => item.taskId === task.id && item.kind === 'notice').length, 1);
});

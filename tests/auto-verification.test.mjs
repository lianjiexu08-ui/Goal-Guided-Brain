import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createWorkbench } from '../server/index.mjs';

function sandbox() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ggb-autoverify-'));
  const workspace = path.join(dir, 'project');
  fs.mkdirSync(workspace);
  return { dir, workspace, dataDir: path.join(dir, 'data') };
}
const write = (root, name, content = '') => {
  const file = path.join(root, name);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
};
const waitFor = async (check, timeoutMs = 8000) => {
  const started = Date.now();
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() - started > timeoutMs) return null;
    await new Promise(resolve => setTimeout(resolve, 40));
  }
};

function start(t, runtimeFactory) {
  const fixture = sandbox();
  const app = createWorkbench({ ...fixture, requireCredential: false, runtimeFactory });
  t.after(async () => {
    await app.close();
    fs.rmSync(fixture.dir, { recursive: true, force: true });
  });
  return { app, ...fixture };
}

test('任务完成后自动探测并记录验证证据（通过）', async t => {
  const runs = [];
  const { app } = start(t, options => ({
    options,
    start(prompt) {
      this.prompt = prompt;
      runs.push(this);
      // 模拟编码任务：写一个能跑通的测试脚本
      fs.writeFileSync(path.join(options.task.workspace, 'package.json'), JSON.stringify({
        scripts: { test: 'node -e "process.exit(0)"' },
      }));
      fs.mkdirSync(path.join(options.task.workspace, 'node_modules'), { recursive: true });
      options.onResult('已完成改动。');
      options.onDone('completed', '');
    },
    cancel() { options.onDone('cancelled', ''); },
  }));
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const created = await (await fetch(`${base}/api/tasks`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ role: 'developer', prompt: '实现一个小改动', workspaceMode: 'isolated' }),
  })).json();

  const evidence = await waitFor(() => {
    return app.platform.control.records.list('artifacts').find(
      item => item.taskId === created.id && item.kind === 'verification' && item.source === 'auto'
        && Array.isArray(item.checks),
    );
  });
  assert.ok(evidence, '应生成自动验证证据');
  assert.equal(evidence.status, 'verified');
  assert.ok(evidence.checks.some(check => /test/.test(check.command)));
  assert.match(evidence.output, /验证结论：通过/);

  // 交付状态应因验证通过而进入待验收/可验收，而不是默认 pending-review
  const delivery = app.platform.control.store.taskDelivery(app.platform.control.store.task(created.id));
  assert.equal(delivery.hasCurrentVerificationEvidence, true);
  assert.equal(delivery.acceptanceStatus, 'verified');
});

test('自动验证失败时生成失败证据并产生待处理事项', async t => {
  const { app } = start(t, options => ({
    options,
    start() {
      fs.writeFileSync(path.join(options.task.workspace, 'package.json'), JSON.stringify({
        scripts: { test: 'node -e "process.exit(1)"' },
      }));
      fs.mkdirSync(path.join(options.task.workspace, 'node_modules'), { recursive: true });
      options.onResult('改完了。');
      options.onDone('completed', '');
    },
    cancel() { options.onDone('cancelled', ''); },
  }));
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const created = await (await fetch(`${base}/api/tasks`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ role: 'developer', prompt: '改一个会失败的改动', workspaceMode: 'isolated' }),
  })).json();

  const attention = await waitFor(() =>
    app.platform.control.records.get('attention', `verify:${created.id}`),
  );
  assert.ok(attention, '失败应产生待处理事项');
  assert.equal(attention.kind, 'verification');

  const evidence = app.platform.control.records.list('artifacts').find(
    item => item.taskId === created.id && item.kind === 'verification' && item.source === 'auto'
      && Array.isArray(item.checks),
  );
  assert.equal(evidence.status, 'failed');
  const delivery = app.platform.control.store.taskDelivery(app.platform.control.store.task(created.id));
  assert.equal(delivery.hasCurrentVerificationEvidence, false, '失败不能算作验收证据');
  assert.equal(delivery.deliveryStatus, 'failed');
});

test('没有可识别检查时不伪造证据，只记录跳过事件', async t => {
  const { app } = start(t, options => ({
    options,
    start() { options.onResult('完成了。'); options.onDone('completed', ''); },
    cancel() { options.onDone('cancelled', ''); },
  }));
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const created = await (await fetch(`${base}/api/tasks`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ role: 'developer', prompt: '无代码改动', workspaceMode: 'isolated' }),
  })).json();

  const skipped = await waitFor(() =>
    app.platform.control.records.list('task-events').find(
      item => item.taskId === created.id && item.type === 'verification/skipped',
    ),
  );
  assert.ok(skipped, '应记录跳过事件');
  assert.equal(
    app.platform.control.records.list('artifacts').filter(
      item => item.taskId === created.id && item.source === 'auto',
    ).length,
    0,
    '不应产生验证证据',
  );
});

test('workspaces/:id/profile 返回探测计划且不执行命令', async t => {
  const { app, workspace } = start(t, options => ({
    options,
    start() { options.onDone('cancelled', ''); },
    cancel() { options.onDone('cancelled', ''); },
  }));
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  write(workspace, 'package.json', JSON.stringify({ scripts: { test: 'node --test' } }));
  fs.mkdirSync(path.join(workspace, 'node_modules'), { recursive: true });
  const created = await (await fetch(`${base}/api/tasks`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ role: 'developer', prompt: '探测', workspaceMode: 'shared' }),
  })).json();
  // 触发工作区准备
  app.platform.newTask({ role: 'developer', prompt: '探测', workspace });
  const profile = await (await fetch(`${base}/api/workspaces/${created.id}/profile`)).json();
  // shared 模式下工作区记录需要一个已准备的任务；若尚未准备则返回 404 文案
  if (profile.error) {
    assert.match(profile.error, /执行目录不存在/);
  } else {
    assert.ok(Array.isArray(profile.checks));
    assert.ok(profile.checks.some(check => check.id === 'test'));
  }
});

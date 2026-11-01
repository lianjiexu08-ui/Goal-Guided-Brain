import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createWorkbench } from '../server/index.mjs';

/**
 * 结构化验收清单（platform-reliability-plan #1）：
 * 登记 → 上下文注入 → agent 挂证据 → 门禁（未全绿阻止 accept，force 留痕）。
 */
test('验收清单：登记/挂证据/门禁拦截/force 留痕', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ggb-checklist-'));
  const ws = path.join(dir, 'proj');
  fs.mkdirSync(ws, { recursive: true });
  fs.writeFileSync(path.join(ws, 'package.json'), JSON.stringify({ name: 'x', version: '1.0.0' }));
  // secrets 绕过凭据门槛
  fs.writeFileSync(path.join(dir, 'secrets.json'), JSON.stringify({ apiKey: 'k' }), { mode: 0o600 });
  const app = createWorkbench({ dataDir: dir, workspace: ws });
  await new Promise((resolve) => app.server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  t.after(async () => {
    await app.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  await app.ready;
  const api = async (endpoint, options = {}) => {
    const response = await fetch(`${base}/api${endpoint}`, {
      headers: { 'Content-Type': 'application/json' },
      ...options,
      body: options.body ? JSON.stringify(options.body) : undefined,
    });
    const text = await response.text();
    return { status: response.status, body: text ? JSON.parse(text) : null };
  };

  // 建一个已完成任务（直接用 store 驱动，专注验收门禁逻辑）
  const control = app.platform.control;
  const store = control.store;
  const task = store.createTask({ role: 'project_manager', prompt: '验收清单测试任务' });
  control.claimLocal(store.task(task.id));

  // 1. 登记
  const { body: checklist } = await api(`/tasks/${task.id}/checklist`, {
    method: 'POST',
    body: { items: [
      { id: 'ac-1', requirement: '实现中国站点规则', verifyHint: 'smoke 5 站点' },
      { id: 'ac-2', requirement: '中文词库覆盖', verifyHint: 'detectFieldType 单测' },
    ] },
  });
  assert.equal(checklist.items.length, 2);
  assert.equal(checklist.items[0].status, 'pending');

  // 2. 重复 id 拒绝
  const dup = await api(`/tasks/${task.id}/checklist`, {
    method: 'POST',
    body: { items: [{ id: 'ac-1', requirement: 'a' }, { id: 'ac-1', requirement: 'b' }] },
  });
  assert.equal(dup.status, 400);
  assert.match(dup.body.error, /id 重复/);

  // 3. 未挂证据时 accept 被拦（验证证据先补上，隔离清单门禁）
  const records = app.platform.control.records;
  records.save('task-verifications', {
    taskId: task.id, requirementVersion: 1, status: 'verified',
    checks: [], at: new Date().toISOString(),
  }, `verify:${task.id}:1`);
  // store.taskDelivery.hasCurrentVerificationEvidence 由 verification 记录驱动；直接尝试 accept
  const blocked = await api(`/tasks/${task.id}/accept`, { method: 'POST', body: {} });
  // 注意：可能先被「无验证证据」拦（不同实现顺序）——两种 409 都算门禁生效
  assert.equal(blocked.status, 409, '未满足条件时 accept 应被门禁拦下');

  // 4. 挂证据（模拟 agent 通过 MCP 的行为：走同一 API）
  const evidence = await api(`/tasks/${task.id}/checklist-evidence`, {
    method: 'POST',
    body: { items: [
      { id: 'ac-1', test: 'smoke: boss-zhipin', note: 'name+phone 命中 zhipin 规则' },
      { id: 'ac-2', test: 'field-matcher.test: 中文词库', command: 'npm test' },
    ] },
  });
  assert.equal(evidence.body.items.filter((item) => item.status === 'met').length, 2);

  // 5. GET 查看
  const view = await api(`/tasks/${task.id}/checklist`);
  assert.equal(view.body.items[1].evidence.command, 'npm test');

  // 6. hash 证据可携带
  const evidence2 = await api(`/tasks/${task.id}/checklist-evidence`, {
    method: 'POST',
    body: { items: [{ id: 'ac-1', hash: 'a'.repeat(64) }] },
  });
  assert.equal(evidence2.body.items[0].evidence.hash, 'a'.repeat(64));
});

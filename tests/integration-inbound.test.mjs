import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHmac } from 'node:crypto';
import { createWorkbench } from '../server/index.mjs';

function sandbox() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ggb-inbound-'));
  const workspace = path.join(dir, 'project');
  fs.mkdirSync(workspace);
  return { dir, workspace, dataDir: path.join(dir, 'data') };
}

function start(t, runtimeFactory) {
  const fixture = sandbox();
  const app = createWorkbench({ ...fixture, requireCredential: false, runtimeFactory });
  t.after(async () => {
    await app.close();
    fs.rmSync(fixture.dir, { recursive: true, force: true });
  });
  return { app, ...fixture };
}

const fakeRuntime = (runs) => (options) => ({
  options,
  start(prompt) {
    runs.push({ prompt, taskId: options.task.id });
    options.onResult('收到。');
    options.onDone('completed', '');
  },
  cancel() { options.onDone('cancelled', ''); },
});

test('集成入站：密钥校验、团队消息与项目经理轮次', async t => {
  const runs = [];
  const { app } = start(t, fakeRuntime(runs));
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${app.server.address().port}`;

  // 准备一个已确认的团队空间（直接走服务端 store）。
  const space = app.store.saveTeamSpace({
    name: '入站团队', goal: '接收外部消息。', purpose: '测试。',
    workspace: path.join(app.store.config.workspace),
    pmRoleId: 'project_manager',
  });

  // 创建 webhook 集成并绑定团队。
  const created = await app.platform.integrations.save({
    type: 'webhook', name: '测试出口',
    config: { url: 'https://example.com/hook', secret: 'inbound-secret', teamId: space.id },
    events: ['attention'],
  });

  // 错误签名 → 401，且不产生消息和任务。
  const bad = await fetch(`${base}/api/integrations/${created.id}/inbound`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-GGB-Signature': 'bad' },
    body: JSON.stringify({ text: '不该进来' }),
  });
  assert.equal(bad.status, 401);

  // 正确签名 → 200，产生团队消息和项目经理任务。
  const body = JSON.stringify({ text: '帮我检查登录页报错', sender: '企微群' });
  const good = await fetch(`${base}/api/integrations/${created.id}/inbound`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-GGB-Signature': createHmac('sha256', 'inbound-secret').update(body).digest('hex') },
    body,
  });
  assert.equal(good.status, 200);
  const result = await good.json();
  assert.ok(result.messageId && result.taskId);

  const messages = app.store.teamMessages(space.id);
  assert.ok(messages.some(item => item.senderId === `integration:${created.id}` && /帮我检查登录页报错/.test(item.content)));
  // PM 任务异步调度，轮询等待执行实例启动。
  const pmRun = await (async () => {
    for (let at = 0; at < 200; at++) {
      const found = runs.find(run => run.taskId === result.taskId && /帮我检查登录页报错/.test(run.prompt) && /集成/.test(run.prompt));
      if (found) return found;
      await new Promise(resolve => setTimeout(resolve, 40));
    }
    return null;
  })();
  assert.ok(pmRun, `入站消息应触发项目经理轮次；runs=${JSON.stringify(runs.map(run => ({ taskId: run.taskId === result.taskId, head: String(run.prompt).slice(0, 120) })))}`);

  // 空文本 → 400。
  const empty = JSON.stringify({ text: '  ' });
  const emptyRes = await fetch(`${base}/api/integrations/${created.id}/inbound`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-GGB-Signature': createHmac('sha256', 'inbound-secret').update(empty).digest('hex') },
    body: empty,
  });
  assert.equal(emptyRes.status, 400);

  // 管理状态里能看到集成（掩码密钥）。
  const manage = await (await fetch(`${base}/api/manage`)).json();
  assert.ok(Array.isArray(manage.integrations));
  // 掩码只回显尾 4 位：'inbound-secret' → '***cret'。
  assert.equal(manage.integrations[0].config.secret, '***cret');
});

test('bridge 渠道入站：Bearer token 校验', async t => {
  const runs = [];
  const { app } = start(t, fakeRuntime(runs));
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const space = app.store.saveTeamSpace({
    name: '桥接团队', goal: '微信/QQ 桥接入。', purpose: '测试。',
    workspace: path.join(app.store.config.workspace),
    pmRoleId: 'project_manager',
  });
  const created = await app.platform.integrations.save({
    type: 'bridge', name: '微信桥',
    config: { accessToken: 'bridge-token', teamId: space.id },
    events: [],
  });
  const denied = await fetch(`${base}/api/integrations/${created.id}/inbound`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer wrong' },
    body: JSON.stringify({ text: 'x' }),
  });
  assert.equal(denied.status, 401);
  const ok = await fetch(`${base}/api/integrations/${created.id}/inbound`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer bridge-token' },
    body: JSON.stringify({ text: '微信消息', sender: '文件传输助手' }),
  });
  assert.equal(ok.status, 200);
});

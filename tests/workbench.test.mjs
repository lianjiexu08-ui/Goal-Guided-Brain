import test from 'node:test';
import http from 'node:http';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Store } from '../server/store.mjs';
import { createWorkbench } from '../server/index.mjs';

function sandbox() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-workbench-test-'));
  const workspace = path.join(dir, 'project');
  fs.mkdirSync(workspace);
  return { dir, workspace, dataDir: path.join(dir, 'data') };
}
const tick = () => new Promise((r) => setTimeout(r, 20));
test('assistant migration preserves existing instructions and only seeds defaults once', () => {
  const s = sandbox();
  fs.mkdirSync(s.dataDir);
  const legacy = new DatabaseSync(path.join(s.dataDir, 'workspace.sqlite'));
  legacy.exec(
    'CREATE TABLE settings (id INTEGER PRIMARY KEY, data TEXT NOT NULL)',
  );
  legacy
    .prepare('INSERT INTO settings VALUES(1,?)')
    .run(
      JSON.stringify({
        workspace: s.workspace,
        model: 'deepseek-v4-flash',
        maxConcurrent: 3,
        roleInstructions: { product: '用户原先修改的工作规范' },
      }),
    );
  legacy.close();
  let store = new Store(s.dataDir, s.workspace);
  try {
    assert.equal(store.role('product').instructions, '用户原先修改的工作规范');
    const custom = store.saveRole({
      name: '研究员',
      instructions: '阅读资料并列出出处。',
      prompts: ['检索资料'],
      tools: { files: true, web: false, terminal: false },
    });
    assert.ok(custom.id);
    store.saveRole({ name: '我的产品顾问' }, 'product');
    store.archiveRole('developer', true);
    store.close();
    store = new Store(s.dataDir, s.workspace);
    assert.equal(store.roles().length, 4);
    assert.equal(store.role('product').name, '我的产品顾问');
    assert.equal(store.role('developer').archived, true);
    assert.equal(store.role(custom.id).tools.web, false);
    assert.throws(
      () =>
        store.saveRole({
          name: '非法助手',
          instructions: 'test',
          skillIds: ['../../outside'],
        }),
      /Skill/,
    );
    assert.throws(
      () =>
        store.saveRole(
          { tools: { files: true, terminal: 'false', web: true } },
          custom.id,
        ),
      /布尔/,
    );
  } finally {
    store.close();
    fs.rmSync(s.dir, { recursive: true, force: true });
  }
});

test('custom assistant journey persists edits, controls runtime, queues terminal work, and preserves archived history', async () => {
  const s = sandbox(),
    runtimes = [];
  const app = createWorkbench({
    ...s,
    requireCredential: false,
    runtimeFactory: (options) => {
      const run = {
        options,
        start(prompt) {
          run.prompt = prompt;
          runtimes.push(run);
        },
        cancel() {
          options.onDone('cancelled', '');
        },
        complete() {
          options.onResult('已完成研究');
          options.onDone('completed', '');
        },
      };
      return run;
    },
  });
  await new Promise((r) => app.server.listen(0, '127.0.0.1', r));
  const request = async (route, body, method = 'POST') => {
    const response = await fetch(
      `http://127.0.0.1:${app.server.address().port}/api/${route}`,
      {
        method,
        headers: { 'Content-Type': 'application/json' },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      },
    );
    return { status: response.status, body: await response.json() };
  };
  try {
    const created = await request('roles', {
      name: '自定义研究员',
      instructions: '核实证据。',
      model: 'deepseek-v4-pro',
      tools: { files: true, web: false, terminal: true },
      skillIds: ['product-planning'],
      workflow: '写出核对清单。',
    });
    assert.equal(created.status, 201);
    const id = created.body.id;
    await request('knowledge', {
      title: '研究约定',
      content: '研究使用固定证据编号。',
      scope: id,
      state: 'confirmed',
      source: '本人',
    });
    const task = (await request('tasks', { role: id, prompt: '研究证据' }))
      .body;
    await tick();
    assert.equal(runtimes[0].options.assistant.name, '自定义研究员');
    assert.equal(runtimes[0].options.assistant.model, 'deepseek-v4-pro');
    assert.match(runtimes[0].prompt, /固定证据编号/);
    assert.equal((await request(`roles/${id}/archive`, {})).status, 400);
    await request(
      `roles/${id}`,
      {
        name: '证据顾问',
        instructions: '修改后的规范',
        tools: { files: true, web: true, terminal: false },
      },
      'PUT',
    );
    assert.equal(runtimes[0].options.assistant.instructions, '核实证据。');
    const dev = (
      await request('tasks', { role: 'developer', prompt: '验证代码' })
    ).body;
    await tick();
    assert.equal(app.store.task(dev.id).status, 'queued');
    runtimes[0].complete();
    await tick();
    assert.equal(app.store.task(dev.id).status, 'running');
    runtimes[1].complete();
    assert.equal((await request(`roles/${id}/archive`, {})).status, 200);
    assert.equal(
      (await request('tasks', { role: id, prompt: '不能给归档助手发任务' }))
        .status,
      400,
    );
    const handed = await request(`tasks/${task.id}/handoff`, {
      role: 'product',
      note: '继续整理需求',
    });
    assert.equal(handed.status, 201);
    await tick();
    assert.match(runtimes.at(-1).prompt, /来源助手：证据顾问/);
    runtimes.at(-1).complete();
    const state = (await request('state', undefined, 'GET')).body;
    assert.ok(state.sessions.some((session) => session.id === task.sessionId));
    assert.equal(state.roles.find((role) => role.id === id).archived, true);
    assert.equal((await request(`roles/${id}/restore`, {})).status, 200);
    const next = await request('tasks', {
      role: id,
      sessionId: task.sessionId,
      prompt: '继续研究',
    });
    assert.equal(next.status, 201);
    await tick();
    assert.equal(
      runtimes.at(-1).options.assistant.instructions,
      '修改后的规范',
    );
    runtimes.at(-1).complete();
    assert.equal(
      (await request('roles/missing', { instructions: '无效修改' }, 'PUT'))
        .status,
      400,
    );
  } finally {
    await app.close();
    fs.rmSync(s.dir, { recursive: true, force: true });
  }
});
test('knowledge retrieval isolates role and project, preserves sources, and exports readable files', () => {
  const s = sandbox(),
    store = new Store(s.dataDir, s.workspace);
  try {
    const shared = store.saveKnowledge({
      title: '项目背景：记账',
      content: '预算不能为负数',
      scope: 'project',
      state: 'confirmed',
      source: '用户确认',
    });
    store.saveKnowledge({
      title: '记账产品草稿',
      content: '拟增加外币',
      scope: 'product',
      state: 'draft',
      source: '访谈草稿',
    });
    store.saveKnowledge({
      title: '工作偏好',
      content: '中文回复',
      scope: 'personal',
      state: 'confirmed',
      source: '个人设置',
    });
    store.configure({ workspace: '/different/project' });
    store.saveKnowledge({
      title: '记账其他项目',
      content: '绝不应泄露',
      scope: 'project',
      state: 'confirmed',
      source: '别的项目',
    });
    const task = store.createTask({
      role: 'developer',
      prompt: '实现记账预算校验',
      workspace: s.workspace,
    });
    const context = store.prepareContext(task);
    assert.match(context, /预算不能为负数/);
    assert.match(context, /中文回复/);
    assert.match(context, /用户确认/);
    assert.doesNotMatch(context, /拟增加外币|绝不应泄露/);
    assert.ok(
      fs
        .readFileSync(
          path.join(s.dataDir, 'knowledge', `${shared.id}.md`),
          'utf8',
        )
        .includes('预算不能为负数'),
    );
    assert.throws(
      () =>
        store.createTask({
          role: 'product',
          prompt: '混用会话',
          sessionId: task.sessionId,
          workspace: s.workspace,
        }),
      /不属于/,
    );
  } finally {
    store.close();
    fs.rmSync(s.dir, { recursive: true, force: true });
  }
});
test('running tasks become interrupted after a restart; queued work remains queued', () => {
  const s = sandbox();
  let store = new Store(s.dataDir, s.workspace);
  const active = store.createTask({ role: 'developer', prompt: '修改代码' }),
    queued = store.createTask({ role: 'product', prompt: '整理需求' });
  store.updateTask(active.id, { status: 'running' });
  store.close();
  store = new Store(s.dataDir, s.workspace);
  assert.equal(store.task(active.id).status, 'interrupted');
  assert.equal(store.task(queued.id).status, 'queued');
  store.close();
  fs.rmSync(s.dir, { recursive: true, force: true });
});
test('HTTP journey: concurrent assistants, developer queue, cancellation, handoff, and secret boundary', async () => {
  const s = sandbox(),
    runtimes = [];
  const app = createWorkbench({
    ...s,
    requireCredential: false,
    runtimeFactory: (o) => {
      const fake = {
        options: o,
        start(prompt) {
          fake.prompt = prompt;
          runtimes.push(fake);
        },
        cancel() {
          o.onDone('cancelled', '已停止');
        },
        complete(result) {
          o.onResult(result);
          o.onDone('completed', '');
        },
      };
      return fake;
    },
  });
  await new Promise((r) => app.server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const request = async (p, body, method = 'POST') => {
    const r = await fetch(base + '/api/' + p, {
      method,
      headers: { 'Content-Type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: r.status, body: await r.json() };
  };
  try {
    const p = (await request('tasks', { role: 'product', prompt: '记账需求' }))
      .body;
    const d = (
      await request('tasks', { role: 'developer', prompt: '实现记账功能' })
    ).body;
    const d2 = (
      await request('tasks', {
        role: 'developer',
        prompt: '同一项目的第二个开发任务',
      })
    ).body;
    await tick();
    assert.equal(runtimes.length, 2);
    assert.equal(app.store.task(d2.id).status, 'queued');
    runtimes
      .find((r) => r.options.task.id === p.id)
      .complete('需求：支持新增收支；验收：列表显示新增记录。');
    const handoff = await request(`tasks/${p.id}/handoff`, {
      role: 'developer',
      note: '请实现这些需求并验证',
    });
    assert.equal(handoff.status, 201);
    assert.equal(handoff.body.sourceTaskId, p.id);
    assert.notEqual(handoff.body.sessionId, p.sessionId);
    await request(`tasks/${d.id}/cancel`, {});
    await tick();
    assert.equal(app.store.task(d.id).status, 'cancelled');
    assert.equal(app.store.task(d2.id).status, 'running');
    runtimes.find((r) => r.options.task.id === d2.id).complete('完成');
    await tick();
    const receiver = runtimes.find(
      (r) => r.options.task.id === handoff.body.id,
    );
    assert.match(receiver.prompt, /支持新增收支/);
    assert.match(receiver.prompt, /请实现这些需求并验证/);
    receiver.complete('已完成需求并验证。');
    assert.equal(
      (await request('tasks', { role: 'wrong', prompt: 'test' })).status,
      400,
    );
    const rejected = await fetch(base + '/api/tasks', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Origin: 'https://evil.example',
      },
      body: JSON.stringify({ role: 'product', prompt: '恶意请求' }),
    });
    assert.equal(rejected.status, 403);
    const badHost = await new Promise((resolve) => {
      http.get(
        base + '/api/state',
        { headers: { Host: 'evil.example' } },
        (r) => {
          r.resume();
          resolve(r.statusCode);
        },
      );
    });
    assert.equal(badHost, 403);
    await request('vault/initialize', { passphrase: 'fixture-private-vault-password' });
    const savedSettings = await request(
      'settings',
      {
        workspace: s.workspace,
        model: 'deepseek-v4-flash',
        apiKey: 'fixture-private-key',
      },
      'PUT',
    );
    assert.equal(savedSettings.status, 200);
    const state = await request('state', undefined, 'GET');
    assert.equal(state.body.config.hasApiKey, true);
    assert.ok(!JSON.stringify(state.body).includes('fixture-private-key'));
    assert.ok(!('context' in state.body.tasks[0]));
    assert.ok(state.body.tasks.every((task) => task.artifactCount === 0));
    assert.ok(
      state.body.tasks.every((task) => task.verificationStatus === null),
    );
    const inspectedTask = state.body.tasks[0];
    app.store.records.save('artifacts', {
      taskId: inspectedTask.id,
      kind: 'verification',
      status: 'verified',
      name: 'npm test',
    });
    const withEvidence = await request('state', undefined, 'GET');
    const evidenceTask = withEvidence.body.tasks.find(
      (task) => task.id === inspectedTask.id,
    );
    assert.equal(evidenceTask.artifactCount, 1);
    assert.equal(evidenceTask.verificationStatus, 'verified');
    const inspectedDetail = await request(`tasks/${inspectedTask.id}`, undefined, 'GET');
    assert.equal(inspectedDetail.body.delivery.executionStatus, inspectedDetail.body.status);
    assert.equal(inspectedDetail.body.delivery.acceptanceStatus, 'verified');
    assert.equal(inspectedDetail.body.delivery.evidenceCount, 1);
    assert.equal(inspectedDetail.body.delivery.hasVerificationEvidence, true);
    assert.equal(
      fs.statSync(path.join(s.dataDir, 'vault.json')).mode & 0o777,
      0o600,
    );
    assert.equal(fs.existsSync(path.join(s.dataDir, 'secrets.json')), false);
  } finally {
    await app.close();
    fs.rmSync(s.dir, { recursive: true, force: true });
  }
});

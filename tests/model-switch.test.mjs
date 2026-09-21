import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createWorkbench } from '../server/index.mjs';

const waitFor = async (predicate) => {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('模型切换任务未启动。');
};

test('an explicit provider and model are used for a task, including text-only mode', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-model-switch-'));
  const runs = [];
  const app = createWorkbench({
    dataDir: path.join(dir, 'data'),
    workspace: path.join(dir, 'workspace'),
    requireCredential: false,
    runtimeFactory: (options) => ({
      async start() {
        runs.push(options);
        options.onResult('模型已切换');
        options.onDone('completed', '');
      },
      cancel() {
        options.onDone('cancelled', '');
      },
    }),
  });
  await new Promise((resolve) => app.server.listen(0, '127.0.0.1', resolve));
  await app.platform.ready;
  const provider = app.platform.providers.save({
    name: 'Selectable fixture',
    protocol: 'openai-completions',
    baseUrl: 'http://127.0.0.1:9/v1',
    models: [{ id: 'selectable-text', tools: false }],
    priority: 1,
  });
  try {
    app.platform.newTask({
      role: 'assistant',
      prompt: '使用指定模型完成这次测试。',
      providerId: provider.id,
      model: 'selectable-text',
      allowModelWithoutTools: true,
    });
    await waitFor(() => runs.length === 1);
    assert.equal(runs[0].route.providerId, provider.id);
    assert.equal(runs[0].route.model, 'selectable-text');
    assert.deepEqual(runs[0].assistant.tools, {
      files: false,
      web: false,
      terminal: false,
    });
    assert.equal(runs[0].capabilityPatch.some((item) => item.id === 'workbench-orchestration'), false);
  } finally {
    await app.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('team Chat persists its model choice and sends it to the project manager', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-team-model-'));
  const runs = [];
  const app = createWorkbench({
    dataDir: path.join(dir, 'data'),
    workspace: path.join(dir, 'workspace'),
    requireCredential: false,
    runtimeFactory: (options) => ({
      async start() {
        runs.push(options);
        options.onResult('团队模型已切换');
        options.onDone('completed', '');
      },
      cancel() {
        options.onDone('cancelled', '');
      },
    }),
  });
  await new Promise((resolve) => app.server.listen(0, '127.0.0.1', resolve));
  await app.platform.ready;
  const provider = app.platform.providers.save({
    name: 'Team selectable fixture',
    protocol: 'openai-completions',
    baseUrl: 'http://127.0.0.1:9/v1',
    models: [{ id: 'team-model', tools: true }],
    priority: 1,
  });
  const request = async (route, body, method = 'GET') => {
    const response = await fetch(`http://127.0.0.1:${app.server.address().port}/api/${route}`, {
      method,
      headers: { 'Content-Type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: response.status, body: await response.json() };
  };
  try {
    const spaces = await request('spaces');
    const space = spaces.body[0];
    const saved = await request(`spaces/${space.id}`, {
      model: 'team-model',
      providerId: provider.id,
    }, 'PUT');
    assert.equal(saved.status, 200);
    assert.equal(saved.body.model, 'team-model');
    assert.equal(saved.body.providerId, provider.id);
    const message = await request(`spaces/${space.id}/messages`, {
      clientMessageId: 'model-choice-message',
      content: '使用当前选中的模型回复。',
      model: 'team-model',
      providerId: provider.id,
    }, 'POST');
    assert.equal(message.status, 201);
    await waitFor(() => runs.length === 1);
    assert.equal(runs[0].route.providerId, provider.id);
    assert.equal(runs[0].route.model, 'team-model');
  } finally {
    await app.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('team member conversations retain team context and member model bindings', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-member-model-'));
  const runs = [];
  const app = createWorkbench({
    dataDir: path.join(dir, 'data'),
    workspace: path.join(dir, 'workspace'),
    requireCredential: false,
    runtimeFactory: (options) => ({
      async start() {
        runs.push(options);
        options.onResult('成员模型已执行');
        options.onDone('completed', '');
      },
      cancel() {
        options.onDone('cancelled', '');
      },
    }),
  });
  await new Promise((resolve) => app.server.listen(0, '127.0.0.1', resolve));
  await app.platform.ready;
  const provider = app.platform.providers.save({
    name: 'Member selectable fixture',
    protocol: 'openai-completions',
    baseUrl: 'http://127.0.0.1:9/v1',
    models: [{ id: 'member-model', tools: true }],
    priority: 1,
  });
  const request = async (route, body, method = 'GET') => {
    const response = await fetch(`http://127.0.0.1:${app.server.address().port}/api/${route}`, {
      method,
      headers: { 'Content-Type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: response.status, body: await response.json() };
  };
  try {
    const created = await request('teams', {
      name: '成员模型团队',
      goal: '验证团队成员对话的上下文与模型绑定。',
      pmRoleId: 'project_manager',
      memberRoleIds: ['project_manager', 'developer'],
    }, 'POST');
    assert.equal(created.status, 201);
    const configured = await request(`teams/${created.body.id}`, {
      memberSettings: {
        project_manager: {},
        developer: { modelHint: 'member-model', providerIds: [provider.id] },
      },
    }, 'PUT');
    assert.equal(configured.status, 200);
    const task = await request('tasks', {
      role: 'developer',
      teamId: created.body.id,
      prompt: '在团队上下文中执行成员任务。',
    }, 'POST');
    assert.equal(task.status, 201);
    await waitFor(() => runs.length === 1);
    assert.equal(runs[0].route.providerId, provider.id);
    assert.equal(runs[0].route.model, 'member-model');
    assert.equal(app.platform.control.records.get('task-meta', task.body.id).teamId, created.body.id);
  } finally {
    await app.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Store } from '../server/store.mjs';
import { createWorkbench } from '../server/index.mjs';

function sandbox() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-profile-test-'));
  const workspace = path.join(dir, 'project');
  fs.mkdirSync(workspace);
  return { dir, workspace, dataDir: path.join(dir, 'data') };
}

test('personal profile has stable defaults, validates updates, and persists', () => {
  const s = sandbox();
  const store = new Store(s.dataDir, s.workspace);
  try {
    assert.equal(store.profile().language, 'zh-CN');
    assert.equal(store.profile().verbosity, 'balanced');
    const updated = store.saveProfile({
      name: '老板',
      tone: 'direct',
      verbosity: 'concise',
      habits: ['先给结论，再给证据。'],
      rules: ['不要虚构已经执行的操作。'],
    });
    assert.equal(updated.name, '老板');
    assert.equal(updated.verbosity, 'concise');
    assert.equal(updated.responseFormat, 'markdown');
    assert.throws(() => store.saveProfile({ tone: 'casual' }), /语气/);
    assert.throws(
      () => store.saveProfile({ habits: [''] }),
      /habits 列表无效/,
    );
    store.close();
    const reopened = new Store(s.dataDir, s.workspace);
    try {
      assert.deepEqual(reopened.profile(), updated);
    } finally {
      reopened.close();
    }
  } finally {
    try {
      store.close();
    } catch {}
    fs.rmSync(s.dir, { recursive: true, force: true });
  }
});

test('profile API exposes updates and task context includes preferences', async () => {
  const s = sandbox();
  const runtimes = [];
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
        cancel() {},
      };
      return run;
    },
  });
  await new Promise((resolve) => app.server.listen(0, '127.0.0.1', resolve));
  const request = async (route, body, method = 'GET') => {
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
    const saved = await request(
      'profile',
      {
        name: '老板',
        language: 'zh-CN',
        verbosity: 'concise',
        habits: ['先给结论，再展开。'],
      },
      'PUT',
    );
    assert.equal(saved.status, 200);
    assert.equal(saved.body.name, '老板');
    const current = await request('profile');
    assert.equal(current.body.name, '老板');
    const task = await request(
      'tasks',
      { role: 'assistant', prompt: '整理一个行动计划' },
      'POST',
    );
    assert.equal(task.status, 201);
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.match(runtimes[0].prompt, /个人使用偏好/);
    assert.match(runtimes[0].prompt, /先给结论，再展开/);
  } finally {
    await app.close();
    fs.rmSync(s.dir, { recursive: true, force: true });
  }
});

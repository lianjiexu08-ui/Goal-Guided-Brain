import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createWorkbench } from '../server/index.mjs';
import { seedConfirmedDefaultTeam } from './fixtures/confirmed-default-team.mjs';

const waitFor = async (predicate, message) => {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail(message);
};

for (const entry of ['task-retry', 'job-resume'])
  void test(`${entry} creates a linked isolated attempt and keeps prior files and result`, async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-recovery-'));
    const workspace = path.join(directory, 'workspace');
    fs.mkdirSync(workspace);
    const runs = [];
    const app = createWorkbench({
      dataDir: path.join(directory, 'data'),
      workspace,
      requireCredential: false,
      runtimeFactory: (options) => ({
        options,
        start() {
          runs.push(this);
        },
        cancel() {
          options.onDone('cancelled', '');
        },
      }),
    });
    await app.platform.ready;
    const team = seedConfirmedDefaultTeam(app.store);
    await new Promise((resolve) => app.server.listen(0, '127.0.0.1', resolve));
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
      const created = await request('tasks', {
        role: 'developer',
        teamId: team.id,
        prompt: '实现恢复后仍需保留历史证据的功能',
        providerIds: ['provider-before-failure'],
        model: 'selected-before-failure',
        workspaceMode: 'isolated',
      });
      assert.equal(created.status, 201);
      await waitFor(() => runs.length === 1, '初始执行实例未启动。');
      const original = created.body;
      const originalResult = '部分实现：旧实例已经生成了可复核结果。';
      const oldDirectory = runs[0].options.task.workspace;
      fs.writeFileSync(
        path.join(oldDirectory, 'partial.mjs'),
        'export const progress = 1;\n',
      );
      runs[0].options.onResult(originalResult);
      runs[0].options.onDone('failed', 'provider temporarily unavailable');
      assert.equal(app.store.task(original.id).status, 'failed');

      const originalMeta = app.store.records.get('task-meta', original.id);
      const retried = await request(
        entry === 'task-retry'
          ? `tasks/${original.id}/retry`
          : `jobs/${originalMeta.jobId}/resume`,
        { providerIds: ['provider-after-failure'] },
      );
      if (entry === 'job-resume' && retried.status === 201)
        retried.body = app.store.task(retried.body.taskId);
      assert.equal(retried.status, 201);
      assert.notEqual(retried.body.id, original.id);
      assert.equal(retried.body.sourceTaskId, original.id);
      assert.equal(app.store.task(original.id).result, originalResult);
      assert.equal(
        app.store.task(original.id).error,
        'provider temporarily unavailable',
      );
      const retryMeta = app.store.records.get('task-meta', retried.body.id);
      assert.deepEqual(retryMeta.providerIds, ['provider-after-failure']);
      assert.equal(retryMeta.workspaceMode, 'isolated');
      assert.equal(retryMeta.modelOverride, 'selected-before-failure');
      if (entry === 'task-retry') {
        assert.match(
          retryMeta.contextExtra,
          /provider temporarily unavailable/,
        );
        assert.match(retryMeta.contextExtra, new RegExp(original.id));
      }
      assert.equal(
        app.store.records.get('jobs', retryMeta.jobId).taskId,
        retried.body.id,
      );
      await waitFor(() => runs.length === 2, '恢复执行实例未启动。');
      const newDirectory = runs[1].options.task.workspace;
      assert.notEqual(newDirectory, oldDirectory);
      assert.equal(
        fs.readFileSync(path.join(newDirectory, 'partial.mjs'), 'utf8'),
        'export const progress = 1;\n',
      );
      fs.writeFileSync(
        path.join(newDirectory, 'partial.mjs'),
        'export const progress = 2;\n',
      );
      assert.equal(
        fs.readFileSync(path.join(oldDirectory, 'partial.mjs'), 'utf8'),
        'export const progress = 1;\n',
      );
      assert.equal(fs.existsSync(path.join(workspace, 'partial.mjs')), false);
      assert.equal(
        app.store.records.get('workspaces', retried.body.id).restoredFromTaskId,
        original.id,
      );
    } finally {
      await app.close();
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createWorkbench } from '../server/index.mjs';
import { loadUsageMeter } from '../server/metering.mjs';

async function waitFor(predicate) {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('Routing fixture did not reach expected state.');
}
async function fixture({
  error,
  toolActivity = false,
  restrict = false,
  failures = 1,
  threeProviders = false,
}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-routing-'));
  const workspace = path.join(dir, 'workspace');
  fs.mkdirSync(workspace);
  const runs = [];
  const app = createWorkbench({
    dataDir: path.join(dir, 'data'),
    workspace,
    requireCredential: false,
    runtimeFactory: (options) => ({
      async start() {
        runs.push(options);
        if (runs.length <= failures) {
          if (toolActivity) {
            fs.appendFileSync(
              path.join(workspace, 'operation.txt'),
              'performed\n',
            );
            options.onEvent({
              seq: 1,
              type: 'tool/call',
              data: { turn: 1, step: 1, name: 'write', arguments: '{}' },
            });
          }
          options.onDone('failed', error);
        } else {
          options.onResult('Alternate provider completed');
          options.onDone('completed', '');
        }
      },
      cancel() {
        options.onDone('cancelled', '');
      },
    }),
  });
  await new Promise((resolve) => app.server.listen(0, '127.0.0.1', resolve));
  await app.platform.ready;
  const primary = app.platform.providers.save({
    name: 'Primary fixture',
    protocol: 'openai-responses',
    baseUrl: 'http://127.0.0.1:9/v1',
    models: [{ id: 'primary-model', tools: true }],
    priority: 1,
  });
  const alternate = app.platform.providers.save({
    name: 'Alternate fixture',
    protocol: 'openai-completions',
    baseUrl: 'http://127.0.0.1:9/v1',
    models: [{ id: 'alternate-model', tools: true }],
    priority: 2,
  });
  const tertiary = threeProviders
    ? app.platform.providers.save({
        name: 'Third fixture',
        protocol: 'anthropic-messages',
        baseUrl: 'http://127.0.0.1:9/v1',
        models: [{ id: 'third-model', tools: true }],
        priority: 3,
      })
    : null;
  const task = app.platform.newTask({
    role: 'assistant',
    prompt: 'Complete fixture task',
    ...(restrict
      ? { providerIds: [primary.id] }
      : threeProviders
        ? { providerIds: [primary.id, alternate.id, tertiary.id] }
        : {}),
  });
  return {
    app,
    task,
    runs,
    primary,
    alternate,
    tertiary,
    workspace,
    async close() {
      await app.close();
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

for (const error of [
  'HTTP 401 Unauthorized',
  'HTTP 503 transient network error',
])
  test(`failed route ${error} retries on an actual alternate provider before tool activity`, async () => {
    const f = await fixture({ error });
    try {
      await waitFor(
        () =>
          f.runs.length === 2 &&
          f.app.store.task(f.runs[1].task.id)?.status === 'completed',
      );
      assert.equal(f.app.store.task(f.task.id).status, 'failed');
      assert.equal(f.runs[0].route.providerId, f.primary.id);
      assert.equal(f.runs[1].route.providerId, f.alternate.id);
      assert.equal(f.runs[1].route.model, 'alternate-model');
      assert.notEqual(f.runs[0].task.id, f.runs[1].task.id);
      const first = f.app.store.records.get('task-meta', f.task.id),
        second = f.app.store.records.get('task-meta', f.runs[1].task.id);
      assert.equal(first.jobId, second.jobId);
      assert.ok(second.excludedProviders.includes(f.primary.id));
      assert.equal(
        f.app.platform.providers.list().find((item) => item.id === f.primary.id)
          .enabled,
        !error.includes('401'),
      );
      assert.ok(
        !(
          'secret' in
          f.app.store.records.get('runtime-snapshots', f.runs[1].task.id).route
        ),
      );
    } finally {
      await f.close();
    }
  });

test('a recorded tool side effect prevents automatic model rerun', async () => {
  const f = await fixture({
    error: 'HTTP 503 after tool execution',
    toolActivity: true,
  });
  try {
    await waitFor(() => f.app.store.task(f.task.id)?.status === 'failed');
    await f.app.platform.schedule();
    assert.equal(f.runs.length, 1);
    assert.equal(f.app.store.tasks().length, 1);
    assert.equal(
      fs.readFileSync(path.join(f.workspace, 'operation.txt'), 'utf8'),
      'performed\n',
    );
    assert.equal(
      f.app.store.records.get('task-meta', f.task.id).toolActivity,
      true,
    );
  } finally {
    await f.close();
  }
});

test('successive fallback preserves the original provider allowlist and exclusions', async () => {
  const f = await fixture({
    error: 'HTTP 503 transient error',
    failures: 2,
    threeProviders: true,
  });
  try {
    await waitFor(
      () =>
        f.runs.length === 3 &&
        f.app.store.task(f.runs[2].task.id)?.status === 'completed',
    );
    assert.deepEqual(
      f.runs.map((run) => run.route.providerId),
      [f.primary.id, f.alternate.id, f.tertiary.id],
    );
    const meta = f.app.store.records.get('task-meta', f.runs[2].task.id);
    assert.deepEqual(meta.excludedProviders, [f.primary.id, f.alternate.id]);
    assert.equal(new Set(f.runs.map((run) => run.task.id)).size, 3);
  } finally {
    await f.close();
  }
});

test('exhausted provider routes stop retrying and create an actionable issue', async () => {
  const f = await fixture({ error: 'HTTP 503 transient error', failures: 10 });
  try {
    await waitFor(
      () =>
        f.runs.length === 2 &&
        f.app.store.task(f.runs[1].task.id)?.status === 'failed',
    );
    await f.app.platform.schedule();
    assert.equal(f.runs.length, 2);
    assert.ok(
      f.app.store.records
        .list('attention')
        .some((item) => item.kind === 'model'),
    );
  } finally {
    await f.close();
  }
});

test('task-level provider restrictions apply to fallback', async () => {
  const f = await fixture({ error: 'HTTP 401 Unauthorized', restrict: true });
  try {
    await waitFor(() => f.app.store.task(f.task.id)?.status === 'failed');
    await f.app.platform.schedule();
    assert.equal(f.runs.length, 1);
    assert.equal(f.app.store.tasks().length, 1);
  } finally {
    await f.close();
  }
});

test('shared group budget stops all running agents after combined reported usage', async (t) => {
  if (!(await loadUsageMeter())) {
    t.skip('Native DSH token meter unavailable');
    return;
  }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-budget-'));
  const runs = new Map();
  let cancelled = 0;
  const app = createWorkbench({
    dataDir: path.join(dir, 'data'),
    workspace: dir,
    requireCredential: false,
    runtimeFactory: (options) => ({
      start() {
        runs.set(options.task.id, options);
      },
      cancel() {
        cancelled += 1;
        options.onDone('cancelled', '');
      },
    }),
  });
  await new Promise((resolve) => app.server.listen(0, '127.0.0.1', resolve));
  try {
    await app.platform.ready;
    app.platform.providers.save({
      name: 'Budget fixture',
      protocol: 'openai-completions',
      baseUrl: 'http://127.0.0.1:9/v1',
      models: [{ id: 'budget-model', tools: true }],
    });
    const root = app.platform.control.createJob({
      role: 'assistant',
      prompt: 'Coordinate',
      budgetTokens: 1000,
      maxDurationMinutes: 2,
    });
    const child = app.platform.control.createJob({
      role: 'product',
      prompt: 'Research',
      parentJobId: root.id,
    });
    await waitFor(() => runs.size === 2);
    const report = (id) => {
      const usage = {
        inputTokens: 300,
        cacheReadTokens: 100,
        cacheWriteTokens: 0,
        outputTokens: 200,
        totalTokens: 600,
      };
      const events = [
        { type: 'turn/start', data: { turn: 1 } },
        { type: 'step/start', data: { turn: 1, step: 1 } },
        {
          type: 'assistant/chunk',
          data: { turn: 1, step: 1, chunk: { type: 'usage', usage } },
        },
        {
          type: 'assistant/message',
          data: {
            turn: 1,
            step: 1,
            message: {
              source: { provider: 'workbench-provider', model: 'budget-model' },
              content: [],
            },
            usage,
          },
        },
        { type: 'step/end', data: { turn: 1, step: 1 } },
        { type: 'turn/end', data: { turn: 1 } },
      ];
      events.forEach((event, seq) => runs.get(id).onEvent({ ...event, seq }));
    };
    report(root.taskId);
    assert.equal(app.store.task(root.taskId).status, 'running');
    report(child.taskId);
    await waitFor(
      () =>
        app.store.task(root.taskId).status === 'cancelled' &&
        app.store.task(child.taskId).status === 'cancelled',
    );
    assert.equal(cancelled, 2);
    assert.equal(
      app.store.records
        .list('usage')
        .reduce((sum, value) => sum + value.totalTokens, 0),
      1200,
    );
    for (const job of [root, child])
      assert.equal(
        app.store.records.get('jobs', job.id).status,
        'budget-exceeded',
      );
    assert.equal(
      app.store.records
        .list('attention')
        .filter((item) => item.kind === 'budget').length,
      1,
    );
    await app.platform.schedule();
    assert.equal(runs.size, 2);
  } finally {
    await app.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

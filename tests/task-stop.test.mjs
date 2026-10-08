import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createWorkbench } from '../server/index.mjs';
import { Store } from '../server/store.mjs';
import { sandbox } from './helpers/workbench-helpers.mjs';

for (const shutdown of [false, true]) {
  void test(`${shutdown ? 'service shutdown' : 'owner cancellation'} persists its own cause and partial result after runtime completion`, async () => {
    const fixture = sandbox();
    const runs = [];
    let closed = false;
    const app = createWorkbench({
      ...fixture,
      requireCredential: false,
      runtimeFactory: (options) => ({
        start() {
          runs.push(options);
        },
        async cancel() {
          // Completion arrives asynchronously, as with the real child process.
          await new Promise((resolve) => setTimeout(resolve, 10));
          options.onDone('cancelled', 'runtime generic cancellation');
        },
      }),
    });
    try {
      await app.platform.ready;
      await new Promise((resolve) =>
        app.server.listen(0, '127.0.0.1', resolve),
      );
      const task = app.platform.newTask({
        role: 'product',
        prompt: '保留已完成的分析',
      });
      const deadline = Date.now() + 3000;
      while (!runs.length && Date.now() < deadline)
        await new Promise((resolve) => setTimeout(resolve, 10));
      assert.equal(runs.length, 1);
      runs[0].onResult('已完成第一部分分析。');
      if (!shutdown) {
        await app.platform.stopTask(task.id);
        const before = app.store.task(task.id);
        await app.platform.stopTask(task.id);
        assert.deepEqual(
          app.store.task(task.id),
          before,
          'repeated cancellation must retain the original evidence',
        );
      }
      await app.close();
      closed = true;
      const reopened = new Store(fixture.dataDir, fixture.workspace);
      try {
        const saved = reopened.task(task.id);
        assert.equal(saved.result, '已完成第一部分分析。');
        assert.equal(saved.status, shutdown ? 'interrupted' : 'cancelled');
        assert.match(saved.error, shutdown ? /服务已停止/ : /用户已停止/);
        assert.doesNotMatch(saved.error, /预算/);
      } finally {
        reopened.close();
      }
    } finally {
      if (!closed) await app.close();
      fs.rmSync(fixture.dir, { recursive: true, force: true });
    }
  });
}

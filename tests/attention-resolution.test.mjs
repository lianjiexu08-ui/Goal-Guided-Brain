import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createWorkbench } from '../server/index.mjs';
import { resolveAttention } from '../server/platform/attention-resolution.mjs';

async function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ggb-attention-'));
  const app = createWorkbench({
    workspace: path.join(directory, 'workspace'),
    dataDir: path.join(directory, 'data'),
    requireCredential: false,
  });
  await app.platform.ready;
  await new Promise((resolve) => app.server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    await app.close();
    fs.rmSync(directory, { recursive: true, force: true });
  });
  const request = async (id, body) => {
    const response = await fetch(
      `http://127.0.0.1:${app.server.address().port}/api/attention/${id}/resolve`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      },
    );
    return { status: response.status, body: await response.json() };
  };
  const item = app.platform.control.attention(
    {
      kind: 'decision',
      title: '确认工作目录',
      detail: '请确认下一步使用哪个工作目录。',
    },
    'owner-decision',
  );
  return { app, request, item };
}

void test('owner can resolve an attention without a task and close only its linked notification', async (t) => {
  const { app, request, item } = await fixture(t);
  const { records } = app.store;
  app.platform.control.attention({ title: '另一事项' }, 'other-decision');
  const result = await request(item.id, {
    resolution: '  已确认，继续使用当前目录。  ',
  });
  assert.equal(result.status, 200);
  assert.equal(result.body.status, 'resolved');
  assert.equal(result.body.resolution, '已确认，继续使用当前目录。');
  assert.equal(result.body.resolvedBy, 'owner');
  assert.ok(result.body.resolvedAt);
  assert.equal(records.get('notifications', `attention:${item.id}`).read, true);
  assert.equal(
    records.get('notifications', 'attention:other-decision').read,
    false,
  );
  const again = await request(item.id, {
    resolution: '重复点击不会改写原结果',
  });
  assert.equal(again.status, 200);
  assert.equal(again.body.resolution, result.body.resolution);
  assert.equal(again.body.revision, result.body.revision);
  assert.equal(records.list('jobs').length, 0);
});

void test('attention resolution rejects missing records and empty or invalid notes without writes', async (t) => {
  const { app, request, item } = await fixture(t);
  for (const resolution of ['', '   ', null, {}, 'a'.repeat(4001)]) {
    assert.equal((await request(item.id, { resolution })).status, 400);
    assert.equal(
      app.store.records.get('attention', item.id).revision,
      item.revision,
    );
    assert.equal(
      app.store.records.get('notifications', `attention:${item.id}`).read,
      false,
    );
  }
  assert.equal(
    (await request('missing-attention', { resolution: '已处理' })).status,
    404,
  );
});

void test('failure saving attention rolls back its linked notification changes', async (t) => {
  const { app, request, item } = await fixture(t);
  const { records } = app.store;
  const original = records.save.bind(records);
  let notificationWritten = false;
  records.save = (collection, ...args) => {
    if (collection === 'notifications') notificationWritten = true;
    if (collection === 'attention') throw new Error('simulated write failure');
    return original(collection, ...args);
  };
  try {
    const result = await request(item.id, { resolution: '已确认' });
    assert.notEqual(result.status, 200);
    assert.equal(notificationWritten, true);
    assert.equal(records.get('attention', item.id).status, 'open');
    assert.equal(records.get('attention', item.id).revision, item.revision);
    assert.equal(
      records.get('notifications', `attention:${item.id}`).read,
      false,
    );
  } finally {
    records.save = original;
  }
});

void test('resolving attention neither grants tools nor resumes its failed task', async (t) => {
  const { app, request, item } = await fixture(t);
  const task = app.store.createTask({
    role: 'developer',
    prompt: '保留失败任务',
    workspace: app.store.config.workspace,
  });
  app.store.updateTask(task.id, { status: 'failed' });
  app.store.records.save('attention', { ...item, taskId: task.id }, item.id);
  assert.throws(
    () =>
      resolveAttention(
        app.store,
        item.id,
        { resolution: '由智能体代为确认' },
        { type: 'instance' },
      ),
    { status: 403 },
  );
  const tool = app.platform.control.attention(
    { kind: 'tool-approval', taskId: task.id, title: '待审批工具' },
    'tool-decision',
  );
  assert.throws(
    () =>
      resolveAttention(
        app.store,
        tool.id,
        { resolution: '普通备注' },
        { type: 'owner' },
      ),
    { status: 409 },
  );
  assert.equal(app.store.records.get('attention', tool.id).status, 'open');
  assert.equal(
    (await request(item.id, { resolution: '已人工确认问题，稍后单独重试' }))
      .status,
    200,
  );
  assert.equal(app.store.task(task.id).status, 'failed');
  assert.equal(app.store.tasks().length, 1);
  assert.equal(app.store.records.list('jobs').length, 0);
});

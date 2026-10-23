import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Records, RECORDS_SCHEMA } from '../server/records.mjs';
import { AttachmentService } from '../server/attachments.mjs';
import { createWorkbench } from '../server/index.mjs';

test('attachments retain bytes, safe metadata, and staged execution paths', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-attachments-'));
  const db = new DatabaseSync(':memory:');
  db.exec(RECORDS_SCHEMA);
  const service = new AttachmentService({ dataDir: dir, records: new Records(db) });
  const bytes = Buffer.from('文件内容\n第二行', 'utf8');
  try {
    const item = service.create({
      name: '../需求说明.md',
      mime: 'text/markdown',
      data: bytes.toString('base64'),
    });
    assert.equal(item.name, '需求说明.md');
    assert.equal(item.size, bytes.length);
    assert.deepEqual(service.read(item.id).bytes, bytes);
    assert.deepEqual(service.validateIds([item.id]), [item.id]);
    const destination = path.join(dir, 'run', 'tmp', 'attachments');
    const staged = service.materialize([item.id], destination);
    assert.equal(staged[0].mime, 'text/markdown');
    assert.deepEqual(fs.readFileSync(staged[0].path), bytes);
    assert.throws(() => service.validateIds(['missing']), /附件不存在/);
  } finally {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('task submission carries uploaded attachment bytes into the local runtime', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-attachment-task-'));
  const workspace = path.join(dir, 'project');
  fs.mkdirSync(workspace);
  let runtimeOptions;
  const app = createWorkbench({
    dataDir: path.join(dir, 'data'),
    workspace,
    requireCredential: false,
    runtimeFactory: (options) => {
      runtimeOptions = options;
      return { start() {}, cancel() {} };
    },
  });
  await new Promise((resolve) => app.server.listen(0, '127.0.0.1', resolve));
  const request = async (route, body, method = 'GET') => {
    const response = await fetch(`http://127.0.0.1:${app.server.address().port}/api/${route}`, {
      method,
      headers: { 'Content-Type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: response.status, body: await response.json() };
  };
  try {
    const bytes = Buffer.from('runtime attachment', 'utf8');
    const uploaded = await request('attachments', {
      name: 'context.txt',
      mime: 'text/plain',
      data: bytes.toString('base64'),
    }, 'POST');
    assert.equal(uploaded.status, 201);
    const task = await request('tasks', {
      role: 'assistant',
      prompt: '请阅读附件。',
      attachmentIds: [uploaded.body.id],
    }, 'POST');
    assert.equal(task.status, 201);
    for (let attempt = 0; attempt < 30 && !runtimeOptions; attempt += 1)
      await new Promise((resolve) => setTimeout(resolve, 10));
    assert.ok(runtimeOptions?.attachments?.length);
    assert.deepEqual(fs.readFileSync(runtimeOptions.attachments[0].path), bytes);
    assert.match(runtimeOptions.attachments[0].path, /\.ggb-attachments/);
  } finally {
    await app.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('HTTP attachment upload keeps binary content and task references it', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-attachment-http-'));
  const workspace = path.join(dir, 'workspace');
  const dataDir = path.join(dir, 'data');
  fs.mkdirSync(workspace);
  const app = createWorkbench({ workspace, dataDir, requireCredential: false });
  await app.platform.ready;
  await new Promise((resolve) => app.server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${app.server.address().port}`;
  const request = async (route, body, method = 'POST') => {
    const response = await fetch(`${url}/api/${route}`, {
      method,
      headers: { 'Content-Type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const text = await response.text();
    return { status: response.status, body: text ? JSON.parse(text) : null };
  };
  t.after(async () => {
    await app.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const bytes = Buffer.from([0, 1, 2, 255, 10, 13]);
  const uploaded = await request('attachments', {
    name: '截图.png',
    mime: 'image/png',
    data: bytes.toString('base64'),
  });
  assert.equal(uploaded.status, 201);
  assert.deepEqual(
    fs.readFileSync(path.join(dataDir, 'attachments', `${uploaded.body.id}.bin`)),
    bytes,
  );

  const task = await request('tasks', {
    role: 'project_manager',
    prompt: '检查附件',
    attachmentIds: [uploaded.body.id],
  });
  assert.equal(task.status, 201);
  const state = await request('state', undefined, 'GET');
  const stateTask = state.body.tasks.find((item) => item.id === task.body.id);
  assert.deepEqual(stateTask.attachmentIds, [uploaded.body.id]);
  assert.equal(stateTask.attachments[0].name, '截图.png');

  const space = await request('spaces', {
    name: '附件团队',
    goal: '验证团队消息附件',
    pmRoleId: 'project_manager',
    memberRoleIds: ['project_manager'],
    workspace,
  });
  assert.equal(space.status, 201);
  const message = await request(`spaces/${space.body.id}/messages`, {
    clientMessageId: 'attachment-only-fixture',
    attachmentIds: [uploaded.body.id],
  });
  assert.equal(message.status, 201);
  const updated = await request('state', undefined, 'GET');
  const stateSpace = updated.body.spaces.find((item) => item.id === space.body.id);
  assert.deepEqual(stateSpace.messages[0].attachmentIds, [uploaded.body.id]);
  assert.equal(stateSpace.messages[0].content, '请查看随附文件并处理。');
});

test('team-scoped attachments cannot be referenced by another team', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-attachment-scope-'));
  const workspace = path.join(dir, 'workspace');
  fs.mkdirSync(workspace);
  const app = createWorkbench({
    workspace,
    dataDir: path.join(dir, 'data'),
    requireCredential: false,
    runtimeFactory: () => ({ start() {}, cancel() {} }),
  });
  await app.platform.ready;
  await new Promise((resolve) => app.server.listen(0, '127.0.0.1', resolve));
  const request = async (route, body, method = 'GET') => {
    const response = await fetch(`http://127.0.0.1:${app.server.address().port}/api/${route}`, {
      method,
      headers: { 'Content-Type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: response.status, body: await response.json() };
  };
  try {
    const source = (await request('teams')).body[0];
    const target = (await request('teams', {
      name: '附件引用目标团队',
      goal: '验证团队附件引用边界。',
      memberRoleIds: ['project_manager'],
    }, 'POST')).body;
    const uploaded = await request('attachments', {
      teamId: source.id,
      name: 'source.txt',
      mime: 'text/plain',
      data: Buffer.from('source-only').toString('base64'),
    }, 'POST');
    assert.equal(uploaded.status, 201);

    const sourceMessage = await request(`teams/${source.id}/messages`, {
      clientMessageId: 'scoped-source-message',
      content: '源团队可以引用自己的附件。',
      attachmentIds: [uploaded.body.id],
    }, 'POST');
    assert.equal(sourceMessage.status, 201);

    const targetMessage = await request(`teams/${target.id}/messages`, {
      clientMessageId: 'scoped-target-message',
      content: '目标团队不应读取源附件。',
      attachmentIds: [uploaded.body.id],
    }, 'POST');
    assert.equal(targetMessage.status, 409);
    assert.match(targetMessage.body.error, /另一个团队/);

    const targetTask = await request('tasks', {
      role: 'project_manager',
      teamId: target.id,
      spaceId: target.id,
      prompt: '目标团队不应接收源附件。',
      attachmentIds: [uploaded.body.id],
    }, 'POST');
    assert.equal(targetTask.status, 409);
    assert.equal((await request(`teams/${target.id}`)).body.tasks.length, 0);
  } finally {
    await app.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('retrying a stopped task rematerializes the original attachment bytes', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-attachment-retry-'));
  const workspace = path.join(dir, 'workspace');
  fs.mkdirSync(workspace);
  const runs = [];
  const app = createWorkbench({
    workspace,
    dataDir: path.join(dir, 'data'),
    requireCredential: false,
    runtimeFactory: (options) => {
      const run = {
        options,
        start() { runs.push(run); },
        cancel() { options.onDone('cancelled', ''); },
      };
      return run;
    },
  });
  await new Promise((resolve) => app.server.listen(0, '127.0.0.1', resolve));
  const request = async (route, body, method = 'GET') => {
    const response = await fetch(`http://127.0.0.1:${app.server.address().port}/api/${route}`, {
      method,
      headers: { 'Content-Type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: response.status, body: await response.json() };
  };
  const waitFor = async (predicate) => {
    for (let attempt = 0; attempt < 100; attempt += 1) {
      if (predicate()) return;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.fail('重试任务未启动。');
  };
  try {
    const bytes = Buffer.from([0, 1, 2, 250, 251, 252, 10]);
    const uploaded = await request('attachments', {
      name: '需要重试的截图.png',
      mime: 'image/png',
      data: bytes.toString('base64'),
    }, 'POST');
    assert.equal(uploaded.status, 201);
    const created = await request('tasks', {
      role: 'assistant',
      prompt: '先读取附件，随后验证停止后可重试。',
      attachmentIds: [uploaded.body.id],
    }, 'POST');
    assert.equal(created.status, 201);
    await waitFor(() => runs.length === 1);
    assert.deepEqual(fs.readFileSync(runs[0].options.attachments[0].path), bytes);

    const cancelled = await request(`tasks/${created.body.id}/cancel`, {}, 'POST');
    assert.equal(cancelled.status, 200);
    await waitFor(() => app.store.task(created.body.id).status === 'cancelled');

    const retried = await request(`tasks/${created.body.id}/retry`, {}, 'POST');
    assert.equal(retried.status, 201);
    assert.equal(app.platform.control.records.get('task-meta', retried.body.id).attachmentIds[0], uploaded.body.id);
    await waitFor(() => runs.length === 2);
    assert.deepEqual(fs.readFileSync(runs[1].options.attachments[0].path), bytes);
  } finally {
    await app.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

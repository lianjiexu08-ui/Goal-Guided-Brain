import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createWorkbench } from '../server/index.mjs';

function sandbox() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-drafts-test-'));
  const workspace = path.join(dir, 'workspace');
  fs.mkdirSync(workspace);
  return { dir, workspace, dataDir: path.join(dir, 'data') };
}

async function openApp(fixture) {
  const app = createWorkbench({
    ...fixture,
    requireCredential: false,
  });
  await app.platform.ready;
  await new Promise((resolve) => app.server.listen(0, '127.0.0.1', resolve));
  const request = async (route, body, method = body === undefined ? 'GET' : 'POST') => {
    const response = await fetch(`http://127.0.0.1:${app.server.address().port}/api/${route}`, {
      method,
      headers: { 'Content-Type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const text = await response.text();
    return { status: response.status, body: text ? JSON.parse(text) : null };
  };
  return { app, request };
}

test('server-backed drafts persist across restart, retain attachments, and stay team-scoped', async () => {
  const fixture = sandbox();
  let current = await openApp(fixture);
  try {
    const teamA = (await current.request('teams', {
      name: '开发草稿团队',
      goal: '验证团队草稿的跨设备恢复。',
      pmRoleId: 'project_manager',
      memberRoleIds: ['project_manager'],
      recruitment: { phase: 'confirmed' },
    }, 'POST')).body;
    const teamB = (await current.request('teams', {
      name: '运维草稿团队',
      goal: '验证附件不会跨团队泄露。',
      pmRoleId: 'project_manager',
      memberRoleIds: ['project_manager'],
      recruitment: { phase: 'confirmed' },
    }, 'POST')).body;
    const attachment = (await current.request('attachments', {
      name: '需求图.png',
      mime: 'image/png',
      data: Buffer.from([137, 80, 78, 71, 1, 2, 3]).toString('base64'),
      teamId: teamA.id,
    })).body;
    const saved = await current.request('drafts', {
      spaceId: teamA.id,
      roleId: 'project_manager',
      content: '需要保留到下次打开的团队需求。',
      attachmentIds: [attachment.id],
    }, 'PUT');
    assert.equal(saved.status, 200);
    assert.equal(saved.body.content, '需要保留到下次打开的团队需求。');
    assert.deepEqual(saved.body.attachmentIds, [attachment.id]);
    assert.equal(saved.body.attachments[0].name, '需求图.png');
    assert.equal(saved.body.revision, 1);

    const updatedByAnotherWindow = await current.request('drafts', {
      spaceId: teamA.id,
      roleId: 'project_manager',
      content: '另一个窗口刚刚保存的最新内容。',
      attachmentIds: [attachment.id],
      revision: saved.body.revision,
    }, 'PUT');
    assert.equal(updatedByAnotherWindow.status, 200);
    assert.equal(updatedByAnotherWindow.body.revision, 2);

    const staleUpdate = await current.request('drafts', {
      spaceId: teamA.id,
      roleId: 'project_manager',
      content: '旧窗口不应该覆盖的新内容。',
      attachmentIds: [attachment.id],
      revision: saved.body.revision,
    }, 'PUT');
    assert.equal(staleUpdate.status, 409);
    assert.equal(staleUpdate.body.draft.content, '另一个窗口刚刚保存的最新内容。');
    assert.equal(staleUpdate.body.draft.revision, 2);

    const rejectedAttachment = await current.request('drafts', {
      spaceId: teamB.id,
      roleId: 'project_manager',
      content: '不能引用开发团队附件。',
      attachmentIds: [attachment.id],
    }, 'PUT');
    assert.equal(rejectedAttachment.status, 409);

    const rejectedRole = await current.request('drafts', {
      spaceId: teamA.id,
      roleId: 'developer',
      content: '不属于团队的助手不能写入团队草稿。',
    }, 'PUT');
    assert.equal(rejectedRole.status, 400);

    const beforeRestart = await current.request(`drafts?spaceId=${encodeURIComponent(teamA.id)}&role=project_manager`);
    assert.equal(beforeRestart.body.content, '另一个窗口刚刚保存的最新内容。');
    assert.equal(beforeRestart.body.attachments.length, 1);
    await current.app.close();
    current = await openApp(fixture);
    const afterRestart = await current.request(`drafts?spaceId=${encodeURIComponent(teamA.id)}&role=project_manager`);
    assert.equal(afterRestart.status, 200);
    assert.equal(afterRestart.body.content, '另一个窗口刚刚保存的最新内容。');
    assert.deepEqual(afterRestart.body.attachmentIds, [attachment.id]);

    const staleDelete = await current.request('drafts', {
      spaceId: teamA.id,
      roleId: 'project_manager',
      revision: saved.body.revision,
    }, 'DELETE');
    assert.equal(staleDelete.status, 409);
    assert.equal(staleDelete.body.draft.content, '另一个窗口刚刚保存的最新内容。');

    const unversionedDelete = await current.request('drafts', {
      spaceId: teamA.id,
      roleId: 'project_manager',
    }, 'DELETE');
    assert.equal(unversionedDelete.status, 409);
    assert.equal(unversionedDelete.body.draft.revision, updatedByAnotherWindow.body.revision);

    const removed = await current.request('drafts', {
      spaceId: teamA.id,
      roleId: 'project_manager',
      revision: updatedByAnotherWindow.body.revision,
    }, 'DELETE');
    assert.deepEqual(removed.body, { ok: true });
    const empty = await current.request(`drafts?spaceId=${encodeURIComponent(teamA.id)}&role=project_manager`);
    assert.equal(empty.body.content, '');
    assert.deepEqual(empty.body.attachmentIds, []);
  } finally {
    await current.app.close();
    fs.rmSync(fixture.dir, { recursive: true, force: true });
  }
});

test('standalone drafts can be recovered by role without exposing another role scope', async () => {
  const fixture = sandbox();
  const { app, request } = await openApp(fixture);
  try {
    const saved = await request('drafts', {
      roleId: 'assistant',
      content: '独立助手的未发送内容。',
    }, 'PUT');
    assert.equal(saved.status, 200);
    assert.equal(saved.body.revision, 1);
    const recovered = await request('drafts?role=assistant');
    assert.equal(recovered.body.content, '独立助手的未发送内容。');
    const otherRole = await request('drafts?role=developer');
    assert.equal(otherRole.body.content, '');
  } finally {
    await app.close();
    fs.rmSync(fixture.dir, { recursive: true, force: true });
  }
});

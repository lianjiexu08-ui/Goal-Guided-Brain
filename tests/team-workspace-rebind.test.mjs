import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createWorkbench } from '../server/index.mjs';

/** 团队换执行目录后，PM 会话应重绑 workspace，消息派活不再被“会话不属于当前工作目录”拒绝。 */
test('团队 workspace 变更重绑会话', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ggb-team-ws-'));
  const otherDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ggb-team-ws-target-'));
  const app = createWorkbench({ dataDir: dir });
  await new Promise((resolve) => app.server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  t.after(async () => {
    await app.close();
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(otherDir, { recursive: true, force: true });
  });
  const api = async (endpoint, options = {}) => {
    const response = await fetch(`${base}/api${endpoint}`, {
      headers: { 'Content-Type': 'application/json' },
      ...options,
      body: options.body ? JSON.stringify(options.body) : undefined,
    });
    const text = await response.text();
    return { status: response.status, body: text ? JSON.parse(text) : null };
  };

  const { body: team } = await api('/teams', {
    method: 'POST',
    body: { name: '换目录团队', goal: 'g', purpose: 'p', pmRoleId: 'project_manager', memberRoleIds: ['project_manager'], workspace: dir },
  });
  assert.ok(team?.id);
  assert.equal(team.workspace, dir);

  // 模拟招募会话绑定旧目录
  const control = app.platform.control;
  const store = control.store;
  const session = store.saveSession(null, { title: '招募' }) || null;
  // 用 db 直建一条 session（saveSession 需要 id）
  const sessionId = 'sess-' + Math.random().toString(36).slice(2);
  store.db.prepare('INSERT INTO sessions (id, role, workspace, title, createdAt) VALUES (?,?,?,?,?)')
    .run(sessionId, 'project_manager', dir, '招募', new Date().toISOString());
  store.saveTeamSpace({ recruitment: { ...(team.recruitment || {}), sessionId, phase: 'confirmed' } }, team.id);

  // PUT 换目录 → 会话应重绑
  const { body: updated } = await api(`/teams/${team.id}`, {
    method: 'PUT',
    body: { workspace: otherDir },
  });
  assert.equal(updated.workspace, otherDir);
  const rebound = store.db.prepare('SELECT * FROM sessions WHERE id=?').get(sessionId);
  assert.equal(rebound.workspace, otherDir, 'PM 会话应重绑到新工作目录');
});

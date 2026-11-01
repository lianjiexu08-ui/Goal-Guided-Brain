import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createWorkbench } from '../server/index.mjs';

/**
 * 生命周期集成测试：把实战炸过的时序/边界问题固化为回归测试。
 * （platform-reliability-plan #3）
 */

const read = (file) => fs.readFileSync(path.resolve(import.meta.dirname, file), 'utf8');

test('生命周期：.vault_pass 启动自动解锁 + GET /api/vault 状态可见', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ggb-life-vault-'));
  fs.writeFileSync(path.join(dir, '.vault_pass'), 'life-cycle-pass-123', { mode: 0o600 });
  const app = createWorkbench({ dataDir: dir });
  await new Promise((resolve) => app.server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  t.after(async () => {
    await app.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  await app.ready;
  const status = await (await fetch(`${base}/api/vault`)).json();
  assert.equal(status.initialized, true, '.vault_pass 应触发初始化或解锁');
  assert.equal(status.unlocked, true, '启动应自动解锁');
  // CLI ensureVaultUnlocked 读到 unlocked=true 后应直接返回，不再误判
});

test('生命周期：团队换 workspace 后 newTask 使用团队目录（优先级：任务 > 团队 > 全局）', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ggb-life-ws-'));
  const teamDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ggb-life-team-'));
  const app = createWorkbench({ dataDir: dir });
  await new Promise((resolve) => app.server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    await app.close();
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(teamDir, { recursive: true, force: true });
  });
  // 绕过凭据门槛（本测试只验证 workspace 优先级）
  fs.writeFileSync(path.join(dir, 'secrets.json'), JSON.stringify({ apiKey: 'test-key' }), { mode: 0o600 });
  const control = app.platform.control;
  const store = control.store;
  const team = store.saveTeamSpace({
    name: '生命周期团队', goal: 'g', purpose: 'p',
    pmRoleId: 'project_manager', memberRoleIds: ['project_manager'],
    workspace: teamDir,
  });
  // newTask 不带 workspace → 应落团队目录，而非全局 config.workspace
  const task = control.createTask({ role: 'project_manager', prompt: '生命周期断言', spaceId: team.id });
  assert.equal(
    path.resolve(task.workspace),
    path.resolve(teamDir),
    '无显式 workspace 的团队任务应落在团队执行目录',
  );
});

test('生命周期：同一数据目录二次启动被锁拒绝（防多实例半死）', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ggb-life-lock-'));
  const app = createWorkbench({ dataDir: dir });
  await new Promise((resolve) => app.server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    await app.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  assert.throws(
    () => createWorkbench({ dataDir: dir }),
    /同一数据目录已有控制端运行/,
    '同目录第二个实例必须被拒绝，而不是半死挂着',
  );
});

test('生命周期：CLI 脚本引用的 child_process 方法必须已导入（spawn 事故卫兵）', () => {
  const source = read('../scripts/cli.mjs');
  const importBlock = source.match(/import\s*\{([^}]+)\}\s*from\s*'node:child_process'/)?.[1] || '';
  const imported = new Set(importBlock.split(',').map((name) => name.trim()).filter(Boolean));
  const used = new Set(
    [...source.matchAll(/\b(spawn|spawnSync|execFile|execFileSync|exec|execSync)\s*\(/g)].map((m) => m[1]),
  );
  for (const name of used) {
    assert.ok(imported.has(name), `cli.mjs 使用了 ${name} 但未从 node:child_process 导入（wb restart spawn 事故回归）`);
  }
  assert.ok(used.has('spawn'), '脚本应仍在使用 spawn（restart 依赖）；若移除请同步更新本卫兵');
});

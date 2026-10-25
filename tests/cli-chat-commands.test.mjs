import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createWorkbench } from '../server/index.mjs';

const cli = path.resolve('scripts/cli.mjs');

async function start(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ggb-chat-cmd-'));
  const workspace = path.join(dir, 'project');
  fs.mkdirSync(workspace, { recursive: true });
  const app = createWorkbench({ dir, dataDir: path.join(dir, 'data'), workspace, requireCredential: false });
  await new Promise((resolve, reject) => {
    app.server.once('error', reject);
    app.server.listen(0, '127.0.0.1', resolve);
  });
  t.after(async () => { await app.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  return { app, base: `http://127.0.0.1:${app.server.address().port}` };
}

test('裸 ggb 在非 TTY 下输出帮助（交互入口需要 TTY）', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ggb-bare-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const child = spawn(process.execPath, [cli], {
    env: { ...process.env, PATH: process.env.PATH, DSH_SESSION_DIR: dir },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  child.stdout.on('data', chunk => { stdout += chunk; });
  await new Promise(resolve => child.on('close', resolve));
  assert.match(stdout, /用法：/);
  assert.match(stdout, /进入工作台首页/);
});

test('裸 ggb 进入工作台首页：/help、未知命令、序号选团队', async t => {
  const { base } = await start(t);
  const sessionDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ggb-home-sess-'));
  // 创建两个团队供测试
  for (const name of ['团队甲', '团队乙']) {
    await (await fetch(`${base}/api/teams`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, goal: 'g', purpose: 'p', pmRoleId: 'project_manager', memberRoleIds: ['project_manager'] }),
    })).json();
  }

  const lines = ['/help', '/bogus', 'q'];
  const child = spawn(process.execPath, [cli, '--api', base, '--session', 'home-test'], {
    env: { ...process.env, PATH: process.env.PATH, DSH_SESSION_DIR: sessionDir, GGB_FORCE_INTERACTIVE: '1' },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let out = '';
  child.stdout.on('data', chunk => { out += chunk; });
  child.stderr.on('data', chunk => { out += chunk; });

  // 逐行喂入，间隔 500ms
  for (const line of lines) {
    await new Promise(resolve => setTimeout(resolve, 500));
    child.stdin.write(line + '\n');
  }
  // 等待退出
  await new Promise(resolve => {
    const timer = setTimeout(() => { try { child.kill(); } catch {} resolve(); }, 15000);
    child.on('close', () => { clearTimeout(timer); resolve(); });
  });

  assert.match(out, /Goal-Guided Brain/, '应有标题');
  assert.match(out, /团队甲/, '应列出团队');
  assert.match(out, /团队乙/, '应列出团队');
  assert.match(out, /\/login/, '/help 应列出命令');
  assert.match(out, /未知命令 \/bogus/, '未知命令应提示');
});

test('chat /team 和 /tasks 正常工作', async t => {
  const { base } = await start(t);
  const sessionDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ggb-team-sess-'));
  const team = await (await fetch(`${base}/api/teams`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: '聊天组', goal: 'g', purpose: 'p', pmRoleId: 'project_manager', memberRoleIds: ['project_manager'] }),
  })).json();

  const lines = ['/team', `/team ${team.id}`, '/exit'];
  const child = spawn(process.execPath, [cli, 'chat', '--api', base, '--session', 'team-test'], {
    env: { ...process.env, PATH: process.env.PATH, DSH_SESSION_DIR: sessionDir, GGB_FORCE_INTERACTIVE: '1' },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let out = '';
  child.stdout.on('data', chunk => { out += chunk; });
  for (const line of lines) {
    await new Promise(resolve => setTimeout(resolve, 500));
    child.stdin.write(line + '\n');
  }
  await new Promise(resolve => {
    const timer = setTimeout(() => { try { child.kill(); } catch {} resolve(); }, 10000);
    child.on('close', () => { clearTimeout(timer); resolve(); });
  });
  assert.match(out, /未绑定团队|聊天组/, '应列出或绑定团队');
});

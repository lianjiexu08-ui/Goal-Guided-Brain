import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createWorkbench } from '../server/index.mjs';

const cli = path.resolve('scripts/cli.mjs');

/** 用 pty 模拟 TTY 驱动 chat。 */
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

test('裸 ggb 进入工作台首页：团队列表与编号选择', async t => {
  const { base, app } = await start(t);
  const store = app.platform.control.store;
  store.saveTeamSpace({ name: '首页团队', goal: 'g', purpose: 'p', workspace: store.config.workspace, pmRoleId: 'project_manager' });

  const sessionDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ggb-home-sess-'));
  t.after(() => fs.rmSync(sessionDir, { recursive: true, force: true }));
  const input = ['/help', '/flaky-test', '/bogus', '1', '/exit', '', 'q', ''].join('\n');
  const result = await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cli, '--api', base, '--session', 'hometest'], {
      env: { ...process.env, PATH: process.env.PATH, DSH_SESSION_DIR: sessionDir, GGB_FORCE_INTERACTIVE: '1' },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let out = '';
    child.stdout.on('data', chunk => { out += chunk; });
    child.on('error', reject);
    const lines = input.split('\n');
    let index = 0;
    const feeder = setInterval(() => {
      if (index < lines.length) { child.stdin.write(`${lines[index]}\n`); index += 1; }
      else clearInterval(feeder);
    }, 300);
    const killer = setTimeout(() => { try { child.kill('SIGKILL'); } catch {} resolve({ code: null, out }); }, 30000);
    child.on('close', code => { clearTimeout(killer); clearInterval(feeder); resolve({ code, out }); });
  });

  assert.match(result.out, /Goal-Guided Brain/);
  assert.match(result.out, /首页团队/);
  assert.match(result.out, /首页命令/, '/help 应列出首页命令');
  if (!/尚未安装/.test(result.out)) console.error('DEBUG out:', result.out.slice(0, 1500));
  assert.match(result.out, /尚未安装.*不稳定测试|ggb skill install flaky-test/, '未装 Skill 应提示安装');
  assert.match(result.out, /未知命令 \/bogus/, '未知命令应提示可用列表');
  assert.match(result.out, /已进入团队「首页团队」/);
});

test('chat 的 /team 与 /tasks 斜杠命令（GGB_FORCE_INTERACTIVE 驱动真实循环）', async t => {
  const { base, app } = await start(t);
  const store = app.platform.control.store;
  const team = store.saveTeamSpace({ name: '聊天绑定组', goal: 'g', purpose: 'p', workspace: store.config.workspace, pmRoleId: 'project_manager' });
  store.saveTeamMessage({ spaceId: team.id, kind: 'reply', senderType: 'agent', senderId: 'project_manager', content: '聊天命令测试回复' }, 'chat-evt');

  const sessionDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ggb-chat-sess-'));
  t.after(() => fs.rmSync(sessionDir, { recursive: true, force: true }));

  const input = [
    '/team',
    `/team ${team.id}`,
    '/tasks',
    '/exit',
    '',
  ].join('\n');

  const result = await new Promise((resolve, reject) => {
    // script 分配伪 TTY，让 chat 的 isTTY 检查通过
    const child = spawn(process.execPath, [cli, 'chat', '--api', base, '--session', 'cmdtest'], {
      env: { ...process.env, PATH: process.env.PATH, DSH_SESSION_DIR: sessionDir, GGB_FORCE_INTERACTIVE: '1' },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let out = '';
    child.stdout.on('data', chunk => { out += chunk; });

    child.on('error', reject);
    child.on('close', code => resolve({ code, out }));
    // readline 在异步处理期间会丢弃后续 line 事件，逐行延迟写入
    const lines = input.split('\n');
    let index = 0;
    const feeder = setInterval(() => {
      if (index < lines.length) {
        child.stdin.write(`${lines[index]}\n`);
        index += 1;
      } else clearInterval(feeder);
    }, 350);
    setTimeout(() => { try { child.kill('SIGKILL'); } catch {} resolve({ code: null, out }); }, 15000);
  });

  if (!result.out) console.error('DEBUG: chat 无输出（exit=%s）', result.code);
  assert.match(result.out, /未绑定团队|聊天绑定组/, '应列出团队');
  assert.match(result.out, /已绑定团队：聊天绑定组/);
  assert.match(result.out, /还没有任务|\[\w+\]/, '/tasks 应反馈任务状态');
});

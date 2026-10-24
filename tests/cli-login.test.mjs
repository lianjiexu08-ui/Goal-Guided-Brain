import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createWorkbench } from '../server/index.mjs';

const cli = path.resolve('scripts/cli.mjs');

function runCli(args, { env = {} } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cli, ...args], {
      env: { ...process.env, PATH: process.env.PATH, ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '', stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', code => resolve({ code, stdout, stderr }));
  });
}

async function start(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ggb-login-'));
  const workspace = path.join(dir, 'project');
  fs.mkdirSync(workspace, { recursive: true });
  const app = createWorkbench({ dir, dataDir: path.join(dir, 'data'), workspace, requireCredential: false });
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const sessionDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ggb-login-sess-'));
  t.after(async () => {
    await app.close();
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(sessionDir, { recursive: true, force: true });
  });
  return { app, base, env: { DSH_SESSION_DIR: sessionDir } };
}

test('ggb login 把密钥写入加密凭据库并启用供应商，重复登录复用同一凭据', async t => {
  const { app, base, env } = await start(t);
  const first = await runCli(['login', 'claude', '--api', base, '--api-key', 'sk-ant-test', '--passphrase', 'test-pass-123'], { env });
  assert.equal(first.code, 0, first.stderr);
  assert.match(first.stdout, /已登录 Claude/);

  const manage = await (await fetch(`${base}/api/manage`)).json();
  assert.equal(manage.vault.initialized, true);
  assert.equal(manage.vault.unlocked, true);
  const provider = manage.providers.find(item => item.name === 'Claude');
  assert.ok(provider, '应创建供应商');
  assert.equal(provider.protocol, 'anthropic-messages');
  assert.equal(provider.enabled, true);
  assert.ok(provider.credentialId, '应引用凭据');
  assert.equal(manage.credentials.length, 1);

  // 再次登录：复用同一凭据，不产生第二份密钥
  const second = await runCli(['login', 'claude', '--api', base, '--api-key', 'sk-ant-rotated', '--passphrase', 'test-pass-123'], { env });
  assert.equal(second.code, 0, second.stderr);
  const after = await (await fetch(`${base}/api/manage`)).json();
  assert.equal(after.credentials.length, 1, '不应重复创建凭据');
  assert.equal(after.providers.filter(item => item.name === 'Claude').length, 1);

  const vault = app.platform.vault;
  assert.equal(vault.get(provider.credentialId), 'sk-ant-rotated', '凭据应被更新');
});

test('ggb models 标记已登录的供应商', async t => {
  const { base, env } = await start(t);
  await runCli(['login', 'deepseek', '--api', base, '--api-key', 'sk-test', '--passphrase', 'test-pass-123'], { env });
  const result = await runCli(['models', '--api', base], { env });
  assert.equal(result.code, 0, result.stderr);
  const line = result.stdout.split('\n').find(item => item.includes('deepseek'));
  assert.match(line, /^✓/, '已登录应显示 ✓');
});

test('ggb logout 移除供应商与凭据', async t => {
  const { base, env } = await start(t);
  await runCli(['login', 'gemini', '--api', base, '--api-key', 'g-test', '--passphrase', 'test-pass-123'], { env });
  const out = await runCli(['logout', 'gemini', '--api', base], { env });
  assert.equal(out.code, 0, out.stderr);
  assert.match(out.stdout, /已移除/);
  const manage = await (await fetch(`${base}/api/manage`)).json();
  assert.equal(manage.providers.filter(item => item.name === 'Gemini').length, 0);
  assert.equal(manage.credentials.filter(item => item.name === 'Gemini API Key').length, 0);
});

test('工作台不可达时给出明确指引而不是静默失败', async t => {
  const { env } = await start(t);
  const result = await runCli(['login', 'claude', '--api', 'http://127.0.0.1:1', '--api-key', 'x', '--passphrase', 'test-pass-123'], { env });
  assert.notEqual(result.code, 0);
  assert.match(result.stderr + result.stdout, /无法连接工作台|npm start/);
});

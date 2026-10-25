import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createWorkbench } from '../server/index.mjs';

const cli = path.resolve('scripts/cli.mjs');

function runCli(args) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cli, ...args], {
      env: { ...process.env, PATH: process.env.PATH, DSH_SESSION_DIR: os.tmpdir() },
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
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ggb-usage-'));
  const workspace = path.join(dir, 'project');
  fs.mkdirSync(workspace, { recursive: true });
  const app = createWorkbench({ dir, dataDir: path.join(dir, 'data'), workspace, requireCredential: false });
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  t.after(async () => { await app.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  return { app, base };
}

test('ggb usage 显示任务统计和 token 用量', async t => {
  const { app, base } = await start(t);
  // 造一个任务
  const created = await (await fetch(`${base}/api/tasks`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ role: 'developer', prompt: '测试用量', workspaceMode: 'shared' }),
  })).json();
  // 直接写 usage 记录
  app.platform.control.records.save('usage', {
    taskId: created.id, totalTokens: 500, inputTokens: 400, outputTokens: 100,
    providerId: 'test', model: 'test-model',
  }, `usage:${created.id}:1`);
  app.platform.control.updateTask(created.id, { status: 'completed' });

  const result = await runCli(['usage', '--api', base]);
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /模型用量报告/);
  assert.match(result.stdout, /Token/);
  assert.match(result.stdout, /完成/);
});

test('ggb usage --json 输出结构化数据', async t => {
  const { base } = await start(t);
  const result = await runCli(['usage', '--api', base, '--json']);
  assert.equal(result.code, 0, result.stderr);
  const data = JSON.parse(result.stdout);
  assert.ok(data.totals, '应有 totals');
  assert.ok(Array.isArray(data.items), '应有 items');
  assert.ok(data.options, '应有 options');
});

test('ggb usage 空数据不崩溃', async t => {
  const { base } = await start(t);
  const result = await runCli(['usage', '--api', base]);
  assert.equal(result.code, 0);
  assert.match(result.stdout, /模型用量报告/);
});

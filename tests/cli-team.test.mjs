import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createWorkbench } from '../server/index.mjs';

const cli = path.resolve('scripts/cli.mjs');

function runCli(args, { input = '', env = {} } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cli, ...args], {
      env: { ...process.env, PATH: process.env.PATH, ...env },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '', stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', code => resolve({ code, stdout, stderr }));
    child.stdin.end(input);
  });
}

async function startWorkbench(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ggb-cli-team-'));
  const workspace = path.join(dir, 'project');
  fs.mkdirSync(workspace);
  const runs = [];
  const app = createWorkbench({
    dir, dataDir: path.join(dir, 'data'), workspace,
    requireCredential: false,
    runtimeFactory: options => ({
      options,
      start(prompt) { this.prompt = prompt; runs.push(this); },
      cancel() { options.onDone('cancelled', ''); },
      complete(result = '已完成。') { options.onResult(result); options.onDone('completed', ''); },
    }),
  });
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  t.after(async () => { await app.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  return { app, base, runs, dir };
}

const tick = () => new Promise(resolve => setTimeout(resolve, 30));

test('ggb team list/create/status 驱动工作台团队', async t => {
  const { base } = await startWorkbench(t);
  const sessionDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ggb-sess-'));
  t.after(() => fs.rmSync(sessionDir, { recursive: true, force: true }));
  const env = { DSH_SESSION_DIR: sessionDir };

  const listEmpty = await runCli(['team', 'list', '--api', base], { env });
  assert.equal(listEmpty.code, 0, listEmpty.stderr);

  const created = await runCli(['team', 'create', '--api', base, '--name', 'CLI 团队', '--goal', '交付一个命令行工具', '--no-review'], { env });
  assert.equal(created.code, 0, created.stderr);
  assert.match(created.stdout, /CLI 团队/);
  assert.match(created.stdout, /自动确认/);
  const teamId = (created.stdout.match(/\(([0-9a-f-]{36})\)/) || [])[1];
  assert.ok(teamId, `未从输出解析到团队 ID：${created.stdout}`);

  const list = await runCli(['team', 'list', '--api', base], { env });
  assert.match(list.stdout, /CLI 团队/);
  assert.match(list.stdout, /自治招募/);

  const status = await runCli(['team', 'status', teamId, '--api', base], { env });
  assert.equal(status.code, 0, status.stderr);
  assert.match(status.stdout, /CLI 团队/);
});

test('ggb team run 触发项目经理并可在 status 中看到消息', async t => {
  const { base, runs } = await startWorkbench(t);
  const sessionDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ggb-sess-'));
  t.after(() => fs.rmSync(sessionDir, { recursive: true, force: true }));
  const env = { DSH_SESSION_DIR: sessionDir };

  const created = await runCli(['team', 'create', '--api', base, '--name', '执行团队', '--goal', '实现功能', '--no-review'], { env });
  const teamId = (created.stdout.match(/\(([0-9a-f-]{36})\)/) || [])[1];

  const run = await runCli(['team', 'run', teamId, '做一个可测试的命令行待办工具', '--api', base], { env });
  assert.equal(run.code, 0, run.stderr);
  assert.match(run.stdout, /已把目标交给团队项目经理/);
  await tick();
  assert.equal(runs.length, 1);
  assert.match(runs[0].prompt, /命令行待办工具/);

  const status = await runCli(['team', 'status', teamId, '--api', base], { env });
  assert.match(status.stdout, /命令行待办工具/);
});

test('ggb team review 需要 approve/reject 与操作 ID', async t => {
  const { base } = await startWorkbench(t);
  const sessionDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ggb-sess-'));
  t.after(() => fs.rmSync(sessionDir, { recursive: true, force: true }));
  const env = { DSH_SESSION_DIR: sessionDir };
  const bad = await runCli(['team', 'review', 'some-team', '--api', base], { env });
  assert.notEqual(bad.code, 0);
  assert.match(bad.stderr + bad.stdout, /approve|reject|操作/);
});

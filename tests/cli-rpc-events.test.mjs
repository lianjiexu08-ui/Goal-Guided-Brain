import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { createWorkbench } from '../server/index.mjs';

const cli = path.resolve('scripts/cli.mjs');

function runCli(args, { env = {}, input = '', timeoutMs = 15000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cli, ...args], {
      env: { ...process.env, PATH: process.env.PATH, ...env },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '', stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('error', reject);
    const timer = setTimeout(() => { child.kill('SIGKILL'); resolve({ code: null, stdout, stderr, killed: true }); }, timeoutMs);
    child.on('close', code => { clearTimeout(timer); resolve({ code, stdout, stderr }); });
    child.stdin.end(input);
  });
}

async function start(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ggb-rpc-'));
  const workspace = path.join(dir, 'project');
  fs.mkdirSync(workspace, { recursive: true });
  const app = createWorkbench({ dir, dataDir: path.join(dir, 'data'), workspace, requireCredential: false });
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const sessionDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ggb-rpc-sess-'));
  t.after(async () => {
    await app.close();
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(sessionDir, { recursive: true, force: true });
  });
  return { app, base, env: { DSH_SESSION_DIR: sessionDir }, dir };
}

function fakeProvider(t) {
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      const parsed = JSON.parse(body || '{}');
      const lastUser = [...(parsed.messages || [])].reverse().find(m => m.role === 'user')?.content || '';
      if (parsed.stream) {
        // SSE 流式响应：两段 delta + usage 帧
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        const frame = obj => `data: ${JSON.stringify(obj)}\n\n`;
        res.write(frame({ choices: [{ delta: { content: '回答：' } }] }));
        res.write(frame({ choices: [{ delta: { content: lastUser } }] }));
        res.write(frame({ choices: [], usage: { prompt_tokens: 100, completion_tokens: 20 } }));
        res.write('data: [DONE]\n\n');
        res.end();
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        choices: [{ message: { content: `回答：${lastUser}` } }],
        usage: { prompt_tokens: 100, completion_tokens: 20 },
      }));
    });
  });
  t.after(() => server.close());
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${server.address().port}/v1`)));
}

test('ggb rpc 处理 ping/prompt/follow_up/set_model/abort，输出 JSONL 事件', async t => {
  const pbase = await fakeProvider(t);
  const { env } = await start(t);
  const lines = [
    JSON.stringify({ type: 'ping' }),
    JSON.stringify({ type: 'prompt', id: 'p1', text: '第一个问题' }),
    JSON.stringify({ type: 'follow_up', id: 'p2', text: '第二个问题' }),
    JSON.stringify({ type: 'set_model', provider: 'gemini', model: 'gemini-2.5-flash' }),
    JSON.stringify({ type: 'session' }),
    JSON.stringify({ type: 'prompt', id: 'p3', text: '' }),
    JSON.stringify({ type: 'not-a-type' }),
    '',
  ].join('\n');
  const result = await runCli([
    'rpc', '--provider', 'openai', '--base-url', pbase, '--api-key', 'k', '--session', 'rpc-test',
  ], { env, input: lines });
  assert.equal(result.code, 0, result.stderr);
  const events = result.stdout.trim().split('\n').map(line => { try { return JSON.parse(line); } catch { return null; } }).filter(Boolean);
  const types = events.map(event => event.type);
  assert.ok(types.includes('session_start'));
  assert.ok(types.includes('ready'));
  assert.ok(types.includes('turn_start'));
  assert.equal(types.filter(type => type === 'turn_end').length, 2, '两个有效 prompt 各产生一次 turn_end');
  assert.ok(events.some(event => event.type === 'text_delta'), '应有流式 text_delta');
  assert.ok(events.some(event => event.type === 'text_delta' && /第一个问题/.test(event.text)));
  assert.ok(events.some(event => event.type === 'model_changed' && event.model === 'gemini-2.5-flash'));
  assert.ok(events.some(event => event.type === 'error' && event.code === 'INVALID_PROMPT'));
  assert.ok(events.some(event => event.type === 'error' && event.code === 'INVALID_MESSAGE'));
  assert.ok(events.some(event => event.type === 'session' && event.file));
  // turn_end 的 text 应包含回答
  const turnEnd = events.find(event => event.type === 'turn_end' && event.id === 'p1');
  assert.match(turnEnd.text, /第一个问题/);
});

test('ggb events --team 使用团队事件流输出任务与消息', async t => {
  const { app, base, env } = await start(t);
  const store = app.platform.control.store;
  const team = store.saveTeamSpace({ name: '事件组', goal: 'g', purpose: 'p', workspace: store.config.workspace, pmRoleId: 'project_manager' });
  // 后台写一条消息
  setTimeout(() => {
    store.saveTeamMessage({ spaceId: team.id, kind: 'reply', senderType: 'agent', senderId: 'project_manager', content: '事件流内容' }, 'evt-1');
  }, 300);
  const result = await runCli(['events', '--team', team.id, '--api', base, '--json'], { env, timeoutMs: 6000 });
  // 事件流不会自行结束（kill 后 code=null），只要输出包含事件即可
  assert.match(result.stdout, /事件流内容|hello|team/);
});

test('ggb events <taskId> 输出任务状态与事件', async t => {
  const { base, env } = await start(t);
  const created = await (await fetch(`${base}/api/tasks`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ role: 'developer', prompt: '事件测试', workspaceMode: 'shared' }),
  })).json();
  const result = await runCli(['events', created.id, '--once', '--api', base], { env, timeoutMs: 8000 });
  // 任务详情以一行 task 摘要输出（含状态），事件行包含 type。
  assert.match(result.stdout, /task/);
  assert.match(result.stdout, /事件测试/);
});

test('ggb node --help 显示用法且不启动连接', async () => {
  const result = await runCli(['node', '--help']);
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /--control-url/);
  assert.match(result.stdout, /--workspace/);
});

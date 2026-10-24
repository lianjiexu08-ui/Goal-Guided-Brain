import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createWorkbench } from '../server/index.mjs';

const cli = path.resolve('scripts/cli.mjs');

function runCli(args, { env = {}, input = '' } = {}) {
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

async function start(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ggb-cli-extra-'));
  const workspace = path.join(dir, 'project');
  fs.mkdirSync(workspace, { recursive: true });
  const app = createWorkbench({ dir, dataDir: path.join(dir, 'data'), workspace, requireCredential: false });
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const sessionDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ggb-cli-extra-sess-'));
  t.after(async () => {
    await app.close();
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(sessionDir, { recursive: true, force: true });
  });
  return { app, base, env: { DSH_SESSION_DIR: sessionDir }, dir };
}

test('ggb models 列出内置供应商与上下文窗口，并叠加 models.json', async t => {
  const { dir, env } = await start(t);
  const modelsFile = path.join(dir, 'models.json');
  fs.writeFileSync(modelsFile, JSON.stringify({
    providers: {
      'my-gateway': {
        label: '自建网关',
        baseUrl: 'https://gateway.example.test/v1',
        api: 'openai-completions',
        apiKey: '$MY_GATEWAY_KEY',
        models: [{ id: 'house-model', contextWindow: 64000 }],
      },
    },
  }));

  const result = await runCli(['models'], { env: { ...env, GGB_MODELS_FILE: modelsFile } });
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /deepseek/);
  assert.match(result.stdout, /gemini/);
  assert.match(result.stdout, /my-gateway/);
  assert.match(result.stdout, /house-model/);
  assert.match(result.stdout, /ctx 64k/);

  const json = await runCli(['models', '--json'], { env: { ...env, GGB_MODELS_FILE: modelsFile } });
  const parsed = JSON.parse(json.stdout);
  const custom = parsed.providers.find(item => item.id === 'my-gateway');
  assert.equal(custom.contextWindow, 64000);
  assert.equal(custom.protocol, 'chat');
  assert.equal(custom.custom, true);
  // apiKey 使用环境变量插值，不落盘
  assert.equal(custom.configured, false);
});

test('ggb models 拒绝无效的 models.json', async t => {
  const { dir, env } = await start(t);
  const modelsFile = path.join(dir, 'bad.json');
  fs.writeFileSync(modelsFile, JSON.stringify({ providers: { bad: { baseUrl: 'not-a-url' } } }));
  const result = await runCli(['models'], { env: { ...env, GGB_MODELS_FILE: modelsFile } });
  assert.notEqual(result.code, 0);
  assert.match(result.stderr + result.stdout, /baseUrl/);
});

test('ggb context share / list 支持所有者直接发布与读取', async t => {
  const { app, base, env } = await start(t);
  const store = app.platform.control.store;
  const team = store.saveTeamSpace({ name: '甲', goal: 'g', purpose: 'p', workspace: app.platform.control.store.config.workspace, pmRoleId: 'project_manager' });
  const other = store.saveTeamSpace({ name: '乙', goal: 'g', purpose: 'p', workspace: app.platform.control.store.config.workspace, pmRoleId: 'project_manager' });
  for (const id of [team.id, other.id])
    store.saveTeamSpace({ ...store.teamSpace(id), collaboration: { enabled: true, autoHandoff: true, sharedBoard: true, allowedTeamIds: [] } }, id);

  const shared = await runCli(['context', 'share', team.id, '--api', base, '--key', 'decision/api', '--title', '接口约定', '--content', 'REST 使用 v2 路径。', '--kind', 'decision'], { env });
  assert.equal(shared.code, 0, shared.stderr);
  assert.match(shared.stdout, /已共享/);

  const listed = await runCli(['context', 'list', team.id, '--api', base], { env });
  assert.equal(listed.code, 0, listed.stderr);
  assert.match(listed.stdout, /decision\/api/);
  assert.match(listed.stdout, /接口约定/);

  // 双向协作团队也能读到
  const otherView = await runCli(['context', 'list', other.id, '--api', base], { env });
  assert.match(otherView.stdout, /接口约定/);
  assert.match(otherView.stdout, /甲/);

  // 更新需要 revision
  const rev = JSON.parse((await (await fetch(`${base}/api/teams/${team.id}/context`)).json()).items[0].revision);
  const updated = await runCli(['context', 'share', team.id, '--api', base, '--key', 'decision/api', '--title', '接口约定', '--content', '改为 v3。', '--revision', String(rev)], { env });
  assert.equal(updated.code, 0, updated.stderr);
});

test('团队事件流推送新消息', async t => {
  const { app, base } = await start(t);
  const store = app.platform.control.store;
  const team = store.saveTeamSpace({ name: '甲', goal: 'g', purpose: 'p', workspace: store.config.workspace, pmRoleId: 'project_manager' });
  const controller = new AbortController();
  t.after(() => controller.abort());
  const baseUrl = base;
  const response = await fetch(`${baseUrl}/api/teams/${team.id}/stream`, {
    headers: { Accept: 'text/event-stream' },
    signal: controller.signal,
  });
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type') || '', /text\/event-stream/);
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let sawHello = false;
  let sawMessage = false;
  const deadline = Date.now() + 6000;

  // 连接建立后写入一条团队消息
  setTimeout(() => {
    store.saveTeamMessage({ spaceId: team.id, kind: 'reply', senderType: 'agent', senderId: 'project_manager', content: '流式测试回复' }, 'stream-test');
  }, 200);

  while (Date.now() < deadline && !sawMessage) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value || new Uint8Array(), { stream: true });
    if (buffer.includes('event: hello')) sawHello = true;
    if (buffer.includes('流式测试回复')) sawMessage = true;
  }
  controller.abort();
  assert.equal(sawHello, true, '应先收到 hello 事件');
  assert.equal(sawMessage, true, '应推送新消息');
});

test('run 输出底部状态行（含 token 与上下文占用），且不污染 stdout', async t => {
  const { createServer } = await import('node:http');
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      const parsed = JSON.parse(body || '{}');
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        choices: [{ message: { content: '好的，这是回答。' } }],
        usage: { prompt_tokens: 1200, completion_tokens: 300 },
        model: parsed.model,
      }));
    });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}/v1`;

  const result = await runCli([
    'run', '--provider', 'openai', '--base-url', base, '--api-key', 'test-key',
    '--no-stream', '你好',
  ]);
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /好的，这是回答/);
  // stdout 保持干净：状态行只写 stderr
  assert.doesNotMatch(result.stdout, /上下文/);
  assert.match(result.stderr, /openai\//);
  assert.match(result.stderr, /in 1\.2k \/ out 300/);
  assert.match(result.stderr, /上下文 1\.2k\/400\.0k/);
  assert.match(result.stderr, /\d+(\.\d+)?s/);

  const json = await runCli([
    'run', '--provider', 'openai', '--base-url', base, '--api-key', 'test-key',
    '--no-stream', '--json', '你好',
  ]);
  const event = JSON.parse(json.stdout.trim());
  assert.equal(event.type, 'turn_end');
  assert.deepEqual(event.usage, { inputTokens: 1200, outputTokens: 300 });
  assert.equal(event.contextWindow, 400000);
  assert.ok(event.elapsedMs >= 0);
});

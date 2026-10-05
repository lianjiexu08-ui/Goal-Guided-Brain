import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

const cli = path.resolve('scripts/cli.mjs');

test('package exposes the cross-platform ggb executable alias', () => {
  const packageJson = JSON.parse(fs.readFileSync(path.resolve('package.json'), 'utf8'));
  assert.equal(packageJson.bin.ggb, './scripts/cli.mjs');
});

function runCli(url, args, input = '', noStream = true, extraEnv = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cli, 'run', '--base-url', url, '--api-key', 'fixture-key', ...(noStream ? ['--no-stream'] : []), ...args], {
      env: { ...process.env, PATH: process.env.PATH, ...extraEnv },
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

function runDecide(url, args, extraEnv = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cli, 'decide', '--base-url', url, '--api-key', 'fixture-key', ...args], {
      env: { ...process.env, PATH: process.env.PATH, ...extraEnv },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '', stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', code => resolve({ code, stdout, stderr }));
  });
}

function runDoctor(args = [], extraEnv = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cli, 'doctor', ...args], {
      env: { ...process.env, PATH: process.env.PATH, ...extraEnv },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '', stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', code => resolve({ code, stdout, stderr }));
  });
}

function runEvents(url, args = [], extraEnv = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cli, 'events', 'fixture-task', '--api-url', url, ...args], {
      env: { ...process.env, PATH: process.env.PATH, ...extraEnv },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '', stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', code => resolve({ code, stdout, stderr }));
  });
}

function runTeamEvents(url, args = [], extraEnv = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cli, 'events', '--team', 'fixture-team', '--api-url', url, ...args], {
      env: { ...process.env, PATH: process.env.PATH, ...extraEnv },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '', stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', code => resolve({ code, stdout, stderr }));
  });
}

function runNode(args, extraEnv = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cli, 'node', ...args], {
      env: { ...process.env, PATH: process.env.PATH, ...extraEnv },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '', stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', code => resolve({ code, stdout, stderr }));
  });
}

function runRpc(url, args, messages, extraEnv = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cli, 'rpc', '--base-url', url, '--api-key', 'fixture-key', ...args], {
      env: { ...process.env, PATH: process.env.PATH, ...extraEnv },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '', stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', code => resolve({ code, stdout, stderr }));
    child.stdin.end(messages.map(message => JSON.stringify(message)).join('\n') + '\n');
  });
}

test('CLI doctor reports cross-platform runtime and service checks without exposing credentials', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-cli-doctor-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const api = http.createServer((_req, res) => {
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ status: 'ok' }));
  });
  const ui = http.createServer((_req, res) => {
    res.setHeader('content-type', 'text/html');
    res.end('<!doctype html><title>fixture</title>');
  });
  await Promise.all([
    new Promise(resolve => api.listen(0, '127.0.0.1', resolve)),
    new Promise(resolve => ui.listen(0, '127.0.0.1', resolve)),
  ]);
  t.after(() => { api.close(); ui.close(); });
  const result = await runDoctor([
    '--api-url', `http://127.0.0.1:${api.address().port}/api/health`,
    '--ui-url', `http://127.0.0.1:${ui.address().port}/`,
    '--json',
  ], { DSH_SESSION_DIR: directory, DEEPSEEK_API_KEY: 'doctor-secret-fixture' });
  assert.equal(result.code, 0);
  assert.equal(result.stderr, '');
  assert.equal(result.stdout.includes('doctor-secret-fixture'), false);
  const report = JSON.parse(result.stdout);
  assert.equal(report.ok, true);
  assert.equal(report.platform.node, process.versions.node);
  assert.equal(report.checks.find(check => check.id === 'session').status, 'pass');
  assert.equal(report.checks.find(check => check.id === 'providers').status, 'pass');
  assert.equal(report.checks.find(check => check.id === 'api').status, 'pass');
  assert.equal(report.checks.find(check => check.id === 'ui').status, 'pass');
});

test('CLI doctor strict mode returns a gateable status for deployment checks', async (t) => {
  const api = http.createServer((_req, res) => {
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ status: 'ok' }));
  });
  const ui = http.createServer((_req, res) => {
    res.setHeader('content-type', 'text/html');
    res.end('<!doctype html><title>fixture</title>');
  });
  await Promise.all([
    new Promise(resolve => api.listen(0, '127.0.0.1', resolve)),
    new Promise(resolve => ui.listen(0, '127.0.0.1', resolve)),
  ]);
  t.after(() => { api.close(); ui.close(); });
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-cli-strict-doctor-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const healthy = await runDoctor([
    '--api-url', `http://127.0.0.1:${api.address().port}/api/health`,
    '--ui-url', `http://127.0.0.1:${ui.address().port}/`,
    '--strict', '--json',
  ], { DSH_SESSION_DIR: directory, DEEPSEEK_API_KEY: 'strict-fixture-key' });
  assert.equal(healthy.code, 0, healthy.stderr);
  assert.equal(JSON.parse(healthy.stdout).strictOk, true);
  const unhealthy = await runDoctor([
    '--api-url', 'http://127.0.0.1:1/api/health',
    '--ui-url', 'http://127.0.0.1:1/',
    '--strict', '--json',
  ], { DSH_SESSION_DIR: directory, DEEPSEEK_API_KEY: 'strict-fixture-key' });
  assert.equal(unhealthy.code, 1);
  assert.equal(JSON.parse(unhealthy.stdout).strictOk, false);
});

test('CLI doctor validates a node config without exposing identity data', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-cli-node-doctor-'));
  const workspace = path.join(directory, 'project');
  const configPath = path.join(directory, 'node.json');
  fs.mkdirSync(workspace);
  fs.writeFileSync(configPath, JSON.stringify({
    controlUrl: 'https://workbench.example.test',
    dataDir: path.join(directory, 'node-data'),
    workspaces: { project: workspace },
    token: 'node-secret-fixture',
  }));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const api = http.createServer((_req, res) => {
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ status: 'ok' }));
  });
  const ui = http.createServer((_req, res) => {
    res.setHeader('content-type', 'text/html');
    res.end('<!doctype html><title>fixture</title>');
  });
  await Promise.all([
    new Promise(resolve => api.listen(0, '127.0.0.1', resolve)),
    new Promise(resolve => ui.listen(0, '127.0.0.1', resolve)),
  ]);
  t.after(() => { api.close(); ui.close(); });
  const healthy = await runDoctor([
    '--node-config', configPath,
    '--api-url', `http://127.0.0.1:${api.address().port}/api/health`,
    '--ui-url', `http://127.0.0.1:${ui.address().port}/`,
    '--strict', '--json',
  ], { DSH_SESSION_DIR: path.join(directory, 'sessions'), DEEPSEEK_API_KEY: 'doctor-node-key' });
  assert.equal(healthy.code, 0, healthy.stderr);
  const report = JSON.parse(healthy.stdout);
  assert.equal(report.checks.find(check => check.id === 'node-config').status, 'pass');
  assert.equal(healthy.stdout.includes('node-secret-fixture'), false);

  fs.writeFileSync(configPath, JSON.stringify({
    controlUrl: 'https://workbench.example.test',
    dataDir: path.join(directory, 'node-data'),
    workspaces: { project: path.join(directory, 'missing') },
  }));
  const unhealthy = await runDoctor([
    '--node-config', configPath,
    '--api-url', `http://127.0.0.1:${api.address().port}/api/health`,
    '--ui-url', `http://127.0.0.1:${ui.address().port}/`,
    '--strict', '--json',
  ], { DSH_SESSION_DIR: path.join(directory, 'sessions'), DEEPSEEK_API_KEY: 'doctor-node-key' });
  assert.equal(unhealthy.code, 1);
  assert.equal(JSON.parse(unhealthy.stdout).checks.find(check => check.id === 'node-config').status, 'fail');
});

test('CLI doctor identifies a WSL2 environment from standard process variables', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-cli-wsl-doctor-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const result = await runDoctor(['--json', '--api-url', 'http://127.0.0.1:1/api/health', '--ui-url', 'http://127.0.0.1:1/'], {
    DSH_SESSION_DIR: directory,
    WSL_DISTRO_NAME: 'Ubuntu-24.04',
  });
  assert.equal(result.code, 0);
  const report = JSON.parse(result.stdout);
  assert.equal(report.platform.wsl, true);
  assert.match(report.checks.find(check => check.id === 'platform').detail, /WSL2/);
});

test('CLI exposes the execution node worker through the ggb command', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-ggb-node-'));
  const workspace = path.join(directory, 'project');
  fs.mkdirSync(workspace);
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const result = await runNode([
    '--control-url', 'https://workbench.example.test',
    '--workspace', `project=${workspace}`,
    '--data-dir', path.join(directory, 'node-data'),
    '--max-concurrent', '4',
    '--print-config',
  ]);
  assert.equal(result.code, 0, result.stderr);
  assert.equal(result.stderr, '');
  const config = JSON.parse(result.stdout);
  assert.equal(config.controlUrl, 'https://workbench.example.test');
  assert.deepEqual(config.workspaces, { project: workspace });
  assert.equal(config.maxConcurrent, 4);
  assert.equal(result.stdout.includes('token'), false);
  assert.equal(result.stdout.includes('identity'), false);
});

test('CLI prints a focused execution node help page', async () => {
  const result = await runNode(['--help']);
  assert.equal(result.code, 0);
  assert.equal(result.stderr, '');
  assert.match(result.stdout, /--control-url/);
  assert.match(result.stdout, /--workspace/);
});

test('CLI sends a unified prompt to an OpenAI-compatible provider', async (t) => {
  const requests = [];
  const server = http.createServer(async (req, res) => {
    let body = ''; for await (const chunk of req) body += chunk;
    requests.push({ url: req.url, body: JSON.parse(body), auth: req.headers.authorization });
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ choices: [{ message: { content: 'fixture answer' } }] }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const result = await runCli(`http://127.0.0.1:${server.address().port}/v1`, ['--provider', 'gemini', 'hello'], 'context');
  assert.equal(result.code, 0);
  assert.equal(result.stdout, 'fixture answer\n');
  assert.equal(requests[0].url, '/v1/chat/completions');
  assert.equal(requests[0].auth, 'Bearer fixture-key');
  assert.equal(requests[0].body.messages[0].content, 'hello\n\ncontext');
});

test('CLI decide sends a TypeSafe System One request and prints structured answers', async (t) => {
  const requests = [];
  const server = http.createServer(async (req, res) => {
    let body = ''; for await (const chunk of req) body += chunk;
    requests.push({ url: req.url, auth: req.headers.authorization, body: JSON.parse(body) });
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ model: 'jev-latest', answers: { urgent: { noul: 0.72 } } }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const result = await runDecide(`http://127.0.0.1:${server.address().port}/v1`, [
    '--state', '{"goal":"ship"}',
    '--questions', '{"urgent":{"type":"noul","instructions":"Is it urgent?"}}',
    '--json',
  ]);
  assert.equal(result.code, 0);
  assert.deepEqual(JSON.parse(result.stdout).answers.urgent, { noul: 0.72 });
  assert.equal(requests[0].url, '/v1/systemone');
  assert.equal(requests[0].auth, 'Bearer fixture-key');
  assert.deepEqual(requests[0].body.state, { goal: 'ship' });
});

test('CLI accepts gpt as an OpenAI-compatible provider alias', async (t) => {
  const requests = [];
  const server = http.createServer(async (req, res) => {
    let body = ''; for await (const chunk of req) body += chunk;
    requests.push(JSON.parse(body));
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ output_text: 'gpt alias answer' }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const result = await runCli(`http://127.0.0.1:${server.address().port}/v1`, ['--provider', 'gpt', '--model', 'fixture-gpt', 'hello']);
  assert.equal(result.code, 0);
  assert.equal(result.stdout, 'gpt alias answer\n');
  assert.equal(requests[0].model, 'fixture-gpt');
});

test('CLI parses Anthropic message responses', async (t) => {
  const server = http.createServer((req, res) => {
    assert.equal(req.url, '/v1/messages');
    assert.equal(req.headers['x-api-key'], 'fixture-key');
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ content: [{ type: 'text', text: 'claude answer' }] }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const result = await runCli(`http://127.0.0.1:${server.address().port}`, ['--provider', 'claude', 'hello']);
  assert.equal(result.code, 0);
  assert.equal(result.stdout, 'claude answer\n');
});

test('CLI emits streaming SSE chunks as they arrive', async (t) => {
  const server = http.createServer(async (_req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write('data: {"choices":[{"delta":{"content":"one "}}]}\n\n');
    await new Promise(resolve => setTimeout(resolve, 10));
    res.write('data: {"choices":[{"delta":{"content":"two"}}]}\n\n');
    res.end('data: [DONE]\n\n');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const result = await runCli(`http://127.0.0.1:${server.address().port}`, ['--provider', 'deepseek', 'hello'], '', false);
  assert.equal(result.code, 0);
  assert.equal(result.stdout, 'one two\n');
});

test('CLI events follows the workbench task stream and supports cursor recovery', async (t) => {
  const requests = [];
  const server = http.createServer(async (req, res) => {
    requests.push(req.url);
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write('id: 2026-09-30T00:00:00.000Z|history\nevent: task_event\ndata: {"id":"history","type":"history/test","at":"2026-09-30T00:00:00.000Z"}\n\n');
    res.write('event: ready\ndata: {"taskId":"fixture-task","cursor":"2026-09-30T00:00:00.000Z|history"}\n\n');
    await new Promise(resolve => setTimeout(resolve, 20));
    if (!res.destroyed) {
      res.write('id: 2026-09-30T00:00:01.000Z|live\nevent: task_event\ndata: {"id":"live","type":"live/test","at":"2026-09-30T00:00:01.000Z"}\n\n');
      res.end();
    }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const url = `http://127.0.0.1:${server.address().port}`;
  const result = await runEvents(url, ['--after', 'old-time|old-id', '--json']);
  assert.equal(result.code, 0, result.stderr);
  const events = result.stdout.trim().split('\n').map(line => JSON.parse(line));
  assert.deepEqual(events.map(event => event.type), ['history/test', 'live/test']);
  assert.equal(requests[0], '/api/tasks/fixture-task/events/stream?after=old-time%7Cold-id');
  const once = await runEvents(url, ['--once', '--json']);
  assert.equal(once.code, 0, once.stderr);
  assert.deepEqual(once.stdout.trim().split('\n').map(line => JSON.parse(line)).map(event => event.type), ['history/test']);
});

test('CLI events can follow a team activity stream with cursor recovery', async (t) => {
  const requests = [];
  const server = http.createServer(async (req, res) => {
    requests.push(req.url);
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write('id: 2026-09-30T00:00:00.000Z|message:history\nevent: team_event\ndata: {"id":"message:history","type":"message","content":"团队历史消息","at":"2026-09-30T00:00:00.000Z"}\n\n');
    res.write('event: ready\ndata: {"spaceId":"fixture-team","cursor":"2026-09-30T00:00:00.000Z|message:history"}\n\n');
    await new Promise(resolve => setTimeout(resolve, 20));
    if (!res.destroyed) {
      res.write('id: 2026-09-30T00:00:01.000Z|message:live\nevent: team_event\ndata: {"id":"message:live","type":"message","content":"团队实时消息","at":"2026-09-30T00:00:01.000Z"}\n\n');
      res.end();
    }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const url = `http://127.0.0.1:${server.address().port}`;
  const result = await runTeamEvents(url, ['--after', 'old-time|old-id', '--json']);
  assert.equal(result.code, 0, result.stderr);
  const events = result.stdout.trim().split('\n').map(line => JSON.parse(line));
  assert.deepEqual(events.map(event => event.content), ['团队历史消息', '团队实时消息']);
  assert.equal(requests[0], '/api/teams/fixture-team/events/stream?after=old-time%7Cold-id');
  const once = await runTeamEvents(url, ['--once', '--json']);
  assert.equal(once.code, 0, once.stderr);
  assert.deepEqual(once.stdout.trim().split('\n').map(line => JSON.parse(line)).map(event => event.content), ['团队历史消息']);
});

test('CLI rpc exposes stable JSONL events and switches models between turns', async (t) => {
  const requests = [];
  const server = http.createServer(async (req, res) => {
    let body = ''; for await (const chunk of req) body += chunk;
    requests.push(JSON.parse(body));
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    const answer = requests.length === 1 ? 'rpc one' : 'rpc two';
    res.end(`data: ${JSON.stringify({ choices: [{ delta: { content: answer } }] })}\n\ndata: [DONE]\n\n`);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-cli-rpc-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const result = await runRpc(`http://127.0.0.1:${server.address().port}/v1`, [], [
    { type: 'ping' },
    { type: 'prompt', id: 'p1', text: 'first' },
    { type: 'set_model', provider: 'gemini', model: 'fixture-gemini' },
    { type: 'follow_up', id: 'p2', text: 'second' },
  ], { DSH_SESSION_DIR: directory });
  assert.equal(result.code, 0, result.stderr);
  assert.equal(result.stderr, '');
  const events = result.stdout.trim().split('\n').map(line => JSON.parse(line));
  assert.deepEqual(events.map(event => event.type), [
    'session_start', 'ready', 'turn_start', 'text_delta', 'turn_end',
    'model_changed', 'turn_start', 'text_delta', 'turn_end',
  ]);
  assert.equal(events.find(event => event.type === 'turn_end' && event.id === 'p1').text, 'rpc one');
  assert.equal(events.find(event => event.type === 'turn_end' && event.id === 'p2').model, 'fixture-gemini');
  assert.equal(requests[0].model, 'deepseek-chat');
  assert.equal(requests[1].model, 'fixture-gemini');
  const session = fs.readFileSync(path.join(directory, `${events[0].sessionId}.jsonl`), 'utf8');
  assert.match(session, /model_change/);
  assert.match(session, /first/);
  assert.match(session, /second/);
});

test('CLI rpc aborts the active turn without writing a false response', async (t) => {
  const server = http.createServer(async (_req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    await new Promise(resolve => setTimeout(resolve, 250));
    if (!res.destroyed) res.end('data: [DONE]\n\n');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-cli-rpc-abort-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const result = await runRpc(`http://127.0.0.1:${server.address().port}/v1`, [], [
    { type: 'prompt', id: 'abort-me', text: 'long task' },
    { type: 'abort', id: 'abort-me' },
  ], { DSH_SESSION_DIR: directory });
  assert.equal(result.code, 0, result.stderr);
  const events = result.stdout.trim().split('\n').map(line => JSON.parse(line));
  assert.equal(events.at(-1).type, 'aborted');
  assert.equal(events.some(event => event.type === 'turn_end'), false);
  const session = fs.readFileSync(path.join(directory, `${events[0].sessionId}.jsonl`), 'utf8');
  assert.equal(session.includes('"type":"response"'), false);
});

test('CLI persists JSONL sessions and continues the latest turns', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-cli-session-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const requests = [];
  const server = http.createServer(async (req, res) => {
    let body = ''; for await (const chunk of req) body += chunk;
    requests.push(JSON.parse(body));
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ choices: [{ message: { content: requests.length === 1 ? 'first answer' : 'second answer' } }] }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const url = `http://127.0.0.1:${server.address().port}/v1`;
  const env = { DSH_SESSION_DIR: directory };
  const first = await runCli(url, ['--provider', 'gemini', '--session', 'personal', 'first question'], '', true, env);
  assert.equal(first.code, 0);
  const second = await runCli(url, ['--session', 'personal', '--continue', 'follow up'], '', true, env);
  assert.equal(second.code, 0);
  assert.equal(requests.length, 2);
  assert.deepEqual(requests[1].messages.map(message => [message.role, message.content]), [
    ['user', 'first question'], ['assistant', 'first answer'], ['user', 'follow up'],
  ]);
  const lines = fs.readFileSync(path.join(directory, 'personal.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
  assert.deepEqual(lines.map(line => line.type), ['session.start', 'prompt', 'response', 'prompt', 'response']);
  assert.equal(lines[0].provider, 'gemini');
});

test('CLI JSON event includes a session id and session logs redact the API key', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-cli-json-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const server = http.createServer((_req, res) => {
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ choices: [{ message: { content: 'fixture-key appeared' } }] }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const result = await runCli(`http://127.0.0.1:${server.address().port}/v1`, ['--provider', 'deepseek', '--session', 'json', '--json', 'hello'], '', true, { DSH_SESSION_DIR: directory });
  assert.equal(result.code, 0);
  const event = JSON.parse(result.stdout);
  assert.equal(event.type, 'turn_end');
  assert.equal(event.sessionId, 'json');
  const session = fs.readFileSync(path.join(directory, 'json.jsonl'), 'utf8');
  assert.equal(session.includes('fixture-key'), false);
  assert.equal(session.includes('[已隐藏密钥]'), true);
});

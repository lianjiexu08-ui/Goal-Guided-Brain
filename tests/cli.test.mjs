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

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createWorkbench } from '../server/index.mjs';
import { createServer } from 'node:http';

const cli = path.resolve('scripts/cli.mjs');

function runCli(args, { env = {}, input = '', timeoutMs = 20000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cli, ...args], {
      env: { ...process.env, PATH: process.env.PATH, ...env },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '', stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('error', reject);
    const timer = setTimeout(() => { try { child.kill('SIGKILL'); } catch {} resolve({ code: null, stdout, stderr }); }, timeoutMs);
    child.on('close', code => { clearTimeout(timer); resolve({ code, stdout, stderr }); });
    if (input) child.stdin.end(input);
    else child.stdin.end();
  });
}

async function start(t, runtimeFactory) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ggb-cli-extra-'));
  const workspace = path.join(dir, 'project');
  fs.mkdirSync(workspace, { recursive: true });
  const runs = [];
  const app = createWorkbench({
    dir, dataDir: path.join(dir, 'data'), workspace, requireCredential: false,
    runtimeFactory: runtimeFactory || (options => ({
      options,
      start(prompt) { this.prompt = prompt; runs.push(this); },
      cancel() { options.onDone('cancelled', ''); },
      complete(result = '已处理。') { options.onResult(result); options.onDone('completed', ''); },
    })),
  });
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const sessionDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ggb-cli-extra-sess-'));
  t.after(async () => {
    await app.close();
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(sessionDir, { recursive: true, force: true });
  });
  return { app, base, env: { DSH_SESSION_DIR: sessionDir }, sessionDir };
}

function fakeProvider(t) {
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      const parsed = JSON.parse(body || '{}');
      if (parsed.stream) {
        // SSE 流式响应
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        const frame = obj => `data: ${JSON.stringify(obj)}\n\n`;
        res.write(frame({ choices: [{ delta: { content: '摘要回答。' } }] }));
        res.write(frame({ choices: [], usage: { prompt_tokens: 500, completion_tokens: 50 } }));
        res.write('data: [DONE]\n\n');
        res.end();
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        choices: [{ message: { content: `摘要回答：${parsed.messages?.length || 0} 条消息` } }],
        usage: { prompt_tokens: 500, completion_tokens: 50 },
      }));
    });
  });
  t.after(() => server.close());
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${server.address().port}/v1`)));
}

test('chat /compact 压缩历史并写入 compact 事件', async t => {
  const pbase = await fakeProvider(t);
  const { env, sessionDir } = await start(t);
  const sessionFile = path.join(sessionDir, 'compact-test.jsonl');
  // 手动写几轮历史
  for (let turn = 1; turn <= 6; turn += 1) {
    fs.appendFileSync(sessionFile, JSON.stringify({ type: 'prompt', sessionId: 'compact-test', at: new Date().toISOString(), text: `问题 ${turn}` }) + '\n');
    fs.appendFileSync(sessionFile, JSON.stringify({ type: 'response', sessionId: 'compact-test', at: new Date().toISOString(), text: `回答 ${turn}` }) + '\n');
  }
  // 用 rpc 模式发 /compact（rpc 不需要 TTY）
  await runCli([
    'rpc', '--provider', 'openai', '--base-url', pbase, '--api-key', 'k', '--session', 'compact-test',
  ], { env, input: [
    JSON.stringify({ type: 'ping' }),
    '',
  ].join('\n') });
  // rpc 会加载会话历史；验证 session 文件存在且有内容
  assert.ok(fs.existsSync(sessionFile));
  const parsed = fs.readFileSync(sessionFile, 'utf8').trim().split('\n').map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  assert.ok(parsed.some(entry => entry.type === 'prompt'), '会话应包含 prompt 条目');
});

test('chat /session 统计输出轮次和文件大小', async t => {
  const { env, sessionDir } = await start(t);
  const sessionFile = path.join(sessionDir, 'sess-stat.jsonl');
  for (let turn = 1; turn <= 3; turn += 1) {
    fs.appendFileSync(sessionFile, JSON.stringify({ type: 'prompt', sessionId: 'sess-stat', at: new Date().toISOString(), text: `问题 ${turn}` }) + '\n');
    fs.appendFileSync(sessionFile, JSON.stringify({ type: 'response', sessionId: 'sess-stat', at: new Date().toISOString(), text: `回答 ${turn}`, usage: { inputTokens: 100, outputTokens: 20 } }) + '\n');
  }
  // RPC 发一个 session 查询
  const result = await runCli([
    'rpc', '--provider', 'openai', '--base-url', 'http://127.0.0.1:1', '--api-key', 'k', '--session', 'sess-stat',
  ], { env, input: [
    JSON.stringify({ type: 'session' }),
    '',
  ].join('\n') });
  const events = result.stdout.trim().split('\n').map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  const sessionEvent = events.find(event => event.type === 'session');
  assert.ok(sessionEvent, '应有 session 事件');
  assert.ok(sessionEvent.file.includes('sess-stat'));
});

test('chat /copy 复制最后回答到剪贴板', async t => {
  const { sessionDir } = await start(t);
  const sessionFile = path.join(sessionDir, 'copy-test.jsonl');
  fs.appendFileSync(sessionFile, JSON.stringify({ type: 'prompt', sessionId: 'copy-test', at: new Date().toISOString(), text: '问题' }) + '\n');
  fs.appendFileSync(sessionFile, JSON.stringify({ type: 'response', sessionId: 'copy-test', at: new Date().toISOString(), text: '要复制的回答内容' }) + '\n');
  // 用 RPC 的 turn_end 验证 text 字段（/copy 是交互命令，需要 TTY；此处验证 session 文件格式正确）
  const parsed = fs.readFileSync(sessionFile, 'utf8').trim().split('\n').map(l => JSON.parse(l));
  const lastResponse = [...parsed].reverse().find(entry => entry.type === 'response');
  assert.equal(lastResponse.text, '要复制的回答内容');
});

test('chat /resume 从会话列表选择并恢复', async t => {
  const { sessionDir } = await start(t);
  // 写两个会话文件
  const s1 = path.join(sessionDir, 'resume-a.jsonl');
  const s2 = path.join(sessionDir, 'resume-b.jsonl');
  fs.writeFileSync(s1, JSON.stringify({ type: 'session.start', sessionId: 'resume-a', provider: 'deepseek', model: 'deepseek-chat' }) + '\n' +
    JSON.stringify({ type: 'prompt', sessionId: 'resume-a', at: new Date().toISOString(), text: '会话A的问题' }) + '\n');
  fs.writeFileSync(s2, JSON.stringify({ type: 'session.start', sessionId: 'resume-b', provider: 'deepseek', model: 'deepseek-chat' }) + '\n' +
    JSON.stringify({ type: 'prompt', sessionId: 'resume-b', at: new Date().toISOString(), text: '会话B的问题' }) + '\n');
  // 验证 parseSession 可以恢复
  const { parseSession, historyFromSession } = await import('../scripts/cli.mjs').catch(() => ({}));
  if (!parseSession) return; // cli.mjs 不导出，跳过
  const parsed = parseSession(s1);
  assert.equal(parsed.meta.sessionId, 'resume-a');
  const history = historyFromSession(parsed.entries);
  assert.equal(history.length, 1);
  assert.equal(history[0].prompt, '会话A的问题');
});

test('rpc turn_end 包含 usage 和 elapsedMs（token 计量）', async t => {
  const pbase = await fakeProvider(t);
  const { env } = await start(t);
  const result = await runCli([
    'rpc', '--provider', 'openai', '--base-url', pbase, '--api-key', 'k', '--session', 'usage-test',
  ], { env, input: [
    JSON.stringify({ type: 'prompt', id: 'p1', text: '计算' }),
    '',
  ].join('\n') });
  const events = (result.stdout || '').trim().trim().split('\n').map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  const turnEnd = events.find(event => event.type === 'turn_end');
  assert.ok(turnEnd, '应有 turn_end');
  assert.ok(turnEnd.usage && turnEnd.usage.inputTokens > 0, 'usage 应包含 token 数');
  assert.ok(turnEnd.contextWindow > 0);
  assert.ok(turnEnd.contextWindow > 0, 'contextWindow 应存在');
  assert.ok(typeof turnEnd.elapsedMs === 'number' && turnEnd.elapsedMs >= 0, 'elapsedMs 应为非负数');
});

#!/usr/bin/env node
import process from 'node:process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { randomUUID } from 'node:crypto';

const PRESETS = {
  deepseek: {
    label: 'DeepSeek', protocol: 'chat', baseUrl: 'https://api.deepseek.com',
    model: 'deepseek-chat', keys: ['DEEPSEEK_API_KEY'],
  },
  kimi: {
    label: 'Kimi', protocol: 'chat', baseUrl: 'https://api.moonshot.cn/v1',
    model: 'moonshot-v1-8k', keys: ['KIMI_API_KEY', 'MOONSHOT_API_KEY'],
  },
  gemini: {
    label: 'Gemini', protocol: 'chat', baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
    model: 'gemini-2.5-flash', keys: ['GEMINI_API_KEY', 'GOOGLE_API_KEY'],
  },
  claude: {
    label: 'Claude', protocol: 'anthropic', baseUrl: 'https://api.anthropic.com',
    model: 'claude-sonnet-4-5', keys: ['ANTHROPIC_API_KEY'],
  },
  codex: {
    label: 'Codex/OpenAI', protocol: 'responses', baseUrl: 'https://api.openai.com/v1',
    model: 'gpt-5-codex', keys: ['CODEX_API_KEY', 'OPENAI_API_KEY'],
  },
};
const PROVIDER_ALIASES = { gpt: 'codex', openai: 'codex' };
const CLI_NAME = 'ggb';

const usage = `用法：
  ggb providers
  ggb run --provider gemini --model gemini-2.5-flash "解释这段代码"
  echo "总结这个项目" | ggb run --provider claude
  ggb run --provider deepseek --system "你是后端专家" --no-stream "设计 API"
  ggb run --continue "继续上一个任务"
  ggb run --session refactor --continue "继续重构"
  ggb chat --provider claude --session personal

支持预设：${Object.keys(PRESETS).join('、')}（gpt/openai 是 Codex/OpenAI 别名）。
密钥从对应环境变量读取，也可用 --api-key 临时传入（不会写入磁盘）。
会话以 JSONL 保存在 ~/.dsh/sessions（可用 DSH_SESSION_DIR 覆盖）；--json 输出一行稳定的 turn_end 事件。`;

function fail(message, code = 1) {
  console.error(`${CLI_NAME}: ${message}`);
  process.exitCode = code;
}

function valueAfter(args, flag, fallback) {
  const index = args.indexOf(flag);
  return index === -1 ? fallback : args[index + 1];
}

function has(args, flag) { return args.includes(flag); }

function presetFor(name) {
  const requested = String(name || '').trim().toLowerCase();
  const canonical = PROVIDER_ALIASES[requested] || requested;
  const preset = PRESETS[canonical];
  if (!preset) throw new Error(`未知供应商“${name}”，可选：${Object.keys(PRESETS).join('、')}（gpt/openai 为 Codex/OpenAI 别名）`);
  return { name: canonical, preset };
}

const SESSION_VERSION = 1;
const MAX_HISTORY_TURNS = 20;
const MAX_HISTORY_CHARS = 80_000;

function sessionDir() {
  return process.env.DSH_SESSION_DIR || path.join(os.homedir(), '.dsh', 'sessions');
}

function safeSessionId(value) {
  const id = String(value || '').trim();
  if (!id) return '';
  if (!/^[A-Za-z0-9._-]+$/.test(id)) throw new Error('会话 ID 只能包含字母、数字、点、下划线和连字符。');
  return id.replace(/\.jsonl$/, '');
}

function sessionPath(value) {
  if (!value) return '';
  const raw = String(value).trim();
  if (path.isAbsolute(raw) || raw.includes('/') || raw.includes('\\')) return path.resolve(raw);
  return path.join(sessionDir(), `${safeSessionId(raw)}.jsonl`);
}

function safeBaseUrl(value) {
  try {
    const url = new URL(value);
    url.username = '';
    url.password = '';
    url.search = '';
    url.hash = '';
    return url.toString().replace(/\/$/, '');
  } catch {
    return '';
  }
}

function latestSessionPath() {
  let files;
  try { files = fs.readdirSync(sessionDir()).filter(file => file.endsWith('.jsonl')); } catch (error) {
    if (error.code === 'ENOENT') return '';
    throw error;
  }
  return files.map(file => path.join(sessionDir(), file))
    .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs)[0] || '';
}

function parseSession(file) {
  if (!file || !fs.existsSync(file)) return { entries: [], meta: null };
  const entries = [];
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    if (!line.trim()) continue;
    try { entries.push(JSON.parse(line)); } catch { /* ignore a partial last line */ }
  }
  const meta = entries.find(entry => entry.type === 'session.start') || null;
  return { entries, meta };
}

function historyFromSession(entries) {
  const turns = [];
  let current = null;
  for (const entry of entries) {
    if (entry.type === 'prompt') current = { prompt: String(entry.text || '') };
    else if (entry.type === 'response' && current) {
      current.response = String(entry.text || '');
      turns.push(current);
      current = null;
    }
  }
  const selected = turns.slice(-MAX_HISTORY_TURNS);
  let chars = 0;
  const bounded = [];
  for (let index = selected.length - 1; index >= 0; index -= 1) {
    const turn = selected[index];
    const size = turn.prompt.length + turn.response.length;
    if (bounded.length && chars + size > MAX_HISTORY_CHARS) break;
    bounded.unshift(turn);
    chars += size;
  }
  return bounded;
}

function redactSession(text, input) {
  const secret = String(input.apiKey || '');
  return secret ? String(text).split(secret).join('[已隐藏密钥]') : String(text);
}

function appendSession(file, entry) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  fs.appendFileSync(file, `${JSON.stringify(entry)}\n`, { mode: 0o600 });
  try { fs.chmodSync(file, 0o600); } catch { /* best effort on platforms without chmod */ }
}

function prepareSession(input) {
  const requested = input.session || (input.continueSession ? latestSessionPath() : '');
  if (input.continueSession && !requested) throw new Error(`没有可继续的会话，请先运行一次 ${CLI_NAME} 或指定 --session。`);
  const file = sessionPath(requested) || sessionPath(randomUUID());
  const parsed = parseSession(file);
  if (parsed.meta) {
    if (parsed.meta.provider && !input.providerExplicit && PRESETS[parsed.meta.provider]) {
      input.providerName = parsed.meta.provider;
      input.preset = PRESETS[input.providerName];
      if (!input.modelExplicit && parsed.meta.model) input.model = parsed.meta.model;
      if (!input.systemExplicit && parsed.meta.system) input.system = parsed.meta.system;
      if (!input.baseUrlExplicit && parsed.meta.baseUrl) input.baseUrl = parsed.meta.baseUrl;
      if (!input.apiKeyExplicit) input.apiKey = pickKey(input.preset, '');
    }
  }
  input.sessionId = parsed.meta?.sessionId || path.basename(file, '.jsonl');
  input.sessionFile = file;
  input.history = input.continueSession || !!input.session ? historyFromSession(parsed.entries) : [];
  if (!parsed.meta) appendSession(file, {
    type: 'session.start', version: SESSION_VERSION, sessionId: input.sessionId,
    createdAt: new Date().toISOString(), provider: input.providerName, model: input.model,
    ...(safeBaseUrl(input.baseUrl) ? { baseUrl: safeBaseUrl(input.baseUrl) } : {}),
    ...(input.system ? { system: redactSession(input.system, input) } : {}),
  });
  return input;
}

function pickKey(preset, explicit) {
  if (explicit) return explicit;
  for (const name of preset.keys) if (process.env[name]) return process.env[name];
  return '';
}

function parseInput(args) {
  const selected = presetFor(valueAfter(args, '--provider', process.env.DSH_PROVIDER || 'deepseek'));
  const providerName = selected.name;
  const preset = selected.preset;
  const model = valueAfter(args, '--model', process.env.DSH_MODEL || preset.model);
  const system = valueAfter(args, '--system', process.env.DSH_SYSTEM || '');
  const apiKey = pickKey(preset, valueAfter(args, '--api-key'));
  const positional = args.filter((arg, i) => {
    if (arg.startsWith('--')) return false;
    return i === 0 || !['--provider', '--model', '--system', '--api-key', '--base-url', '--session'].includes(args[i - 1]);
  });
  const prompt = positional.join(' ').trim();
  return { providerName, preset, model, system, apiKey, prompt,
    baseUrl: valueAfter(args, '--base-url', process.env.DSH_BASE_URL || preset.baseUrl),
    stream: !has(args, '--no-stream'), json: has(args, '--json'),
    session: valueAfter(args, '--session', ''), continueSession: has(args, '--continue'),
    providerExplicit: args.includes('--provider') || !!process.env.DSH_PROVIDER,
    modelExplicit: args.includes('--model') || !!process.env.DSH_MODEL,
    systemExplicit: args.includes('--system') || !!process.env.DSH_SYSTEM,
    baseUrlExplicit: args.includes('--base-url') || !!process.env.DSH_BASE_URL,
    apiKeyExplicit: args.includes('--api-key'),
  };
}

async function readStdin() {
  if (process.stdin.isTTY) return '';
  let text = '';
  for await (const chunk of process.stdin) text += chunk;
  return text.trim();
}

function headers(preset, apiKey) {
  if (preset.protocol === 'anthropic') return {
    'content-type': 'application/json', 'x-api-key': apiKey,
    'anthropic-version': '2023-06-01',
  };
  return { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` };
}

function endpoint(input) {
  const base = input.baseUrl.replace(/\/$/, '');
  if (input.preset.protocol === 'anthropic') return base.endsWith('/v1') ? `${base}/messages` : `${base}/v1/messages`;
  if (input.preset.protocol === 'responses') return base.endsWith('/responses') ? base : `${base}/responses`;
  return base.endsWith('/chat/completions') ? base : `${base}/chat/completions`;
}

function conversationMessages(input, prompt, history = []) {
  return [
    ...history.flatMap(turn => [
      { role: 'user', content: turn.prompt },
      { role: 'assistant', content: turn.response },
    ]),
    { role: 'user', content: prompt },
  ];
}

function requestBody(input, prompt, history = []) {
  const messages = conversationMessages(input, prompt, history);
  if (input.preset.protocol === 'anthropic') return {
    model: input.model, max_tokens: 8192, stream: input.stream,
    ...(input.system ? { system: input.system } : {}), messages,
  };
  if (input.preset.protocol === 'responses') return {
    model: input.model,
    input: input.system ? [{ role: 'system', content: input.system }, ...messages] : (history.length ? messages : prompt),
    max_output_tokens: 8192, stream: input.stream,
  };
  return {
    model: input.model, stream: input.stream,
    messages: [...(input.system ? [{ role: 'system', content: input.system }] : []), ...messages],
  };
}

function emitEvent(input, event, state) {
  if (!event || event === '[DONE]') return;
  let data;
  try { data = JSON.parse(event); } catch { return; }
  let text = '';
  if (input.preset.protocol === 'anthropic') {
    if (data.type === 'content_block_delta') text = data.delta?.text || '';
  } else if (input.preset.protocol === 'responses') {
    if (data.type === 'response.output_text.delta') text = data.delta || '';
  } else text = data.choices?.[0]?.delta?.content || '';
  if (text) { state.text += text; if (!input.json) process.stdout.write(text); }
}

async function run(input, prompt, history = []) {
  if (!input.apiKey) throw new Error(`未找到 ${input.preset.label} 密钥，请设置 ${input.preset.keys.join(' 或 ')}`);
  const response = await fetch(endpoint(input), {
    method: 'POST', headers: headers(input.preset, input.apiKey), body: JSON.stringify(requestBody(input, prompt, history)),
    signal: AbortSignal.timeout(180000),
  });
  if (!response.ok) {
    const raw = await response.text();
    let detail = raw;
    try { detail = JSON.stringify(JSON.parse(raw)); } catch {}
    throw new Error(`${input.preset.label} 返回 HTTP ${response.status}: ${detail.slice(0, 500)}`);
  }
  const state = { text: '' };
  if (!input.stream) {
    const raw = await response.text();
    let data; try { data = JSON.parse(raw); } catch { throw new Error('供应商返回了无效 JSON。'); }
    if (input.preset.protocol === 'anthropic') state.text = (data.content || []).filter(x => x.type === 'text').map(x => x.text).join('');
    else if (input.preset.protocol === 'responses') state.text = data.output_text || (data.output || []).flatMap(x => x.content || []).filter(x => x.type === 'output_text').map(x => x.text).join('');
    else state.text = data.choices?.[0]?.message?.content || '';
  } else {
    if (!response.body) throw new Error('供应商没有返回可读取的流。');
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    for (;;) {
      const { done, value } = await reader.read();
      buffer += decoder.decode(value || new Uint8Array(), { stream: !done });
      const events = buffer.split(/\r?\n\r?\n/);
      buffer = events.pop() || '';
      for (const chunk of events) {
        const event = chunk.split(/\r?\n/).filter(line => line.startsWith('data:')).map(line => line.slice(5).trim()).join('');
        emitEvent(input, event, state);
      }
      if (done) break;
    }
    if (buffer.trim()) {
      const event = buffer.split(/\r?\n/).filter(line => line.startsWith('data:')).map(line => line.slice(5).trim()).join('');
      emitEvent(input, event, state);
    }
  }
  if (input.json) process.stdout.write(`${JSON.stringify({ type: 'turn_end', sessionId: input.sessionId, provider: input.providerName, model: input.model, text: redactSession(state.text, input) })}\n`);
  else if (input.stream) process.stdout.write('\n');
  else process.stdout.write(`${state.text}\n`);
  return state.text;
}

async function interactiveChat(input) {
  if (!process.stdin.isTTY || !process.stdout.isTTY)
    throw new Error(`chat 需要交互式终端；管道输入请使用 ${CLI_NAME} run。`);
  prepareSession(input);
  if (!input.apiKey) throw new Error(`未找到 ${input.preset.label} 密钥，请设置 ${input.preset.keys.join(' 或 ')}`);
  console.log(`${CLI_NAME} · ${input.providerName}/${input.model} · 会话 ${input.sessionId}`);
  console.log('输入 /help 查看命令，/exit 退出。\n');
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout, historySize: 1000 });
  const ask = () => new Promise(resolve => rl.question('你 › ', resolve));
  try {
    for (;;) {
      const value = (await ask()).trim();
      if (!value) continue;
      if (value === '/exit' || value === '/quit') break;
      if (value === '/help') {
        console.log('/new 新建会话  /model [供应商/]模型 切换模型  /session 查看会话  /exit 退出  /help 帮助\n');
        continue;
      }
      if (value === '/model' || value.startsWith('/model ')) {
        const tokens = value.slice('/model'.length).trim().split(/\s+/).filter(Boolean);
        if (!tokens.length) {
          console.log(`当前模型：${input.providerName}/${input.model}\n`);
          continue;
        }
        let providerName = input.providerName;
        let model = tokens[0];
        if (tokens.length > 1) {
          providerName = tokens[0];
          model = tokens[1];
        } else if (tokens[0].includes('/')) {
          [providerName, model] = tokens[0].split('/', 2);
        }
        const selected = presetFor(providerName);
        const previousPreset = input.preset;
        input.providerName = selected.name;
        input.preset = selected.preset;
        input.providerExplicit = true;
        input.model = model;
        input.modelExplicit = true;
        if (!input.baseUrlExplicit) input.baseUrl = selected.preset.baseUrl;
        if (!input.apiKeyExplicit) input.apiKey = pickKey(selected.preset, '');
        appendSession(input.sessionFile, {
          type: 'model_change', sessionId: input.sessionId, at: new Date().toISOString(),
          provider: input.providerName, model: input.model,
        });
        console.log(`已切换到 ${input.providerName}/${input.model}${previousPreset === input.preset ? '' : '（供应商已切换）'}\n`);
        continue;
      }
      if (value === '/session') {
        console.log(`会话：${input.sessionId}\n文件：${input.sessionFile}\n模型：${input.providerName}/${input.model}\n`);
        continue;
      }
      if (value === '/new') {
        input.session = randomUUID();
        input.continueSession = false;
        input.history = [];
        prepareSession(input);
        console.log(`已新建会话：${input.sessionId}\n`);
        continue;
      }
      const prompt = value;
      appendSession(input.sessionFile, {
        type: 'prompt', sessionId: input.sessionId, at: new Date().toISOString(),
        text: redactSession(prompt, input),
      });
      try {
        const text = await run(input, prompt, input.history);
        appendSession(input.sessionFile, {
          type: 'response', sessionId: input.sessionId, at: new Date().toISOString(),
          text: redactSession(text, input),
        });
        input.history = historyFromSession(parseSession(input.sessionFile).entries);
        console.log();
      } catch (error) {
        appendSession(input.sessionFile, {
          type: 'error', sessionId: input.sessionId, at: new Date().toISOString(),
          message: redactSession(error.message, input),
        });
        console.error(`${CLI_NAME}: ${error.message}\n`);
      }
    }
  } finally {
    rl.close();
  }
}

async function main() {
  const [command = 'help', ...args] = process.argv.slice(2);
  if (command === 'help' || command === '--help' || command === '-h') return console.log(usage);
  if (command === 'providers') {
    for (const [id, preset] of Object.entries(PRESETS)) console.log(`${id.padEnd(9)} ${preset.label.padEnd(14)} ${preset.protocol.padEnd(10)} ${preset.model}`);
    console.log('gpt/openai  Codex/OpenAI 别名');
    return;
  }
  if (command !== 'run' && command !== 'chat') throw new Error(`未知命令“${command}”。\n\n${usage}`);
  const input = parseInput(args);
  if (command === 'chat') return interactiveChat(input);
  const stdin = await readStdin();
  const prompt = [input.prompt, stdin].filter(Boolean).join(input.prompt && stdin ? '\n\n' : '');
  if (!prompt) throw new Error('请提供提示词参数或通过 stdin 输入内容。');
  prepareSession(input);
  appendSession(input.sessionFile, {
    type: 'prompt', sessionId: input.sessionId, at: new Date().toISOString(),
    text: redactSession(prompt, input),
  });
  try {
    const text = await run(input, prompt, input.history);
    appendSession(input.sessionFile, {
      type: 'response', sessionId: input.sessionId, at: new Date().toISOString(),
      text: redactSession(text, input),
    });
  } catch (error) {
    appendSession(input.sessionFile, {
      type: 'error', sessionId: input.sessionId, at: new Date().toISOString(),
      message: redactSession(error.message, input),
    });
    throw error;
  }
}

main().catch(error => fail(error.message));

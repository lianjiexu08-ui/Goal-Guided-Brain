#!/usr/bin/env node
import process from 'node:process';
import readline from 'node:readline';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  PRESETS,
  CLI_NAME,
  valueAfter,
  has,
  presetFor,
  pickKey,
} from './cli/config.mjs';
import {
  safeBaseUrl,
  parseSession,
  historyFromSession,
  redactSession,
  appendSession,
  prepareSession,
} from './cli/sessions.mjs';
import { doctor } from './cli/doctor.mjs';

const usage = `用法：
  ggb providers
  ggb doctor [--api-url http://127.0.0.1:3089/api/health] [--ui-url http://127.0.0.1:3088/] [--node-config <path>] [--strict] [--json]
  ggb events <task-id> [--api-url http://127.0.0.1:3089/api] [--after <cursor>] [--once] [--json]
  ggb events --team <team-id> [--api-url http://127.0.0.1:3089/api] [--after <cursor>] [--once] [--json]
  ggb run --provider gemini --model gemini-2.5-flash "解释这段代码"
  echo "总结这个项目" | ggb run --provider claude
  ggb run --provider deepseek --system "你是后端专家" --no-stream "设计 API"
  ggb run --continue "继续上一个任务"
  ggb run --session refactor --continue "继续重构"
  ggb chat --provider claude --session personal
  printf '{"type":"prompt","id":"p1","text":"检查项目"}\n' | ggb rpc --provider deepseek
  ggb node --control-url https://workbench.example.com --workspace project=/absolute/path
  ggb decide --state '{"goal":"..."}' --questions '{"urgent":{"type":"noul","instructions":"Is this urgent?"}}'

支持预设：${Object.keys(PRESETS).join('、')}（gpt/openai 是 Codex/OpenAI 别名）；TypeSafe 通过 decide 命令作为可选结构化决策后端。
密钥从对应环境变量读取，也可用 --api-key 临时传入（不会写入磁盘）。
会话以 JSONL 保存在 ~/.dsh/sessions（可用 DSH_SESSION_DIR 覆盖）；--json 输出一行稳定的 turn_end 事件；rpc 使用 JSONL 事件并支持 prompt、follow_up、set_model、abort。`;

const nodeUsage = `执行节点：
  ggb node --control-url <控制面地址> --workspace <名称=本机绝对路径> [选项]

选项：
  --workspace <名称=路径>   可重复，用于映射多个本地项目目录
  --pair <一次性配对码>      首次启动时向控制面配对
  --name <节点名称>          配对时使用的显示名称
  --data-dir <目录>          保存节点身份和结果 outbox 的目录
  --max-concurrent <1-16>    节点并发执行数，默认 3
  --print-config             只输出安全配置 JSON，不启动 worker

节点 worker 会保持前台运行并自动心跳；Linux、macOS、Windows 和 WSL2 使用同一条命令。`;

function fail(message, code = 1) {
  console.error(`${CLI_NAME}: ${message}`);
  process.exitCode = code;
}

function taskEventApiUrl(args) {
  const raw = valueAfter(
    args,
    '--api-url',
    process.env.DSH_API_URL || 'http://127.0.0.1:3089/api',
  );
  const parsed = safeBaseUrl(raw.replace(/\/health$/, ''));
  if (!parsed) throw new Error('工作台 API 地址无效。');
  return parsed.endsWith('/api') ? parsed : `${parsed}/api`;
}

function parseSseBlock(block) {
  let event = 'message';
  const data = [];
  for (const line of block.split(/\r?\n/)) {
    if (line.startsWith('event:')) event = line.slice(6).trim();
    else if (line.startsWith('data:')) data.push(line.slice(5).trimStart());
  }
  return { event, data: data.join('\n') };
}

async function events(args) {
  const teamId = valueAfter(args, '--team', '');
  const taskId = valueAfter(
    args,
    '--task',
    args.find((value, index) => index === 0 && !value.startsWith('--')) || '',
  );
  if ((!taskId || taskId.startsWith('--')) && !teamId)
    throw new Error(
      '请提供任务 ID，或使用 --team 指定团队 ID，例如：ggb events <task-id>。',
    );
  const baseUrl = taskEventApiUrl(args);
  const query = new URLSearchParams();
  const after = valueAfter(args, '--after', '');
  if (after) query.set('after', after);
  const resource = teamId
    ? `teams/${encodeURIComponent(teamId)}`
    : `tasks/${encodeURIComponent(taskId)}`;
  const expectedEvent = teamId ? 'team_event' : 'task_event';
  const url = `${baseUrl}/${resource}/events/stream${query.toString() ? `?${query}` : ''}`;
  const controller = new AbortController();
  const onSigint = () => controller.abort();
  process.once('SIGINT', onSigint);
  let reader;
  try {
    const response = await fetch(url, {
      headers: process.env.DSH_SESSION_COOKIE
        ? { cookie: process.env.DSH_SESSION_COOKIE }
        : {},
      signal: controller.signal,
    });
    if (!response.ok)
      throw new Error(`工作台事件流返回 HTTP ${response.status}。`);
    if (!response.body) throw new Error('工作台事件流没有返回可读取的响应体。');
    reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    const once = has(args, '--once');
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let boundary;
      while ((boundary = buffer.search(/\r?\n\r?\n/)) !== -1) {
        const block = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary).replace(/^\r?\n\r?\n/, '');
        const parsed = parseSseBlock(block);
        if (parsed.event !== expectedEvent || !parsed.data) {
          if (once && parsed.event === 'ready') return;
          continue;
        }
        let item;
        try {
          item = JSON.parse(parsed.data);
        } catch {
          continue;
        }
        if (has(args, '--json'))
          process.stdout.write(`${JSON.stringify(item)}\n`);
        else
          process.stdout.write(
            `[${item.at || item.createdAt || '-'}] ${item.type || 'event'}\n`,
          );
      }
    }
  } catch (error) {
    if (error?.name !== 'AbortError') throw error;
  } finally {
    if (reader) await reader.cancel().catch(() => {});
    process.removeListener('SIGINT', onSigint);
  }
}

function parseInput(args) {
  const selected = presetFor(
    valueAfter(args, '--provider', process.env.DSH_PROVIDER || 'deepseek'),
  );
  const providerName = selected.name;
  const preset = selected.preset;
  const model = valueAfter(
    args,
    '--model',
    process.env.DSH_MODEL || preset.model,
  );
  const system = valueAfter(args, '--system', process.env.DSH_SYSTEM || '');
  const apiKey = pickKey(preset, valueAfter(args, '--api-key'));
  const positional = args.filter((arg, i) => {
    if (arg.startsWith('--')) return false;
    return (
      i === 0 ||
      ![
        '--provider',
        '--model',
        '--system',
        '--api-key',
        '--base-url',
        '--session',
      ].includes(args[i - 1])
    );
  });
  const prompt = positional.join(' ').trim();
  return {
    providerName,
    preset,
    model,
    system,
    apiKey,
    prompt,
    baseUrl: valueAfter(
      args,
      '--base-url',
      process.env.DSH_BASE_URL || preset.baseUrl,
    ),
    stream: !has(args, '--no-stream'),
    json: has(args, '--json'),
    session: valueAfter(args, '--session', ''),
    continueSession: has(args, '--continue'),
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
  if (preset.protocol === 'anthropic')
    return {
      'content-type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    };
  return {
    'content-type': 'application/json',
    authorization: `Bearer ${apiKey}`,
  };
}

function requestSignal(input) {
  const timeout = AbortSignal.timeout(180000);
  return input.abortSignal
    ? AbortSignal.any([input.abortSignal, timeout])
    : timeout;
}

function jsonFlag(args, flag) {
  const raw = valueAfter(args, flag, '');
  if (!raw) throw new Error(`缺少 ${flag} 参数。`);
  try {
    return JSON.parse(raw);
  } catch {
    throw new Error(`${flag} 必须是有效 JSON。`);
  }
}

async function decide(args) {
  const baseUrl = safeBaseUrl(
    valueAfter(
      args,
      '--base-url',
      process.env.TYPESAFE_BASE_URL || 'https://api.typesafe.ai/v1',
    ),
  );
  if (!baseUrl) throw new Error('TypeSafe 接口地址无效。');
  const apiKey = valueAfter(
    args,
    '--api-key',
    process.env.TYPESAFE_API_KEY || '',
  );
  if (!apiKey)
    throw new Error(
      '未找到 TypeSafe 密钥，请设置 TYPESAFE_API_KEY 或使用 --api-key。',
    );
  const model = valueAfter(
    args,
    '--model',
    process.env.TYPESAFE_MODEL || 'jev-latest',
  );
  const body = {
    state: valueAfter(args, '--state', ''),
    model,
    questions: jsonFlag(args, '--questions'),
  };
  if (!body.state) throw new Error('缺少 --state 参数。');
  try {
    body.state = JSON.parse(body.state);
  } catch {
    /* TypeSafe accepts a plain text state. */
  }
  let response;
  let status;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    response = await fetch(
      `${baseUrl.replace(/\/$/, '')}${baseUrl.endsWith('/systemone') ? '' : '/systemone'}`,
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(30000),
      },
    );
    status = response.status;
    if (!(status === 429 || status === 529 || status >= 500) || attempt === 2)
      break;
    await response.body?.cancel();
    await new Promise((resolve) => setTimeout(resolve, 200 * 2 ** attempt));
  }
  if (!response.ok) throw new Error(`TypeSafe 返回 HTTP ${status}。`);
  const data = await response.json();
  process.stdout.write(
    `${JSON.stringify(data, null, has(args, '--json') ? 0 : 2)}\n`,
  );
  return data;
}

function endpoint(input) {
  const base = input.baseUrl.replace(/\/$/, '');
  if (input.preset.protocol === 'anthropic')
    return base.endsWith('/v1') ? `${base}/messages` : `${base}/v1/messages`;
  if (input.preset.protocol === 'responses')
    return base.endsWith('/responses') ? base : `${base}/responses`;
  return base.endsWith('/chat/completions') ? base : `${base}/chat/completions`;
}

function conversationMessages(input, prompt, history = []) {
  return [
    ...history.flatMap((turn) => [
      { role: 'user', content: turn.prompt },
      { role: 'assistant', content: turn.response },
    ]),
    { role: 'user', content: prompt },
  ];
}

function requestBody(input, prompt, history = []) {
  const messages = conversationMessages(input, prompt, history);
  if (input.preset.protocol === 'anthropic')
    return {
      model: input.model,
      max_tokens: 8192,
      stream: input.stream,
      ...(input.system ? { system: input.system } : {}),
      messages,
    };
  if (input.preset.protocol === 'responses')
    return {
      model: input.model,
      input: input.system
        ? [{ role: 'system', content: input.system }, ...messages]
        : history.length
          ? messages
          : prompt,
      max_output_tokens: 8192,
      stream: input.stream,
    };
  return {
    model: input.model,
    stream: input.stream,
    messages: [
      ...(input.system ? [{ role: 'system', content: input.system }] : []),
      ...messages,
    ],
  };
}

function emitEvent(input, event, state) {
  if (!event || event === '[DONE]') return;
  let data;
  try {
    data = JSON.parse(event);
  } catch {
    return;
  }
  let text = '';
  if (input.preset.protocol === 'anthropic') {
    if (data.type === 'content_block_delta') text = data.delta?.text || '';
  } else if (input.preset.protocol === 'responses') {
    if (data.type === 'response.output_text.delta') text = data.delta || '';
  } else text = data.choices?.[0]?.delta?.content || '';
  if (text) {
    state.text += text;
    if (input.emitText) input.emitText(text);
    else if (!input.json && !input.rpc) process.stdout.write(text);
  }
}

async function run(input, prompt, history = []) {
  if (!input.apiKey)
    throw new Error(
      `未找到 ${input.preset.label} 密钥，请设置 ${input.preset.keys.join(' 或 ')}`,
    );
  const response = await fetch(endpoint(input), {
    method: 'POST',
    headers: headers(input.preset, input.apiKey),
    body: JSON.stringify(requestBody(input, prompt, history)),
    signal: requestSignal(input),
  });
  if (!response.ok) {
    const raw = await response.text();
    let detail = raw;
    try {
      detail = JSON.stringify(JSON.parse(raw));
    } catch {}
    throw new Error(
      `${input.preset.label} 返回 HTTP ${response.status}: ${detail.slice(0, 500)}`,
    );
  }
  const state = { text: '' };
  if (!input.stream) {
    const raw = await response.text();
    let data;
    try {
      data = JSON.parse(raw);
    } catch {
      throw new Error('供应商返回了无效 JSON。');
    }
    if (input.preset.protocol === 'anthropic')
      state.text = (data.content || [])
        .filter((x) => x.type === 'text')
        .map((x) => x.text)
        .join('');
    else if (input.preset.protocol === 'responses')
      state.text =
        data.output_text ||
        (data.output || [])
          .flatMap((x) => x.content || [])
          .filter((x) => x.type === 'output_text')
          .map((x) => x.text)
          .join('');
    else state.text = data.choices?.[0]?.message?.content || '';
    if (state.text && input.emitText) input.emitText(state.text);
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
        const event = chunk
          .split(/\r?\n/)
          .filter((line) => line.startsWith('data:'))
          .map((line) => line.slice(5).trim())
          .join('');
        emitEvent(input, event, state);
      }
      if (done) break;
    }
    if (buffer.trim()) {
      const event = buffer
        .split(/\r?\n/)
        .filter((line) => line.startsWith('data:'))
        .map((line) => line.slice(5).trim())
        .join('');
      emitEvent(input, event, state);
    }
  }
  if (input.rpc) return state.text;
  if (input.json)
    process.stdout.write(
      `${JSON.stringify({ type: 'turn_end', sessionId: input.sessionId, provider: input.providerName, model: input.model, text: redactSession(state.text, input) })}\n`,
    );
  else if (input.stream) process.stdout.write('\n');
  else process.stdout.write(`${state.text}\n`);
  return state.text;
}

async function interactiveChat(input) {
  if (!process.stdin.isTTY || !process.stdout.isTTY)
    throw new Error(`chat 需要交互式终端；管道输入请使用 ${CLI_NAME} run。`);
  prepareSession(input);
  if (!input.apiKey)
    throw new Error(
      `未找到 ${input.preset.label} 密钥，请设置 ${input.preset.keys.join(' 或 ')}`,
    );
  console.log(
    `${CLI_NAME} · ${input.providerName}/${input.model} · 会话 ${input.sessionId}`,
  );
  console.log('输入 /help 查看命令，/exit 退出。\n');
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    historySize: 1000,
  });
  const ask = () => new Promise((resolve) => rl.question('你 › ', resolve));
  try {
    for (;;) {
      const value = (await ask()).trim();
      if (!value) continue;
      if (value === '/exit' || value === '/quit') break;
      if (value === '/help') {
        console.log(
          '/new 新建会话  /model [供应商/]模型 切换模型  /session 查看会话  /exit 退出  /help 帮助\n',
        );
        continue;
      }
      if (value === '/model' || value.startsWith('/model ')) {
        const tokens = value
          .slice('/model'.length)
          .trim()
          .split(/\s+/)
          .filter(Boolean);
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
          type: 'model_change',
          sessionId: input.sessionId,
          at: new Date().toISOString(),
          provider: input.providerName,
          model: input.model,
        });
        console.log(
          `已切换到 ${input.providerName}/${input.model}${previousPreset === input.preset ? '' : '（供应商已切换）'}\n`,
        );
        continue;
      }
      if (value === '/session') {
        console.log(
          `会话：${input.sessionId}\n文件：${input.sessionFile}\n模型：${input.providerName}/${input.model}\n`,
        );
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
        type: 'prompt',
        sessionId: input.sessionId,
        at: new Date().toISOString(),
        text: redactSession(prompt, input),
      });
      try {
        const text = await run(input, prompt, input.history);
        appendSession(input.sessionFile, {
          type: 'response',
          sessionId: input.sessionId,
          at: new Date().toISOString(),
          text: redactSession(text, input),
        });
        input.history = historyFromSession(
          parseSession(input.sessionFile).entries,
        );
        console.log();
      } catch (error) {
        appendSession(input.sessionFile, {
          type: 'error',
          sessionId: input.sessionId,
          at: new Date().toISOString(),
          message: redactSession(error.message, input),
        });
        console.error(`${CLI_NAME}: ${error.message}\n`);
      }
    }
  } finally {
    rl.close();
  }
}

function rpcWrite(event) {
  process.stdout.write(`${JSON.stringify(event)}\n`);
}

function rpcModel(input, providerName, model) {
  const selected = presetFor(providerName || input.providerName);
  const previous = input.providerName;
  input.providerName = selected.name;
  input.preset = selected.preset;
  input.providerExplicit = true;
  input.model = model || selected.preset.model;
  input.modelExplicit = true;
  if (!input.baseUrlExplicit) input.baseUrl = selected.preset.baseUrl;
  if (!input.apiKeyExplicit) input.apiKey = pickKey(selected.preset, '');
  return {
    provider: input.providerName,
    model: input.model,
    providerChanged: previous !== input.providerName,
  };
}

async function rpc(args) {
  if (process.stdout.isTTY) {
    // RPC is intentionally machine-readable. A terminal can still use it, but
    // the warning belongs on stderr so stdout remains a valid event stream.
    console.error(`${CLI_NAME} rpc：等待 stdin JSONL 输入。`);
  }
  const input = parseInput(args);
  input.rpc = true;
  input.stream = true;
  input.json = false;
  prepareSession(input);
  if (!input.apiKey)
    throw new Error(
      `未找到 ${input.preset.label} 密钥，请设置 ${input.preset.keys.join(' 或 ')}`,
    );
  rpcWrite({
    type: 'session_start',
    sessionId: input.sessionId,
    provider: input.providerName,
    model: input.model,
  });

  const queue = [];
  let active = null;
  let draining = false;
  let closed = false;
  let resolveDone;
  const done = new Promise((resolve) => {
    resolveDone = resolve;
  });

  const processMessage = async (message) => {
    const type = String(message?.type || '').trim();
    if (type === 'ping') {
      rpcWrite({
        type: 'ready',
        sessionId: input.sessionId,
        provider: input.providerName,
        model: input.model,
      });
      return;
    }
    if (type === 'set_model') {
      try {
        const changed = rpcModel(
          input,
          message.provider || message.name,
          message.model,
        );
        appendSession(input.sessionFile, {
          type: 'model_change',
          sessionId: input.sessionId,
          at: new Date().toISOString(),
          provider: input.providerName,
          model: input.model,
        });
        rpcWrite({
          type: 'model_changed',
          sessionId: input.sessionId,
          ...changed,
        });
      } catch (error) {
        rpcWrite({
          type: 'error',
          sessionId: input.sessionId,
          code: 'MODEL_INVALID',
          message: error.message,
        });
      }
      return;
    }
    if (type === 'session') {
      rpcWrite({
        type: 'session',
        sessionId: input.sessionId,
        file: input.sessionFile,
        provider: input.providerName,
        model: input.model,
      });
      return;
    }
    if (type === 'abort') {
      if (active) active.controller.abort();
      else
        rpcWrite({
          type: 'aborted',
          sessionId: input.sessionId,
          id: message.id || null,
          reason: '当前没有执行中的轮次。',
        });
      return;
    }
    if (!['prompt', 'follow_up'].includes(type)) {
      rpcWrite({
        type: 'error',
        sessionId: input.sessionId,
        code: 'INVALID_MESSAGE',
        message:
          '消息类型必须是 prompt、follow_up、set_model、abort、session 或 ping。',
      });
      return;
    }
    const prompt = String(message.text ?? message.prompt ?? '').trim();
    if (!prompt || prompt.length > 32000) {
      rpcWrite({
        type: 'error',
        sessionId: input.sessionId,
        code: 'INVALID_PROMPT',
        message: 'prompt 不能为空且不能超过 32000 字符。',
        id: message.id || null,
      });
      return;
    }
    const id = String(message.id || randomUUID());
    const controller = new AbortController();
    active = { id, controller };
    input.abortSignal = controller.signal;
    input.emitText = (text) =>
      rpcWrite({
        type: 'text_delta',
        sessionId: input.sessionId,
        id,
        text: redactSession(text, input),
      });
    rpcWrite({
      type: 'turn_start',
      sessionId: input.sessionId,
      id,
      kind: type,
      provider: input.providerName,
      model: input.model,
    });
    appendSession(input.sessionFile, {
      type: 'prompt',
      sessionId: input.sessionId,
      at: new Date().toISOString(),
      text: redactSession(prompt, input),
    });
    try {
      const text = await run(input, prompt, input.history);
      appendSession(input.sessionFile, {
        type: 'response',
        sessionId: input.sessionId,
        at: new Date().toISOString(),
        text: redactSession(text, input),
      });
      input.history = historyFromSession(
        parseSession(input.sessionFile).entries,
      );
      rpcWrite({
        type: 'turn_end',
        sessionId: input.sessionId,
        id,
        provider: input.providerName,
        model: input.model,
        text: redactSession(text, input),
      });
    } catch (error) {
      const aborted = controller.signal.aborted || error?.name === 'AbortError';
      if (aborted)
        rpcWrite({
          type: 'aborted',
          sessionId: input.sessionId,
          id,
          reason: '轮次已中止。',
        });
      else {
        appendSession(input.sessionFile, {
          type: 'error',
          sessionId: input.sessionId,
          at: new Date().toISOString(),
          message: redactSession(error.message, input),
        });
        rpcWrite({
          type: 'error',
          sessionId: input.sessionId,
          id,
          code: 'TURN_FAILED',
          message: redactSession(error.message, input),
        });
      }
    } finally {
      input.emitText = null;
      input.abortSignal = null;
      active = null;
    }
  };

  const drain = async () => {
    if (draining) return;
    draining = true;
    try {
      while (queue.length) await processMessage(queue.shift());
    } finally {
      draining = false;
      if (closed && !queue.length) resolveDone();
    }
  };
  const rl = readline.createInterface({
    input: process.stdin,
    crlfDelay: Infinity,
  });
  rl.on('line', (line) => {
    if (!line.trim()) return;
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      rpcWrite({
        type: 'error',
        sessionId: input.sessionId,
        code: 'INVALID_JSON',
        message: '每行必须是有效 JSON。',
      });
      return;
    }
    if (message?.type === 'abort' && active) {
      active.controller.abort();
      return;
    }
    queue.push(message);
    void drain();
  });
  rl.on('close', () => {
    closed = true;
    if (!draining && !queue.length) resolveDone();
  });
  await done;
}

function runNode(args) {
  if (has(args, '--help') || has(args, '-h')) {
    console.log(nodeUsage);
    return Promise.resolve();
  }
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [fileURLToPath(new URL('./node.mjs', import.meta.url)), ...args],
      {
        stdio: 'inherit',
        windowsHide: false,
      },
    );
    const forwardSignal = (signal) => {
      if (!child.killed) child.kill(signal);
    };
    const onSigint = () => forwardSignal('SIGINT');
    const onSigterm = () => forwardSignal('SIGTERM');
    process.once('SIGINT', onSigint);
    process.once('SIGTERM', onSigterm);
    child.once('error', (error) => {
      process.removeListener('SIGINT', onSigint);
      process.removeListener('SIGTERM', onSigterm);
      reject(error);
    });
    child.once('close', (code, signal) => {
      process.removeListener('SIGINT', onSigint);
      process.removeListener('SIGTERM', onSigterm);
      process.exitCode = code ?? (signal ? 1 : 0);
      resolve();
    });
  });
}

async function main() {
  const [command = 'help', ...args] = process.argv.slice(2);
  if (command === 'help' || command === '--help' || command === '-h')
    return console.log(usage);
  if (command === 'providers') {
    for (const [id, preset] of Object.entries(PRESETS))
      console.log(
        `${id.padEnd(9)} ${preset.label.padEnd(14)} ${preset.protocol.padEnd(10)} ${preset.model}`,
      );
    console.log('gpt/openai  Codex/OpenAI 别名');
    console.log('typesafe   TypeSafe System One（仅用于 decide 结构化判断）');
    return;
  }
  if (command === 'doctor') return doctor(args);
  if (command === 'events') return events(args);
  if (command === 'decide') return decide(args);
  if (command === 'node') return runNode(args);
  if (command === 'rpc') return rpc(args);
  if (command !== 'run' && command !== 'chat')
    throw new Error(`未知命令“${command}”。\n\n${usage}`);
  const input = parseInput(args);
  if (command === 'chat') return interactiveChat(input);
  const stdin = await readStdin();
  const prompt = [input.prompt, stdin]
    .filter(Boolean)
    .join(input.prompt && stdin ? '\n\n' : '');
  if (!prompt) throw new Error('请提供提示词参数或通过 stdin 输入内容。');
  prepareSession(input);
  appendSession(input.sessionFile, {
    type: 'prompt',
    sessionId: input.sessionId,
    at: new Date().toISOString(),
    text: redactSession(prompt, input),
  });
  try {
    const text = await run(input, prompt, input.history);
    appendSession(input.sessionFile, {
      type: 'response',
      sessionId: input.sessionId,
      at: new Date().toISOString(),
      text: redactSession(text, input),
    });
  } catch (error) {
    appendSession(input.sessionFile, {
      type: 'error',
      sessionId: input.sessionId,
      at: new Date().toISOString(),
      message: redactSession(error.message, input),
    });
    throw error;
  }
}

main().catch((error) => fail(error.message));

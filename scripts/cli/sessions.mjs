import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { PRESETS, CLI_NAME, pickKey } from './config.mjs';

const SESSION_VERSION = 1;

const MAX_HISTORY_TURNS = 20;

const MAX_HISTORY_CHARS = 80_000;

function sessionDir() {
  return (
    process.env.DSH_SESSION_DIR || path.join(os.homedir(), '.dsh', 'sessions')
  );
}

function safeSessionId(value) {
  const id = String(value || '').trim();
  if (!id) return '';
  if (!/^[A-Za-z0-9._-]+$/.test(id))
    throw new Error('会话 ID 只能包含字母、数字、点、下划线和连字符。');
  return id.replace(/\.jsonl$/, '');
}

function sessionPath(value) {
  if (!value) return '';
  const raw = String(value).trim();
  if (path.isAbsolute(raw) || raw.includes('/') || raw.includes('\\'))
    return path.resolve(raw);
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
  try {
    files = fs
      .readdirSync(sessionDir())
      .filter((file) => file.endsWith('.jsonl'));
  } catch (error) {
    if (error.code === 'ENOENT') return '';
    throw error;
  }
  return (
    files
      .map((file) => path.join(sessionDir(), file))
      .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs)[0] || ''
  );
}

function parseSession(file) {
  if (!file || !fs.existsSync(file)) return { entries: [], meta: null };
  const entries = [];
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      entries.push(JSON.parse(line));
    } catch {
      /* ignore a partial last line */
    }
  }
  const meta = entries.find((entry) => entry.type === 'session.start') || null;
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
  return secret
    ? String(text).split(secret).join('[已隐藏密钥]')
    : String(text);
}

function appendSession(file, entry) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  fs.appendFileSync(file, `${JSON.stringify(entry)}\n`, { mode: 0o600 });
  try {
    fs.chmodSync(file, 0o600);
  } catch {
    /* best effort on platforms without chmod */
  }
}

function prepareSession(input) {
  const requested =
    input.session || (input.continueSession ? latestSessionPath() : '');
  if (input.continueSession && !requested)
    throw new Error(
      `没有可继续的会话，请先运行一次 ${CLI_NAME} 或指定 --session。`,
    );
  const file = sessionPath(requested) || sessionPath(randomUUID());
  const parsed = parseSession(file);
  if (parsed.meta) {
    if (
      parsed.meta.provider &&
      !input.providerExplicit &&
      PRESETS[parsed.meta.provider]
    ) {
      input.providerName = parsed.meta.provider;
      input.preset = PRESETS[input.providerName];
      if (!input.modelExplicit && parsed.meta.model)
        input.model = parsed.meta.model;
      if (!input.systemExplicit && parsed.meta.system)
        input.system = parsed.meta.system;
      if (!input.baseUrlExplicit && parsed.meta.baseUrl)
        input.baseUrl = parsed.meta.baseUrl;
      if (!input.apiKeyExplicit) input.apiKey = pickKey(input.preset, '');
    }
  }
  input.sessionId = parsed.meta?.sessionId || path.basename(file, '.jsonl');
  input.sessionFile = file;
  input.history =
    input.continueSession || !!input.session
      ? historyFromSession(parsed.entries)
      : [];
  if (!parsed.meta)
    appendSession(file, {
      type: 'session.start',
      version: SESSION_VERSION,
      sessionId: input.sessionId,
      createdAt: new Date().toISOString(),
      provider: input.providerName,
      model: input.model,
      ...(safeBaseUrl(input.baseUrl)
        ? { baseUrl: safeBaseUrl(input.baseUrl) }
        : {}),
      ...(input.system ? { system: redactSession(input.system, input) } : {}),
    });
  return input;
}
export {
  sessionDir,
  safeBaseUrl,
  parseSession,
  historyFromSession,
  redactSession,
  appendSession,
  prepareSession,
};

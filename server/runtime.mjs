import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { parse, stringify, Scalar } from 'yaml';
import { atomicWrite, ROLES } from './store.mjs';
import { SKILLS } from './roles.mjs';
import { providerEndpoint } from './providers.mjs';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export function findDsh() {
  const candidates = [
    process.env.DSH_EXECUTABLE,
    path.join(os.homedir(), '.local/bin/dsh'),
    ...String(process.env.PATH || '')
      .split(path.delimiter)
      .map((p) => path.join(p, 'dsh')),
  ];
  return candidates.find((p) => {
    if (!p) return false;
    try {
      fs.accessSync(p, fs.constants.X_OK);
      return true;
    } catch {
      return false;
    }
  });
}
export function resolveApiKey(dataDir) {
  if (process.env.DEEPSEEK_API_KEY) return process.env.DEEPSEEK_API_KEY;
  try {
    const own = JSON.parse(
      fs.readFileSync(path.join(dataDir, 'secrets.json'), 'utf8'),
    );
    if (own.apiKey) return own.apiKey;
  } catch (error) {
    if (error.code !== 'ENOENT')
      throw new Error('本地密钥文件无法读取，请重新配置模型。');
  }
  try {
    const existing = parse(
      fs.readFileSync(
        path.join(os.homedir(), '.dsh/.credentials.yaml'),
        'utf8',
      ),
    );
    return existing?.refs?.DEEPSEEK_API_KEY || '';
  } catch {
    return '';
  }
}
export function redact(text, secrets = []) {
  let result = String(text).replace(/\bsk-[A-Za-z0-9_-]{8,}/g, '[已隐藏密钥]');
  for (const s of secrets)
    if (s) {
      result = result.split(s).join('[已隐藏密钥]');
      const encoded = JSON.stringify(String(s)).slice(1, -1);
      if (encoded !== s) result = result.split(encoded).join('[已隐藏密钥]');
    }
  return result;
}
export function rolePatch(assistant, customSkillDir) {
  const disabled = [
    'tool-subagent',
    'tool-subagent-fork',
    'tool-subagent-control',
    'tool-subagent-list-agents',
    'tool-workflow',
    'tool-ralph',
    'tool-goal',
    'tool-cron',
    'tool-schedule',
  ];
  if (!assistant.tools.terminal) disabled.push('tool-bash', 'tool-pwsh');
  if (!assistant.tools.files)
    disabled.push('tool-fs', 'tool-fs-search', 'tool-str-replace-editor');
  if (!assistant.tools.web) disabled.push('tool-web');
  return [
    { id: 'system-prompt', config: { persona: assistant.instructions } },
    // Keep the shipped workspace sandbox; unattended jobs cannot answer approval
    // prompts, so escalation is denied instead of enabling unrestricted execution.
    { id: 'approval', config: { policy: 'never' } },
    {
      id: 'permission',
      config: {
        defaultPreset: 'workspace-write',
        presets: {
          'workspace-write': { sandbox: 'workspace-write', approval: 'never' },
        },
      },
    },
    {
      id: 'skill-filesystem',
      config: {
        includeDefaultRoots: false,
        customSkillDirs: [
          ...SKILLS.filter((s) => assistant.skillIds.includes(s.id)).map((s) =>
            path.join(root, 'roles', s.role, 'skills'),
          ),
          ...(customSkillDir ? [customSkillDir] : []),
        ],
        watch: false,
      },
    },
    ...disabled.map((id) => ({ id, disabled: true })),
  ];
}
export function modelPatch(route) {
  if (!route || route.protocol === 'deepseek') return [];
  return [
    {
      id: 'llm-pi-ai',
      name: '@deepseek-ai/dsh-llm-pi-ai',
      config: {
        providers: {
          'workbench-provider': {
            displayName: route.providerName,
            apiKeyEnv: 'WORKBENCH_MODEL_API_KEY',
            api: route.protocol,
            baseURL: providerEndpoint(route).replace(
              route.protocol === 'anthropic-messages'
                ? /\/v1\/messages$/
                : route.protocol === 'openai-responses'
                  ? /\/responses$/
                  : /\/chat\/completions$/,
              '',
            ),
            retryPolicy: { mode: 'normal', maxRetries: 2 },
            models: [
              {
                id: route.model,
                name: route.model,
                contextWindow: route.modelSpec?.contextWindow ?? 128000,
                maxTokens: 8192,
                input: route.modelSpec?.vision ? ['text', 'image'] : ['text'],
                reasoningEfforts: false,
              },
            ],
          },
        },
      },
    },
  ];
}
export function runtimePatch(
  assistant,
  customSkillDir,
  route,
  capabilityPatch = [],
) {
  const patches = [
    ...rolePatch(assistant, customSkillDir),
    ...modelPatch(route),
  ];
  for (const entry of capabilityPatch) {
    if (entry.id === 'skill-filesystem') {
      const skills = patches.find((patch) => patch.id === 'skill-filesystem');
      skills.config.customSkillDirs = [
        ...new Set([
          ...skills.config.customSkillDirs,
          ...(entry.config?.customSkillDirs ?? []),
        ]),
      ];
    } else if (
      entry.name === '@deepseek-ai/dsh-mcp-client' ||
      (entry.name || '').startsWith('@deepseek-ai/dsh-hooks-')
    )
      patches.push({ insert: [entry] });
    else patches.push(entry);
  }
  return patches;
}
export function secureRuntimePatch(patches) {
  const env = {};
  const secrets = [];
  const visit = (value, parentKey = '') => {
    if (Array.isArray(value)) return value.map((item) => visit(item));
    if (!value || typeof value !== 'object' || value instanceof Scalar)
      return value;
    return Object.fromEntries(
      Object.entries(value).map(([key, nested]) => {
        if (
          ['env', 'headers'].includes(parentKey) &&
          typeof nested === 'string' &&
          nested
        ) {
          const name = `DSH_RUN_SECRET_${Object.keys(env).length}`;
          env[name] = nested;
          secrets.push(nested);
          if (/^Bearer /i.test(nested)) secrets.push(nested.slice(7));
          const expression = new Scalar(`process.env.${name}`);
          expression.tag = 'tag:yaml.org,2002:js';
          return [key, expression];
        }
        return [key, visit(nested, key)];
      }),
    );
  };
  return { patch: visit(patches), env, secrets };
}
export function childEnvironment(extraEnv = {}) {
  const allowed = [
    'PATH',
    'HOME',
    'USER',
    'LOGNAME',
    'SHELL',
    'LANG',
    'LC_ALL',
    'LC_CTYPE',
    'TZ',
    'TMPDIR',
    'TEMP',
    'TMP',
    'SystemRoot',
    'WINDIR',
    'COMSPEC',
    'PATHEXT',
    'SSL_CERT_FILE',
    'SSL_CERT_DIR',
    'NODE_EXTRA_CA_CERTS',
  ];
  return {
    ...Object.fromEntries(
      allowed
        .filter((key) => process.env[key] !== undefined)
        .map((key) => [key, process.env[key]]),
    ),
    ...extraEnv,
  };
}
export class DshRun {
  constructor({
    task,
    assistant,
    config,
    dataDir,
    onLog,
    onResult,
    onDone,
    onEvent = () => {},
    route,
    capabilityPatch = [],
    contextExtra = '',
    attachments = [],
    maxDurationMinutes = 30,
    env = {},
  }) {
    this.task = task;
    this.config = config;
    this.assistant = assistant ?? {
      ...ROLES[task.role],
      instructions: config.roleInstructions[task.role],
    };
    this.dataDir = dataDir;
    this.onLog = onLog;
    this.onResult = onResult;
    this.onDone = onDone;
    this.onEvent = onEvent;
    this.route = route;
    this.capabilityPatch = capabilityPatch;
    this.contextExtra = contextExtra;
    this.attachments = Array.isArray(attachments) ? attachments : [];
    if (
      !Number.isFinite(maxDurationMinutes) ||
      maxDurationMinutes <= 0 ||
      maxDurationMinutes > 1440
    )
      throw new Error('执行时限必须为 0 至 1440 分钟之间的有效数值。');
    this.maxDurationMinutes = maxDurationMinutes;
    this.extraEnv = env;
    this.pending = new Map();
    this.nextId = 1;
    this.done = false;
    this.sawTurn = false;
    this.finalReason = null;
    this.result = '';
    this.stderr = '';
    this.queue = [];
    this.finishing = null;
    this.closed = false;
  }
  async start(prompt) {
    if (this.started || this.done || this.finishing) return;
    this.started = true;
    try {
      const executable = findDsh();
      if (!executable)
        throw new Error('未找到 dsh，请先安装 @deepseek-ai/dsh。');
      const apiKey =
        this.route?.secret ||
        this.extraEnv.DEEPSEEK_API_KEY ||
        resolveApiKey(this.dataDir);
      this.secrets = [
        apiKey,
        ...Object.entries(this.extraEnv)
          .filter(([key]) => /KEY|TOKEN|SECRET|PASSWORD/i.test(key))
          .map(([, value]) => value),
      ];
      if (!apiKey)
        throw new Error('请先在工作空间设置中配置 DeepSeek API Key。');
      if (!/^[a-zA-Z0-9_-]{1,160}$/.test(this.task.id))
        throw new Error('无效的执行实例 ID。');
      const runDir = path.join(this.dataDir, 'runs', this.task.id);
      const patchFile = path.join(runDir, 'runtime.yml');
      const customSkillDir = this.assistant.workflow
        ? path.join(this.dataDir, 'runs', this.task.id, 'skills')
        : undefined;
      if (customSkillDir)
        atomicWrite(
          path.join(customSkillDir, 'assistant-workflow', 'SKILL.md'),
          `---\nname: assistant-workflow\ndescription: Custom workflow for this assistant. Use for its assigned tasks.\n---\n\n${this.assistant.workflow}\n`,
        );
      const secured = secureRuntimePatch(
        runtimePatch(
          this.assistant,
          customSkillDir,
          this.route,
          this.capabilityPatch,
        ),
      );
      this.secrets.push(...secured.secrets);
      atomicWrite(patchFile, stringify(secured.patch));
      const dshHome = path.join(runDir, 'home');
      fs.mkdirSync(dshHome, { recursive: true, mode: 0o700 });
      this.onLog('启动 DSH，载入角色工具与工作规范。');
      this.child = spawn(
        executable,
        ['--profile', 'sdk', '--patch', patchFile],
        {
          cwd: this.task.workspace,
          detached: true,
          stdio: ['pipe', 'pipe', 'pipe'],
          env: {
            ...childEnvironment(this.extraEnv),
            ...secured.env,
            DSH_HOME: dshHome,
            ...(this.route && this.route.protocol !== 'deepseek'
              ? { WORKBENCH_MODEL_API_KEY: apiKey }
              : {
                  DEEPSEEK_API_KEY: apiKey,
                  ...(this.route
                    ? {
                        DEEPSEEK_BASE_URL: providerEndpoint(this.route).replace(
                          /\/chat\/completions$/,
                          '',
                        ),
                      }
                    : {}),
                }),
            DSH_PERMISSION_MODE: 'workspace-write',
          },
        },
      );
      this.child.stdin.on('error', () => {});
      this.child.once('error', (error) => this.finish('failed', error.message));
      this.child.once('close', (code, signal) => {
        this.closed = true;
        for (const p of this.pending.values()) {
          clearTimeout(p.timer);
          p.reject(new Error('DSH 进程已退出'));
        }
        this.pending.clear();
        if (!this.finishing)
          this.finishing = {
            status: 'failed',
            error: `DSH 意外退出（${signal || code}）。${this.stderr.slice(-1600)}`,
          };
        this.complete();
      });
      let buffer = '';
      this.child.stdout.setEncoding('utf8');
      this.child.stdout.on('data', (chunk) => {
        buffer += chunk;
        if (buffer.length > 8_000_000) {
          this.finish('failed', '执行事件过大，已停止任务。');
          return;
        }
        let at;
        while ((at = buffer.indexOf('\n')) >= 0) {
          const line = buffer.slice(0, at);
          buffer = buffer.slice(at + 1);
          if (!line.trim()) continue;
          try {
            this.message(JSON.parse(line));
          } catch {
            this.onLog(redact(line.slice(0, 1000), this.secrets));
          }
        }
      });
      this.child.stderr.setEncoding('utf8');
      this.child.stderr.on('data', (chunk) => {
        if (this.done) return;
        const text = redact(chunk, this.secrets);
        this.stderr = (this.stderr + text).slice(-8000);
        this.onLog(text.slice(-2000));
      });
      this.timeout = setTimeout(
        () =>
          this.finish(
            'failed',
            `任务已达到 ${this.maxDurationMinutes} 分钟执行上限。已有成果保留，可检查后继续。`,
          ),
        this.maxDurationMinutes * 60_000,
      );
      const ready = await this.request('initialize', {
        cwd: this.task.workspace,
        provider:
          this.route && this.route.protocol !== 'deepseek'
            ? 'workbench-provider'
            : 'deepseek-official',
        model: this.route?.model || this.assistant.model || this.config.model,
        maxTokens: 8192,
      });
      this.onLog(
        `已连接 ${ready.serverInfo.name} · ${this.route?.model || this.assistant.model || this.config.model}`,
      );
      const contentBlocks = [
        {
          type: 'text',
          text: [prompt, this.contextExtra].filter(Boolean).join('\n\n'),
        },
      ];
      // DSH admits encoded raster blocks into its durable attachment store. Pass
      // image bytes inline when the selected model advertises vision support;
      // other file types remain available at the staged workspace paths listed
      // in the context, so file-capable agents can inspect their original bytes.
      if (this.route?.modelSpec?.vision === true) {
        const imageTypes = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif']);
        for (const attachment of this.attachments) {
          const mimeType = String(attachment.mime || '').toLowerCase();
          if (!imageTypes.has(mimeType) || !attachment.path) continue;
          const data = fs.readFileSync(attachment.path).toString('base64');
          contentBlocks.push({ type: 'image', data, mimeType });
        }
      }
      await this.request('session/prompt', {
        sessionId: this.task.id,
        contentBlocks,
      });
    } catch (error) {
      if (!this.done)
        this.finish('failed', redact(error.message, this.secrets));
    }
  }
  request(method, params) {
    return new Promise((resolve, reject) => {
      if (!this.child || this.closed || this.done || this.finishing)
        return reject(new Error('DSH 进程不可用。'));
      const id = this.nextId++;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`DSH ${method} 响应超时`));
      }, 90_000);
      this.pending.set(id, { resolve, reject, timer });
      this.child.stdin.write(
        JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n',
      );
    });
  }
  message(frame) {
    if (frame.id !== undefined) {
      const p = this.pending.get(frame.id);
      if (p) {
        this.pending.delete(frame.id);
        clearTimeout(p.timer);
        if (frame.error) p.reject(new Error(frame.error.message));
        else p.resolve(frame.result);
      }
      return;
    }
    if (this.done || this.finishing) return;
    const params = frame.params || {};
    if (params.sessionId !== this.task.id) return;
    if (frame.method === 'session.event') {
      const e = params.event,
        d = e.data || e;
      const scrub = (value) =>
        typeof value === 'string'
          ? redact(value, this.secrets)
          : Array.isArray(value)
            ? value.map(scrub)
            : value && typeof value === 'object'
              ? Object.fromEntries(
                  Object.entries(value).map(([key, nested]) => [
                    key,
                    scrub(nested),
                  ]),
                )
              : value;
      this.onEvent(scrub({ ...e, taskId: this.task.id }));
      if (e.type === 'turn/start') {
        this.sawTurn = true;
        this.onLog('开始处理任务。');
      }
      if (e.type === 'assistant/message') {
        const content = d.message?.content || [];
        const text = Array.isArray(content)
          ? content
              .filter((b) => b.type === 'text')
              .map((b) => b.text)
              .join('\n')
          : String(content);
        if (text) {
          this.result = text;
          this.onResult(redact(text, this.secrets));
        }
      }
      if (e.type === 'tool/call')
        this.onLog(
          `调用工具：${d.name}\n${redact(d.arguments, this.secrets).slice(0, 1200)}`,
        );
      if (e.type === 'tool/result')
        this.onLog(
          d.error
            ? `工具失败：${d.error.code || d.error.name}`
            : '工具执行结束。',
        );
      if (e.type === 'turn/end') this.finalReason = d.reason;
    }
    if (
      frame.method === 'session.status' &&
      params.status === 'idle' &&
      this.sawTurn
    ) {
      const reason = this.finalReason;
      if (reason?.kind === 'completed' && this.queue.length) {
        const queued = this.queue.splice(0);
        this.sawTurn = false;
        this.finalReason = null;
        this.onEvent({
          type: 'message/accepted',
          taskId: this.task.id,
          ids: queued.map((item) => item.id),
        });
        void this.request('session/prompt', {
          sessionId: this.task.id,
          contentBlocks: [
            {
              type: 'text',
              text: queued.map((item) => item.text).join('\n\n'),
            },
          ],
        }).catch((error) => this.finish('failed', error.message));
        return;
      }
      if (reason?.kind === 'completed') this.finish('completed', '');
      else
        this.finish(
          'failed',
          reason?.error?.message ||
            `执行未完成：${reason?.kind || '未返回结果状态'}`,
        );
    }
  }
  cancel() {
    this.finish('cancelled', '用户已停止任务。已有文件修改不会自动回滚。');
  }
  enqueue(text) {
    if (this.done || this.finishing)
      throw new Error('执行实例已结束，请创建后续任务。');
    if (
      typeof text !== 'string' ||
      !text.trim() ||
      text.length > 100000 ||
      this.queue.length >= 100
    )
      throw new Error('追加消息无效或收件队列已满。');
    const id = randomUUID();
    this.queue.push({ id, text });
    return { queued: true, id };
  }
  finish(status, error) {
    if (this.done || this.finishing) return;
    this.finishing = { status, error: redact(error, this.secrets) };
    clearTimeout(this.timeout);
    if (!this.child || this.closed) {
      this.complete();
      return;
    }
    if (!this.child.killed) {
      if (status === 'completed') {
        const id = this.nextId++;
        this.child.stdin.write(
          JSON.stringify({ jsonrpc: '2.0', id, method: 'shutdown' }) + '\n',
        );
        const timer = setTimeout(() => this.kill(), 4000);
        timer.unref();
        this.child.once('close', () => clearTimeout(timer));
      } else this.kill();
    }
  }
  complete() {
    if (this.done || !this.finishing) return;
    this.done = true;
    clearTimeout(this.timeout);
    this.onDone(
      this.finishing.status,
      redact(this.finishing.error, this.secrets),
    );
  }
  kill() {
    if (!this.child?.pid) return;
    try {
      process.kill(-this.child.pid, 'SIGTERM');
    } catch {}
    const pid = this.child.pid;
    const timer = setTimeout(() => {
      try {
        process.kill(-pid, 'SIGKILL');
      } catch {}
    }, 2000);
    timer.unref();
    this.child.once('close', () => clearTimeout(timer));
  }
}

#!/usr/bin/env node
import process from 'node:process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { randomUUID, createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { SKILLS } from '../server/roles.mjs';

const PRESETS = {
  deepseek: {
    label: 'DeepSeek', contextWindow: 128000, protocol: 'chat', baseUrl: 'https://api.deepseek.com',
    model: 'deepseek-chat', keys: ['DEEPSEEK_API_KEY'], models: ['deepseek-chat', 'deepseek-reasoner'],
  },
  kimi: {
    label: 'Kimi', protocol: 'chat', baseUrl: 'https://api.moonshot.cn/v1',
    model: 'moonshot-v1-8k', keys: ['KIMI_API_KEY', 'MOONSHOT_API_KEY'], models: ['moonshot-v1-8k', 'moonshot-v1-32k'],
  },
  gemini: {
    label: 'Gemini', contextWindow: 1048576, protocol: 'chat', baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
    model: 'gemini-2.5-flash', keys: ['GEMINI_API_KEY', 'GOOGLE_API_KEY'], models: ['gemini-2.5-flash', 'gemini-2.5-pro'],
  },
  claude: {
    label: 'Claude', contextWindow: 200000, protocol: 'anthropic', baseUrl: 'https://api.anthropic.com',
    model: 'claude-sonnet-4-5', keys: ['ANTHROPIC_API_KEY'], models: ['claude-sonnet-4-5', 'claude-opus-4-1'],
  },
  codex: {
    label: 'Codex/OpenAI', contextWindow: 400000, protocol: 'responses', baseUrl: 'https://api.openai.com/v1',
    model: 'gpt-5-codex', keys: ['CODEX_API_KEY', 'OPENAI_API_KEY'], models: ['gpt-5-codex', 'gpt-5'],
  },
  openai: {
    label: 'OpenAI Chat', contextWindow: 400000, protocol: 'chat', baseUrl: 'https://api.openai.com/v1',
    model: 'gpt-4.1', keys: ['OPENAI_API_KEY'], models: ['gpt-4.1', 'gpt-4.1-mini'],
  },
  xai: {
    label: 'xAI Grok', contextWindow: 256000, protocol: 'chat', baseUrl: 'https://api.x.ai/v1',
    model: 'grok-4', keys: ['XAI_API_KEY'], models: ['grok-4', 'grok-3'],
  },
  mistral: {
    label: 'Mistral', contextWindow: 128000, protocol: 'chat', baseUrl: 'https://api.mistral.ai/v1',
    model: 'mistral-large-latest', keys: ['MISTRAL_API_KEY'], models: ['mistral-large-latest'],
  },
  groq: {
    label: 'Groq', contextWindow: 128000, protocol: 'chat', baseUrl: 'https://api.groq.com/openai/v1',
    model: 'llama-3.3-70b-versatile', keys: ['GROQ_API_KEY'], models: ['llama-3.3-70b-versatile'],
  },
  cerebras: {
    label: 'Cerebras', protocol: 'chat', baseUrl: 'https://api.cerebras.ai/v1',
    model: 'llama-3.3-70b', keys: ['CEREBRAS_API_KEY'], models: ['llama-3.3-70b'],
  },
  openrouter: {
    label: 'OpenRouter', protocol: 'chat', baseUrl: 'https://openrouter.ai/api/v1',
    model: 'anthropic/claude-sonnet-4.5', keys: ['OPENROUTER_API_KEY'], models: [],
  },
  together: {
    label: 'Together', protocol: 'chat', baseUrl: 'https://api.together.xyz/v1',
    model: 'meta-llama/Llama-3.3-70B-Instruct-Turbo', keys: ['TOGETHER_API_KEY'], models: [],
  },
  fireworks: {
    label: 'Fireworks', protocol: 'chat', baseUrl: 'https://api.fireworks.ai/inference/v1',
    model: 'accounts/fireworks/models/llama-v3p3-70b-instruct', keys: ['FIREWORKS_API_KEY'], models: [],
  },
  qwen: {
    label: 'Qwen/DashScope', contextWindow: 128000, protocol: 'chat', baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    model: 'qwen-plus', keys: ['DASHSCOPE_API_KEY', 'QWEN_API_KEY'], models: ['qwen-plus', 'qwen-max'],
  },
  zhipu: {
    label: 'Zhipu/GLM', contextWindow: 128000, protocol: 'chat', baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
    model: 'glm-4.6', keys: ['ZHIPU_API_KEY', 'ZAI_API_KEY'], models: ['glm-4.6', 'glm-4.5'],
  },
  ollama: {
    label: 'Ollama (本地)', contextWindow: 32768, protocol: 'chat', baseUrl: 'http://127.0.0.1:11434/v1',
    model: 'qwen2.5-coder:7b', keys: ['OLLAMA_API_KEY'], keyOptional: true, models: [],
  },
  lmstudio: {
    label: 'LM Studio (本地)', contextWindow: 32768, protocol: 'chat', baseUrl: 'http://127.0.0.1:1234/v1',
    model: 'local-model', keys: ['LMSTUDIO_API_KEY'], keyOptional: true, models: [],
  },
};
const PROVIDER_ALIASES = { gpt: 'codex', moonshot: 'kimi', glm: 'zhipu' };
const CLI_NAME = 'ggb';

const usage = `用法：
  ggb                            # 进入工作台首页（选团队派活）
  ggb providers
  ggb doctor [--api-url http://127.0.0.1:3089/api/health] [--ui-url http://127.0.0.1:3088/] [--json]
  ggb run --provider gemini --model gemini-2.5-flash "解释这段代码"
  echo "总结这个项目" | ggb run --provider claude
  ggb run --provider deepseek --system "你是后端专家" --no-stream "设计 API"
  ggb run --continue "继续上一个任务"
  ggb run --session refactor --continue "继续重构"
  ggb chat --provider claude --session personal
  ggb decide --state '{"goal":"..."}' --questions '{"urgent":{"type":"noul","instructions":"Is this urgent?"}}'
  ggb team list | create | run <id> "目标" [--watch] | status <id> | reviews <id> | review --approve <opId>
  ggb skill recommend "任务描述" | install <技能ID> | list | enable|disable <ID|名称> [--yes]
  ggb task <id> | ack <id> | accept <id> | reject <id> --note "需改什么" | retry <id>
  ggb team watch <id>            # 订阅实时事件流（不再轮询）
  ggb context list|share <teamId> ...   # 查看或发布跨团队共享上下文
  ggb models                     # 供应商与模型目录（含自定义 models.json）
  ggb rpc                        # JSONL 机器协议（prompt/follow_up/set_model/abort）
  ggb events <taskId> | --team <id> [--once] [--json]
  ggb node --control-url https://… --workspace 名称=/绝对路径
  ggb login <providerId>         # 把 API Key 写入加密凭据库，并在工作台启用供应商
  ggb logout <providerId>        # 移除该供应商的凭据与配置

支持预设：${Object.keys(PRESETS).join('、')}（gpt/openai 是 Codex/OpenAI 别名）；TypeSafe 通过 decide 命令作为可选结构化决策后端。
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

function versionAtLeast(version, minimum) {
  const parse = value => String(value).split('.').map(part => Number.parseInt(part, 10) || 0);
  const actual = parse(version);
  const expected = parse(minimum);
  return expected.every((part, index) => (actual[index] || 0) >= part || actual.slice(0, index).some((value, i) => value > expected[i]));
}

function doctorCheck(id, label, status, detail) {
  return { id, label, status, detail };
}

// ---- 工作台 API 客户端（团队自治流程） ----
// 本地 loopback 且未开启 WORKBENCH_REQUIRE_AUTH 时无需登录；否则用 --password 或 GGB_PASSWORD 登录后缓存 cookie。
const workbenchBase = args => String(valueAfter(args, '--api', process.env.GGB_API_URL || 'http://127.0.0.1:3089')).replace(/\/$/, '');
const cookieFile = () => path.join(sessionDir(), '.workbench-session');
// 工作台未运行时自动拉起一个（后台常驻），用户不需要先手动 npm start。
// 常驻实例跑的是旧代码时（我们刚更新过），按代码指纹自动重启。
const autoStarted = new Set();
const fingerprintOf = dir => {
  const hash = createHash('sha1');
  const walk = directory => {
    for (const item of fs.readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const full = path.join(directory, item.name);
      if (item.isDirectory()) walk(full);
      else if (item.name.endsWith('.mjs')) {
        const stat = fs.statSync(full);
        hash.update(item.name).update(String(stat.size)).update(String(Math.floor(stat.mtimeMs / 1000)));
      }
    }
  };
  walk(dir);
  return hash.digest('hex').slice(0, 12);
};
const serverDir = () => path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'server');
const workbenchDataDir = () => process.env.WORKBENCH_DATA_DIR || path.join(os.homedir(), '.dsh-workbench');
const runFile = () => path.join(workbenchDataDir(), 'workbench-run.json');

// 重启在 CLI 进程内同步完成：杀旧 → 等死 → 等端口 → 拉新 → 确认健康。
// 拉新用的是已验证可在父进程退出后存活的 detached 模式。
async function restartWorkbench(args, reason) {
  const runInfo = fs.existsSync(runFile()) ? JSON.parse(fs.readFileSync(runFile(), 'utf8')) : null;
  const base = workbenchBase(args);
  let restartPort = 3089;
  try { restartPort = new URL(base).port || 3089; } catch {}
  const restartHelperPath = fileURLToPath(new URL('../server/restart-helper.mjs', import.meta.url));
  const restartServerPath = fileURLToPath(new URL('../server/index.mjs', import.meta.url));
  const restartDataDir = workbenchDataDir();
  console.error(`· ${reason}，正在重启工作台（等待完成）…`);
  // helper 同步执行：杀旧 → 等进程死透 → 等端口释放 → 拉新 → 确认健康后退出。
  // CLI 等待 helper 完成再退出，避免父进程退出与子进程 exec 竞争导致新实例被静默回收。
  const result = await new Promise(resolve => {
    const child = spawn(process.execPath, [restartHelperPath, String(runInfo?.pid || ''), String(restartPort), restartDataDir, restartServerPath], {
      stdio: 'inherit',
      env: { ...process.env },
    });
    child.on('error', error => resolve({ ok: false, message: error.message }));
    child.on('close', code => resolve({ ok: code === 0, message: code === 0 ? '' : `重启助手退出码 ${code}` }));
  });
  autoStarted.delete(base);
  if (!result.ok) throw new Error(result.message || '工作台重启失败。');
  console.error('· 工作台重启完成。');
  return true;
}
async function ensureWorkbench(args) {
  if (has(args, '--no-autostart') || process.env.GGB_NO_AUTOSTART === '1') return false;
  const base = workbenchBase(args);
  if (autoStarted.has(base)) return false;
  const serverPath = fileURLToPath(new URL('../server/index.mjs', import.meta.url));
  let port = 3089;
  try { port = new URL(base).port || 3089; } catch {}
  const dataDir = workbenchDataDir();
  console.error(`· 工作台未运行，正在自动启动（数据目录 ${dataDir}）…`);
  const logFile = path.join(dataDir, 'autostart.log');
  fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  // 自愈：子进程意外退出（如端口未及时释放）时自动重拉，最多 3 次。
  for (let attemptNo = 1; attemptNo <= 3; attemptNo += 1) {
    const out = fs.openSync(logFile, 'a');
    fs.appendFileSync(logFile, `[cli] spawn attempt ${attemptNo} pid=${process.pid}\n`);
    const child = spawn(process.execPath, [serverPath], {
      detached: true,
      stdio: ['ignore', out, out],
      env: { ...process.env, WORKBENCH_API_PORT: String(port), WORKBENCH_DATA_DIR: dataDir },
    });
    child.unref();
    fs.closeSync(out);
    child.once('exit', (code, signal) => fs.appendFileSync(logFile, `[cli] child exited code=${code} signal=${signal}\n`));
    autoStarted.add(base);
    // 等健康检查就绪（最多 20 秒）。
    for (let index = 0; index < 60; index += 1) {
      await new Promise(resolve => setTimeout(resolve, 300));
      if (child.exitCode !== null) break;
      try {
        const health = await fetch(`${base}/api/health`, { signal: AbortSignal.timeout(1500) });
        if (health.ok) {
          console.error(`· 工作台已就绪：${base}`);
          return true;
        }
      } catch {}
    }
    const logTail = fs.existsSync(logFile) ? fs.readFileSync(logFile, 'utf8').trim().split('\n').slice(-2).join(' | ') : '';
    console.error(`· 工作台启动未就绪（第 ${attemptNo} 次）${child.exitCode !== null ? `，进程已退出（码 ${child.exitCode}）` : ''}。日志：${logTail.slice(0, 200)}，重试…`);
    if (attemptNo === 3)
      throw new Error(`工作台自动启动失败。请查看 ${logFile} 或手动运行 npm start 定位原因。`);
    await new Promise(resolve => setTimeout(resolve, 1000));
  }
  throw new Error(`工作台自动启动超时（${base}）。请手动运行 npm start 查看具体错误。`);
}

async function workbenchFetch(args, route, { method = 'GET', body } = {}) {
  const base = workbenchBase(args);
  const url = `${base}/api/${String(route).replace(/^\//, '')}`;
  const cookie = fs.existsSync(cookieFile()) ? fs.readFileSync(cookieFile(), 'utf8').trim() : '';
  const attempt = async authCookie => fetch(url, {
    method,
    headers: { 'Content-Type': 'application/json', ...(authCookie ? { Cookie: authCookie } : {}) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  let response;
  try {
    response = await attempt(cookie);
  } catch {
    // 连接失败 → 自动拉起工作台再重试一次。
    await ensureWorkbench(args).catch(() => {});
    try {
      response = await attempt(cookie);
    } catch (retryError) {
      throw new Error(`无法连接工作台 ${base}（自动启动失败或被禁用：GGB_NO_AUTOSTART=1）。\n原始错误：${retryError.message}`);
    }
  }
  if (response.status === 401) {
    const password = valueAfter(args, '--password', process.env.GGB_PASSWORD || '');
    if (!password) throw new Error('工作台需要登录。请用 --password 或环境变量 GGB_PASSWORD 提供密码。');
    const login = await fetch(`${base}/api/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password }) });
    if (!login.ok) throw new Error(`工作台登录失败（HTTP ${login.status}）。`);
    const setCookie = login.headers.get('set-cookie') || '';
    const sessionCookie = setCookie.split(';')[0];
    fs.mkdirSync(sessionDir(), { recursive: true, mode: 0o700 });
    fs.writeFileSync(cookieFile(), sessionCookie, { mode: 0o600 });
    response = await attempt(sessionCookie);
  }
  const text = await response.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  if (!response.ok) throw new Error((data && data.error) || `HTTP ${response.status}`);
  await checkWorkbenchFreshness(args).catch(() => {});
  return data;
}

// 常驻实例可能在跑旧代码：每进程一次，用 /api/health 的指纹比对，旧了就自动重启。
let freshnessChecked = false;
async function checkWorkbenchFreshness(args) {
  if (freshnessChecked) return;
  freshnessChecked = true;
  if (has(args, '--no-autorestart') || process.env.GGB_NO_AUTORESTART === '1') return;
  const base = workbenchBase(args);
  if (autoStarted.has(base)) return; // 本进程刚拉起的，必然是最新代码
  const health = await fetch(`${base}/api/health`, {
    headers: fs.existsSync(cookieFile()) ? { Cookie: fs.readFileSync(cookieFile(), 'utf8').trim() } : {},
    signal: AbortSignal.timeout(3000),
  });
  if (!health.ok) return;
  const info = await health.json();
  const mine = fingerprintOf(serverDir());
  const runInfo = fs.existsSync(runFile()) ? JSON.parse(fs.readFileSync(runFile(), 'utf8')) : null;
  if (process.env.GGB_DEBUG)
    console.error(`[debug] 运行实例指纹=${info.fingerprint} 本地=${mine} 运行文件=${JSON.stringify(runInfo)}`);
  if (info.fingerprint && info.fingerprint !== mine && runInfo?.pid && runInfo.fingerprint === info.fingerprint) {
    const restarted = await restartWorkbench(args, '工作台代码已更新');
    if (restarted) {
      // 让当前调用的响应反映重启后的实例：重发一次原始请求由调用方处理，这里只提示。
      console.error('· 后续命令将连接新实例。');
    }
  }
}
function fmtTime(value) { if (!value) return ''; const d = new Date(value); return Number.isNaN(d.getTime()) ? '' : d.toLocaleString('zh-CN', { hour12: false }); }

async function checkReachable(id, label, target) {
  try {
    const url = new URL(target);
    const response = await fetch(url, { signal: AbortSignal.timeout(3000), redirect: 'manual' });
    return doctorCheck(id, label, response.ok ? 'pass' : 'warn', response.ok ? `${url.origin} 可访问（HTTP ${response.status}）` : `${url.origin} 返回 HTTP ${response.status}`);
  } catch (error) {
    const message = error?.name === 'TimeoutError' ? '连接超时（3 秒）' : '当前不可访问';
    return doctorCheck(id, label, 'warn', `${target} ${message}`);
  }
}

function writableSessionCheck() {
  const directory = sessionDir();
  try {
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    const probe = path.join(directory, `.doctor-${process.pid}-${randomUUID()}.tmp`);
    fs.writeFileSync(probe, 'ok', { mode: 0o600 });
    fs.rmSync(probe, { force: true });
    return doctorCheck('session', '会话目录', 'pass', `${directory} 可读写`);
  } catch {
    return doctorCheck('session', '会话目录', 'fail', `${directory} 不可读写`);
  }
}

function configuredProviderCheck() {
  const configured = Object.entries(PRESETS)
    .filter(([, preset]) => preset.keys.some(key => Boolean(process.env[key])))
    .map(([id, preset]) => `${preset.label} (${id})`);
  return doctorCheck(
    'providers',
    '模型凭据',
    configured.length ? 'pass' : 'warn',
    configured.length ? `已配置：${configured.join('、')}` : '未发现普通模型环境变量；可在网页模型管理或环境变量中配置',
  );
}

function gitCheck() {
  try {
    const version = execFileSync('git', ['--version'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    return doctorCheck('git', 'Git', 'pass', version || '已安装');
  } catch {
    return doctorCheck('git', 'Git', 'warn', '未找到 Git；不影响直接调用模型，但项目执行能力可能受限');
  }
}

async function doctor(args) {
  const apiUrl = valueAfter(args, '--api-url', process.env.DSH_API_HEALTH_URL || 'http://127.0.0.1:3089/api/health');
  const uiUrl = valueAfter(args, '--ui-url', process.env.DSH_UI_URL || 'http://127.0.0.1:3088/');
  const nodeOk = versionAtLeast(process.versions.node, '22.13.0');
  const platform = process.env.WSL_DISTRO_NAME || process.env.WSL_INTEROP ? `${process.platform}/${process.arch} · WSL2` : `${process.platform}/${process.arch}`;
  const checks = [
    doctorCheck('node', 'Node.js', nodeOk ? 'pass' : 'fail', `${process.versions.node}${nodeOk ? '' : '（需要 22.13+）'}`),
    doctorCheck('platform', '运行平台', 'pass', platform),
    writableSessionCheck(),
    gitCheck(),
    configuredProviderCheck(),
    doctorCheck('typesafe', 'TypeSafe', process.env.TYPESAFE_API_KEY ? 'pass' : 'info', process.env.TYPESAFE_API_KEY ? '已配置（可选）' : '未配置（可选）'),
    await checkReachable('api', '工作台 API', apiUrl),
    await checkReachable('ui', '工作台网页', uiUrl),
  ];
  const result = {
    ok: checks.every(check => check.status !== 'fail'),
    generatedAt: new Date().toISOString(),
    platform: { os: process.platform, arch: process.arch, node: process.versions.node, wsl: Boolean(process.env.WSL_DISTRO_NAME || process.env.WSL_INTEROP) },
    checks,
  };
  if (has(args, '--json')) {
    process.stdout.write(`${JSON.stringify(result)}\n`);
    return result;
  }
  for (const check of checks) {
    const marker = check.status === 'pass' ? '✓' : check.status === 'fail' ? '✗' : check.status === 'warn' ? '!' : '·';
    console.log(`${marker} ${check.label}：${check.detail}`);
  }
  console.log(result.ok ? '\n环境检查通过；带 ! 的项目是可选提醒。' : '\n环境检查未通过，请先修复 ✗ 项目。');
  return result;
}

// ---- ggb team：终端版自治团队 ----
const teamUsage = `用法：
  ggb team list
  ggb team create --name 团队名 --goal 目标 [--workspace /项目绝对路径] [--no-review] [--type development|product|operations|project|custom]
  ggb team run <teamId> "要达成的目标" [--watch]
  ggb team watch <teamId>
  ggb team status <teamId>
  ggb team reviews <teamId>
  ggb team review --approve|--reject <operationId> [--reason 说明]

  ggb skill recommend "任务描述" [--limit 8] [--json]
  ggb skill install <技能ID|安装地址>
  ggb skill list [--json]

  ggb task <taskId> [--json]
  ggb task ack <taskId> [--note 说明]
  ggb task accept <taskId> [--note 说明]
  ggb task reject <taskId> --note 需要改什么

  ggb context list <teamId>
  ggb context share <teamId> --key <key> --title <标题> --content "内容" [--kind note|decision|finding|status|artifact] [--revision N]
  ggb models [--json]
通用：--api 指定工作台地址（默认 http://127.0.0.1:3089），--password 或 GGB_PASSWORD 登录。`;

async function teamList(args) {
  const teams = await workbenchFetch(args, 'teams');
  if (has(args, '--json')) return console.log(JSON.stringify(teams, null, 2));
  if (!teams.length) return console.log('还没有团队。用 ggb team create 创建。');
  for (const team of teams) {
    const phase = team.recruitment?.phase || 'unknown';
    const review = team.requireReview === false ? '自治招募' : '人工审核';
    const members = team.recruitment?.phase === 'confirmed' ? (team.memberRoleIds || []).length : 1;
    console.log(`${team.id}  ${team.name}  [${phase}]  ${review}  成员${members}  ${team.status}`);
  }
}

async function teamCreate(args) {
  const name = valueAfter(args, '--name', '');
  const goal = valueAfter(args, '--goal', '');
  if (!name || !goal) throw new Error('team create 需要 --name 和 --goal。');
  const teamType = valueAfter(args, '--type', 'custom');
  const requireReview = !has(args, '--no-review');
  const workspace = valueAfter(args, '--workspace', '');
  if (workspace && !path.isAbsolute(workspace)) throw new Error('--workspace 需要绝对路径。');
  if (workspace && !fs.existsSync(workspace)) throw new Error(`--workspace 目录不存在：${workspace}`);
  if (workspace) {
    const entries = fs.readdirSync(workspace).filter((name) => name !== '.git' && name !== 'node_modules');
    if (!entries.length) console.error(`警告：${workspace} 是空目录，团队将没有可处理的代码。`);
  }
  const body = {
    name, goal, purpose: goal, teamType, pmRoleId: 'project_manager', memberRoleIds: ['project_manager'],
    requireReview,
    ...(workspace ? { workspace } : {}),
    collaboration: { enabled: true, autoHandoff: true, sharedBoard: true, allowedTeamIds: [] },
  };
  const saved = await workbenchFetch(args, 'teams', { method: 'POST', body });
  if (has(args, '--json')) return console.log(JSON.stringify(saved, null, 2));
  console.log(`已创建团队「${saved.name}」(${saved.id})，招募审核：${requireReview ? '需要人工确认' : '自动确认（自治）'}。`);
  if (saved.workspace) console.log(`工作目录：${saved.workspace}`);
  console.log(`下一步：ggb team run ${saved.id} "你要达成的目标" --watch`);
}

function renderTeamStatus(team, tasksOptions = [], options = {}) {
  console.log(`团队：${team.name} (${team.id})  阶段：${team.recruitment?.phase || 'unknown'}  状态：${team.status}`);
  if (team.goal) console.log(`目标：${team.goal}`);
  const messages = team.messages || [];
  const recent = messages.slice(-8);
  if (recent.length) {
    console.log('\n最近消息：');
    for (const message of recent) {
      const who = message.senderType === 'owner' ? '你' : message.senderType === 'system' ? '系统' : message.senderType === 'team' ? `团队(${message.senderId || ''})` : 'PM';
      console.log(`  [${fmtTime(message.createdAt)}] ${who}: ${String(message.content || '').slice(0, 160)}${message.status === 'blocked' ? '（阻塞）' : ''}`);
    }
  }
  if (options.filtered) {
    console.log(`\n任务（过滤后 ${tasksOptions.length}/${options.total}）：`);
    if (!tasksOptions.length) console.log('  （没有匹配的任务）');
    for (const task of tasksOptions) {
      const acceptance = task.verificationStatus ? ` 验证:${task.verificationStatus}` : '';
      const delivery = task.deliveryStatus ? ` 交付:${task.deliveryStatus}` : '';
      const title = String(task.title || task.id || '').replace(/\s+/g, ' ').slice(0, 50);
      console.log(`  [${task.status}] ${title}${acceptance}${delivery}`);
      console.log(`    id: ${task.id}`);
    }
    console.log('\n过滤：ggb team status <id> --open（未完成） / --failed（失败） / --limit N');
  } else if (options.total) {
    console.log(`\n任务（最近 ${Math.min(tasksOptions.length, options.total)}/${options.total}）：`);
    for (const task of tasksOptions) {
      const acceptance = task.verificationStatus ? ` 验证:${task.verificationStatus}` : '';
      const delivery = task.deliveryStatus ? ` 交付:${task.deliveryStatus}` : '';
      const title = String(task.title || task.id || '').replace(/\s+/g, ' ').slice(0, 50);
      console.log(`  [${task.status}] ${title}${acceptance}${delivery}`);
      console.log(`    id: ${task.id}`);
    }
    console.log('\n过滤：ggb team status <id> --open（未完成） / --failed（失败） / --limit N');
  }
}

const RISK_TEXT = { high: '高风险', medium: '中风险', low: '低风险', unknown: '未知' };

function renderTask(task) {
  const delivery = task.delivery || {};
  const impact = delivery.impact || task.impact || null;
  console.log(`任务：${task.title || task.id}`);
  console.log(`状态：${task.status}   交付：${delivery.deliveryStatus || '-'}   验收：${delivery.acceptanceStatus || '-'}`);
  if (task.error) console.log(`错误：${String(task.error).slice(0, 300)}`);
  console.log(`\n执行目录：${task.executionWorkspace?.path || '-'}  (${task.executionWorkspace?.kind || '-'})`);

  const verification = delivery.latestVerification;
  if (verification) {
    console.log(`\n验证：${verification.status}  ${fmtTime(verification.finishedAt || verification.updatedAt)}`);
    const output = String(verification.output || '').trim();
    if (output) console.log(output.split('\n').map(line => `  ${line}`).join('\n').slice(0, 2000));
  } else {
    console.log('\n验证：尚无证据');
  }

  if (impact) {
    const ack = task.impactAcknowledged ? '已确认' : impact.requiresAck ? '待确认' : '无需确认';
    console.log(`\n变更影响：${RISK_TEXT[impact.risk] || impact.risk}（${ack}）`);
    const stats = impact.stats;
    if (stats) console.log(`  文件：共 ${stats.total}（新增 ${stats.added} / 修改 ${stats.modified} / 删除 ${stats.deleted}）`);
    for (const reason of impact.reasons || []) console.log(`  - ${reason}`);
    if (impact.requiresAck && !task.impactAcknowledged)
      console.log(`  下一步：ggb task ack ${task.id}`);
  }

  const artifacts = (task.artifacts || []).filter(item => item.kind !== 'impact');
  if (artifacts.length) {
    console.log('\n产物：');
    for (const item of artifacts.slice(0, 10))
      console.log(`  [${item.kind || 'artifact'}] ${item.name || item.title || item.id}${item.status ? ` (${item.status})` : ''}`);
  }
  if (task.result) {
    console.log('\n结果：');
    console.log(String(task.result).slice(0, 4000));
  }
}

async function taskCommand(args) {
  const sub = args[0];
  if (!sub || sub === 'help' || sub === '--help' || sub === '-h') return console.log(teamUsage);
  const known = ['ack', 'accept', 'reject', 'retry'];
  if (!known.includes(sub)) {
    const task = await workbenchFetch(args, `tasks/${sub}`);
    if (has(args, '--json')) return console.log(JSON.stringify(task, null, 2));
    return renderTask(task);
  }
  const id = args[1] && !args[1].startsWith('--') ? args[1] : '';
  if (!id) throw new Error(`task ${sub} 需要任务 ID。`);
  const note = valueAfter(args, '--note', '');
  if (sub === 'ack') {
    const result = await workbenchFetch(args, `tasks/${id}/impact/ack`, { method: 'POST', body: { note } });
    if (has(args, '--json')) return console.log(JSON.stringify(result, null, 2));
    return console.log(`已确认影响面：${id}`);
  }
  if (sub === 'reject' && !note) throw new Error('退回复核需要 --note 说明需要改什么。');
  if (sub === 'retry') {
    const result = await workbenchFetch(args, `tasks/${id}/retry`, { method: 'POST', body: {} });
    if (has(args, '--json')) return console.log(JSON.stringify(result, null, 2));
    console.log(`已重试：新执行实例 ${result.taskId || result.id || id}`);
    return;
  }
  const result = await workbenchFetch(args, `tasks/${id}/${sub}`, { method: 'POST', body: { note } });
  if (has(args, '--json')) return console.log(JSON.stringify(result, null, 2));
  console.log(sub === 'accept' ? `已验收通过：${id}` : `已退回复核：${id}`);
  if (result.delivery) console.log(`交付状态：${result.delivery.deliveryStatus}`);
}

/** 隐藏输入的交互式读取（密钥/口令）。 */
function askSecret(label) {
  if (!process.stdin.isTTY) throw new Error(`${label}需要在交互式终端输入，或用参数/环境变量提供。`);
  return new Promise((resolve) => {
    process.stderr.write(label);
    const rl = readline.createInterface({ input: process.stdin, output: process.stderr, terminal: true });
    rl._writeToOutput = () => {};
    rl.question('', (answer) => {
      rl.close();
      process.stderr.write('\n');
      resolve(answer.trim());
    });
  });
}

// CLI 协议名 → 控制平面协议名
function controlProtocol(preset, providerId) {
  if (providerId === 'deepseek') return 'deepseek';
  if (preset.protocol === 'anthropic') return 'anthropic-messages';
  if (preset.protocol === 'responses') return 'openai-responses';
  return 'openai-completions';
}

function providerModels(preset) {
  const ids = preset.models && preset.models.length ? preset.models : (preset.model ? [preset.model] : []);
  if (!ids.length) throw new Error('该供应商没有可用模型列表，请用 --model 指定，或在 models.json 中配置 models。');
  return ids.map((id) => ({ id, name: id, tools: true, contextWindow: Number(preset.contextWindow) || 128000 }));
}

async function loginCommand(args) {
  const providerId = args[0] && !args[0].startsWith('--') ? args[0] : '';
  if (!providerId) throw new Error('用法：ggb login <providerId> [--api-key KEY] [--passphrase 口令] [--model ID] [--base-url URL]');
  const { name: canonical, preset } = presetFor(providerId);

  // 1) 取密钥：参数 → 环境变量 → 交互输入
  let apiKey = valueAfter(args, '--api-key', '');
  if (!apiKey) apiKey = pickKey(preset, '');
  if (!apiKey || apiKey === 'local') {
    apiKey = await askSecret(`${preset.label} API Key（输入不回显）› `);
  }
  if (!apiKey) throw new Error('未提供 API Key。');

  // 2) 凭据库状态
  let manage;
  try {
    manage = await workbenchFetch(args, 'manage');
  } catch (error) {
    throw new Error(`无法连接工作台（${workbenchBase(args)}）：${error.message}\n请先运行 npm start，或改用环境变量 ${(preset.keys || []).join('/') || 'API Key'}。`);
  }
  const vault = manage.vault || {};
  let passphrase = valueAfter(args, '--passphrase', process.env.GGB_VAULT_PASSWORD || '');
  if (!passphrase) {
    passphrase = await askSecret(vault.initialized ? '凭据库口令（输入不回显）› ' : '设置凭据库口令（至少 6 位，输入不回显）› ');
    if (!vault.initialized) {
      const confirm = await askSecret('再输入一次确认 › ');
      if (confirm !== passphrase) throw new Error('两次输入的口令不一致。');
    }
  }
  if (!passphrase) throw new Error('需要凭据库口令。');
  if (vault.initialized) await workbenchFetch(args, 'vault/unlock', { method: 'POST', body: { passphrase } });
  else await workbenchFetch(args, 'vault/initialize', { method: 'POST', body: { passphrase } });

  // 4) 先找现有供应商，尽量复用同一个凭据，避免重复登录产生多份密钥。
  const baseUrl = valueAfter(args, '--base-url', preset.baseUrl);
  const existing = await workbenchFetch(args, 'providers');
  const match = (existing || []).find((item) => item.name === preset.label || item.baseUrl === baseUrl);

  // 3) 写入加密凭据（已有则原地更新）
  const credential = match?.credentialId
    ? await workbenchFetch(args, `credentials/${match.credentialId}`, {
        method: 'PUT',
        body: { name: `${preset.label} API Key`, value: apiKey, kind: 'api-key' },
      })
    : await workbenchFetch(args, 'credentials', {
        method: 'POST',
        body: { name: `${preset.label} API Key`, value: apiKey, kind: 'api-key' },
      });

  // 5) 建或更新供应商
  const modelOverride = valueAfter(args, '--model', '');
  const models = providerModels(preset);
  const payload = {
    name: preset.label,
    protocol: controlProtocol(preset, canonical),
    baseUrl,
    credentialId: credential.id,
    models: modelOverride ? [{ id: modelOverride, name: modelOverride, tools: true, contextWindow: Number(preset.contextWindow) || 128000 }] : models,
    enabled: true,
    priority: 100,
  };
  const saved = match
    ? await workbenchFetch(args, `providers/${match.id}`, { method: 'PUT', body: payload })
    : await workbenchFetch(args, 'providers', { method: 'POST', body: payload });

  if (has(args, '--json')) return console.log(JSON.stringify({ credential, provider: saved }, null, 2));
  console.log(`已登录 ${preset.label}：密钥写入加密凭据库，供应商「${saved.name}」已启用。`);
  console.log(`模型：${saved.models.map((model) => model.id).join(', ')}`);
  console.log(`团队任务即可使用该供应商；CLI 可直接 ggb run --provider ${canonical} "…"`);
  return;
}

async function logoutCommand(args) {
  const providerId = args[0] && !args[0].startsWith('--') ? args[0] : '';
  if (!providerId) throw new Error('用法：ggb logout <providerId>');
  const { preset } = presetFor(providerId);
  const providers = await workbenchFetch(args, 'providers');
  const matches = (providers || []).filter((item) => item.name === preset.label || item.baseUrl === preset.baseUrl);
  if (!matches.length) return console.log(`没有找到已登录的「${preset.label}」。`);
  for (const provider of matches) {
    if (provider.credentialId) {
      await workbenchFetch(args, `credentials/${provider.credentialId}`, { method: 'DELETE' }).catch(() => {});
    }
    await workbenchFetch(args, `providers/${provider.id}`, { method: 'DELETE' }).catch(() => {});
  }
  // 清理同名残留凭据（历史重复登录可能留下多份）。
  const leftover = (await workbenchFetch(args, 'credentials').catch(() => []) || [])
    .filter((entry) => entry.name === `${preset.label} API Key`);
  for (const entry of leftover)
    await workbenchFetch(args, `credentials/${entry.id}`, { method: 'DELETE' }).catch(() => {});
  console.log(`已移除 ${preset.label} 的凭据与供应商配置（${matches.length} 个供应商，${leftover.length} 份残留凭据）。`);
}

async function modelsCommand(args) {
  const presets = allPresets();
  // 尽力读取工作台的已配置供应商，用于标记“已登录”。
  let serverProviders = [];
  try { serverProviders = await workbenchFetch(args, 'providers'); } catch { serverProviders = []; }
  const loggedIn = (preset) => serverProviders.some((item) =>
    item.name === preset.label || item.baseUrl === preset.baseUrl);
  const rows = Object.entries(presets).map(([id, preset]) => ({
    id,
    label: preset.label,
    protocol: preset.protocol,
    model: preset.model,
    models: preset.models || [],
    contextWindow: Number(preset.contextWindow) || 128000,
    baseUrl: preset.baseUrl,
    configured: Boolean(pickKey(preset, '')) || loggedIn(preset),
    loggedIn: loggedIn(preset),
    custom: Boolean(preset.custom),
    keys: preset.keys || [],
  }));
  if (has(args, '--json')) return console.log(JSON.stringify({ file: modelsFile(), providers: rows }, null, 2));
  console.log(`自定义供应商文件：${modelsFile()}`);
  console.log('（写入 { "providers": { "<id>": { "baseUrl": "...", "api": "openai-completions", "apiKey": "$ENV_NAME", "models": [{ "id": "...", "contextWindow": 128000 }] } } }）\n');
  for (const row of rows) {
    const env = row.keys.length ? row.keys.join('|') : row.custom ? '自定义' : '-';
    console.log(
      `${row.configured ? '✓' : '·'} ${row.id.padEnd(12)} ${row.label.padEnd(16)} ${row.protocol.padEnd(10)}` +
      ` ctx ${(String(Math.round(row.contextWindow / 1000)) + 'k').padEnd(6)} ${env}`,
    );
    if (row.models.length) console.log(`    ${row.models.slice(0, 4).join(', ')}`);
  }
  console.log('\n用法：ggb run --provider <id> --model <model> "..."');
}

async function contextCommand(args) {
  const sub = args[0];
  if (!sub || sub === 'help' || sub === '--help' || sub === '-h') return console.log(teamUsage);
  const teamId = args[1] && !args[1].startsWith('--') ? args[1] : '';
  if (!teamId) throw new Error(`context ${sub} 需要团队 ID。`);
  if (sub === 'list' || sub === 'show') {
    const data = await workbenchFetch(args, `teams/${teamId}/context`);
    const items = data.items || [];
    if (has(args, '--json')) return console.log(JSON.stringify(items, null, 2));
    if (!items.length) return console.log('还没有共享上下文。用 ggb context share 发布一条。');
    for (const item of items) {
      console.log(`[${item.kind}] ${item.key}  ${item.title}  · ${item.teamName}${item.own ? '（本团队）' : ''}  rev${item.revision}`);
      console.log(String(item.content || '').split('\n').slice(0, 6).map(line => `    ${line}`).join('\n'));
    }
    return;
  }
  if (sub === 'share') {
    const key = valueAfter(args, '--key', '');
    const title = valueAfter(args, '--title', '');
    let content = valueAfter(args, '--content', '');
    if (!content) content = await readStdin();
    if (!key || !title || !content) throw new Error('用法：ggb context share <teamId> --key k --title t --content "..."（或通过 stdin 传内容）');
    const kind = valueAfter(args, '--kind', 'note');
    const body = { key, title, content, kind };
    const revision = valueAfter(args, '--revision', '');
    if (revision) body.expectedRevision = Number(revision);
    const saved = await workbenchFetch(args, `teams/${teamId}/context`, { method: 'POST', body });
    if (has(args, '--json')) return console.log(JSON.stringify(saved, null, 2));
    console.log(`已共享：${saved.key}（${saved.title}）rev${saved.revision}`);
    return;
  }
  throw new Error(`未知 context 子命令“${sub}”。\n\n${teamUsage}`);
}

/**
 * 订阅团队 SSE 事件流。返回一个中止函数。
 * 事件：hello / message / task
 */
async function streamTeam(args, teamId, onEvent, { signal } = {}) {
  const base = workbenchBase(args);
  const cookie = fs.existsSync(cookieFile()) ? fs.readFileSync(cookieFile(), 'utf8').trim() : '';
  const request = (authCookie) => fetch(`${base}/api/teams/${teamId}/stream`, {
    headers: { Accept: 'text/event-stream', ...(authCookie ? { Cookie: authCookie } : {}) },
    signal,
  });
  let response = await request(cookie);
  if (response.status === 401) {
    const password = valueAfter(args, '--password', process.env.GGB_PASSWORD || '');
    if (!password) throw new Error('工作台需要登录。请用 --password 或 GGB_PASSWORD 提供密码。');
    const login = await fetch(`${base}/api/auth/login`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password }),
    });
    if (!login.ok) throw new Error(`工作台登录失败（HTTP ${login.status}）。`);
    const sessionCookie = (login.headers.get('set-cookie') || '').split(';')[0];
    fs.mkdirSync(sessionDir(), { recursive: true, mode: 0o700 });
    fs.writeFileSync(cookieFile(), sessionCookie, { mode: 0o600 });
    response = await request(sessionCookie);
  }
  if (!response.ok) throw new Error(`事件流连接失败（HTTP ${response.status}）。`);
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value || new Uint8Array(), { stream: true });
    const blocks = buffer.split(/\r?\n\r?\n/);
    buffer = blocks.pop() || '';
    for (const block of blocks) {
      let type = 'message';
      const data = [];
      for (const line of block.split(/\r?\n/)) {
        if (line.startsWith('event:')) type = line.slice(6).trim();
        else if (line.startsWith('data:')) data.push(line.slice(5).trim());
      }
      if (!data.length) continue;
      try { onEvent(type, JSON.parse(data.join('\n'))); } catch { /* 忽略坏帧 */ }
    }
  }
}

async function teamWatch(args) {
  const id = args[1] && !args[1].startsWith('--') ? args[1] : '';
  if (!id) throw new Error('team watch 需要团队 ID。');
  const controller = new AbortController();
  const stop = () => { controller.abort(); };
  process.once('SIGINT', stop);
  console.log(`订阅团队事件流（Ctrl-C 退出）：${id}`);
  let tasks = 0;
  let messages = 0;
  try {
    await streamTeam(args, id, (type, data) => {
      if (type === 'hello') {
        tasks = data.tasks || 0;
        messages = data.messages || 0;
        console.log(`已连接：${data.name}  阶段 ${data.phase || '-'}  消息 ${messages}  任务 ${tasks}`);
        return;
      }
      if (type === 'message') {
        messages += 1;
        const who = data.senderType === 'owner' ? '你' : data.senderType === 'system' ? '系统' : data.senderType === 'team' ? `团队(${data.fromTeamId || data.senderId || ''})` : 'PM';
        console.log(`\n[${fmtTime(data.createdAt)}] ${who}: ${String(data.content || '').slice(0, 500)}`);
      }
      if (type === 'task') {
        const risk = data.impactRisk && data.impactRisk !== 'unknown'
          ? ` 影响:${data.impactRisk}${data.impactAcknowledged ? '(已确认)' : ''}`
          : '';
        const verify = data.verificationStatus ? ` 验证:${data.verificationStatus}` : '';
        const title = String(data.title || data.id || '').replace(/\s+/g, ' ').slice(0, 60);
        const failedMark = data.status === 'failed' ? `  ✗ ${String(data.error || '任务失败').slice(0, 160)}` : '';
        console.log(`\n[任务] ${title}  ${data.status}  交付:${data.deliveryStatus || '-'}${verify}${risk}${failedMark}`);
        console.log(`       ggb task ${data.id}`);
      }
    }, { signal: controller.signal });
  } catch (error) {
    if (!/abort/i.test(String(error?.name || ''))) throw error;
  } finally {
    process.removeListener('SIGINT', stop);
    console.log('\n已断开事件流。');
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
  return { provider: input.providerName, model: input.model, providerChanged: previous !== input.providerName };
}

/** JSONL 机器协议：stdin 每行一个消息，stdout 每行一个事件。支持 prompt/follow_up/set_model/abort/session/ping。 */
async function rpc(args) {
  if (process.stdout.isTTY)
    console.error(`${CLI_NAME} rpc：等待 stdin JSONL 输入。`);
  const input = parseInput(args);
  input.rpc = true;
  input.stream = true;
  input.json = false;
  prepareSession(input);
  if (!input.apiKey)
    throw new Error(`未找到 ${input.preset.label} 密钥，请设置 ${(input.preset.keys || []).join(' 或 ') || '自定义供应商的 apiKey'}`);
  rpcWrite({ type: 'session_start', sessionId: input.sessionId, provider: input.providerName, model: input.model });

  const queue = [];
  let active = null;
  let draining = false;
  let closed = false;
  let resolveDone;
  const done = new Promise((resolve) => { resolveDone = resolve; });

  const processMessage = async (message) => {
    const type = String(message?.type || '').trim();
    if (type === 'ping') {
      rpcWrite({ type: 'ready', sessionId: input.sessionId, provider: input.providerName, model: input.model });
      return;
    }
    if (type === 'set_model') {
      try {
        const changed = rpcModel(input, message.provider || message.name, message.model);
        appendSession(input.sessionFile, { type: 'model_change', sessionId: input.sessionId, at: new Date().toISOString(), provider: input.providerName, model: input.model });
        rpcWrite({ type: 'model_changed', sessionId: input.sessionId, ...changed });
      } catch (error) {
        rpcWrite({ type: 'error', sessionId: input.sessionId, code: 'MODEL_INVALID', message: error.message });
      }
      return;
    }
    if (type === 'session') {
      rpcWrite({ type: 'session', sessionId: input.sessionId, file: input.sessionFile, provider: input.providerName, model: input.model });
      return;
    }
    if (type === 'abort') {
      if (active) active.controller.abort();
      else rpcWrite({ type: 'aborted', sessionId: input.sessionId, id: message.id || null, reason: '当前没有执行中的轮次。' });
      return;
    }
    if (!['prompt', 'follow_up'].includes(type)) {
      rpcWrite({ type: 'error', sessionId: input.sessionId, code: 'INVALID_MESSAGE', message: '消息类型必须是 prompt、follow_up、set_model、abort、session 或 ping。' });
      return;
    }
    const prompt = String(message.text ?? message.prompt ?? '').trim();
    if (!prompt || prompt.length > 32000) {
      rpcWrite({ type: 'error', sessionId: input.sessionId, code: 'INVALID_PROMPT', message: 'prompt 不能为空且不能超过 32000 字符。', id: message.id || null });
      return;
    }
    const id = String(message.id || randomUUID());
    const controller = new AbortController();
    active = { id, controller };
    input.abortSignal = controller.signal;
    input.emitText = (text) => rpcWrite({ type: 'text_delta', sessionId: input.sessionId, id, text: redactSession(text, input) });
    rpcWrite({ type: 'turn_start', sessionId: input.sessionId, id, kind: type, provider: input.providerName, model: input.model });
    appendSession(input.sessionFile, { type: 'prompt', sessionId: input.sessionId, at: new Date().toISOString(), text: redactSession(prompt, input) });
    try {
      const turn = await run(input, prompt, input.history);
      appendSession(input.sessionFile, { type: 'response', sessionId: input.sessionId, at: new Date().toISOString(), text: redactSession(turn.text, input) });
      input.history = historyFromSession(parseSession(input.sessionFile).entries);
      rpcWrite({ type: 'turn_end', sessionId: input.sessionId, id, provider: input.providerName, model: input.model, text: redactSession(turn.text, input) });
    } catch (error) {
      const aborted = controller.signal.aborted || error?.name === 'AbortError';
      if (aborted)
        rpcWrite({ type: 'aborted', sessionId: input.sessionId, id, reason: '轮次已中止。' });
      else {
        appendSession(input.sessionFile, { type: 'error', sessionId: input.sessionId, at: new Date().toISOString(), message: redactSession(error.message, input) });
        rpcWrite({ type: 'error', sessionId: input.sessionId, id, code: 'TURN_FAILED', message: redactSession(error.message, input) });
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
  const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
  rl.on('line', (line) => {
    if (!line.trim()) return;
    let message;
    try { message = JSON.parse(line); } catch {
      rpcWrite({ type: 'error', sessionId: input.sessionId, code: 'INVALID_JSON', message: '每行必须是有效 JSON。' });
      return;
    }
    if (message?.type === 'abort' && active) { active.controller.abort(); return; }
    queue.push(message);
    void drain();
  });
  rl.on('close', () => { closed = true; if (!draining && !queue.length) resolveDone(); });
  await done;
}

/** 订阅任务/团队事件流。任务流用工作台的 task 事件；团队流复用 team stream 端点。 */
async function events(args) {
  const teamId = valueAfter(args, '--team', '');
  const taskId = args.find((value, index) => index === 0 && !value.startsWith('--')) || '';
  if ((!taskId || taskId.startsWith('--')) && !teamId)
    throw new Error('请提供任务 ID，或使用 --team 指定团队 ID，例如：ggb events <task-id>。');
  const controller = new AbortController();
  const onSigint = () => controller.abort();
  process.once('SIGINT', onSigint);
  const once = has(args, '--once');
  const print = (item) => {
    if (has(args, '--json')) process.stdout.write(`${JSON.stringify(item)}\n`);
    else process.stdout.write(`[${item.at || item.createdAt || '-'}] ${item.type || 'event'} ${item.status || ''} ${String(item.title || item.content || '').slice(0, 120)}\n`);
  };
  try {
    if (teamId) {
      // 团队流：复用 hello/message/task 事件。
      await streamTeam(args, teamId, (type, data) => {
        if (type === 'hello') {
          if (once) controller.abort();
          return;
        }
        print({ ...data, type: type === 'task' ? 'task' : 'message', at: data.createdAt || data.updatedAt });
      }, { signal: controller.signal });
      return;
    }
    // 任务流：轮询任务详情的增量（工作台任务详情已含事件、验证与影响）。
    let last = null;
    for (;;) {
      if (controller.signal.aborted) break;
      const task = await workbenchFetch(args, `tasks/${taskId}`);
      const signature = `${task.status}:${task.updatedAt}`;
      if (signature !== last) {
        last = signature;
        print({ ...task, type: 'task', at: task.updatedAt });
        for (const event of (task.events || []).slice(-5))
          print({ ...event, type: event.type || 'event' });
        if (once) break;
      }
      await new Promise((resolve) => setTimeout(resolve, 2000));
    }
  } catch (error) {
    if (error?.name !== 'AbortError') throw error;
  } finally {
    process.removeListener('SIGINT', onSigint);
  }
}

function runNode(args) {
  if (has(args, '--help') || has(args, '-h')) {
    console.log([
      '用法：ggb node --control-url https://workbench.example.com --workspace 名称=/绝对路径',
      '  --config <path>        节点配置文件（JSON）',
      '  --pair <code>          配对码',
      '  --name <名称>          节点名称',
      '  --data-dir <path>      数据目录',
      '  --print-config         打印解析后的配置',
    ].join('\n'));
    return Promise.resolve();
  }
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [fileURLToPath(new URL('./node.mjs', import.meta.url)), ...args], {
      stdio: 'inherit', windowsHide: false,
    });
    const forward = (signal) => { if (!child.killed) child.kill(signal); };
    const onSigint = () => forward('SIGINT');
    const onSigterm = () => forward('SIGTERM');
    process.once('SIGINT', onSigint);
    process.once('SIGTERM', onSigterm);
    child.once('error', (error) => { process.removeListener('SIGINT', onSigint); reject(error); });
    child.once('close', (code, signal) => {
      process.removeListener('SIGINT', onSigint);
      process.removeListener('SIGTERM', onSigterm);
      process.exitCode = code ?? (signal ? 1 : 0);
      resolve();
    });
  });
}

async function skillCommand(args) {
  const sub = args[0];
  if (!sub || sub === 'help' || sub === '--help' || sub === '-h') return console.log(teamUsage);
  if (sub === 'recommend') {
    const query = args.slice(1).filter(value => !value.startsWith('--') && value !== valueAfter(args, '--limit', '__none__')).join(' ');
    if (!query) throw new Error('用法：ggb skill recommend "任务描述"');
    const limit = Number(valueAfter(args, '--limit', '8')) || 8;
    const data = await workbenchFetch(args, `capabilities/recommend?q=${encodeURIComponent(query)}&limit=${limit}`);
    const items = data.items || [];
    if (has(args, '--json')) return console.log(JSON.stringify(items, null, 2));
    if (!items.length) return console.log('没有匹配的 Skill。换个说法再试。');
    for (const item of items) {
      const badge = item.source === 'builtin' ? '内置' : item.source === 'installed' ? '已装' : 'Hub ';
      console.log(`${badge}  ${String(item.id).padEnd(28)} ${item.title || ''}  ${Number(item.score || 0).toFixed(2)}`);
      if (item.reason) console.log(`      ${item.reason}`);
      if (item.source === 'hub' && item.installUrl) console.log(`      安装：ggb skill install ${item.id}`);
      if (item.source === 'installed') console.log(`      绑定：capabilityId=${item.capabilityId || item.id}${item.enabled === false ? '（未启用）' : ''}`);
      if (item.source === 'builtin') console.log('      绑定：写入成员 skillIds');
    }
    return;
  }
  if (sub === 'install') {
    const target = args[1] && !args[1].startsWith('--') ? args[1] : '';
    if (!target) throw new Error('用法：ggb skill install <技能ID|安装地址>');
    let sourceUrl = target;
    if (!/^https?:\/\//.test(target)) {
      // 用技能 ID 从自维护库解析安装地址。
      const data = await workbenchFetch(args, `capabilities/search?source=hub&q=${encodeURIComponent(target)}`);
      const items = (data.items || data || []).filter(item => item.id === target);
      if (!items.length) throw new Error(`自维护 Hub 中找不到技能「${target}」。`);
      sourceUrl = items[0].installUrl || items[0].sourceUrl;
    }
    const installed = await workbenchFetch(args, 'capabilities/install', { method: 'POST', body: { source: 'git', sourceUrl } });
    if (has(args, '--json')) return console.log(JSON.stringify(installed, null, 2));
    console.log(`已安装：${installed.name} (${installed.id})，默认未启用。`);
    console.log(`启用：ggb skill enable ${installed.name}`);
    return;
  }
  if (sub === 'list') {
    const items = await workbenchFetch(args, 'capabilities');
    if (has(args, '--json')) return console.log(JSON.stringify(items, null, 2));
    if (!items.length) return console.log('还没有安装任何能力。用 ggb skill recommend 找找。');
    for (const item of items)
      console.log(`${item.enabled === false ? '停用' : '启用'}  ${String(item.kind).padEnd(7)} ${String(item.name).padEnd(24)} ${item.id}`);
    return;
  }
  if (sub === 'enable' || sub === 'disable') {
    const id = args[1] && !args[1].startsWith('--') ? args[1] : '';
    if (!id) throw new Error(`用法：ggb skill ${sub} <能力ID或名称>`);
    const items = await workbenchFetch(args, 'capabilities');
    const match = (items || []).find(item => item.id === id || item.name === id)
      || (items || []).find(item => Array.isArray(item.skills) && item.skills.some(skill => skill.name === id))
      || (items || []).find(item => item.name === id || item.name.includes(id));
    if (!match) throw new Error(`找不到能力「${id}」。用 ggb skill list 查看已安装项。`);
    const confirmed = has(args, '--yes');
    const saved = await workbenchFetch(args, `capabilities/${match.id}/${sub}`, {
      method: 'POST',
      body: { confirmed, ...(sub === 'enable' ? {} : {}) },
    });
    if (has(args, '--json')) return console.log(JSON.stringify(saved, null, 2));
    console.log(`已${sub === 'enable' ? '启用' : '停用'}：${saved.name} (${saved.id})`);
    return;
  }
  throw new Error(`未知 skill 子命令“${sub}”。\n\n${teamUsage}`);
}

async function teamStatus(args) {
  const rest = args.slice(1);
  const id = rest[0] && !rest[0].startsWith('--') ? rest[0] : '';
  if (!id) throw new Error('team status 需要团队 ID。');
  // --open 只看未完成的任务；--failed 只看失败；--limit N 控制条数。
  const filter = has(args, '--open') ? 'open' : has(args, '--failed') ? 'failed' : '';
  const limit = Number(valueAfter(args, '--limit', '10')) || 10;
  const team = await workbenchFetch(args, `teams/${id}`);
  if (has(args, '--json')) return console.log(JSON.stringify(team, null, 2));
  const tasks = team.tasks || [];
  const visible = filter === 'open'
    ? tasks.filter((task) => !['completed', 'failed', 'cancelled'].includes(task.status))
    : filter === 'failed'
      ? tasks.filter((task) => task.status === 'failed' || (task.deliveryStatus || '').includes('fail'))
      : tasks;
  renderTeamStatus(team, visible.slice(0, limit), { filtered: Boolean(filter), total: tasks.length });
}

async function teamReviews(args) {
  const id = args[1] && !args[1].startsWith('--') ? args[1] : '';
  if (!id) throw new Error('team reviews 需要团队 ID。');
  const data = await workbenchFetch(args, `operations?teamId=${encodeURIComponent(id)}&limit=100`);
  const items = (data.items || []).filter(op => op.review?.required);
  if (has(args, '--json')) return console.log(JSON.stringify(items, null, 2));
  if (!items.length) return console.log('当前没有需要评审的高风险操作。');
  for (const op of items) {
    const stages = (op.review.stages || []).map(slot => `${slot.stage}:${slot.record ? slot.record.decision : '待'}`).join(' → ');
    const pending = (op.review.stages || []).find(slot => !slot.record);
    console.log(`${op.id}  [${op.status}]  ${op.title || op.action}\n    ${stages}  可执行:${op.review.canExecute ? '是' : '否'}${op.review.rejected ? '  已被拒绝' : ''}${pending && !op.review.rejected ? `  等待:${pending.stage === 'owner' ? '你本人确认' : pending.stage}` : ''}`);
  }
  console.log('\n用 ggb team review --approve|--reject <operationId> 提交你本人的评审。');
}

async function teamReview(args) {
  const approve = has(args, '--approve');
  const reject = has(args, '--reject');
  // 操作 ID：--op 优先，否则取第一个非标志且非 --reason 值的参数。
  const reasonValue = valueAfter(args, '--reason', null);
  const positional = args.slice(1).filter(value => !value.startsWith('--') && value !== reasonValue && value !== 'review');
  const operationId = valueAfter(args, '--op', '') || positional[0] || '';
  if (!operationId || (!approve && !reject)) throw new Error('用法：ggb team review --approve|--reject <operationId> [--reason 说明]');
  const decision = approve ? 'approve' : 'reject';
  const rationale = reasonValue || '';
  const result = await workbenchFetch(args, `operations/${operationId}/review`, { method: 'POST', body: { decision, rationale } });
  if (has(args, '--json')) return console.log(JSON.stringify(result, null, 2));
  const state = result.review || {};
  const stages = (state.stages || []).map(slot => `${slot.stage}:${slot.record ? slot.record.decision : '待'}`).join(' → ');
  console.log(`已记录评审：${decision === 'approve' ? '通过' : '拒绝'}。`);
  if (stages) console.log(`进度：${stages}`);
  console.log(`当前可执行：${state.canExecute ? '是' : '否'}${state.rejected ? '（已被拒绝，操作终止）' : ''}${!state.canExecute && !state.rejected ? '（还需后续评审轮）' : ''}`);
}

async function teamRun(args) {
  const rest = args.slice(1);
  const id = rest[0] && !rest[0].startsWith('--') ? rest[0] : '';
  const prompt = rest.slice(1).filter(value => !value.startsWith('--') && value !== valueAfter(args, '--interval', '__none__')).join(' ').trim() || (await readStdin());
  if (!id) throw new Error('team run 需要团队 ID。');
  if (!prompt) throw new Error('请提供要达成的目标（参数或 stdin）。');
  const result = await workbenchFetch(args, `teams/${id}/messages`, { method: 'POST', body: { clientMessageId: `cli-${randomUUID()}`, content: prompt } });
  console.log(`已把目标交给团队项目经理（消息 ${result.id || ''}，会话 ${result.sessionId || ''}）。`);
  if (!has(args, '--watch')) {
    console.log(`查看进展：ggb team status ${id}`);
    return;
  }
  console.log('订阅事件流（Ctrl-C 退出）…');
  const controller = new AbortController();
  const stop = () => controller.abort();
  process.once('SIGINT', stop);
  let handled = 0;
  try {
    await streamTeam(args, id, (type, data) => {
      if (type === 'hello') return;
      if (type === 'message') {
        if (data.senderType === 'owner') return;
        handled += 1;
        const who = data.senderType === 'system' ? '[系统]' : data.senderType === 'team' ? '[协作]' : '[PM]';
        console.log(`${who} ${String(data.content || '').slice(0, 500)}`);
      }
      if (type === 'task') {
        const verify = data.verificationStatus ? ` 验证:${data.verificationStatus}` : '';
        // 没有 Git 基准时影响为 unknown，属于正常情况，不展示以免噪音。
        const risk = data.impactRisk && data.impactRisk !== 'unknown'
          ? ` 影响:${data.impactRisk}${data.impactAcknowledged ? '(已确认)' : ''}`
          : '';
        const title = String(data.title || data.id || '').replace(/\s+/g, ' ').slice(0, 60);
        const failedMark = data.status === 'failed' ? `  ✗ ${String(data.error || '任务失败').slice(0, 160)}` : '';
        console.log(`[任务] ${title}  ${data.status}  交付:${data.deliveryStatus || '-'}${verify}${risk}${failedMark}`);
        console.log(`       ggb task ${data.id}`);
      }
    }, { signal: controller.signal });
  } catch (error) {
    if (!/abort/i.test(String(error?.name || ''))) throw error;
  } finally {
    process.removeListener('SIGINT', stop);
    console.log(`\n已断开事件流（处理 ${handled} 条新消息）。`);
  }
}

async function team(args) {
  const sub = args[0];
  if (!sub || sub === 'help' || sub === '--help' || sub === '-h') return console.log(teamUsage);
  if (sub === 'list') return teamList(args);
  if (sub === 'create') return teamCreate(args);
  if (sub === 'run') return teamRun(args);
  if (sub === 'status') return teamStatus(args);
  if (sub === 'reviews') return teamReviews(args);
  if (sub === 'watch') return teamWatch(args);
  if (sub === 'review') return teamReview(args);
  throw new Error(`未知 team 子命令“${sub}”。\n\n${teamUsage}`);
}

// ---- 自定义供应商（参考 pi 的 models.json 叠加方式） ----
// 位置：$GGB_MODELS_FILE 或 ~/.ggb/models.json
// 形状：{ providers: { id: { baseUrl, api, apiKey, models: [{ id, name, contextWindow }] } } }
// api: openai-completions | openai-responses | anthropic-messages | deepseek
const PROTOCOL_MAP = {
  'openai-completions': 'chat',
  'openai-responses': 'responses',
  'anthropic-messages': 'anthropic',
  deepseek: 'chat',
  chat: 'chat',
  responses: 'responses',
  anthropic: 'anthropic',
};
function modelsFile() {
  return process.env.GGB_MODELS_FILE || path.join(os.homedir(), '.ggb', 'models.json');
}
function loadCustomProviders() {
  const file = modelsFile();
  let raw;
  try { raw = fs.readFileSync(file, 'utf8'); } catch { return {}; }
  let data;
  try { data = JSON.parse(raw); } catch (error) { throw new Error(`${file} 不是有效 JSON：${error.message}`); }
  const providers = data?.providers;
  if (!providers || typeof providers !== 'object' || Array.isArray(providers)) return {};
  const merged = {};
  for (const [id, entry] of Object.entries(providers)) {
    if (!/^[a-z0-9][a-z0-9-]{0,40}$/.test(id)) throw new Error(`供应商 ID 无效：${id}`);
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) throw new Error(`供应商 ${id} 配置无效。`);
    if (typeof entry.baseUrl !== 'string' || !/^https?:\/\//.test(entry.baseUrl)) throw new Error(`供应商 ${id} 需要合法 baseUrl。`);
    const protocol = PROTOCOL_MAP[entry.api || 'openai-completions'];
    if (!protocol) throw new Error(`供应商 ${id} 的 api 不受支持：${entry.api}`);
    const models = (Array.isArray(entry.models) ? entry.models : []).map((model) =>
      typeof model === 'string' ? { id: model } : model).filter((model) => model && typeof model.id === 'string');
    merged[id] = {
      label: typeof entry.label === 'string' && entry.label.trim() ? entry.label.trim() : id,
      protocol,
      baseUrl: entry.baseUrl.replace(/\/$/, ''),
      model: models[0]?.id || entry.model || '',
      models: models.map((model) => model.id),
      contextWindow: Number(models[0]?.contextWindow) || Number(entry.contextWindow) || 128000,
      keys: [],
      apiKey: typeof entry.apiKey === 'string' ? entry.apiKey : '',
      keyOptional: entry.apiKey === '' || entry.keyOptional === true,
      custom: true,
      file,
    };
  }
  return merged;
}
function allPresets() {
  return { ...PRESETS, ...loadCustomProviders() };
}
function presetFor(name) {
  const requested = String(name || '').trim().toLowerCase();
  const canonical = PROVIDER_ALIASES[requested] || requested;
  const presets = allPresets();
  const preset = presets[canonical];
  if (!preset) throw new Error(`未知供应商“${name}”，可选：${Object.keys(presets).join('、')}（gpt 为 Codex 别名）。自定义供应商写入 ${modelsFile()}`);
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

function expandSecret(value) {
  if (typeof value !== 'string') return '';
  // 与 pi 一致：支持 $NAME / ${NAME} 环境变量插值，密钥不落盘。
  return value.replace(/\$\{([A-Z_][A-Z0-9_]*)\}|\$([A-Z_][A-Z0-9_]*)/g, (_, a, b) => process.env[a || b] || '');
}
function pickKey(preset, explicit) {
  if (explicit) return explicit;
  if (preset.apiKey) {
    const expanded = expandSecret(preset.apiKey);
    if (expanded) return expanded;
  }
  for (const name of preset.keys || []) if (process.env[name]) return process.env[name];
  if (preset.keyOptional) return 'local';
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

function jsonFlag(args, flag) {
  const raw = valueAfter(args, flag, '');
  if (!raw) throw new Error(`缺少 ${flag} 参数。`);
  try { return JSON.parse(raw); } catch { throw new Error(`${flag} 必须是有效 JSON。`); }
}

async function decide(args) {
  const baseUrl = safeBaseUrl(valueAfter(args, '--base-url', process.env.TYPESAFE_BASE_URL || 'https://api.typesafe.ai/v1'));
  if (!baseUrl) throw new Error('TypeSafe 接口地址无效。');
  const apiKey = valueAfter(args, '--api-key', process.env.TYPESAFE_API_KEY || '');
  if (!apiKey) throw new Error('未找到 TypeSafe 密钥，请设置 TYPESAFE_API_KEY 或使用 --api-key。');
  const model = valueAfter(args, '--model', process.env.TYPESAFE_MODEL || 'jev-latest');
  const body = { state: valueAfter(args, '--state', ''), model, questions: jsonFlag(args, '--questions') };
  if (!body.state) throw new Error('缺少 --state 参数。');
  try { body.state = JSON.parse(body.state); } catch { /* TypeSafe accepts a plain text state. */ }
  let response;
  let status;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    response = await fetch(`${baseUrl.replace(/\/$/, '')}${baseUrl.endsWith('/systemone') ? '' : '/systemone'}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(30000),
    });
    status = response.status;
    if (!(status === 429 || status === 529 || status >= 500) || attempt === 2) break;
    await response.body?.cancel();
    await new Promise(resolve => setTimeout(resolve, 200 * 2 ** attempt));
  }
  if (!response.ok) throw new Error(`TypeSafe 返回 HTTP ${status}。`);
  const data = await response.json();
  process.stdout.write(`${JSON.stringify(data, null, has(args, '--json') ? 0 : 2)}\n`);
  return data;
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
    // OpenAI 兼容接口默认不在流式响应里返回 usage，显式要求。
    ...(input.stream ? { stream_options: { include_usage: true } } : {}),
    messages: [...(input.system ? [{ role: 'system', content: input.system }] : []), ...messages],
  };
}

const dim = (text) => process.stderr.isTTY ? `\u001b[2m${text}\u001b[0m` : text;
/**
 * 持久底部状态栏：利用 ANSI 滚动区域把底部固定行数保留为状态显示。
 * setStatus 更新内容；clearStatus 退出时清除。
 * 仅在 TTY 下激活；非 TTY 时所有方法变为 no-op（保持管道安全）。
 */
const status = {
  active: false,
  content: '',
  init() { this.active = process.stdout.isTTY === true; },
  setContent(text) { this.content = text; },
  clear() { this.active = false; },
};
const fmtTokens = (value) => {
  const n = Number(value) || 0;
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return String(n);
};
/**
 * 终端底部的状态行：模型、用量、上下文占用、耗时。
 * 写到 stderr，保持 stdout 可被管道消费。
 */
function statusLine(input, { usage, elapsedMs, note } = {}) {
  const contextWindow = Number(input.preset.contextWindow) || 128000;
  const parts = [`${input.providerName}/${input.model}`];
  if (usage && (usage.inputTokens || usage.outputTokens)) {
    const percent = contextWindow ? Math.min(100, (usage.inputTokens / contextWindow) * 100) : 0;
    parts.push(`in ${fmtTokens(usage.inputTokens)} / out ${fmtTokens(usage.outputTokens)}`);
    parts.push(`上下文 ${fmtTokens(usage.inputTokens)}/${fmtTokens(contextWindow)} (${percent > 0 && percent < 1 ? '<1' : percent.toFixed(0)}%)`);
  }
  if (Number.isFinite(elapsedMs)) parts.push(`${(elapsedMs / 1000).toFixed(1)}s`);
  if (note) parts.push(note);
  process.stderr.write(dim(`· ${parts.join(' · ')}`) + '\n');
}
function absorbUsage(input, data, state) {
  if (!data || typeof data !== 'object') return;
  const pick = (usage) => {
    if (!usage || typeof usage !== 'object') return;
    const inputTokens = Number(usage.prompt_tokens ?? usage.input_tokens ?? 0) || 0;
    const outputTokens = Number(usage.completion_tokens ?? usage.output_tokens ?? 0) || 0;
    if (inputTokens || outputTokens) state.usage = { inputTokens, outputTokens };
  };
  pick(data.usage);
  pick(data.message?.usage);
  pick(data.response?.usage);
}

function emitEvent(input, event, state) {
  if (!event || event === '[DONE]') return;
  let data;
  try { data = JSON.parse(event); } catch { return; }
  absorbUsage(input, data, state);
  let text = '';
  if (input.preset.protocol === 'anthropic') {
    if (data.type === 'content_block_delta') text = data.delta?.text || '';
  } else if (input.preset.protocol === 'responses') {
    if (data.type === 'response.output_text.delta') text = data.delta || '';
  } else text = data.choices?.[0]?.delta?.content || '';
  // rpc 模式下 stdout 是 JSONL 事件流，原始文本只能通过 text_delta 事件输出。
  if (text) { state.text += text; if (!input.json && !input.rpc) process.stdout.write(text); }
}

async function run(input, prompt, history = []) {
  if (!input.apiKey) throw new Error(`未找到 ${input.preset.label} 密钥，请设置 ${(input.preset.keys || []).join(' 或 ') || '自定义供应商的 apiKey'}`);
  const startedAt = Date.now();
  const timeout = AbortSignal.timeout(180000);
  const response = await fetch(endpoint(input), {
    method: 'POST', headers: headers(input.preset, input.apiKey), body: JSON.stringify(requestBody(input, prompt, history)),
    // rpc 模式可传入 abortSignal，与超时信号合并。
    signal: input.abortSignal ? AbortSignal.any([input.abortSignal, timeout]) : timeout,
  });
  if (!response.ok) {
    const raw = await response.text();
    let detail = raw;
    try { detail = JSON.stringify(JSON.parse(raw)); } catch {}
    throw new Error(`${input.preset.label} 返回 HTTP ${response.status}: ${detail.slice(0, 500)}`);
  }
  const state = { text: '', usage: null };
  const emitDelta = (text) => { if (text && input.emitText) input.emitText(text); };
  if (!input.stream) {
    const raw = await response.text();
    let data; try { data = JSON.parse(raw); } catch { throw new Error('供应商返回了无效 JSON。'); }
    absorbUsage(input, data, state);
    if (input.preset.protocol === 'anthropic') state.text = (data.content || []).filter(x => x.type === 'text').map(x => x.text).join('');
    else if (input.preset.protocol === 'responses') state.text = data.output_text || (data.output || []).flatMap(x => x.content || []).filter(x => x.type === 'output_text').map(x => x.text).join('');
    else state.text = data.choices?.[0]?.message?.content || '';
    emitDelta(state.text);
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
        const before = state.text;
        emitEvent(input, event, state);
        emitDelta(state.text.slice(before.length));
      }
      if (done) break;
    }
    if (buffer.trim()) {
      const event = buffer.split(/\r?\n/).filter(line => line.startsWith('data:')).map(line => line.slice(5).trim()).join('');
      const before = state.text;
      emitEvent(input, event, state);
      emitDelta(state.text.slice(before.length));
    }
  }
  const elapsedMs = Date.now() - startedAt;
  if (input.json) process.stdout.write(`${JSON.stringify({
    type: 'turn_end', sessionId: input.sessionId, provider: input.providerName, model: input.model,
    text: redactSession(state.text, input),
    ...(state.usage ? { usage: state.usage, contextWindow: Number(input.preset.contextWindow) || 128000 } : {}),
    elapsedMs,
  })}\n`);
  else if (input.stream) { if (!input.rpc) process.stdout.write('\n'); }
  else process.stdout.write(`${state.text}\n`);
  if (!input.json && !input.rpc) statusLine(input, { usage: state.usage, elapsedMs });
  return { text: state.text, usage: state.usage, elapsedMs };
}

// 工作台首页：团队列表 + 模型状态 + 编号选择。派活是主路径，裸模型对话是次级选项。
// ---- 斜杠菜单：输入 / 时在提示行上方实时显示过滤后的命令与 Skill ----
// 对标 Claude Code / Cursor：内置命令 + 已装/可装 Skill 混排，Tab 补全，回车执行。
const slashMenu = { count: 0, cache: null, cacheUntil: 0 };
const BUILTIN_SKILL_COMMANDS = () => SKILLS.map(skill => {
  const file = path.join(fileURLToPath(new URL('../roles', import.meta.url)), skill.role, 'skills', skill.id, 'SKILL.md');
  let description = skill.name;
  try {
    const text = fs.readFileSync(file, 'utf8');
    const front = text.match(/^---\r?\n([\s\S]*?)\r?\n---/);
    if (front) {
      const m = front[1].match(/^description:\s*([\s\S]*?)(?:\n[a-z-]+:|\s*$)/m);
      if (m) description = m[1].replace(/\s+/g, ' ').trim();
    }
  } catch {}
  return { id: skill.id, title: skill.name, description, source: 'builtin' };
});
let slashCatalogInFlight = null;
async function slashCatalog(args) {
  if (slashMenu.cache && slashMenu.cacheUntil > Date.now()) return slashMenu.cache;
  // 多处调用共享同一次拉取，避免重复网络请求。
  if (slashCatalogInFlight) return slashCatalogInFlight;
  slashCatalogInFlight = (async () => {
    let catalog = [];
    try {
      const data = await workbenchFetch(args, 'capabilities/hub-catalog');
      catalog = (data.skills || []).map(skill => ({ ...skill, source: 'hub' }));
    } catch {}
    const items = [...BUILTIN_SKILL_COMMANDS(), ...catalog];
    slashMenu.cache = items;
    slashMenu.cacheUntil = Date.now() + 300000;
    return items;
  })();
  try {
    return await slashCatalogInFlight;
  } finally {
    slashCatalogInFlight = null;
  }
}
function slashMatches(line, contextCommands, skills) {
  const text = line.replace(/^\//, '').trim().toLowerCase();
  const all = [
    ...contextCommands,
    ...skills.map(skill => ({ name: `/${skill.id}`, title: skill.title || skill.id, description: skill.description, source: skill.source, categoryLabel: skill.categoryLabel || '' })),
  ];
  if (!text) return all.slice(0, 8);
  const scored = all.filter(item => `${item.name} ${item.title || ''} ${item.description || ''}`.toLowerCase().includes(text));
  return scored.slice(0, 8);
}
function drawSlashMenu(matches, state) {
  const out = process.stdout;
  const width = out.columns || 80;
  const clear = () => {
    if (state.count) out.write(`\x1b[${state.count}A`);
    for (let index = 0; index < state.count; index += 1) out.write('\x1b[2K\x1b[1B');
    out.write(`\x1b[${state.count}A`);
    state.count = 0;
  };
  if (!matches.length) return clear();
  const lines = matches.map(item => {
    const source = item.source === 'builtin' ? '内置' : item.source === 'installed' ? '已装' : item.source === 'command' ? '' : 'Hub';
    const label = `${item.name}  ${item.title || ''}${source ? `  [${source}]` : ''}`;
    const desc = item.description ? ` — ${String(item.description).slice(0, 40)}` : '';
    return `  \x1b[2m${(label + desc).slice(0, width - 2)}\x1b[0m`;
  });
  clear();
  out.write(lines.join('\n') + '\n');
  // 光标回到提示行
  out.write(`\x1b[${lines.length}A`);
  state.count = lines.length;
}
function attachSlashMenu(rl, getContext) {
  const state = { count: 0 };
  const handler = () => setImmediate(() => {
    try {
      const { line, contextCommands, skills } = getContext();
      if (line.startsWith('/')) {
        slashMatches(line, contextCommands, skills).then(matches => drawSlashMenu(matches, state));
      } else drawSlashMenu([], state);
    } catch {}
  });
  process.stdin.on('keypress', handler);
  rl.on('close', () => process.stdin.removeListener('keypress', handler));
}

async function home(input, args) {
  prepareSession(input);
  const homeCommands = [
    { name: '/help', title: '命令列表', description: '', source: 'command' },
    { name: '/login', title: '登录模型供应商', description: '密钥入加密凭据库', source: 'command' },
    { name: '/logout', title: '移除供应商', description: '', source: 'command' },
    { name: '/models', title: '供应商与模型目录', description: '', source: 'command' },
    { name: '/tasks', title: '查看团队任务', description: '/tasks [序号]', source: 'command' },
    { name: '/new', title: '创建新团队', description: '', source: 'command' },
    { name: '/exit', title: '退出', description: '', source: 'command' },
  ];
  const homeSkills = () => slashCatalog(args);
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    completer: line => {
      if (!line.startsWith('/')) return [[], line];
      const skills = slashMenu.cache || [];
      const hits = slashMatches(line, homeCommands, skills).map(item => item.name);
      return [hits.length ? hits : homeCommands.map(item => item.name), line];
    },
  });
  attachSlashMenu(rl, () => ({
    line: rl.line || '',
    contextCommands: homeCommands,
    skills: slashMenu.cache || [],
  }));
  void homeSkills();
  const homeLineQueue = [];
  let homeNotifyLine = null;
  rl.on('line', line => {
    if (homeNotifyLine) { const resolve = homeNotifyLine; homeNotifyLine = null; resolve(line); }
    else homeLineQueue.push(line);
  });
  const readLine = async label => {
    if (homeLineQueue.length) return homeLineQueue.shift();
    if (rl.closed) return 'q';
    process.stdout.write(label);
    return await new Promise(resolve => { homeNotifyLine = resolve; });
  };
  try {
    for (;;) {
      // 拉取状态（失败不阻塞首页）
      let teams = [];
      let providers = [];
      let workbenchOk = true;
      try {
        teams = await workbenchFetch(args, 'teams');
        providers = await workbenchFetch(args, 'providers');
      } catch {
        await ensureWorkbench(args).catch(() => {});
        try {
          teams = await workbenchFetch(args, 'teams');
          providers = await workbenchFetch(args, 'providers');
        } catch { workbenchOk = false; }
      }
      const envKey = Boolean(pickKey(input.preset, ''));
      const enabledProvider = (providers || []).find(item => item.enabled !== false && (item.protocol !== 'typesafe-system-one'));
      const modelReady = envKey || Boolean(enabledProvider);
      console.log('');
      console.log(`Goal-Guided Brain · ${workbenchOk ? '工作台运行中' : '工作台未连接'} · 模型${modelReady ? '已配置' : '未配置'}`);
      if (!modelReady) console.log(`  未配置模型：运行 ggb login <供应商>（如 ggb login deepseek），或设置对应环境变量。`);
      console.log('');
      void slashCatalog(args).catch(() => {}); // 后台预热技能目录供斜杠补全
      if (!workbenchOk) {
        console.log('无法连接工作台，仅可使用纯模型对话。');
      } else if (!teams.length) {
        console.log('还没有团队。输入 n 创建第一个团队，或继续用纯模型对话。');
      } else {
        console.log('团队：');
        teams.forEach((team, index) => {
          const phase = team.recruitment?.phase === 'confirmed' ? '就绪' : team.recruitment?.phase || '-';
          const members = team.recruitment?.phase === 'confirmed' ? (team.memberRoleIds || []).length : 1;
          console.log(`  ${index + 1}. ${team.name}  [${phase}]  成员${members}  ${team.status}`);
        });
      }
      console.log('');
      console.log('序号 → 进入派活 · / 命令列表 · c → 纯模型对话 · q → 退出');
      const answer = (await readLine('ggb › ')).trim();
      if (!answer) continue;
      if (answer === 'q' || answer === 'quit' || answer === '/exit' || answer === '/q') break;
      if (answer === 'r' || answer === 'refresh') continue;
      if (answer.startsWith('/') && !['help', 'login', 'logout', 'models', 'tasks', 'new', 'exit', 'q'].includes(answer.slice(1).split(/\s+/)[0])) {
        const skillId = answer.slice(1).split(/\s+/)[0];
        let skills = slashMenu.cache || [];
        if (!skills.length && slashCatalogInFlight) {
          skills = await Promise.race([slashCatalogInFlight.catch(() => []), new Promise(resolve => setTimeout(() => resolve([]), 15000))]);
        }
        const skill = skills.find(item => item.id === skillId);
        if (skill) {
          const skillArgs = answer.slice(1 + skillId.length).trim();
          if (skill.source === 'hub') {
            console.log(`「${skill.title}」尚未安装。安装：ggb skill install ${skill.id}\n`);
            continue;
          }
          if (!teams.length) { console.log('先创建团队（n）再使用技能派活。\n'); continue; }
          console.log(`使用技能「${skill.title}」。输入团队序号：`);
          const pick = (await readLine('ggb › ')).trim();
          const team = teams[Number(pick) - 1];
          if (!team || team.recruitment?.phase !== 'confirmed') { console.log('未选择有效团队。\n'); continue; }
          input.teamId = team.id;
          input.pendingPrompt = `请使用 ${skill.id} 技能（${skill.title}）处理：${skillArgs || '见团队上下文'}`;
          await interactiveChat(input, args);
          continue;
        }
      }
      if (answer.startsWith('/')) {
        const [cmd, ...rest] = answer.slice(1).split(/\s+/).filter(Boolean);
        const arg = rest.join(' ');
        if (cmd === 'help' || answer === '/') {
          console.log([
            '首页命令：',
            '  /help                本列表',
            '  /login <供应商>      登录模型供应商（密钥入加密凭据库）',
            '  /models              供应商与模型目录',
            '  /tasks [序号]        查看团队任务',
            '  /new                 创建新团队',
            '  /exit | /q           退出',
            '输入团队序号进入派活会话；c 进入纯模型对话。',
          ].join('\n') + '\n');
          continue;
        }
        if (cmd === 'login') {
          try { await loginCommand([arg, '--api', workbenchBase(args)].filter(Boolean)); } catch (error) { console.error(`${CLI_NAME}: ${error.message}\n`); }
          continue;
        }
        if (cmd === 'logout') {
          try { await logoutCommand([arg]); } catch (error) { console.error(`${CLI_NAME}: ${error.message}\n`); }
          continue;
        }
        if (cmd === 'models') {
          try { await modelsCommand(args); } catch (error) { console.error(`${CLI_NAME}: ${error.message}\n`); }
          continue;
        }
        if (cmd === 'tasks') {
          const target = teams[Number(arg) - 1];
          const teamId = target?.id || arg;
          if (!teamId) { console.log('用法：/tasks [团队序号]\n'); continue; }
          try {
            const detail = await workbenchFetch(args, `teams/${teamId}`);
            const tasks = (detail.tasks || []).slice(0, 8);
            if (!tasks.length) console.log('该团队还没有任务。\n');
            for (const task of tasks) {
              const title = String(task.title || task.id).replace(/\s+/g, ' ').slice(0, 50);
              console.log(`[${task.status}] ${title}\n    ggb task ${task.id}`);
            }
            console.log('');
          } catch (error) { console.error(`${CLI_NAME}: ${error.message}\n`); }
          continue;
        }
        if (!slashMenu.cache) {
          console.log('技能目录加载中，请重试。可用命令：/help /login /models /tasks /new /exit\n');
        } else {
          console.log([
            `未知命令 /${cmd}。可用：`,
            '  /help  /login <供应商>  /logout <供应商>  /models  /tasks [序号]  /new  /exit',
          ].join('\n') + '\n');
        }
        continue;
      }
      if (answer === 'c' || answer === 'chat') {
        if (!pickKey(input.preset, '') && !(await workbenchFetch(args, 'providers').catch(() => [])).some(item => item.enabled !== false)) {
          console.log(`未配置模型。先运行 ggb login ${input.providerName}，或设置 ${(input.preset.keys || []).join('/') || 'API Key'}。\n`);
          continue;
        }
        await interactiveChat(input, args);
        continue;
      }
      if (answer === 'n' || answer === 'new') {
        const name = (await readLine('团队名称 › ')).trim();
        const goal = (await readLine('团队目标 › ')).trim();
        if (!name || !goal) { console.log('需要名称与目标。\n'); continue; }
        try {
          const saved = await workbenchFetch(args, 'teams', { method: 'POST', body: {
            name, goal, purpose: goal, pmRoleId: 'project_manager', memberRoleIds: ['project_manager'],
            requireReview: false,
            collaboration: { enabled: true, autoHandoff: true, sharedBoard: true, allowedTeamIds: [] },
          } });
          console.log(`已创建「${saved.name}」。\n`);
        } catch (error) { console.error(`${CLI_NAME}: ${error.message}\n`); }
        continue;
      }
      const index = Number(answer);
      if (Number.isInteger(index) && index >= 1 && index <= teams.length) {
        const team = teams[index - 1];
        if (team.recruitment?.phase !== 'confirmed') {
          console.log(`团队「${team.name}」尚未完成招募（${team.recruitment?.phase || '-'}），请先在网页或招募流程中确认。\n`);
          continue;
        }
        input.teamId = team.id;
        console.log(`已进入团队「${team.name}」。直接输入目标即可派活，/exit 返回首页。\n`);
        await interactiveChat(input, args);
        continue;
      }
      console.log(`无法理解「${answer}」。输入序号派活，/ 查看命令，c 纯模型对话，q 退出。`);
    }
  } finally {
    rl.close();
  }
}

async function interactiveChat(input, args = []) {
  // GGB_FORCE_INTERACTIVE 供测试或嵌入式调用绕过 TTY 检查（readline 仍按行驱动）。
  if (!(process.env.GGB_FORCE_INTERACTIVE === '1') &&
      (!process.stdin.isTTY || !process.stdout.isTTY))
    throw new Error(`chat 需要交互式终端；管道输入请使用 ${CLI_NAME} run。`);
  prepareSession(input);
  // 密钥延迟检查：/team、/tasks 等命令不需要模型；真正发模型请求时才要求。
  const requireModelKey = () => {
    if (!input.apiKey)
      throw new Error(`未找到 ${input.preset.label} 密钥，请设置 ${input.preset.keys.join(' 或 ')}，或先运行 ggb login ${input.providerName}`);
  };
  console.log(`${CLI_NAME} · ${input.providerName}/${input.model} · 会话 ${input.sessionId}`);
  // 持久状态栏：模型、Token 用量、上下文占用
  const totalUsage = { inputTokens: 0, outputTokens: 0 };
  const contextWindow = Number(input.preset.contextWindow) || 128000;
  const updateFooter = (turn) => {
    if (turn?.usage) {
      totalUsage.inputTokens += turn.usage.inputTokens || 0;
      totalUsage.outputTokens += turn.usage.outputTokens || 0;
    }
    const parts = [`${input.providerName}/${input.model}`];
    if (totalUsage.inputTokens || totalUsage.outputTokens)
      parts.push(`in ${fmtTokens(totalUsage.inputTokens)} / out ${fmtTokens(totalUsage.outputTokens)}`);
    const pct = contextWindow ? Math.min(100, (totalUsage.inputTokens / contextWindow) * 100) : 0;
    parts.push(`ctx ${fmtTokens(totalUsage.inputTokens)}/${fmtTokens(contextWindow)} (${pct > 0 && pct < 1 ? '<1' : pct.toFixed(0)}%)`);
    if (input.teamId) parts.push(`团队 ${input.teamId.slice(0, 8)}`);
    console.log(dim(`· ${parts.join(' · ')}`));
  };
  updateFooter(null);
  console.log('输入 /help 查看命令，/exit 退出。');
  const chatCommands = [
    { name: '/help', title: '命令列表', description: '', source: 'command' },
    { name: '/new', title: '新建会话', description: '', source: 'command' },
    { name: '/model', title: '切换模型', description: '/model [供应商/]模型', source: 'command' },
    { name: '/session', title: '查看会话', description: '', source: 'command' },
    { name: '/team', title: '绑定团队', description: '/team [id]', source: 'command' },
    { name: '/tasks', title: '查看团队任务', description: '', source: 'command' },
    { name: '/exit', title: '退出', description: '', source: 'command' },
  ];
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    historySize: 1000,
    completer: line => {
      if (!line.startsWith('/')) return [[], line];
      const skills = slashMenu.cache || [];
      const hits = slashMatches(line, chatCommands, skills).map(item => item.name);
      return [hits.length ? hits : chatCommands.map(item => item.name), line];
    },
  });
  attachSlashMenu(rl, () => ({
    line: rl.line || '',
    contextCommands: chatCommands,
    skills: slashMenu.cache || [],
  }));
  void slashCatalog(args).catch(() => {}); // 预热技能目录
  const chatLineQueue = [];
  let chatNotifyLine = null;
  rl.on('line', line => {
    if (chatNotifyLine) { const resolve = chatNotifyLine; chatNotifyLine = null; resolve(line); }
    else chatLineQueue.push(line);
  });
  const ask = async () => {
    // 异步命令处理期间用户敲入的行进入队列，不会丢失。
    if (chatLineQueue.length) return chatLineQueue.shift();
    if (rl.closed) return '/exit';
    process.stdout.write('你 › ');
    return await new Promise(resolve => { chatNotifyLine = resolve; });
  };
  try {
    for (;;) {
      const value = (await ask()).trim();
      if (!value) continue;
      if (value === '/exit' || value === '/quit') { status.clear(); break; }
      if (value === '/help') {
        console.log([
          '/new 新建会话   /model [供应商/]模型 切换模型   /session 查看会话',
          '/team [id]      切换/查看当前团队（后续任务在该团队上下文执行）',
          '/tasks [id]     查看团队最近任务',
          '/exit 退出      /help 帮助',
        ].join('\n') + '\n');
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
        const parsed = parseSession(input.sessionFile);
        const prompts = parsed.entries.filter(entry => entry.type === 'prompt').length;
        const responses = parsed.entries.filter(entry => entry.type === 'response').length;
        const usage = parsed.entries.reduce((sum, entry) => {
          if (!entry.usage) return sum;
          return { input: sum.input + (entry.usage.inputTokens || 0), output: sum.output + (entry.usage.outputTokens || 0) };
        }, { input: 0, output: 0 });
        const contextWindow = Number(input.preset.contextWindow) || 128000;
        const fileBytes = fs.existsSync(input.sessionFile) ? fs.statSync(input.sessionFile).size : 0;
        console.log([
          `会话：${input.sessionId}`,
          `文件：${input.sessionFile} (${(fileBytes / 1024).toFixed(1)} KB)`,
          `模型：${input.providerName}/${input.model}`,
          `轮次：${prompts} 问 / ${responses} 答`,
          ...(usage.input || usage.output ? [`Token：in ${fmtTokens(usage.input)} / out ${fmtTokens(usage.output)}`] : []),
          `上下文窗口：${fmtTokens(contextWindow)}`,
          ...(input.teamId ? [`团队：${input.teamId}`] : []),
        ].join('\n') + '\n');
        continue;
      }
      if (value === '/team' || value.startsWith('/team ')) {
        const tokens = value.slice('/team'.length).trim().split(/\s+/).filter(Boolean);
        try {
          const teams = await workbenchFetch(args, 'teams');
          if (!tokens.length) {
            if (input.teamId) {
              const current = teams.find((team) => team.id === input.teamId);
              console.log(`当前团队：${current?.name || input.teamId}  阶段 ${current?.recruitment?.phase || '-'}\n`);
            } else {
              console.log('未绑定团队。用 /team <teamId> 选择：');
              for (const team of teams) console.log(`  ${team.id}  ${team.name}  [${team.recruitment?.phase || '-'}]`);
              console.log('');
            }
          } else {
            const match = teams.find((team) => team.id === tokens[0] || team.name === tokens[0])
              || teams.find((team) => team.name.includes(tokens[0]));
            if (!match) throw new Error(`找不到团队「${tokens[0]}」。`);
            input.teamId = match.id;
            console.log(`已绑定团队：${match.name} (${match.id})\n后续 prompt 会作为该团队的需求发给项目经理。\n`);
          }
        } catch (error) {
          console.error(`${CLI_NAME}: ${error.message}\n`);
        }
        continue;
      }
      if (value === '/tasks' || value.startsWith('/tasks ')) {
        const tokens = value.slice('/tasks'.length).trim().split(/\s+/).filter(Boolean);
        const teamId = input.teamId || tokens[0];
        if (!teamId) {
          console.log('请先用 /team <teamId> 绑定团队，或 /tasks <teamId>。\n');
          continue;
        }
        try {
          const team = await workbenchFetch(args, `teams/${teamId}`);
          const tasks = (team.tasks || []).slice(0, 8);
          if (!tasks.length) console.log('该团队还没有任务。\n');
          for (const task of tasks) {
            const title = String(task.title || task.id).replace(/\s+/g, ' ').slice(0, 50);
            console.log(`[${task.status}] ${title}\n    ggb task ${task.id}`);
          }
          console.log('');
        } catch (error) {
          console.error(`${CLI_NAME}: ${error.message}\n`);
        }
        continue;
      }
      if (value === '/copy') {
        const lastResponse = [...input.history].reverse().find(turn => turn.response);
        if (!lastResponse) { console.log('还没有可复制的回答。\n'); continue; }
        const { execFileSync: efs } = await import('node:child_process');
        try {
          const copier = process.platform === 'darwin' ? 'pbcopy' : process.platform === 'linux' ? (fs.existsSync('/usr/bin/xclip') ? 'xclip' : 'xsel') : null;
          if (!copier) throw new Error('不支持的平台');
          efs(copier, copier === 'pbcopy' ? [] : ['-selection', 'clipboard'], { input: lastResponse.response, stdio: ['pipe', 'ignore', 'ignore'] });
          console.log(`已复制最后一条回答（${lastResponse.response.length} 字符）。\n`);
        } catch (error) {
          console.log(`复制失败：${error.message}\n`);
        }
        continue;
      }
      if (value === '/compact') {
        if (input.teamId) { console.log('团队会话由工作台管理上下文，无需手动压缩。\n'); continue; }
        if (!input.history.length) { console.log('会话为空，无需压缩。\n'); continue; }
        requireModelKey();
        const keepRecent = 4;
        const older = input.history.slice(0, -keepRecent);
        if (older.length < 2) { console.log(`最近 ${Math.min(keepRecent, input.history.length)} 轮已占会话主体，无需压缩。\n`); continue; }
        console.log(`正在压缩 ${older.length} 轮历史…`);
        try {
          const summaryPrompt = `请将以下对话历史压缩为简洁摘要（保留关键决定、结论和未完成事项，不超过 300 字）：\n\n` +
            older.map(turn => `用户：${turn.prompt}\n助手：${turn.response}`).join('\n\n');
          const summary = await run(input, summaryPrompt, []);
          input.history = [
            { prompt: '[历史摘要]', response: summary.text },
            ...input.history.slice(-keepRecent),
          ];
          appendSession(input.sessionFile, {
            type: 'compact', sessionId: input.sessionId, at: new Date().toISOString(),
            compacted: older.length, summary: redactSession(summary.text, input),
          });
          console.log(`已压缩 ${older.length} 轮为摘要。保留最近 ${keepRecent} 轮。\n`);
        } catch (error) {
          console.error(`${CLI_NAME}: 压缩失败：${error.message}\n`);
        }
        continue;
      }
      if (value === '/resume') {
        const files = sessionDir() && fs.existsSync(sessionDir())
          ? fs.readdirSync(sessionDir()).filter(file => file.endsWith('.jsonl')).sort((a, b) => {
              const sa = fs.statSync(path.join(sessionDir(), a));
              const sb = fs.statSync(path.join(sessionDir(), b));
              return sb.mtimeMs - sa.mtimeMs;
            })
          : [];
        if (!files.length) { console.log('没有历史会话。\n'); continue; }
        console.log('可用会话（最近优先）：');
        files.slice(0, 10).forEach((file, index) => {
          const parsed = parseSession(path.join(sessionDir(), file));
          const prompts = parsed.entries.filter(entry => entry.type === 'prompt').length;
          const firstPrompt = parsed.entries.find(entry => entry.type === 'prompt');
          const preview = firstPrompt ? String(firstPrompt.text || '').slice(0, 40) : file;
          console.log(`  ${index + 1}. ${path.basename(file, '.jsonl').slice(0, 12)}  ${prompts} 轮  ${preview}`);
        });
        const pick = (await new Promise(resolve => rl.question('输入序号继续（回车取消）› ', resolve))).trim();
        const pickIndex = Number(pick);
        if (!Number.isInteger(pickIndex) || pickIndex < 1 || pickIndex > Math.min(10, files.length)) { console.log('已取消。\n'); continue; }
        const chosen = files[pickIndex - 1];
        input.session = path.basename(chosen, '.jsonl');
        input.continueSession = true;
        prepareSession(input);
        console.log(`已切换到会话 ${input.sessionId}（${input.history.length} 轮历史）。\n`);
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
      // /<技能ID> [参数] → 以该技能为上下文发起任务
      if (value.startsWith('/')) {
        const skillId = value.slice(1).split(/\s+/)[0];
        let skills = slashMenu.cache || [];
        if (!skills.length && slashCatalogInFlight) {
          skills = await Promise.race([slashCatalogInFlight.catch(() => []), new Promise(resolve => setTimeout(() => resolve([]), 15000))]);
        }
        const skill = skills.find(item => item.id === skillId);
        if (skill) {
          const skillArgs = value.slice(1 + skillId.length).trim();
          if (skill.source === 'hub') {
            console.log(`「${skill.title}」尚未安装。安装：ggb skill install ${skill.id}\n`);
            continue;
          }
          const promptText = `请使用 ${skill.id} 技能（${skill.title}）处理：${skillArgs || '当前任务'}`;
          if (input.teamId) {
            try {
              await workbenchFetch(args, `teams/${input.teamId}/messages`, {
                method: 'POST',
                body: { clientMessageId: `chat-${randomUUID()}`, content: promptText },
              });
              console.log(`已派给团队（使用技能 ${skill.id}）。/tasks 查看进展。\n`);
            } catch (error) { console.error(`${CLI_NAME}: ${error.message}\n`); }
            continue;
          }
          requireModelKey();
          const turn = await run(input, promptText, input.history);
          appendSession(input.sessionFile, { type: 'response', sessionId: input.sessionId, at: new Date().toISOString(), text: redactSession(turn.text, input) });
          continue;
        }
      }
      const prompt = value;
      appendSession(input.sessionFile, {
        type: 'prompt', sessionId: input.sessionId, at: new Date().toISOString(),
        text: redactSession(prompt, input),
      });
      if (input.teamId) {
        try {
          const result = await workbenchFetch(args, `teams/${input.teamId}/messages`, {
            method: 'POST',
            body: { clientMessageId: `chat-${randomUUID()}`, content: prompt },
          });
          console.log(`已交给团队项目经理（会话 ${result.sessionId || '-'}）。查看进展：/tasks 或 ggb team watch ${input.teamId}\n`);
        } catch (error) {
          console.error(`${CLI_NAME}: ${error.message}\n`);
        }
        continue;
      }
      try {
        requireModelKey();
        const turn = await run(input, prompt, input.history);
        if (turn.usage) updateFooter(turn);
        appendSession(input.sessionFile, {
          type: 'response', sessionId: input.sessionId, at: new Date().toISOString(),
          text: redactSession(turn.text, input),
          ...(turn.usage ? { usage: turn.usage } : {}),
          elapsedMs: turn.elapsedMs,
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
  let [command = '', ...args] = process.argv.slice(2);
  // 允许全局选项写在命令前（如 ggb --api http://… team list）；首个 token 是选项时视为省略命令。
  if (command.startsWith('--')) {
    args = [command, ...args];
    command = '';
  }
  // 裸 ggb：交互终端直接进入对话（与 claude/gemini 一致）；非交互保持帮助。
  if (!command) {
    // GGB_FORCE_INTERACTIVE 供测试或嵌入式调用绕过 TTY 检查。
    const interactive = process.env.GGB_FORCE_INTERACTIVE === '1' ||
      (process.stdin.isTTY && process.stdout.isTTY);
    if (interactive) return home(parseInput(args), args);
    return console.log(usage);
  }
  if (command === 'help' || command === '--help' || command === '-h') return console.log(usage);
  if (command === 'providers') {
    for (const [id, preset] of Object.entries(PRESETS)) console.log(`${id.padEnd(9)} ${preset.label.padEnd(14)} ${preset.protocol.padEnd(10)} ${preset.model}`);
    console.log('gpt/openai  Codex/OpenAI 别名');
    console.log('typesafe   TypeSafe System One（仅用于 decide 结构化判断）');
    return;
  }
  if (command === 'doctor') return doctor(args);
  if (command === 'decide') return decide(args);
  if (command === 'team') return team(args);
  if (command === 'task') return taskCommand(args);
  if (command === 'skill') return skillCommand(args);
  if (command === 'models') return modelsCommand(args);
  if (command === 'login') return loginCommand(args);
  if (command === 'rpc') return rpc(args);
  if (command === 'events') return events(args);
  if (command === 'node') return runNode(args);
  if (command === 'logout') return logoutCommand(args);
  if (command === 'context') return contextCommand(args);
  if (command !== 'run' && command !== 'chat') throw new Error(`未知命令“${command}”。\n\n${usage}`);
  const input = parseInput(args);
  if (command === 'chat') return interactiveChat(input, args);
  const stdin = await readStdin();
  const prompt = [input.prompt, stdin].filter(Boolean).join(input.prompt && stdin ? '\n\n' : '');
  if (!prompt) throw new Error('请提供提示词参数或通过 stdin 输入内容。');
  prepareSession(input);
  appendSession(input.sessionFile, {
    type: 'prompt', sessionId: input.sessionId, at: new Date().toISOString(),
    text: redactSession(prompt, input),
  });
  try {
    const turn = await run(input, prompt, input.history);
    appendSession(input.sessionFile, {
      type: 'response', sessionId: input.sessionId, at: new Date().toISOString(),
      text: redactSession(turn.text, input),
      ...(turn.usage ? { usage: turn.usage } : {}),
      elapsedMs: turn.elapsedMs,
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

#!/usr/bin/env node
import process from 'node:process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';

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
  ggb doctor [--api-url http://127.0.0.1:3089/api/health] [--ui-url http://127.0.0.1:3088/] [--json]
  ggb run --provider gemini --model gemini-2.5-flash "解释这段代码"
  echo "总结这个项目" | ggb run --provider claude
  ggb run --provider deepseek --system "你是后端专家" --no-stream "设计 API"
  ggb run --continue "继续上一个任务"
  ggb run --session refactor --continue "继续重构"
  ggb chat --provider claude --session personal
  ggb decide --state '{"goal":"..."}' --questions '{"urgent":{"type":"noul","instructions":"Is this urgent?"}}'
  ggb team list | create | run <id> "目标" [--watch] | status <id> | reviews <id> | review --approve <opId>
  ggb skill recommend "任务描述" | install <技能ID> | list
  ggb task <id> | ack <id> | accept <id> | reject <id> --note "需改什么"

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
async function workbenchFetch(args, route, { method = 'GET', body } = {}) {
  const base = workbenchBase(args);
  const url = `${base}/api/${String(route).replace(/^\//, '')}`;
  const cookie = fs.existsSync(cookieFile()) ? fs.readFileSync(cookieFile(), 'utf8').trim() : '';
  const attempt = async authCookie => fetch(url, {
    method,
    headers: { 'Content-Type': 'application/json', ...(authCookie ? { Cookie: authCookie } : {}) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  let response = await attempt(cookie);
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
  return data;
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
  ggb team create --name 团队名 --goal 目标 [--no-review] [--type development|product|operations|project|custom]
  ggb team run <teamId> "要达成的目标" [--watch] [--interval 秒]
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
通用：--api 指定工作台地址（默认 http://127.0.0.1:3089），--password 或 GGB_PASSWORD 登录。`;

function teamIdArg(args) { return args.find(value => !value.startsWith('--') && value !== 'team'); }

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
  const body = {
    name, goal, purpose: goal, teamType, pmRoleId: 'project_manager', memberRoleIds: ['project_manager'],
    requireReview,
    collaboration: { enabled: true, autoHandoff: true, sharedBoard: true, allowedTeamIds: [] },
  };
  const saved = await workbenchFetch(args, 'teams', { method: 'POST', body });
  if (has(args, '--json')) return console.log(JSON.stringify(saved, null, 2));
  console.log(`已创建团队「${saved.name}」(${saved.id})，招募审核：${requireReview ? '需要人工确认' : '自动确认（自治）'}。`);
  console.log(`下一步：ggb team run ${saved.id} "你要达成的目标" --watch`);
}

function renderTeamStatus(team) {
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
  const tasks = team.tasks || [];
  if (tasks.length) {
    console.log('\n任务：');
    for (const task of tasks.slice(-10)) {
      const acceptance = task.verificationStatus ? ` 验证:${task.verificationStatus}` : '';
      const delivery = task.deliveryStatus ? ` 交付:${task.deliveryStatus}` : '';
      console.log(`  [${task.status}] ${task.title || task.id}${acceptance}${delivery}`);
      console.log(`    id: ${task.id}`);
    }
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
  const known = ['ack', 'accept', 'reject'];
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
  const result = await workbenchFetch(args, `tasks/${id}/${sub}`, { method: 'POST', body: { note } });
  if (has(args, '--json')) return console.log(JSON.stringify(result, null, 2));
  console.log(sub === 'accept' ? `已验收通过：${id}` : `已退回复核：${id}`);
  if (result.delivery) console.log(`交付状态：${result.delivery.deliveryStatus}`);
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
    console.log(`启用：在管理界面启用并确认风险，或调用 POST /api/capabilities/${installed.id}/enable`);
    return;
  }
  if (sub === 'list') {
    const items = await workbenchFetch(args, 'capabilities');
    if (has(args, '--json')) return console.log(JSON.stringify(items, null, 2));
    if (!items.length) return console.log('还没有安装任何能力。用 ggb skill recommend 找找。');
    for (const item of items)
      console.log(`${item.enabled === false ? '停用' : '启用'}  ${String(item.kind).padEnd(7)} ${String(item.id).padEnd(38)} ${item.name}`);
    return;
  }
  throw new Error(`未知 skill 子命令“${sub}”。\n\n${teamUsage}`);
}

async function teamStatus(args) {
  const id = teamIdArg(args.slice(1));
  if (!id) throw new Error('team status 需要团队 ID。');
  const team = await workbenchFetch(args, `teams/${id}`);
  if (has(args, '--json')) return console.log(JSON.stringify(team, null, 2));
  renderTeamStatus(team);
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
  const intervalMs = Math.max(1, Number(valueAfter(args, '--interval', '4')) || 4) * 1000;
  console.log('持续跟踪中（Ctrl-C 退出）…');
  let lastMessageCount = -1;
  let lastTaskSignature = '';
  for (;;) {
    await new Promise(resolve => setTimeout(resolve, intervalMs));
    let team;
    try { team = await workbenchFetch(args, `teams/${id}`); } catch { continue; }
    const messages = team.messages || [];
    if (messages.length !== lastMessageCount) {
      for (const message of messages.slice(Math.max(0, lastMessageCount))) {
        if (message.senderType === 'owner') continue;
        const who = message.senderType === 'system' ? '[系统]' : message.senderType === 'team' ? '[协作]' : '[PM]';
        console.log(`${who} ${String(message.content || '').slice(0, 300)}`);
      }
      lastMessageCount = messages.length;
    }
    const tasks = team.tasks || [];
    const signature = tasks.map(task => `${task.id}:${task.status}`).join(',');
    if (signature !== lastTaskSignature) {
      const done = tasks.filter(task => ['completed', 'failed', 'cancelled'].includes(task.status)).length;
      console.log(`[任务] 共 ${tasks.length} 个，完成 ${done} 个；阶段 ${team.recruitment?.phase || ''}`);
      lastTaskSignature = signature;
    }
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
  if (sub === 'review') return teamReview(args);
  throw new Error(`未知 team 子命令“${sub}”。\n\n${teamUsage}`);
}

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
    console.log('typesafe   TypeSafe System One（仅用于 decide 结构化判断）');
    return;
  }
  if (command === 'doctor') return doctor(args);
  if (command === 'decide') return decide(args);
  if (command === 'team') return team(args);
  if (command === 'task') return taskCommand(args);
  if (command === 'skill') return skillCommand(args);
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

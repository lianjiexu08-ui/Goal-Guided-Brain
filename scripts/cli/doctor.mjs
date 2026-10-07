import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { PRESETS, valueAfter, has } from './config.mjs';
import { sessionDir } from './sessions.mjs';

function versionAtLeast(version, minimum) {
  const parse = (value) =>
    String(value)
      .split('.')
      .map((part) => Number.parseInt(part, 10) || 0);
  const actual = parse(version);
  const expected = parse(minimum);
  return expected.every(
    (part, index) =>
      (actual[index] || 0) >= part ||
      actual.slice(0, index).some((value, i) => value > expected[i]),
  );
}

function doctorCheck(id, label, status, detail) {
  return { id, label, status, detail };
}

async function checkReachable(id, label, target) {
  try {
    const url = new URL(target);
    const response = await fetch(url, {
      signal: AbortSignal.timeout(3000),
      redirect: 'manual',
    });
    return doctorCheck(
      id,
      label,
      response.ok ? 'pass' : 'warn',
      response.ok
        ? `${url.origin} 可访问（HTTP ${response.status}）`
        : `${url.origin} 返回 HTTP ${response.status}`,
    );
  } catch (error) {
    const message =
      error?.name === 'TimeoutError' ? '连接超时（3 秒）' : '当前不可访问';
    return doctorCheck(id, label, 'warn', `${target} ${message}`);
  }
}

function writableSessionCheck() {
  const directory = sessionDir();
  try {
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    const probe = path.join(
      directory,
      `.doctor-${process.pid}-${randomUUID()}.tmp`,
    );
    fs.writeFileSync(probe, 'ok', { mode: 0o600 });
    fs.rmSync(probe, { force: true });
    return doctorCheck('session', '会话目录', 'pass', `${directory} 可读写`);
  } catch {
    return doctorCheck('session', '会话目录', 'fail', `${directory} 不可读写`);
  }
}

function configuredProviderCheck() {
  const configured = Object.entries(PRESETS)
    .filter(([, preset]) =>
      preset.keys.some((key) => Boolean(process.env[key])),
    )
    .map(([id, preset]) => `${preset.label} (${id})`);
  return doctorCheck(
    'providers',
    '模型凭据',
    configured.length ? 'pass' : 'warn',
    configured.length
      ? `已配置：${configured.join('、')}`
      : '未发现普通模型环境变量；可在网页模型管理或环境变量中配置',
  );
}

function gitCheck() {
  try {
    const version = execFileSync('git', ['--version'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    return doctorCheck('git', 'Git', 'pass', version || '已安装');
  } catch {
    return doctorCheck(
      'git',
      'Git',
      'warn',
      '未找到 Git；不影响直接调用模型，但项目执行能力可能受限',
    );
  }
}

function portableAbsolutePath(value) {
  return (
    typeof value === 'string' &&
    Boolean(
      path.isAbsolute(value) ||
      path.posix.isAbsolute(value) ||
      path.win32.isAbsolute(value),
    )
  );
}

function expandHome(value) {
  if (value === '~') return os.homedir();
  if (typeof value === 'string' && value.startsWith('~/'))
    return path.join(os.homedir(), value.slice(2));
  return value;
}

function nodeConfigCheck(configPath) {
  try {
    if (!configPath) throw new Error('未提供节点配置路径。');
    const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    if (!config || typeof config !== 'object' || Array.isArray(config))
      throw new Error('节点配置必须是 JSON 对象。');
    const controlUrl = new URL(config.controlUrl);
    if (
      controlUrl.username ||
      controlUrl.password ||
      controlUrl.search ||
      controlUrl.hash ||
      !['http:', 'https:'].includes(controlUrl.protocol) ||
      (controlUrl.protocol !== 'https:' &&
        !['localhost', '127.0.0.1', '[::1]', '::1'].includes(
          controlUrl.hostname,
        ))
    )
      throw new Error('控制端必须使用 HTTPS；仅本机回环地址可以使用 HTTP。');
    const workspaces = config.workspaces;
    if (
      !workspaces ||
      typeof workspaces !== 'object' ||
      Array.isArray(workspaces)
    )
      throw new Error('节点配置缺少工作目录映射。');
    const entries = Object.entries(workspaces);
    if (!entries.length || entries.length > 100)
      throw new Error('节点至少需要一个工作目录映射，最多 100 个。');
    for (const [name, directory] of entries) {
      if (
        !/^[a-zA-Z0-9_-]{1,100}$/.test(name) ||
        !portableAbsolutePath(directory)
      )
        throw new Error('工作目录映射名称或路径无效。');
      if (!fs.existsSync(directory) || !fs.statSync(directory).isDirectory())
        throw new Error('工作目录映射必须指向本机已存在的文件夹。');
    }
    const dataDir = path.resolve(
      expandHome(
        config.dataDir || path.join(os.homedir(), '.dsh-workbench-node'),
      ),
    );
    fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
    const probe = path.join(
      dataDir,
      `.doctor-node-${process.pid}-${randomUUID()}.tmp`,
    );
    fs.writeFileSync(probe, 'ok', { mode: 0o600 });
    fs.rmSync(probe, { force: true });
    return doctorCheck(
      'node-config',
      '执行节点配置',
      'pass',
      `控制端地址有效，${entries.length} 个工作目录映射可用，节点数据目录可写`,
    );
  } catch (error) {
    return doctorCheck(
      'node-config',
      '执行节点配置',
      'fail',
      error?.message || '节点配置不可用。',
    );
  }
}

async function doctor(args) {
  const apiUrl = valueAfter(
    args,
    '--api-url',
    process.env.DSH_API_HEALTH_URL || 'http://127.0.0.1:3089/api/health',
  );
  const uiUrl = valueAfter(
    args,
    '--ui-url',
    process.env.DSH_UI_URL || 'http://127.0.0.1:3088/',
  );
  const nodeOk = versionAtLeast(process.versions.node, '22.13.0');
  const platform =
    process.env.WSL_DISTRO_NAME || process.env.WSL_INTEROP
      ? `${process.platform}/${process.arch} · WSL2`
      : `${process.platform}/${process.arch}`;
  const checks = [
    doctorCheck(
      'node',
      'Node.js',
      nodeOk ? 'pass' : 'fail',
      `${process.versions.node}${nodeOk ? '' : '（需要 22.13+）'}`,
    ),
    doctorCheck('platform', '运行平台', 'pass', platform),
    writableSessionCheck(),
    gitCheck(),
    configuredProviderCheck(),
    doctorCheck(
      'typesafe',
      'TypeSafe',
      process.env.TYPESAFE_API_KEY ? 'pass' : 'info',
      process.env.TYPESAFE_API_KEY ? '已配置（可选）' : '未配置（可选）',
    ),
    await checkReachable('api', '工作台 API', apiUrl),
    await checkReachable('ui', '工作台网页', uiUrl),
  ];
  if (args.includes('--node-config'))
    checks.push(nodeConfigCheck(valueAfter(args, '--node-config', '')));
  const strict = has(args, '--strict');
  const strictOk = checks.every(
    (check) => check.status !== 'fail' && check.status !== 'warn',
  );
  const result = {
    ok: checks.every((check) => check.status !== 'fail'),
    strict,
    strictOk,
    generatedAt: new Date().toISOString(),
    platform: {
      os: process.platform,
      arch: process.arch,
      node: process.versions.node,
      wsl: Boolean(process.env.WSL_DISTRO_NAME || process.env.WSL_INTEROP),
    },
    checks,
  };
  if (has(args, '--json')) {
    process.stdout.write(`${JSON.stringify(result)}\n`);
    if (strict && !strictOk) process.exitCode = 1;
    return result;
  }
  for (const check of checks) {
    const marker =
      check.status === 'pass'
        ? '✓'
        : check.status === 'fail'
          ? '✗'
          : check.status === 'warn'
            ? '!'
            : '·';
    console.log(`${marker} ${check.label}：${check.detail}`);
  }
  console.log(
    strict
      ? strictOk
        ? '\n严格环境检查通过。'
        : '\n严格环境检查未通过，请先修复 ✗ 或 ! 项目。'
      : result.ok
        ? '\n环境检查通过；带 ! 的项目是可选提醒。'
        : '\n环境检查未通过，请先修复 ✗ 项目。',
  );
  if (strict && !strictOk) process.exitCode = 1;
  return result;
}
export { doctor };

import fs from 'node:fs';
import path from 'node:path';
import { command } from './workspaces.mjs';

/**
 * 验证门禁：按项目类型探测可执行的检查，并给出确定性的结论。
 *
 * 设计要点：
 * - 只用项目自带的标准入口（package scripts、pytest、go test、cargo test 等），
 *   不猜测自定义脚本，也不执行安装/部署类命令。
 * - 结论分三档：verified（通过）/ failed（真实失败）/ unavailable（工具或依赖
 *   缺失，无法得出结论）。unavailable 不能冒充通过，也不该被判成失败。
 * - 依赖缺失（例如隔离目录没有 node_modules）按 unavailable 处理，避免把
 *   "没装依赖"误报成"测试失败"。
 */

const MAX_CHECKS = 8;
const DEFAULT_TIMEOUT_MS = 300000;
const MAX_OUTPUT = 20000;

const safeRead = (file) => {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return '';
  }
};
const exists = (file) => {
  try {
    return fs.existsSync(file);
  } catch {
    return false;
  }
};
const isDir = (file) => {
  try {
    return fs.statSync(file).isDirectory();
  } catch {
    return false;
  }
};

// ---- 各类项目探测 ----

function nodeChecks(root, warnings) {
  const manifestFile = path.join(root, 'package.json');
  if (!exists(manifestFile)) return [];
  let manifest;
  try {
    manifest = JSON.parse(safeRead(manifestFile));
  } catch {
    warnings.push('package.json 无法解析，跳过 Node 检查。');
    return [];
  }
  const scripts = manifest?.scripts && typeof manifest.scripts === 'object' ? manifest.scripts : {};
  const manager = exists(path.join(root, 'pnpm-lock.yaml'))
    ? 'pnpm'
    : exists(path.join(root, 'yarn.lock'))
      ? 'yarn'
      : exists(path.join(root, 'bun.lockb'))
        ? 'bun'
        : 'npm';
  const run = (name) => manager === 'npm' ? ['npm', ['run', name]] : [manager, ['run', name]];
  const checks = [];
  // 顺序：类型检查 / lint（快）→ 测试 → 构建（慢）。
  for (const [id, label, names] of [
    ['typecheck', '类型检查', ['typecheck', 'type-check', 'tsc']],
    ['lint', 'Lint', ['lint']],
    ['test', '测试', ['test', 'tests']],
    ['build', '构建', ['build']],
  ]) {
    const script = names.find((name) => typeof scripts[name] === 'string');
    if (!script) continue;
    const [bin, args] = run(script);
    checks.push({
      id,
      label,
      stack: 'node',
      command: bin,
      args,
      // test 脚本常见 watch 模式，CI 下必须单次执行。
      env: id === 'test' ? { CI: '1' } : {},
    });
  }
  if (!checks.length) warnings.push('package.json 没有 test / lint / typecheck / build 脚本，未生成检查。');
  const nodeModules = isDir(path.join(root, 'node_modules'));
  if (checks.length && !nodeModules) warnings.push('未找到 node_modules：依赖相关检查会被标记为"环境不可用"。');
  if (manifest?.workspaces || exists(path.join(root, 'pnpm-workspace.yaml')))
    warnings.push('检测到 monorepo 工作区：只运行根级脚本，子包需单独验证。');
  return checks;
}

function pythonChecks(root, warnings) {
  const hasProject =
    exists(path.join(root, 'pyproject.toml')) ||
    exists(path.join(root, 'setup.py')) ||
    exists(path.join(root, 'requirements.txt'));
  if (!hasProject) return [];
  const pyproject = safeRead(path.join(root, 'pyproject.toml'));
  const checks = [];
  const hasPytest =
    exists(path.join(root, 'pytest.ini')) ||
    exists(path.join(root, 'tox.ini')) ||
    isDir(path.join(root, 'tests')) ||
    isDir(path.join(root, 'test')) ||
    /\[tool\.pytest/.test(pyproject);
  if (hasPytest)
    checks.push({ id: 'test', label: '测试', stack: 'python', command: 'python3', args: ['-m', 'pytest', '-q'], env: {} });
  if (/\[tool\.ruff/.test(pyproject) || exists(path.join(root, 'ruff.toml')) || exists(path.join(root, '.ruff.toml')))
    checks.push({ id: 'lint', label: 'Lint', stack: 'python', command: 'python3', args: ['-m', 'ruff', 'check', '.'], env: {} });
  if (/\[tool\.mypy/.test(pyproject) || exists(path.join(root, 'mypy.ini')))
    checks.push({ id: 'typecheck', label: '类型检查', stack: 'python', command: 'python3', args: ['-m', 'mypy', '.'], env: {} });
  if (!checks.length) warnings.push('Python 项目未发现 pytest / ruff / mypy 配置，未生成检查。');
  return checks;
}

function goChecks(root) {
  if (!exists(path.join(root, 'go.mod'))) return [];
  return [
    { id: 'vet', label: '静态检查', stack: 'go', command: 'go', args: ['vet', './...'], env: {} },
    { id: 'build', label: '构建', stack: 'go', command: 'go', args: ['build', './...'], env: {} },
    { id: 'test', label: '测试', stack: 'go', command: 'go', args: ['test', './...'], env: {} },
  ];
}

function rustChecks(root) {
  if (!exists(path.join(root, 'Cargo.toml'))) return [];
  return [
    { id: 'build', label: '构建', stack: 'rust', command: 'cargo', args: ['check', '--all-targets'], env: {} },
    { id: 'test', label: '测试', stack: 'rust', command: 'cargo', args: ['test'], env: {} },
  ];
}

function jvmChecks(root) {
  if (exists(path.join(root, 'pom.xml')))
    return [{ id: 'test', label: '测试', stack: 'jvm', command: 'mvn', args: ['-q', '-B', 'test'], env: {} }];
  if (exists(path.join(root, 'build.gradle')) || exists(path.join(root, 'build.gradle.kts'))) {
    const gradle = exists(path.join(root, 'gradlew')) ? './gradlew' : 'gradle';
    return [{ id: 'test', label: '测试', stack: 'jvm', command: gradle, args: ['test'], env: {} }];
  }
  return [];
}

function makeChecks(root, existing) {
  if (existing.length || !exists(path.join(root, 'Makefile'))) return [];
  const makefile = safeRead(path.join(root, 'Makefile'));
  const target = /^check\s*:/m.test(makefile) ? 'check' : /^test\s*:/m.test(makefile) ? 'test' : null;
  return target ? [{ id: target, label: `make ${target}`, stack: 'make', command: 'make', args: [target], env: {} }] : [];
}

/**
 * 探测一个工作目录可运行的验证计划。
 * 纯读取，不执行任何命令。
 */
export function detectVerificationPlan(root, { maxChecks = MAX_CHECKS } = {}) {
  const warnings = [];
  if (!root || !isDir(root)) {
    return { root: root || '', checks: [], warnings: ['工作目录不存在或不可读。'], stacks: [] };
  }
  const checks = [
    ...nodeChecks(root, warnings),
    ...pythonChecks(root, warnings),
    ...goChecks(root),
    ...rustChecks(root),
    ...jvmChecks(root),
  ];
  checks.push(...makeChecks(root, checks));
  const limited = checks.slice(0, maxChecks);
  if (checks.length > limited.length) warnings.push(`检查项超过 ${maxChecks} 个，只执行前 ${maxChecks} 个。`);
  if (!limited.length && !warnings.length) warnings.push('未识别出可验证的项目类型（无 package.json / pyproject / go.mod / Cargo.toml / 构建文件）。');
  return {
    root,
    checks: limited,
    warnings,
    stacks: [...new Set(limited.map((check) => check.stack))],
  };
}

// 工具或依赖缺失时不能判成"测试失败"：这些模式说明环境不具备，而不是代码错。
const UNAVAILABLE_PATTERN =
  /command not found|不是内部或外部命令|no such file or directory|ENOENT|No module named|cannot find module|not found: |无法将.*项识别为|is not recognized as an internal or external command|requires .* which is not installed|Please install/i;

export function classifyFailure(error, timedOut) {
  if (timedOut) return 'unavailable';
  const message = String(error?.message || error || '');
  return UNAVAILABLE_PATTERN.test(message) ? 'unavailable' : 'failed';
}

/**
 * 顺序执行检查，任一失败即停止（省时且避免连锁噪声）。
 * 返回聚合结果，供调用方落成验证证据。
 */
export async function runVerificationPlan(plan, {
  timeoutMs = DEFAULT_TIMEOUT_MS,
  run = command,
  onCheck = () => {},
} = {}) {
  const results = [];
  let status = 'verified';
  for (const check of plan.checks) {
    const startedAt = new Date().toISOString();
    const startedMs = Date.now();
    let output = '';
    let checkStatus = 'verified';
    let timedOut = false;
    try {
      output = await run(check.command, check.args, {
        cwd: plan.root,
        timeout: timeoutMs,
        env: check.env || {},
      });
    } catch (error) {
      timedOut = /超时|timeout/i.test(String(error?.message || ''));
      checkStatus = classifyFailure(error, timedOut);
      output = String(error?.message || error || '');
    }
    const result = {
      id: check.id,
      label: check.label,
      stack: check.stack,
      command: [check.command, ...check.args].join(' '),
      status: checkStatus,
      durationMs: Date.now() - startedMs,
      startedAt,
      finishedAt: new Date().toISOString(),
      output: String(output).slice(-MAX_OUTPUT),
    };
    results.push(result);
    onCheck(result);
    if (checkStatus === 'failed') {
      status = 'failed';
      break;
    }
    // 环境不可用不阻断后续检查，但最终结论不能是 verified。
    if (checkStatus === 'unavailable') status = 'unavailable';
  }
  if (!plan.checks.length) status = 'unavailable';
  return {
    status,
    results,
    checksRan: results.length,
    checksPlanned: plan.checks.length,
    warnings: plan.warnings,
    stacks: plan.stacks,
  };
}

export function summarizeVerification(aggregate) {
  const label = { verified: '通过', failed: '失败', unavailable: '环境不可用' }[aggregate.status] || aggregate.status;
  const lines = aggregate.results.map((result) => {
    const mark = { verified: '✓', failed: '✗', unavailable: '!' }[result.status] || '·';
    return `${mark} ${result.command}  (${result.status}, ${result.durationMs}ms)`;
  });
  const skipped = aggregate.checksPlanned - aggregate.checksRan;
  return [
    `验证结论：${label}`,
    ...(lines.length ? lines : ['（没有可执行的检查）']),
    ...(skipped > 0 ? [`未执行：${skipped} 项（前序检查已失败或环境不可用）`] : []),
    ...(aggregate.warnings.length ? ['', '提示：', ...aggregate.warnings.map((w) => `- ${w}`)] : []),
  ].join('\n');
}

export const VERIFICATION_LIMITS = { MAX_CHECKS, DEFAULT_TIMEOUT_MS, MAX_OUTPUT };

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  classifyFailure,
  detectVerificationPlan,
  runVerificationPlan,
  summarizeVerification,
} from '../server/verification.mjs';

function sandbox(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ggb-verify-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}
const write = (dir, name, content = '') => {
  const file = path.join(dir, name);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
};
const cmds = plan => plan.checks.map(check => `${check.command} ${check.args.join(' ')}`.trim());

test('Node 项目：按 typecheck → lint → test → build 排序并识别包管理器', t => {
  const dir = sandbox(t);
  write(dir, 'package.json', JSON.stringify({
    scripts: { build: 'tsc', test: 'node --test', lint: 'oxlint', typecheck: 'tsc --noEmit' },
  }));
  write(dir, 'pnpm-lock.yaml');
  write(dir, 'node_modules/.keep');
  const plan = detectVerificationPlan(dir);
  assert.deepEqual(cmds(plan), ['pnpm run typecheck', 'pnpm run lint', 'pnpm run test', 'pnpm run build']);
  assert.deepEqual(plan.stacks, ['node']);
  assert.equal(plan.checks.find(c => c.id === 'test').env.CI, '1', 'test 必须带 CI=1 避免 watch 模式');
});

test('Node 项目：缺少依赖时给出警告，不生成假检查', t => {
  const dir = sandbox(t);
  write(dir, 'package.json', JSON.stringify({ scripts: { test: 'vitest run' } }));
  const plan = detectVerificationPlan(dir);
  assert.deepEqual(cmds(plan), ['npm run test']);
  assert.ok(plan.warnings.some(w => /node_modules/.test(w)));
});

test('Node 项目：没有标准脚本时不生成检查并说明原因', t => {
  const dir = sandbox(t);
  write(dir, 'package.json', JSON.stringify({ scripts: { dev: 'vite' } }));
  const plan = detectVerificationPlan(dir);
  assert.equal(plan.checks.length, 0);
  assert.ok(plan.warnings.some(w => /没有 test/.test(w)));
});

test('Python 项目：识别 pytest / ruff / mypy', t => {
  const dir = sandbox(t);
  write(dir, 'pyproject.toml', '[tool.pytest.ini_options]\n[tool.ruff]\n[tool.mypy]\n');
  write(dir, 'tests/test_a.py', 'def test_a():\n    assert True\n');
  const plan = detectVerificationPlan(dir);
  assert.deepEqual(cmds(plan), ['python3 -m pytest -q', 'python3 -m ruff check .', 'python3 -m mypy .']);
});

test('Go / Rust / JVM / Makefile 探测', t => {
  const go = sandbox(t);
  write(go, 'go.mod', 'module x\n');
  assert.deepEqual(cmds(detectVerificationPlan(go)), ['go vet ./...', 'go build ./...', 'go test ./...']);

  const rust = sandbox(t);
  write(rust, 'Cargo.toml', '[package]\nname="x"\n');
  assert.deepEqual(cmds(detectVerificationPlan(rust)), ['cargo check --all-targets', 'cargo test']);

  const maven = sandbox(t);
  write(maven, 'pom.xml', '<project/>');
  assert.deepEqual(cmds(detectVerificationPlan(maven)), ['mvn -q -B test']);

  const gradle = sandbox(t);
  write(gradle, 'build.gradle', '');
  assert.deepEqual(cmds(detectVerificationPlan(gradle)), ['gradle test']);

  const make = sandbox(t);
  write(make, 'Makefile', 'check:\n\techo ok\n');
  assert.deepEqual(cmds(detectVerificationPlan(make)), ['make check']);
});

test('Monorepo：只跑根级脚本并提示子包', t => {
  const dir = sandbox(t);
  write(dir, 'package.json', JSON.stringify({ workspaces: ['packages/*'], scripts: { test: 'node --test' } }));
  write(dir, 'node_modules/.keep');
  const plan = detectVerificationPlan(dir);
  assert.deepEqual(cmds(plan), ['npm run test']);
  assert.ok(plan.warnings.some(w => /monorepo/.test(w)));
});

test('未识别的目录：无检查且给出提示', t => {
  const dir = sandbox(t);
  const plan = detectVerificationPlan(dir);
  assert.equal(plan.checks.length, 0);
  assert.ok(plan.warnings.some(w => /未识别/.test(w)));
});

test('不存在的目录安全返回而不是抛错', () => {
  const plan = detectVerificationPlan('/nonexistent/ggb-verify');
  assert.equal(plan.checks.length, 0);
  assert.ok(plan.warnings.length > 0);
});

test('聚合结果：全部通过为 verified，任一失败立即停止', async t => {
  const dir = sandbox(t);
  write(dir, 'package.json', JSON.stringify({ scripts: { lint: 'lint', test: 'test', build: 'build' } }));
  write(dir, 'node_modules/.keep');
  const plan = detectVerificationPlan(dir);
  const seen = [];
  const ok = await runVerificationPlan(plan, {
    run: async (cmd, args) => { seen.push([cmd, ...args].join(' ')); return 'ok'; },
  });
  assert.equal(ok.status, 'verified');
  assert.equal(ok.checksRan, 3);

  seen.length = 0;
  const failed = await runVerificationPlan(plan, {
    run: async (cmd, args) => {
      const line = [cmd, ...args].join(' ');
      seen.push(line);
      if (line.endsWith(' test')) throw new Error('2 tests failed');
      return 'ok';
    },
  });
  assert.equal(failed.status, 'failed');
  assert.equal(failed.checksRan, 2, '失败后不应继续执行后续检查');
  assert.equal(failed.checksPlanned, 3);
});

test('环境不可用与真实失败要区分：不可用不中止且结论不是 verified', async t => {
  const dir = sandbox(t);
  write(dir, 'package.json', JSON.stringify({ scripts: { lint: 'lint', test: 'test' } }));
  write(dir, 'node_modules/.keep');
  const plan = detectVerificationPlan(dir);
  const result = await runVerificationPlan(plan, {
    run: async (cmd, args) => {
      const line = [cmd, ...args].join(' ');
      if (line.endsWith(' lint')) throw new Error('sh: lint: command not found');
      return 'ok';
    },
  });
  assert.equal(result.status, 'unavailable');
  assert.equal(result.results[0].status, 'unavailable');
  assert.equal(result.results[1].status, 'verified');
});

test('超时归类为 unavailable，而不是 failed', () => {
  assert.equal(classifyFailure(new Error('npm 执行超时。'), true), 'unavailable');
  assert.equal(classifyFailure(new Error('No module named pytest')), 'unavailable');
  assert.equal(classifyFailure(new Error('  1 failing')), 'failed');
});

test('汇总文本包含结论、命令与未执行项', async t => {
  const dir = sandbox(t);
  write(dir, 'package.json', JSON.stringify({ scripts: { lint: 'lint', test: 'test' } }));
  write(dir, 'node_modules/.keep');
  const plan = detectVerificationPlan(dir);
  const result = await runVerificationPlan(plan, {
    run: async (cmd, args) => {
      if ([cmd, ...args].join(' ').endsWith(' lint')) throw new Error('boom');
      return 'ok';
    },
  });
  const text = summarizeVerification(result);
  assert.match(text, /验证结论：失败/);
  assert.match(text, /✗/);
  assert.match(text, /未执行：1 项/);
});

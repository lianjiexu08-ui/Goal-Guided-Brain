import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { analyzeImpact, summarizeImpact } from '../server/impact-analysis.mjs';

function repo(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ggb-impact-'));
  const git = (...args) => execFileSync('git', args, { cwd: dir, stdio: 'pipe' }).toString().trim();
  git('init', '-q');
  git('config', 'user.email', 't@t');
  git('config', 'user.name', 't');
  fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'src', 'a.js'), 'export const a = 1;\n');
  git('add', '-A');
  git('commit', '-qm', 'init');
  const base = git('rev-parse', 'HEAD');
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return { dir, base, git };
}

test('低风险：普通源码改动', async t => {
  const { dir, base } = repo(t);
  fs.writeFileSync(path.join(dir, 'src', 'a.js'), 'export const a = 2;\n');
  const impact = await analyzeImpact({ path: dir, baseCommit: base, kind: 'worktree' });
  assert.equal(impact.risk, 'low');
  assert.equal(impact.requiresAck, false);
  assert.equal(impact.requiresNotice, false);
  assert.equal(impact.stats.total, 1);
});

test('高风险：迁移 / 认证 / 凭据 / 部署', async t => {
  const cases = [
    ['migrations/001_add.sql', 'CREATE TABLE x(id int);'],
    ['src/auth/session.js', 'export const x = 1;'],
    ['.env.example', 'TOKEN='],
    ['.github/workflows/ci.yml', 'on: push'],
  ];
  for (const [file, content] of cases) {
    const { dir, base } = repo(t);
    fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
    fs.writeFileSync(path.join(dir, file), content);
    const impact = await analyzeImpact({ path: dir, baseCommit: base, kind: 'worktree' });
    assert.equal(impact.risk, 'high', `${file} 应判为高风险`);
    assert.equal(impact.requiresAck, true);
    assert.equal(impact.requiresNotice, true);
  }
});

test('中风险：依赖或接口文件', async t => {
  const { dir, base } = repo(t);
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'x' }));
  const impact = await analyzeImpact({ path: dir, baseCommit: base, kind: 'worktree' });
  assert.equal(impact.risk, 'medium');
  assert.equal(impact.requiresAck, false);
  assert.ok(impact.reasons.some(reason => /依赖/.test(reason)));
});

test('规模升级：文件数超过阈值提高风险', async t => {
  const { dir, base } = repo(t);
  for (let index = 0; index < 26; index += 1)
    fs.writeFileSync(path.join(dir, 'src', `f${index}.js`), 'export const x = 1;\n');
  const impact = await analyzeImpact({ path: dir, baseCommit: base, kind: 'worktree' });
  assert.equal(impact.risk, 'medium');
  assert.ok(impact.reasons.some(reason => /26/.test(reason)));

  for (let index = 26; index < 81; index += 1)
    fs.writeFileSync(path.join(dir, 'src', `f${index}.js`), 'export const x = 1;\n');
  const huge = await analyzeImpact({ path: dir, baseCommit: base, kind: 'worktree' });
  assert.equal(huge.risk, 'high');
});

test('无基准或无变更时如实返回', async t => {
  const { dir } = repo(t);
  const noBase = await analyzeImpact({ path: dir, baseCommit: null, kind: 'worktree' });
  assert.equal(noBase.risk, 'unknown');
  assert.equal(noBase.requiresAck, false);

  const { dir: dir2, base } = repo(t);
  const clean = await analyzeImpact({ path: dir2, baseCommit: base, kind: 'worktree' });
  assert.equal(clean.risk, 'low');
  assert.equal(clean.stats.total, 0);
});

test('不存在的目录安全返回 unknown', async () => {
  const impact = await analyzeImpact({ path: '/nonexistent/ggb', baseCommit: 'abc', kind: 'worktree' });
  assert.equal(impact.risk, 'unknown');
});

test('汇总文本包含等级、文件统计与原因', async t => {
  const { dir, base } = repo(t);
  fs.writeFileSync(path.join(dir, 'migrations.sql'), 'CREATE TABLE x(id int);');
  const impact = await analyzeImpact({ path: dir, baseCommit: base, kind: 'worktree' });
  const text = summarizeImpact(impact);
  assert.match(text, /变更风险：高/);
  assert.match(text, /文件：共 1/);
  assert.match(text, /数据库/);
  assert.match(text, /需要所有者确认/);
});

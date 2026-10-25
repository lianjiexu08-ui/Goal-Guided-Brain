import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  detectTaskType,
  detectProjectStack,
  detectCodeStyle,
  buildVerificationExpectations,
  buildLessonsFromHistory,
  enrichTaskContext,
} from '../server/task-enrichment.mjs';

function tmpDir(t, files = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ggb-enrich-'));
  for (const [name, content] of Object.entries(files)) {
    const full = path.join(dir, name);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content);
  }
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test('detectTaskType: 各类型正确匹配', () => {
  assert.equal(detectTaskType('修复登录超时的bug'), 'bug-fix');
  assert.equal(detectTaskType('实现用户登录功能'), 'new-feature');
  assert.equal(detectTaskType('重构数据库模块'), 'refactor');
  assert.equal(detectTaskType('优化查询性能'), 'performance');
  assert.equal(detectTaskType('添加单元测试'), 'testing');
  assert.equal(detectTaskType('编写API文档'), 'docs');
  assert.equal(detectTaskType('部署到Kubernetes'), 'devops');
  assert.equal(detectTaskType('随便聊聊'), 'general');
});

test('detectProjectStack: 识别 Node/TS/Go/Python', t => {
  const nodeDir = tmpDir(t, { 'package.json': '{}', 'tsconfig.json': '{}' });
  const stacks = detectProjectStack(nodeDir);
  assert.ok(stacks.some(s => s.name === 'Node.js'));
  assert.ok(stacks.some(s => s.name === 'TypeScript'));

  const goDir = tmpDir(t, { 'go.mod': 'module x' });
  assert.ok(detectProjectStack(goDir).some(s => s.name === 'Go'));
});

test('detectCodeStyle: 检测 ESLint 和 AGENTS.md', t => {
  const dir = tmpDir(t, { '.eslintrc.json': '{}', 'AGENTS.md': '规则' });
  const style = detectCodeStyle(dir);
  assert.match(style, /eslintrc/);
  assert.match(style, /AGENTS\.md/);
});

test('buildVerificationExpectations: 生成命令列表', () => {
  const ve = buildVerificationExpectations({
    checks: [
      { command: 'npm', args: ['run', 'test'], label: '测试' },
      { command: 'npx', args: ['tsc', '--noEmit'], label: '类型检查' },
    ],
  });
  assert.match(ve, /npm run test/);
  assert.match(ve, /npx tsc/);
  assert.match(ve, /验证预期/);
});

test('buildLessonsFromHistory: 只注入相关教训', () => {
  const history = [
    { pattern: '用户登录', lesson: '密码需要 bcrypt 加密' },
    { pattern: '数据库迁移', lesson: '必须在事务中执行' },
    { pattern: '无关的教训', lesson: '不应出现' },
  ];
  const lessons = buildLessonsFromHistory(history, '实现用户登录功能');
  assert.match(lessons, /bcrypt/);
  assert.ok(!lessons.includes('不应出现'), '不应包含无关教训');
});

test('enrichTaskContext: 综合输出所有维度', t => {
  const dir = tmpDir(t, { 'package.json': '{}', '.eslintrc.json': '{}' });
  const result = enrichTaskContext({
    prompt: '修复登录页面的性能问题',
    workspace: dir,
    verificationPlan: { checks: [{ command: 'npm', args: ['test'], label: '测试' }] },
    failureHistory: [{ pattern: '性能', lesson: '注意 N+1 查询' }],
  });
  assert.match(result, /任务类型.*缺陷修复/); // 「修复…」优先匹配 bug-fix
  assert.match(result, /Node\.js/);
  assert.match(result, /eslintrc/);
  assert.match(result, /验证预期/);
  assert.match(result, /npm test/);
  assert.match(result, /历史教训/);
  assert.match(result, /N\+1/);
});

test('enrichTaskContext: 空目录不产生技术栈', t => {
  const dir = tmpDir(t);
  const result = enrichTaskContext({ prompt: '做点什么', workspace: dir });
  assert.ok(!result.includes('项目技术栈'));
});

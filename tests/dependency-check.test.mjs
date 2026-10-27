import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  MISSING_DEPENDENCIES_MESSAGE,
  describeMissing,
  missingDependencies,
} from '../scripts/check-dependencies.mjs';

function sandbox(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ggb-deps-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

const write = (dir, name, content = '') => {
  const file = path.join(dir, name);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
};

test('没有 package.json 时不报缺失', t => {
  const dir = sandbox(t);
  assert.deepEqual(missingDependencies(dir), { nodeModulesMissing: false, missing: [] });
});

test('没有声明任何依赖时不报缺失（纯内置模块项目无需 node_modules）', t => {
  const dir = sandbox(t);
  write(dir, 'package.json', JSON.stringify({ scripts: { test: 'node --test' } }));
  assert.deepEqual(missingDependencies(dir), { nodeModulesMissing: false, missing: [] });
});

test('声明了依赖但没有 node_modules：列出全部依赖并标记 nodeModulesMissing', t => {
  const dir = sandbox(t);
  write(dir, 'package.json', JSON.stringify({
    dependencies: { yaml: '2.8.3' },
    devDependencies: { oxlint: '1.76.0' },
  }));
  const result = missingDependencies(dir);
  assert.equal(result.nodeModulesMissing, true);
  assert.deepEqual(result.missing.sort(), ['oxlint', 'yaml']);
});

test('node_modules 存在但个别依赖解析不到：只报真正缺失的依赖', t => {
  const dir = sandbox(t);
  write(dir, 'package.json', JSON.stringify({ dependencies: { yaml: '2.8.3', tar: '7.5.22' } }));
  write(dir, 'node_modules/yaml/package.json', '{}');
  const result = missingDependencies(dir);
  assert.equal(result.nodeModulesMissing, false);
  assert.deepEqual(result.missing, ['tar']);
});

test('依赖齐全时不报缺失', t => {
  const dir = sandbox(t);
  write(dir, 'package.json', JSON.stringify({ dependencies: { yaml: '2.8.3' } }));
  write(dir, 'node_modules/yaml/package.json', '{}');
  assert.deepEqual(missingDependencies(dir), { nodeModulesMissing: false, missing: [] });
});

test('peerDependencies / optionalDependencies 缺失不算失败', t => {
  const dir = sandbox(t);
  write(dir, 'package.json', JSON.stringify({
    peerDependencies: { react: '19.2.8' },
    optionalDependencies: { fsevents: '2.3.3' },
  }));
  assert.deepEqual(missingDependencies(dir), { nodeModulesMissing: false, missing: [] });
});

test('提示信息说明"依赖未安装"，避免被误读成代码失败', () => {
  assert.match(MISSING_DEPENDENCIES_MESSAGE, /not installed/);
  assert.match(MISSING_DEPENDENCIES_MESSAGE, /Please install/);
  assert.match(describeMissing({ nodeModulesMissing: true, missing: ['yaml', 'tar'] }), /依赖未安装/);
  assert.match(describeMissing({ nodeModulesMissing: true, missing: ['yaml', 'tar'] }), /yaml, tar/);
});

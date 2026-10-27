#!/usr/bin/env node
/**
 * `pretest` 守卫：依赖没装时给出准确的失败原因。
 *
 * 为什么需要它：`node --test tests/*.test.mjs` 在缺少 node_modules 时会直接抛出
 * `Error [ERR_MODULE_NOT_FOUND]: Cannot find package 'yaml' imported from ...`。
 * 这是"环境不具备"，不是"代码失败"，但调用方（人、CI、验证门禁）从这行报错里
 * 很难一眼分辨。守卫把原因写清楚：依赖未安装，请先 `npm ci`。
 *
 * 行为约定：
 * - 依赖齐全：静默通过（退出码 0），正常测试流程不受影响。
 * - 声明了依赖但 node_modules 缺失（或个别依赖解析不到）：说明原因并以非零码退出，
 *   绝不伪装成"测试通过"。
 * - 没有声明任何依赖：直接通过（纯 Node 内置模块的项目不需要 node_modules）。
 */
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

// 只检查"跑测试必须存在"的依赖；peerDependencies 允许由使用者提供，optional 允许缺失。
const REQUIRED_FIELDS = ['dependencies', 'devDependencies'];

export const MISSING_DEPENDENCIES_MESSAGE =
  'Dependencies are not installed: the test suite cannot run without node_modules. Please install them first: npm ci';

const exists = (file) => fs.existsSync(file);

/**
 * 计算缺失的依赖。纯函数式读取，不执行安装、不写文件。
 * @param {string} root 项目根目录
 * @returns {{ nodeModulesMissing: boolean, missing: string[] }}
 */
export function missingDependencies(root = process.cwd()) {
  const manifestFile = path.join(root, 'package.json');
  if (!exists(manifestFile)) return { nodeModulesMissing: false, missing: [] };
  let manifest;
  try {
    manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8'));
  } catch {
    return { nodeModulesMissing: false, missing: [] };
  }
  const declared = [
    ...new Set(
      REQUIRED_FIELDS.flatMap((field) =>
        manifest?.[field] && typeof manifest[field] === 'object' ? Object.keys(manifest[field]) : [],
      ),
    ),
  ];
  if (!declared.length) return { nodeModulesMissing: false, missing: [] };
  const modulesDir = path.join(root, 'node_modules');
  if (!fs.existsSync(modulesDir)) return { nodeModulesMissing: true, missing: declared };
  const missing = declared.filter((name) => !exists(path.join(modulesDir, name)));
  return { nodeModulesMissing: false, missing };
}

/**
 * 给缺失依赖生成可直接阅读的提示行。
 */
export function describeMissing({ nodeModulesMissing, missing }) {
  const head = nodeModulesMissing ? 'node_modules 不存在' : `缺少 ${missing.length} 个依赖`;
  const sample = missing.slice(0, 5).join(', ');
  const tail = missing.length > 5 ? ` 等 ${missing.length} 个` : '';
  return `检测到依赖未安装（${head}）：${sample}${tail}`;
}

function main() {
  const result = missingDependencies();
  if (!result.missing.length) return;
  console.error(MISSING_DEPENDENCIES_MESSAGE);
  console.error(describeMissing(result));
  process.exitCode = 1;
}

// 只有被当作脚本直接执行时才运行，import 时不产生副作用（便于测试）。
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();

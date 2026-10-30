/**
 * GGB 内置技能库（Skill Library）加载器。
 *
 * skills-library/library.json 由 scripts/generate-skill-library.mjs
 * 确定性生成（2000 个技能，含完整 SKILL.md 正文），随仓库分发。
 * 本模块提供惰性加载、关键词搜索与按 id 取用，供能力中心搜索、
 * 推荐与离线安装使用——全程无网络依赖。
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const LIBRARY_FILE = path.join(repo, 'skills-library', 'library.json');

let cache = null;

/** 惰性加载并校验库结构。文件缺失或损坏时抛错（调用方决定降级策略）。 */
export function loadLibrary() {
  if (cache) return cache;
  const raw = JSON.parse(fs.readFileSync(LIBRARY_FILE, 'utf8'));
  if (!raw || !Array.isArray(raw.skills) || !raw.skills.length)
    throw new Error('内置技能库格式无效。');
  cache = raw;
  return cache;
}

/** 库内技能总数。 */
export function libraryCount() {
  return loadLibrary().skills.length;
}

/**
 * 关键词搜索：对 id/标题/描述/分类做不区分大小写的子串匹配，
 * 按「标题命中 > 描述命中 > 分类命中」排序，返回最多 limit 条。
 */
export function searchLibrary(query, { limit = 25 } = {}) {
  const needle = String(query || '').trim().toLowerCase();
  const skills = loadLibrary().skills;
  if (!needle) return [];
  const scored = [];
  for (const skill of skills) {
    const haystack =
      `${skill.id} ${skill.title} ${skill.description} ${skill.category} ${skill.categoryLabel}`.toLowerCase();
    if (!haystack.includes(needle)) continue;
    let score = 1;
    if (skill.title.toLowerCase().includes(needle)) score += 3;
    if (skill.description.toLowerCase().includes(needle)) score += 1;
    if (skill.categoryLabel.includes(needle)) score += 1;
    scored.push({ score, skill });
  }
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, Math.max(1, Math.min(limit, 50))).map(({ skill }) => ({
    id: skill.id,
    name: skill.title,
    description: skill.description,
    source: 'library',
    kind: 'skill',
    sourceUrl: null,
    url: null,
    version: skill.version || null,
    category: skill.category,
    categoryLabel: skill.categoryLabel || null,
  }));
}

/** 按 id 取技能（含 SKILL.md 正文）。不存在返回 null。 */
export function getLibrarySkill(id) {
  if (typeof id !== 'string' || !id.startsWith('lib-')) return null;
  return loadLibrary().skills.find((skill) => skill.id === id) || null;
}

/** 推荐用候选：把库内技能映射为 recommend 的候选结构（限制数量防膨胀）。 */
export function libraryCandidates(query, { limit = 8 } = {}) {
  return searchLibrary(query, { limit }).map((item) => ({
    id: item.id,
    skillId: item.id,
    title: item.name,
    name: item.name,
    description: item.description,
    category: item.category,
    categoryLabel: `内置库 · ${item.categoryLabel || ''}`.trim(),
    sourceUrl: null,
  }));
}

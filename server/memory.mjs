/**
 * 团队记忆（TEAM_MEMORY，AGENTS.md 模式的团队版）。
 *
 * 每个团队空间一份 Markdown 记忆文件，存放项目结构、构建/测试命令、
 * 已踩过的坑和用户偏好修正。任务收尾时由平台增量追加结构化条目，
 * 执行时作为常驻背景注入上下文，替代重复回放历史检查点。
 *
 * 文件保存在 <dataDir>/team-memory/<teamId>.md；团队删除时由调用方清理。
 * 读写都是追加/截断式的简单文本操作，不做并发锁（单写者：控制平面）。
 */

import fs from 'node:fs';
import path from 'node:path';

const MAX_FILE_CHARS = 64_000;
const SECTION_CHAR_BUDGET = 4_000;

function memoryPath(dataDir, teamId) {
  if (!teamId || !/^[a-zA-Z0-9_-]{1,128}$/.test(String(teamId)))
    throw new Error('无效的团队 ID。');
  return path.join(dataDir, 'team-memory', `${teamId}.md`);
}

/** 读取团队记忆全文（用于注入执行上下文）。不存在或为空返回 null。 */
export function readTeamMemory(dataDir, teamId, { maxChars = SECTION_CHAR_BUDGET } = {}) {
  let content;
  try {
    content = fs.readFileSync(memoryPath(dataDir, teamId), 'utf8');
  } catch {
    return null;
  }
  const trimmed = content.trim();
  if (!trimmed) return null;
  return trimmed.length > maxChars ? trimmed.slice(-maxChars) : trimmed;
}

/** 直接覆盖写入（供 API/PM 全量更新）。 */
export function writeTeamMemory(dataDir, teamId, content) {
  const file = memoryPath(dataDir, teamId);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const clean = String(content || '').slice(0, MAX_FILE_CHARS);
  fs.writeFileSync(file, clean, 'utf8');
  return clean.length;
}

/**
 * 任务收尾时追加一条结构化记忆。
 * @param {object} entry { teamId, taskTitle, outcome ('verified'|'failed'|'completed'),
 *   lessons (string), commands (string[]), preferences (string) }
 * @returns {boolean} 是否写入（无实质内容时不写）
 */
export function appendTeamMemory(dataDir, entry = {}) {
  const { teamId, taskTitle, outcome, lessons, commands, preferences } = entry;
  if (!teamId) return false;
  const lines = [];
  if (lessons && String(lessons).trim()) lines.push(`- 教训：${String(lessons).trim().slice(0, 800)}`);
  if (Array.isArray(commands) && commands.length)
    lines.push(`- 命令：${commands.filter(Boolean).slice(0, 5).map(String).join('；').slice(0, 500)}`);
  if (preferences && String(preferences).trim())
    lines.push(`- 偏好：${String(preferences).trim().slice(0, 500)}`);
  if (!lines.length) return false;
  const header = `\n## ${new Date().toISOString().slice(0, 10)} · ${String(taskTitle || '任务').slice(0, 120)}（${outcome || 'completed'}）\n`;
  const block = `${header}${lines.join('\n')}\n`;
  const file = memoryPath(dataDir, teamId);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  let existing = '';
  try {
    existing = fs.readFileSync(file, 'utf8');
  } catch {
    existing = '# 团队记忆\n\n由工作台自动维护：项目约定、验证命令、踩坑记录与用户偏好修正。\n';
  }
  let next = existing + block;
  // 超限时从头部丢弃最旧的条目，保住文件头与最近内容。
  if (next.length > MAX_FILE_CHARS) {
    const tail = next.slice(next.length - MAX_FILE_CHARS + existing.slice(0, existing.indexOf('\n## ', 1) + 1).length);
    next = `${existing.slice(0, existing.indexOf('\n## ', 1) + 1)}${tail}`;
  }
  fs.writeFileSync(file, next, 'utf8');
  return true;
}

/** 删除团队记忆文件（团队删除时调用）。 */
export function deleteTeamMemory(dataDir, teamId) {
  try {
    fs.rmSync(memoryPath(dataDir, teamId), { force: true });
    return true;
  } catch {
    return false;
  }
}

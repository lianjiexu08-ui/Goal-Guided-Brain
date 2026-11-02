/**
 * 验收标准提取器（platform-reliability-plan #1 的服务端统一实现）。
 * 从工作区 PRD/README 的「验收标准/验收/DoD」章节提取列表项，供派活时自动登记
 * 验收清单。没有验收章节返回空数组（门禁对无清单任务不生效，但不报错）。
 */
import fs from 'node:fs';
import path from 'node:path';

const PRD_CANDIDATES = ['PRD.md', 'prd.md', 'README.md', '需求.md'];
const SECTION_RE = /验收|acceptance|DoD|交付标准/i;
const ENTRY_RE = /^\s*(?:[-*•]|\d+[.、)])\s+(.*)$/;

export function extractAcceptanceFromWorkspace(workspace) {
  const items = [];
  for (const name of PRD_CANDIDATES) {
    const file = path.join(workspace, name);
    if (!fs.existsSync(file)) continue;
    let text;
    try { text = fs.readFileSync(file, 'utf8'); } catch { continue; }
    let inSection = false;
    for (const line of text.split('\n')) {
      const heading = line.match(/^#{1,4}\s*(.*)$/);
      if (heading) {
        inSection = SECTION_RE.test(heading[1]);
        continue;
      }
      if (!inSection) continue;
      const entry = line.match(ENTRY_RE);
      if (!entry) continue;
      const requirement = entry[1].replace(/`/g, '').trim();
      if (requirement.length < 4 || requirement.length > 300) continue;
      items.push({ id: `ac-${items.length + 1}`, requirement, verifyHint: '' });
      if (items.length >= 20) return items;
    }
    if (items.length) break;
  }
  return items;
}

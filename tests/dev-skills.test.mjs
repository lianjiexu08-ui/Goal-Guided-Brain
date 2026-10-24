import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SKILLS, validateRole } from '../server/roles.mjs';
import { Store } from '../server/store.mjs';

const sandbox = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ggb-devskills-'));
  const workspace = path.join(dir, 'project');
  fs.mkdirSync(workspace);
  return { dir, workspace, dataDir: path.join(dir, 'data') };
};

test('development skills are registered and resolvable to on-disk SKILL.md', () => {
  const dev = ['development-workflow', 'code-review', 'bug-fix', 'project-map'];
  for (const id of dev) {
    const skill = SKILLS.find(item => item.id === id);
    assert.ok(skill, `Skill ${id} 未注册`);
    const file = path.resolve('roles', skill.role, 'skills', id, 'SKILL.md');
    assert.ok(fs.existsSync(file), `缺少 ${file}`);
    const text = fs.readFileSync(file, 'utf8');
    assert.match(text, /^---\r?\n/, `${id} 缺少 frontmatter`);
    assert.ok(text.includes(`name: ${id}`), `${id} frontmatter name 不匹配`);
  }
});

test('developer role accepts the new development skills', () => {
  for (const id of ['development-workflow', 'code-review', 'bug-fix', 'project-map']) {
    const role = validateRole({ name: 'dev', instructions: 'x', skillIds: [id] });
    assert.deepEqual(role.skillIds, [id]);
  }
});

test('developer seed carries development-workflow, code-review and bug-fix', () => {
  const s = sandbox();
  const store = new Store(s.dataDir, s.workspace, { seedProjectManager: true });
  try {
    const developer = store.role('developer');
    assert.ok(developer.skillIds.includes('development-workflow'));
    assert.ok(developer.skillIds.includes('code-review'));
    assert.ok(developer.skillIds.includes('bug-fix'));
    assert.match(developer.instructions, /project-map|五步法|code-review/);
  } finally {
    store.close();
    fs.rmSync(s.dir, { recursive: true, force: true });
  }
});

test('existing developer role is migrated to include new dev skills without clobbering instructions', () => {
  const s = sandbox();
  // 先造一个只有旧 Skill、带自定义指令的 developer。
  const seedDir = s.dataDir;
  const first = new Store(seedDir, s.workspace, { seedProjectManager: true });
  first.saveRole({ ...first.role('developer'), skillIds: ['development-workflow'], instructions: '我自己的开发指令。' }, 'developer');
  first.close();
  // 重新打开应触发迁移：补上 code-review / bug-fix，但保留自定义指令。
  const store = new Store(seedDir, s.workspace, { seedProjectManager: true });
  try {
    const developer = store.role('developer');
    assert.ok(developer.skillIds.includes('code-review'));
    assert.ok(developer.skillIds.includes('bug-fix'));
    assert.equal(developer.instructions, '我自己的开发指令。');
  } finally {
    store.close();
    fs.rmSync(s.dir, { recursive: true, force: true });
  }
});

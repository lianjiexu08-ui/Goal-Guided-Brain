import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadLibrary, libraryCount, searchLibrary, getLibrarySkill, libraryCandidates } from '../server/skill-library.mjs';
import { CapabilityService } from '../server/capabilities.mjs';
import { Records, RECORDS_SCHEMA } from '../server/records.mjs';
import { DatabaseSync } from 'node:sqlite';

test('内置技能库：加载 2000 个技能且结构完整', () => {
  const lib = loadLibrary();
  assert.equal(libraryCount(), 2000);
  const ids = new Set(lib.skills.map((s) => s.id));
  assert.equal(ids.size, 2000, '技能 id 必须唯一');
  for (const skill of lib.skills.slice(0, 50)) {
    assert.ok(skill.id.startsWith('lib-'));
    assert.ok(skill.title && skill.description);
    assert.ok(skill.body.includes('## 执行步骤'));
    assert.ok(skill.body.includes('## 验证方式'));
    assert.ok(skill.body.includes('## 注意事项'));
  }
});

test('搜索：中英文关键词命中且排序合理', () => {
  const cn = searchLibrary('React 审查');
  assert.ok(cn.length > 0);
  assert.ok(cn.some((item) => item.id.includes('react')));
  const en = searchLibrary('postgresql');
  assert.ok(en.some((item) => item.id.includes('postgresql')));
  // 空查询返回空
  assert.deepEqual(searchLibrary(''), []);
  // limit 生效
  assert.ok(searchLibrary('e', { limit: 3 }).length <= 3);
});

test('按 id 取技能与非法输入', () => {
  const lib = loadLibrary();
  const first = lib.skills[0];
  assert.equal(getLibrarySkill(first.id).id, first.id);
  assert.equal(getLibrarySkill('nonexistent'), null);
  assert.equal(getLibrarySkill('no-prefix'), null);
  assert.equal(getLibrarySkill(null), null);
});

test('libraryCandidates：推荐候选结构完整', () => {
  const candidates = libraryCandidates('kubernetes 部署', { limit: 5 });
  assert.ok(candidates.length > 0 && candidates.length <= 5);
  for (const item of candidates) {
    assert.ok(item.skillId.startsWith('lib-'));
    assert.ok(item.categoryLabel.startsWith('内置库'));
    assert.equal(item.sourceUrl, null);
  }
});

test('离线安装：library 技能走现有 path 安装流程并完成 digest 固定', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-libinstall-'));
  try {
    const db = new DatabaseSync(':memory:');
    db.exec(RECORDS_SCHEMA);
    const records = new Records(db);
    const service = new CapabilityService({
      store: { records },
      vault: { get: () => null },
      dataDir: path.join(dir, 'data'),
    });
    // 模拟 install 的 library 分支：取技能正文写临时目录后走 path 安装
    const target = searchLibrary('kubernetes 部署', { limit: 1 })[0];
    const libSkill = getLibrarySkill(target.id);
    const staging = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-libskill-'));
    const skillDir = path.join(staging, target.id);
    fs.mkdirSync(skillDir, { recursive: true });
    fs.writeFileSync(path.join(skillDir, 'SKILL.md'), libSkill.body);
    const installed = await service.install({ path: skillDir, source: 'library', id: target.id });
    assert.equal(installed.enabled, false);
    assert.equal(installed.skills.length, 1);
    assert.equal(installed.source, 'library');
    assert.ok(installed.digest);
    // 同 id 重复安装复用同一路径（digest 一致）
    const again = await service.install({ path: skillDir, source: 'library', id: target.id });
    assert.equal(again.path, installed.path);
    fs.rmSync(staging, { recursive: true, force: true });
    db.close();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

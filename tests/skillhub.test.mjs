import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Store } from '../server/store.mjs';
import { CapabilityService, assessCapabilityRisk } from '../server/capabilities.mjs';

function setup(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ggb-hub-'));
  const workspace = path.join(dir, 'project');
  fs.mkdirSync(workspace);
  const store = new Store(path.join(dir, 'data'), workspace);
  const capabilities = new CapabilityService({ store, vault: null, dataDir: path.join(dir, 'data') });
  t.after(() => { store.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  return { store, capabilities };
}

// 自维护 Hub 的搜索依赖公开 catalog.json；离线环境跳过网络用例。
async function hubReachable() {
  try {
    const response = await fetch('https://raw.githubusercontent.com/lianjiexu08-ui/skills-hub/main/catalog.json', {
      signal: AbortSignal.timeout(8000),
    });
    return response.ok;
  } catch {
    return false;
  }
}

test('自维护 Hub 的 catalog 包含开发相关 Skill 且字段完整', async t => {
  if (!(await hubReachable())) return t.skip('无法连接自维护 Hub');
  const { capabilities } = setup(t);
  const review = await capabilities.search('hub', 'review');
  assert.ok(review.length >= 1, '应能搜到 code-review');
  const entry = review.find(item => item.id === 'code-review');
  assert.ok(entry, '缺少 code-review');
  assert.equal(entry.source, 'hub');
  assert.equal(entry.kind, 'skill');
  assert.match(entry.sourceUrl, /skills-hub\/tree\/main\/skills\/code-review/);
  assert.ok(entry.description.length > 10);

  const gate = await capabilities.search('hub', '验证');
  assert.ok(gate.some(item => item.id === 'verification-gate'), '应能搜到 verification-gate');
});

test('从自维护 Hub 按 GitHub tree URL 安装 Skill 并固定摘要', async t => {
  const { store, capabilities } = setup(t);
  const row = await capabilities.install({
    source: 'git',
    sourceUrl: 'https://github.com/lianjiexu08-ui/skills-hub/tree/main/skills/change-impact',
  });
  assert.equal(row.name, 'change-impact');
  assert.equal(row.kind, 'skill');
  assert.equal(row.enabled, false, '安装后默认不启用');
  assert.ok(/^[a-f0-9]{64}$/.test(row.digest), '必须保存内容摘要');
  assert.deepEqual(row.skills.map(item => item.name), ['change-impact']);

  const risk = assessCapabilityRisk(row);
  assert.equal(risk.level, 'low', '纯指令类 Skill 应为低风险');
  assert.equal(risk.requiresReview, false);

  // 摘要可校验，内容未变时能正常生成注入补丁（需先启用）
  capabilities.action(row.id, 'enable', { actor: 'owner' });
  const patch = capabilities.patch({ capabilityIds: [row.id] });
  assert.ok(patch.patches.some(item => item.id === 'skill-filesystem'));
  assert.equal(store.records.get('capabilities', row.id).digest, row.digest);
});

test('Hub 目录拉取不受 raw CDN 陈旧缓存影响，且整份目录只拉一次', async t => {
  if (!(await hubReachable())) return t.skip('无法连接自维护 Hub');
  const { capabilities } = setup(t);
  const first = await capabilities.hubCatalog();
  assert.ok(first.skills.length >= 200, `目录条目偏少：${first.skills.length}`);
  for (const id of ['ui-automation', 'device-automation', 'disposable-workspace', 'issue-tracker-workflow']) {
    assert.ok(first.skills.some(skill => skill.id === id), `目录缺少 ${id}`);
  }
  // 跨领域覆盖：分类索引必须存在且不只包含开发类。
  assert.ok(first.categories && Object.keys(first.categories).length >= 15, '缺少分类索引');
  for (const category of ['writing', 'data', 'finance', 'legal', 'learning', 'personal']) {
    assert.ok(first.categories[category] > 0, `分类 ${category} 为空`);
  }
  const cached = capabilities.hubCatalogCache;
  assert.ok(cached && cached.until > Date.now(), '应缓存整份目录');
  const second = await capabilities.hubCatalog();
  assert.equal(second, cached.data, '第二次应复用缓存，不重复拉取');
});

 test('Hub 目录经 GitHub API 获取原始内容（不回退到旧 CDN 缓存）', async t => {
  if (!(await hubReachable())) return t.skip('无法连接自维护 Hub');
  const { capabilities } = setup(t);
  const catalog = await capabilities.hubCatalog();
  // 这三个 Skill 只在较新版本的自维护库中存在；旧 CDN 缓存（25 条）里没有。
  for (const id of ['worktree-isolation', 'terminal-session', 'external-publishing']) {
    assert.ok(catalog.skills.some(skill => skill.id === id), `目录缺少 ${id}，可能回退到了旧缓存`);
  }
  assert.ok(catalog.skills.length >= 200, `目录条目偏少：${catalog.skills.length}`);
});

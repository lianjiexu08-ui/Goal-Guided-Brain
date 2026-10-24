import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Store } from '../server/store.mjs';
import { CapabilityService } from '../server/capabilities.mjs';

function setup(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ggb-route-int-'));
  const workspace = path.join(dir, 'project');
  fs.mkdirSync(workspace);
  const store = new Store(path.join(dir, 'data'), workspace);
  const capabilities = new CapabilityService({ store, vault: null, dataDir: path.join(dir, 'data') });
  t.after(() => { store.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  return { store, capabilities };
}

async function hubReachable() {
  // 与 hubCatalog 相同的回退顺序；GitHub API 被限流时 jsDelivr 仍可用。
  for (const url of [
    'https://api.github.com/repos/lianjiexu08-ui/skills-hub/contents/catalog.json?ref=main',
    'https://cdn.jsdelivr.net/gh/lianjiexu08-ui/skills-hub@main/catalog.json',
    'https://raw.githubusercontent.com/lianjiexu08-ui/skills-hub/main/catalog.json',
  ]) {
    try {
      const response = await fetch(url, {
        headers: url.includes('api.github.com') ? { Accept: 'application/vnd.github.raw' } : {},
        signal: AbortSignal.timeout(8000),
      });
      if (response.status === 403 || response.status === 429) continue; // 限流，试下一个源
      if (response.ok) return true;
    } catch {}
  }
  return false;
}

test('推荐覆盖内置 Skill 与 Hub 目录，并标注来源', async t => {
  if (!(await hubReachable())) return t.skip('无法连接自维护 Hub');
  const { capabilities } = setup(t);
  const results = await capabilities.recommend('审阅合同风险', { limit: 6 });
  const contract = results.find(item => item.id === 'contract-review');
  assert.ok(contract, '应推荐 contract-review');
  assert.equal(contract.source, 'hub');
  assert.ok(contract.installUrl.includes('/tree/main/skills/contract-review'));
  assert.ok(contract.reason.length > 0);

  // 内置 Skill 也在候选中（例如 team-orchestration 的职责是协作编排）。
  const builtin = await capabilities.recommend('团队协作编排与任务分派', { limit: 8 });
  assert.ok(builtin.some(item => item.source === 'builtin'), '内置 Skill 应参与推荐');
});

test('已安装能力优先于同级 Hub 条目并被标记 installed', async t => {
  if (!(await hubReachable())) return t.skip('无法连接自维护 Hub');
  const { store, capabilities } = setup(t);
  // 安装并启用 Hub 上的 code-review，确认推荐里变成 installed。
  const row = await capabilities.install({
    source: 'git',
    sourceUrl: 'https://github.com/lianjiexu08-ui/skills-hub/tree/main/skills/code-review',
  });
  capabilities.action(row.id, 'enable', { actor: 'owner' });
  assert.ok(store.records.get('capabilities', row.id).enabled);

  const results = await capabilities.recommend('代码审查 diff', { limit: 8 });
  const hit = results.find(item => item.capabilityId === row.id || item.id === row.id);
  assert.ok(hit, '已安装能力应出现在推荐里');
  assert.equal(hit.source, 'installed');
  assert.equal(hit.installed, true);
  assert.equal(hit.enabled, true);
  assert.equal(hit.capabilityId, row.id, '应给出可直接绑定的 capability id');
  assert.equal(hit.title, '代码审查', '展示信息应沿用 Hub 的中文标题');
});

test('Hub 不可用时仍能用内置与已安装能力推荐', async t => {
  const { capabilities } = setup(t);
  capabilities.hubCatalog = async () => { throw new Error('hub offline'); };
  const results = await capabilities.recommend('代码审查', { limit: 5 });
  const source = new Set(results.map(item => item.source));
  assert.ok(source.size > 0, '应至少返回内置推荐');
  assert.ok(!source.has('hub'), 'Hub 失败时不应出现 hub 条目');
});

test('HTTP /api/capabilities/recommend 返回可绑定建议', async t => {
  const { createWorkbench } = await import('../server/index.mjs');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ggb-route-api-'));
  const workspace = path.join(dir, 'project');
  fs.mkdirSync(workspace);
  const app = createWorkbench({ dir, dataDir: path.join(dir, 'data'), workspace, requireCredential: false });
  t.after(async () => { await app.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${app.server.address().port}`;

  const response = await fetch(`${base}/api/capabilities/recommend?q=${encodeURIComponent('预算与成本控制')}&limit=5`);
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.ok(Array.isArray(body.items) && body.items.length > 0);
  assert.ok(body.items.some(item => item.id === 'budget-planning' || item.id === 'cost-control'));
  for (const item of body.items) {
    assert.ok(item.source, '每条建议都应标注来源');
    assert.ok(['builtin', 'installed', 'hub'].includes(item.source));
    assert.equal(typeof item.score, 'number');
  }

  // 空查询不应编造结果
  const empty = await (await fetch(`${base}/api/capabilities/recommend?q=`)).json();
  assert.deepEqual(empty.items, []);
});

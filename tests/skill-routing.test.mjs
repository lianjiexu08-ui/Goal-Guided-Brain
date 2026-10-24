import test from 'node:test';
import assert from 'node:assert/strict';
import { tokenize, recommend, collectCandidates } from '../server/skill-routing.mjs';

const candidates = [
  { id: 'contract-review', title: '合同审阅', description: '在签署前识别合同中的关键风险条款。', category: 'legal', categoryLabel: '法务与行政' },
  { id: 'budget-planning', title: '预算规划', description: '为团队或项目制定预算。', category: 'finance', categoryLabel: '财务' },
  { id: 'churn-analysis', title: '流失分析', description: '找出用户离开的原因与信号。', category: 'business', categoryLabel: '商业与运营' },
  { id: 'flaky-test', title: '不稳定测试', description: '诊断和修复不稳定的测试。', category: 'quality', categoryLabel: '测试与质量' },
  { id: 'mobile-release', title: '移动端发布', description: '准备并提交移动应用版本。', category: 'mobile', categoryLabel: '移动与桌面' },
];

test('tokenize 同时产出 ASCII 词、中文 n-gram 与别名展开', () => {
  const terms = tokenize('审一下合同的风险');
  assert.ok(terms.includes('合同'), '应包含中文整词');
  assert.ok(terms.includes('风险'));
  assert.ok(terms.includes('legal'), '应展开别名');
  assert.ok(!terms.includes('使用'), '应过滤停用词');
});

test('推荐能把任务描述匹配到正确领域', () => {
  const contract = recommend('帮我审一下这份合同的风险', candidates);
  assert.equal(contract[0].id, 'contract-review');
  assert.ok(contract[0].reason.includes('合同'));

  const budget = recommend('做一个财务预算', candidates);
  assert.equal(budget[0].id, 'budget-planning');

  const churn = recommend('分析用户流失原因', candidates);
  assert.equal(churn[0].id, 'churn-analysis');

  const flaky = recommend('排查一个不稳定的测试', candidates);
  assert.equal(flaky[0].id, 'flaky-test');

  const mobile = recommend('移动应用发布准备', candidates);
  assert.equal(mobile[0].id, 'mobile-release');
});

test('无关查询返回空，不硬凑结果', () => {
  assert.deepEqual(recommend('量子色动力学的重整化', candidates), []);
  assert.deepEqual(recommend('', candidates), []);
});

test('理由只保留最长匹配，去掉子串碎片', () => {
  const [top] = recommend('合同风险', candidates);
  assert.ok(!top.reason.includes('的风'), `理由不应包含碎片：${top.reason}`);
});

test('limit 生效且结果按分数降序', () => {
  const results = recommend('测试与质量', candidates, { limit: 2 });
  assert.ok(results.length <= 2);
  for (let index = 1; index < results.length; index += 1)
    assert.ok(results[index - 1].score >= results[index].score);
});

test('候选合并按 installed > builtin > hub 去重', () => {
  const merged = collectCandidates({
    hub: [{ id: 'code-review', title: '代码审查', description: 'x' }],
    builtin: [{ id: 'code-review', title: '代码审查（内置）', description: 'x' }],
    installed: [{ id: 'code-review', title: '代码审查（已装）', description: 'x' }],
  });
  assert.equal(merged.length, 1);
  assert.equal(merged[0].source, 'installed');
  assert.equal(merged[0].installed, true);

  const onlyBuiltin = collectCandidates({
    hub: [{ id: 'x', title: 'hub' }],
    builtin: [{ id: 'x', title: 'builtin' }],
  });
  assert.equal(onlyBuiltin[0].source, 'builtin');
  assert.equal(onlyBuiltin[0].builtin, true);
});

test('buildIndex 对高频词降权，避免泛词主导', () => {
  const noisy = [
    { id: 'a', title: '数据', description: '数据分析' },
    { id: 'b', title: '数据', description: '数据处理' },
    { id: 'c', title: '数据', description: '数据报表' },
    { id: 'contract-review', title: '合同审阅', description: '合同风险' },
  ];
  const results = recommend('数据 合同', noisy);
  // “数据”在三个文档中都出现，IDF 低；“合同”只在一个出现，应把它排到第一。
  assert.equal(results[0].id, 'contract-review');
});

/**
 * Skill 路由：根据任务描述从「内置 Skill / 已安装能力 / 自维护 Hub」中推荐相关项。
 *
 * 设计约束：
 * - 纯本地计算，不调用模型，结果确定且可测试。
 * - 只做推荐，不自动安装、不自动授权。Hub 项必须走现有审批闸门。
 * - 中文没有分词器时用 2/3-gram，并对高频词做逆文档频率惩罚，避免“用户/数据”这类词到处命中。
 */

const STOP_TERMS = new Set([
  '使用', '可以', '需要', '进行', '以及', '或者', '如果', '这个', '那个', '我们', '他们',
  '一个', '什么', '怎么', '如何', '通过', '根据', '相关', '内容', '问题', '方法', '时候',
  'the', 'and', 'for', 'with', 'that', 'this', 'from', 'are', 'was', 'you', 'use', 'when',
]);

// 常见中文说法到英文分类/关键词的映射，补足纯 n-gram 的语义缺口。
const ALIASES = {
  测试: ['test', 'quality', 'testing'],
  质量: ['quality'],
  审查: ['review', 'audit'],
  审阅: ['review', 'audit', 'contract'],
  检查: ['review', 'check', 'audit'],
  评审: ['review'],
  发布: ['release', 'deploy', 'deployment'],
  部署: ['deploy', 'deployment', 'operations'],
  运维: ['operations', 'sre'],
  安全: ['security', 'threat', 'vulnerability'],
  合规: ['legal', 'compliance', 'license'],
  法务: ['legal', 'contract', 'license'],
  合同: ['contract', 'legal'],
  财务: ['finance', 'budget', 'cost'],
  预算: ['budget', 'finance'],
  成本: ['cost', 'finance'],
  写作: ['writing', 'content', 'article'],
  文档: ['writing', 'docs', 'documentation'],
  翻译: ['translation', 'localization'],
  数据: ['data', 'analytics'],
  分析: ['analysis', 'analytics'],
  指标: ['metrics', 'analytics'],
  看板: ['dashboard', 'visualization'],
  设计: ['design', 'ui', 'ux'],
  界面: ['ui', 'design'],
  体验: ['ux', 'usability'],
  排版: ['typography', 'design'],
  配色: ['color', 'design'],
  产品: ['product', 'prd', 'discovery'],
  需求: ['requirement', 'prd', 'spec'],
  路线图: ['roadmap', 'planning'],
  研究: ['research', 'intel'],
  调研: ['research', 'discovery'],
  竞品: ['competitor', 'intel'],
  教学: ['learning', 'teaching', 'curriculum'],
  课程: ['curriculum', 'lesson'],
  学习: ['learning', 'study'],
  会议: ['meeting', 'notes', 'facilitation'],
  复盘: ['retro', 'review', 'postmortem'],
  计划: ['planning', 'roadmap'],
  效率: ['productivity', 'planning', 'personal'],
  习惯: ['habit', 'personal'],
  时间: ['time', 'planning', 'personal'],
  视频: ['video', 'script', 'storyboard'],
  播客: ['podcast', 'audio'],
  社交: ['social', 'post', 'content'],
  内容: ['content', 'writing'],
  自动化: ['automation', 'workflow'],
  集成: ['integration', 'api', 'webhook'],
  接口: ['api', 'contract', 'integration'],
  定时: ['cron', 'schedule', 'automation'],
  移动: ['mobile', 'ios', 'android'],
  应用商店: ['app-store', 'mobile'],
  权限: ['permission', 'access', 'security'],
  性能: ['performance', 'latency'],
  慢: ['performance', 'latency', 'optimization'],
  内存: ['memory', 'performance'],
  排查: ['debugging', 'troubleshooting', 'incident'],
  故障: ['incident', 'troubleshooting', 'outage'],
  告警: ['alert', 'observability', 'monitoring'],
  日志: ['logging', 'observability'],
  监控: ['monitoring', 'observability'],
  备份: ['backup', 'restore', 'disaster'],
  恢复: ['restore', 'recovery', 'disaster'],
  容量: ['capacity', 'planning', 'scaling'],
  容器: ['container', 'kubernetes', 'docker'],
  镜像: ['container', 'image'],
  数据库: ['data', 'migration', 'sql'],
  迁移: ['migration', 'data'],
  重构: ['refactor', 'engineering'],
  依赖: ['dependency', 'audit'],
  漏洞: ['vulnerability', 'security', 'dependency'],
  密钥: ['secret', 'credential', 'security'],
  策略: ['strategy', 'planning'],
  商业: ['business', 'model'],
  定价: ['pricing', 'finance', 'business'],
  流失: ['churn', 'retention', 'business'],
  客户: ['customer', 'support', 'business'],
  销售: ['sales', 'pipeline', 'business'],
  营销: ['marketing', 'seo', 'content'],
  推荐: ['recommend', 'routing'],
  检索: ['rag', 'retrieval', 'search'],
  模型: ['model', 'ai', 'llm'],
  提示词: ['prompt', 'ai'],
  评测: ['evaluation', 'benchmark', 'quality'],
  上下文: ['context', 'ai'],
  任务: ['task', 'planning', 'orchestration'],
  协作: ['collaboration', 'orchestration', 'team'],
  交接: ['handoff', 'collaboration'],
  工单: ['issue', 'tracker', 'ticket'],
  风险: ['risk', 'security', 'threat'],
  隐私: ['privacy', 'security', 'data'],
  审计: ['audit', 'security', 'compliance'],
};

const normalize = (value) => String(value || '').toLowerCase().normalize('NFKC');

/** 把文本拆成可比较的词元：ASCII 词 + 中文 2/3-gram + 别名展开。 */
export function tokenize(value) {
  const text = normalize(value);
  const terms = new Set();
  for (const word of text.match(/[a-z0-9][a-z0-9+#._-]{1,}/g) || []) {
    if (!STOP_TERMS.has(word)) terms.add(word);
  }
  for (const run of text.match(/[\u4e00-\u9fff]+/g) || []) {
    // 中文字符均为单码点，用 Array.from 按码点拆分即可（不走 emoji 场景）。
    const chars = Array.from(run);
    for (let size = 2; size <= 3; size += 1) {
      for (let index = 0; index + size <= chars.length; index += 1) {
        const gram = chars.slice(index, index + size).join('');
        if (!STOP_TERMS.has(gram)) terms.add(gram);
      }
    }
    // 整段短词本身也作为词元（如“财务”“翻译”）。
    if (chars.length <= 4) terms.add(run);
  }
  for (const [key, expansions] of Object.entries(ALIASES)) {
    if (text.includes(key)) for (const term of expansions) terms.add(term);
  }
  return [...terms];
}

/**
 * 为候选建立索引。
 * weights: id 4 / title 3 / category 2 / description 1，标题与 ID 更能代表主题。
 */
export function buildIndex(candidates) {
  const documents = candidates.map((item) => {
    const fields = [
      { text: `${item.id || ''} ${item.name || ''}`.replace(/-/g, ' '), weight: 4 },
      { text: item.title || '', weight: 3 },
      { text: `${item.category || ''} ${item.categoryLabel || ''}`, weight: 2 },
      { text: item.description || '', weight: 1 },
    ];
    const counts = new Map();
    for (const field of fields) {
      for (const term of tokenize(field.text)) {
        counts.set(term, (counts.get(term) || 0) + field.weight);
      }
    }
    return { item, counts, length: Math.sqrt([...counts.values()].reduce((sum, value) => sum + value * value, 0)) || 1 };
  });
  // 逆文档频率：在多数条目中都出现的词（如“使用”“数据”）降低权重。
  const df = new Map();
  for (const doc of documents) for (const term of doc.counts.keys()) df.set(term, (df.get(term) || 0) + 1);
  const total = documents.length || 1;
  for (const [term, count] of df) df.set(term, Math.log(1 + total / (1 + count)));
  return { documents, df };
}

/** 对查询打分，返回带理由的排序结果。 */
export function recommend(query, candidates, { limit = 8, minScore = 0.5 } = {}) {
  const { documents, df } = buildIndex(candidates);
  const queryTerms = tokenize(query);
  if (!queryTerms.length) return [];
  const scored = [];
  for (const doc of documents) {
    let score = 0;
    const matched = [];
    for (const term of queryTerms) {
      const weight = doc.counts.get(term);
      if (!weight) continue;
      const idf = df.get(term) || 0;
      score += weight * idf;
      matched.push(term);
    }
    if (score <= 0) continue;
    const normalized = score / doc.length;
    if (normalized < minScore) continue;
    // 理由只保留最长的匹配词，去掉被包含的碎片（如“的风”之于“风险”）。
    const longestFirst = [...new Set(matched)].sort((a, b) => b.length - a.length);
    const cleaned = longestFirst.filter((term, index) =>
      !longestFirst.some((other, otherIndex) => otherIndex < index && other.includes(term)));
    scored.push({
      item: doc.item,
      score: Number(normalized.toFixed(4)),
      matched: cleaned.slice(0, 8),
    });
  }
  scored.sort((a, b) => b.score - a.score || String(a.item.id).localeCompare(String(b.item.id)));
  return scored.slice(0, limit).map((entry) => ({
    ...entry.item,
    score: entry.score,
    reason: `匹配：${entry.matched.join('、')}`,
  }));
}

/**
 * 汇总候选：内置 Skill + 已安装能力 + Hub 目录。
 * 身份键用 skillId（已安装项取技能名），这样同一个技能不会因 capability id
 * 不同而重复出现；合并后保留已安装项的绑定 id，展示信息优先用 Hub 的中文标题。
 */
export function collectCandidates({ builtin = [], installed = [], hub = [] }) {
  const merged = new Map();
  const rank = { hub: 1, builtin: 2, installed: 3 };
  const keyOf = (item) => item.skillId || item.id;
  const add = (item, source) => {
    if (!item || !item.id) return;
    const key = keyOf(item);
    const current = merged.get(key);
    if (current && rank[current.source] >= rank[source]) return;
    const flags = source === 'installed'
      ? { capabilityId: item.id, installed: true, builtin: false }
      : source === 'builtin'
        ? { installed: false, builtin: true }
        : { installed: false, builtin: false };
    if (!current) {
      merged.set(key, { ...item, ...flags, source });
      return;
    }
    merged.set(key, {
      ...current,
      ...item,
      id: item.id,
      ...(current.capabilityId ? { capabilityId: current.capabilityId } : {}),
      source,
      ...flags,
      title: current.title || item.title,
      description: current.description || item.description,
      category: current.category || item.category,
      categoryLabel: current.categoryLabel || item.categoryLabel,
      installUrl: current.installUrl || item.installUrl,
    });
  };
  for (const item of hub) add(item, 'hub');
  for (const item of builtin) add(item, 'builtin');
  for (const item of installed) add(item, 'installed');
  return [...merged.values()];
}

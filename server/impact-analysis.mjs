import { command } from './workspaces.mjs';

/**
 * 变更影响分析：根据工作树相对基准提交的差异，判定风险等级与通知范围。
 *
 * 纯规则实现（路径模式 + 规模），不依赖模型，结果可复现。
 * 只有拿到 Git 基准时才能给出确定结论；否则返回 unknown，不假装低风险。
 */

// 顺序有意义：先命中的高风险的类别会决定最终等级，但所有命中的原因都会保留。
const RULES = [
  { id: 'migration', risk: 'high', reason: '数据库结构或数据定义变更',
    patterns: [/(^|\/)migrations?\//i, /\.sql$/i, /schema\.(sql|prisma|rb|ts|js)$/i] },
  { id: 'auth', risk: 'high', reason: '涉及认证、授权或会话',
    patterns: [/(^|\/)(auth|authz|iam|acl|permissions?)(\/|\.|$)/i, /session/i, /login/i] },
  { id: 'secrets', risk: 'high', reason: '涉及凭据、密钥或加密',
    patterns: [/\.env(\.|$)/i, /secret/i, /credential/i, /vault/i, /crypto/i, /\.pem$|\.key$/i] },
  { id: 'delivery', risk: 'high', reason: '影响构建、部署或发布流程',
    patterns: [/(^|\/)\.github\/workflows\//i, /(^|\/)(deploy|deployment|helm|k8s|terraform)(\/|\.|$)/i, /Dockerfile$/i, /docker-compose/i] },
  { id: 'deps', risk: 'medium', reason: '依赖或构建配置变更',
    patterns: [/(^|\/)package\.json$/i, /(package-lock|pnpm-lock|yarn\.lock|bun\.lockb)$/i, /(^|\/)go\.mod$/i, /(^|\/)Cargo\.toml$/i, /(^|\/)pom\.xml$/i, /requirements\.txt$/i] },
  { id: 'api', risk: 'medium', reason: '可能影响对外接口契约',
    patterns: [/(^|\/)(api|routes?|controllers?|handlers?|endpoints?)(\/|\.|$)/i, /openapi|swagger/i, /\.proto$/i, /graphql/i] },
  { id: 'config', risk: 'medium', reason: '配置项变更',
    patterns: [/(^|\/)config(\/|\.|$)/i, /settings/i, /\.ya?ml$/i, /\.toml$/i] },
];

const RISK_ORDER = { unknown: 0, low: 1, medium: 2, high: 3 };
const RISK_LABEL = { low: '低', medium: '中', high: '高', unknown: '未知' };

const classify = (files) => {
  const categories = new Map();
  for (const file of files) {
    for (const rule of RULES) {
      if (!rule.patterns.some((pattern) => pattern.test(file))) continue;
      const entry = categories.get(rule.id) || { id: rule.id, risk: rule.risk, reason: rule.reason, files: [] };
      entry.files.push(file);
      categories.set(rule.id, entry);
    }
  }
  return [...categories.values()].map((entry) => ({ ...entry, files: entry.files.slice(0, 10), count: entry.files.length }));
};

/**
 * @param {{ path: string, baseCommit?: string|null, kind?: string, branch?: string|null }} workspace
 */
export async function analyzeImpact(workspace, { run = command, largeChange = 25, hugeChange = 80 } = {}) {
  if (!workspace?.path) return { risk: 'unknown', requiresAck: false, requiresNotice: false, reasons: ['执行目录不存在'], categories: [], files: [], baseCommit: null };
  if (!workspace.baseCommit || !['worktree', 'integration'].includes(workspace.kind || 'worktree')) {
    if (!workspace.baseCommit) {
      return { risk: 'unknown', requiresAck: false, requiresNotice: false, reasons: ['没有 Git 基准提交，无法比较改动'], categories: [], files: [], baseCommit: null };
    }
  }
  let status = '';
  let untracked = '';
  try {
    status = await run('git', ['diff', '--name-status', workspace.baseCommit], { cwd: workspace.path, timeout: 60000 });
    // 新建但未 add 的文件不在 diff 里，必须单独收集，否则新模块会被判成“没有改动”。
    untracked = await run('git', ['ls-files', '--others', '--exclude-standard'], { cwd: workspace.path, timeout: 60000 });
  } catch (error) {
    return { risk: 'unknown', requiresAck: false, requiresNotice: false, reasons: [`无法读取差异：${String(error?.message || error).slice(0, 200)}`], categories: [], files: [], baseCommit: workspace.baseCommit };
  }
  const tracked = status.split('\n').map((line) => line.trim()).filter(Boolean).map((line) => {
    const [state, ...rest] = line.split(/\s+/);
    return { state, file: rest.join(' ') };
  }).filter((entry) => entry.file);
  const added = untracked.split('\n').map((line) => line.trim()).filter(Boolean)
    .map((file) => ({ state: 'A', file }));
  const entries = [...tracked, ...added];
  const files = entries.map((entry) => entry.file);
  const addedCount = entries.filter((entry) => entry.state.startsWith('A')).length;
  const deleted = entries.filter((entry) => entry.state.startsWith('D')).length;
  const modified = entries.filter((entry) => entry.state.startsWith('M') || entry.state.startsWith('R')).length;

  if (!files.length) {
    return { risk: 'low', requiresAck: false, requiresNotice: false, reasons: ['没有检测到文件变更'], categories: [], files: [], stats: { total: 0, added: 0, modified: 0, deleted: 0 }, baseCommit: workspace.baseCommit };
  }

  const categories = classify(files);
  const reasons = categories.map((category) => category.reason);
  let risk = 'low';
  for (const category of categories) {
    if (RISK_ORDER[category.risk] > RISK_ORDER[risk]) risk = category.risk;
  }
  if (files.length >= hugeChange) {
    risk = 'high';
    reasons.push(`改动文件数 ${files.length} 超过 ${hugeChange}`);
  } else if (files.length >= largeChange && RISK_ORDER[risk] < RISK_ORDER.medium) {
    risk = 'medium';
    reasons.push(`改动文件数 ${files.length} 超过 ${largeChange}`);
  }
  if (deleted > 0 && RISK_ORDER[risk] < RISK_ORDER.medium) {
    risk = 'medium';
    reasons.push(`删除了 ${deleted} 个文件`);
  }
  if (!reasons.length) reasons.push('未命中高风险路径');

  return {
    risk,
    riskLabel: RISK_LABEL[risk],
    requiresAck: risk === 'high',
    requiresNotice: risk === 'high',
    reasons: [...new Set(reasons)],
    categories,
    files: files.slice(0, 50),
    stats: { total: files.length, added: addedCount, modified, deleted },
    baseCommit: workspace.baseCommit,
    branch: workspace.branch || null,
  };
}

export function summarizeImpact(impact) {
  const label = impact.riskLabel || RISK_LABEL[impact.risk] || impact.risk;
  const stats = impact.stats || {};
  return [
    `变更风险：${label}`,
    `文件：共 ${stats.total ?? 0}（新增 ${stats.added ?? 0} / 修改 ${stats.modified ?? 0} / 删除 ${stats.deleted ?? 0}）`,
    ...(impact.reasons?.length ? ['原因：', ...impact.reasons.map((reason) => `- ${reason}`)] : []),
    ...(impact.categories?.length
      ? ['', '命中类别：', ...impact.categories.map((category) => `- ${category.reason}（${category.count} 个文件）`)]
      : []),
    ...(impact.requiresAck ? ['', '需要所有者确认影响面后才能验收。'] : []),
  ].join('\n');
}

export const IMPACT_RULES = RULES;

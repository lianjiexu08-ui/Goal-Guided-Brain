export const SKILLS = [
  { id: 'team-orchestration', name: '团队编排', role: 'project_manager' },
  { id: 'product-planning', name: '产品规划', role: 'product' },
  { id: 'development-workflow', name: '开发验证', role: 'developer' },
  { id: 'personal-workflow', name: '资料与行动计划', role: 'assistant' },
];
export const COLORS = [
  '#c48625',
  '#5070db',
  '#278977',
  '#c45376',
  '#647580',
  '#b34e42',
];
export const ICONS = [
  'lightbulb',
  'code',
  'sparkles',
  'book',
  'search',
  'workflow',
];

export function validateRole(input, existing) {
  const value = { ...existing, ...input };
  const text = (key, max, required = false) => {
    const v = value[key] ?? '';
    if (typeof v !== 'string' || v.length > max || (required && !v.trim()))
      throw new Error(`助手的 ${key} 字段无效（最多 ${max} 字符）。`);
    return v.trim();
  };
  const list = (key, max, length) => {
    const v = value[key] ?? [];
    if (
      !Array.isArray(v) ||
      v.length > max ||
      v.some((s) => typeof s !== 'string' || !s.trim() || s.length > length)
    )
      throw new Error(`助手的 ${key} 列表无效。`);
    return [...new Set(v.map((s) => s.trim()))];
  };
  const tools = value.tools ?? { files: true, web: true, terminal: false };
  if (
    !tools ||
    typeof tools !== 'object' ||
    ['files', 'web', 'terminal'].some((k) => typeof tools[k] !== 'boolean')
  )
    throw new Error('工具开关必须为布尔值。');
  const skillIds = list('skillIds', 3, 80);
  if (skillIds.some((id) => !SKILLS.some((s) => s.id === id)))
    throw new Error('未知的 Skill。');
  if (value.color !== undefined && !COLORS.includes(value.color))
    throw new Error('无效的助手颜色。');
  if (value.icon !== undefined && !ICONS.includes(value.icon))
    throw new Error('无效的助手图标。');
  const workspaceMode = value.workspaceMode ?? 'shared';
  if (!['isolated', 'worktree', 'snapshot', 'shared'].includes(workspaceMode))
    throw new Error('无效的执行目录模式。');
  const requiredContextWindow = value.requiredContextWindow ?? 1;
  if (
    !Number.isSafeInteger(requiredContextWindow) ||
    requiredContextWindow < 1 ||
    requiredContextWindow > 10000000
  )
    throw new Error('最低上下文长度需要在 1 至 10000000 之间。');
  if (
    value.requiresVision !== undefined &&
    typeof value.requiresVision !== 'boolean'
  )
    throw new Error('视觉能力要求必须为布尔值。');
  return {
    name: text('name', 40, true),
    desc: text('desc', 240),
    greeting: text('greeting', 120),
    instructions: text('instructions', 12000, true),
    model: text('model', 120),
    requiredContextWindow,
    requiresVision: value.requiresVision === true,
    workflow: text('workflow', 20000),
    color: value.color ?? '#278977',
    icon: value.icon ?? 'sparkles',
    prompts: list('prompts', 6, 500),
    skillIds,
    providerIds: list('providerIds', 32, 160),
    capabilityIds: list('capabilityIds', 100, 160),
    nodeId: text('nodeId', 160),
    workspaceMode,
    tools: { files: tools.files, web: tools.web, terminal: tools.terminal },
    archived: existing?.archived ?? false,
  };
}

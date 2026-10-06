export const TASK_TYPES = Object.freeze([
  { id: 'planning', name: '规划' },
  { id: 'development', name: '开发' },
  { id: 'product', name: '产品' },
  { id: 'operations', name: '运维' },
  { id: 'research', name: '调研' },
  { id: 'verification', name: '验证' },
  { id: 'review', name: '复核' },
  { id: 'coordination', name: '协作' },
  { id: 'general', name: '通用' },
]);

const ids = new Set(TASK_TYPES.map((item) => item.id));
const aliases = new Map([
  ['plan', 'planning'],
  ['planning', 'planning'],
  ['dev', 'development'],
  ['engineering', 'development'],
  ['ops', 'operations'],
  ['devops', 'operations'],
  ['qa', 'verification'],
  ['test', 'verification'],
  ['testing', 'verification'],
  ['handoff', 'coordination'],
]);

export const normalizeTaskType = (value, fallback = 'general') => {
  if (typeof value !== 'string') return fallback;
  const normalized =
    aliases.get(value.trim().toLowerCase()) || value.trim().toLowerCase();
  return ids.has(normalized) ? normalized : fallback;
};

export const isTaskType = (value) =>
  typeof value === 'string' && ids.has(value.trim().toLowerCase());

export const taskTypeName = (value) =>
  TASK_TYPES.find((item) => item.id === value)?.name || value || '通用';

export const inferTaskType = ({
  taskType,
  role,
  check,
  summary = false,
  parentTaskType,
  capabilityCommand,
}) => {
  const explicit = normalizeTaskType(taskType, null);
  if (explicit) return explicit;
  if (check) return 'verification';
  if (summary) return 'review';
  if (capabilityCommand) return 'operations';
  const inherited = normalizeTaskType(parentTaskType, null);
  if (inherited) return inherited;
  const value = String(role || '').toLowerCase();
  if (value.includes('project_manager') || value.includes('planner'))
    return 'planning';
  if (
    value.includes('developer') ||
    value.includes('frontend') ||
    value.includes('backend')
  )
    return 'development';
  if (value.includes('product')) return 'product';
  if (
    value.includes('ops') ||
    value.includes('sre') ||
    value.includes('operator')
  )
    return 'operations';
  if (value.includes('research') || value.includes('analyst'))
    return 'research';
  if (
    value.includes('review') ||
    value.includes('qa') ||
    value.includes('test')
  )
    return 'verification';
  return 'general';
};

export const taskTypeForTask = (input, records, jobId) => {
  const job = records.get('jobs', jobId);
  const parentMeta = input.parentTaskId
    ? records.get('task-meta', input.parentTaskId)
    : null;
  return inferTaskType({
    taskType: input.taskType,
    role: input.role,
    check: input.check,
    summary: input.summary,
    parentTaskType: parentMeta?.taskType || job?.taskType,
    capabilityCommand: input.capabilityCommand,
  });
};

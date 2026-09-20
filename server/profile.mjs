export const PROFILE_LANGUAGES = ['auto', 'zh-CN', 'en-US'];
export const PROFILE_TONES = ['direct', 'friendly', 'formal'];
export const PROFILE_VERBOSITIES = ['concise', 'balanced', 'detailed'];
export const PROFILE_FORMATS = ['markdown', 'plain', 'json'];

export const DEFAULT_PROFILE = Object.freeze({
  name: '',
  language: 'zh-CN',
  timezone: 'Asia/Shanghai',
  tone: 'direct',
  verbosity: 'balanced',
  responseFormat: 'markdown',
  preferredRole: 'assistant',
  preferredProvider: '',
  preferredModel: '',
  habits: [],
  rules: [],
  instructions: '',
});

function text(value, key, max) {
  if (typeof value !== 'string' || value.length > max)
    throw new Error(`个人偏好的 ${key} 字段无效（最多 ${max} 字符）。`);
  return value.trim();
}

function list(value, key, maxItems, maxItemLength) {
  if (
    !Array.isArray(value) ||
    value.length > maxItems ||
    value.some((item) => typeof item !== 'string' || item.length > maxItemLength || !item.trim())
  )
    throw new Error(`个人偏好的 ${key} 列表无效。`);
  return [...new Set(value.map((item) => item.trim()))];
}

/**
 * Validate and normalise preferences that are safe to include in every task.
 * Keeping this schema small makes it useful across providers and UIs while
 * leaving role-specific instructions in the existing role records.
 */
export function validateProfile(input = {}, existing = DEFAULT_PROFILE) {
  if (!input || typeof input !== 'object' || Array.isArray(input))
    throw new Error('个人偏好格式不正确。');
  const value = { ...DEFAULT_PROFILE, ...existing, ...input };
  if (!PROFILE_LANGUAGES.includes(value.language))
    throw new Error('个人偏好语言无效。');
  if (!PROFILE_TONES.includes(value.tone))
    throw new Error('个人偏好语气无效。');
  if (!PROFILE_VERBOSITIES.includes(value.verbosity))
    throw new Error('个人偏好详细程度无效。');
  if (!PROFILE_FORMATS.includes(value.responseFormat))
    throw new Error('个人偏好输出格式无效。');
  return {
    name: text(value.name, 'name', 80),
    language: value.language,
    timezone: text(value.timezone, 'timezone', 80),
    tone: value.tone,
    verbosity: value.verbosity,
    responseFormat: value.responseFormat,
    preferredRole: text(value.preferredRole, 'preferredRole', 80),
    preferredProvider: text(value.preferredProvider, 'preferredProvider', 120),
    preferredModel: text(value.preferredModel, 'preferredModel', 120),
    habits: list(value.habits, 'habits', 24, 240),
    rules: list(value.rules, 'rules', 24, 240),
    instructions: text(value.instructions, 'instructions', 12000),
  };
}

export function profileContext(profile) {
  const value = validateProfile(profile);
  const lines = [
    `称呼：${value.name || '未设置'}`,
    `语言：${value.language}`,
    `时区：${value.timezone}`,
    `语气：${value.tone}`,
    `详细程度：${value.verbosity}`,
    `输出格式：${value.responseFormat}`,
    value.preferredRole ? `偏好助手：${value.preferredRole}` : '',
    value.preferredProvider ? `偏好模型提供方：${value.preferredProvider}` : '',
    value.preferredModel ? `偏好模型：${value.preferredModel}` : '',
    value.habits.length ? `工作习惯：\n${value.habits.map((item) => `- ${item}`).join('\n')}` : '',
    value.rules.length ? `长期规则：\n${value.rules.map((item) => `- ${item}`).join('\n')}` : '',
    value.instructions ? `补充偏好：\n${value.instructions}` : '',
  ].filter(Boolean);
  return lines.join('\n');
}

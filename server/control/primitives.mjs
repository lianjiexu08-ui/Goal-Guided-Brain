export const terminal = new Set([
  'completed',
  'failed',
  'cancelled',
  'interrupted',
  'state_unknown',
]);
export const messageKinds = new Set([
  'task',
  'question',
  'reply',
  'progress',
  'blocked',
  'handoff',
  'notice',
]);
export const collections = new Set([
  'jobs',
  'messages',
  'checkpoints',
  'artifacts',
  'operations',
  'attention',
  'board',
]);

export const fail = (message, status = 400) =>
  Object.assign(new Error(message), { status });

export const required = (value, label, max = 32000) => {
  if (typeof value !== 'string' || !value.trim() || value.length > max) {
    throw fail(`${label}不能为空，且不能超过 ${max} 字符。`);
  }
  return value.trim();
};

export const publicRecord = (record) => {
  if (!record) return record;
  const { tokenHash: _tokenHash, ...safe } = record;
  return safe;
};

export const bounded = (items, query) => {
  const limit = Math.max(1, Math.min(Number(query?.get?.('limit')) || 50, 100));
  const offset = Math.max(0, Number(query?.get?.('offset')) || 0);
  return {
    items: items.slice(offset, offset + limit),
    total: items.length,
    offset,
    limit,
  };
};

export const teamKey = (team) => team?.teamId || team?.id;

export const findTeam = (store, value) => {
  const key = String(value || '').trim();
  if (!key) return null;
  return (
    store
      .teamSpaces()
      .find(
        (team) => team.id === key || team.teamId === key || team.chatId === key,
      ) || null
  );
};

export const teamMeta = (store, taskId) =>
  store.records.get('task-meta', taskId) || {};

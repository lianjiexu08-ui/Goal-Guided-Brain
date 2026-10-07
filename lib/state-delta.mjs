// The transport preserves the complete public state. Entity collections use
// stable IDs so adding a newest-first task does not retransmit every old row.
const collections = new Set([
  'roles',
  'skillCatalog',
  'capabilities',
  'providers',
  'tasks',
  'sessions',
  'knowledge',
  'spaces',
  'teamTemplates',
]);
const unsafeKeys = new Set(['__proto__', 'prototype', 'constructor']);
const record = (value) =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
const keyList = (value) =>
  Array.isArray(value) &&
  value.every((key) => typeof key === 'string') &&
  new Set(value).size === value.length;
const entityMap = (value) => {
  if (!Array.isArray(value)) return null;
  const map = new Map();
  for (const item of value) {
    if (!record(item) || typeof item.id !== 'string' || map.has(item.id))
      return null;
    map.set(item.id, item);
  }
  return map;
};
const equal = (a, b) => JSON.stringify(a) === JSON.stringify(b);

export function createStateDelta(previous, next, baseEtag) {
  const set = {};
  const rows = {};
  for (const [key, value] of Object.entries(next)) {
    if (equal(previous[key], value)) continue;
    const before = collections.has(key) ? entityMap(previous[key]) : null;
    const after = collections.has(key) ? entityMap(value) : null;
    if (!before || !after) {
      set[key] = value;
      continue;
    }
    const patch = {
      upsert: [...after.values()].filter(
        (item) => !equal(before.get(item.id), item),
      ),
      remove: [...before.keys()].filter((id) => !after.has(id)),
    };
    if (!equal([...before.keys()], [...after.keys()]))
      patch.order = [...after.keys()];
    rows[key] = patch;
  }
  return {
    format: 'ggb-state-delta-v1',
    baseEtag,
    set,
    remove: Object.keys(previous).filter((key) => !Object.hasOwn(next, key)),
    rows,
  };
}

// Never mutate the accepted snapshot: a malformed or stale response must leave
// the user's current data intact, and unchanged rows should retain identity.
export function applyStateDelta(previous, delta, baseEtag) {
  const invalid = () => {
    throw new Error('状态更新版本或内容不完整，请重试。');
  };
  if (
    !record(previous) ||
    !record(delta) ||
    delta.format !== 'ggb-state-delta-v1' ||
    !baseEtag ||
    delta.baseEtag !== baseEtag ||
    !record(delta.set) ||
    !record(delta.rows) ||
    !keyList(delta.remove)
  )
    invalid();
  const keys = [
    ...Object.keys(delta.set),
    ...Object.keys(delta.rows),
    ...delta.remove,
  ];
  if (!keyList(keys) || keys.some((key) => unsafeKeys.has(key))) invalid();
  const next = { ...previous, ...delta.set };
  for (const key of delta.remove) delete next[key];
  for (const [key, patch] of Object.entries(delta.rows)) {
    if (!collections.has(key) || !record(patch) || !keyList(patch.remove))
      invalid();
    const before = entityMap(previous[key]);
    const upserts = entityMap(patch.upsert);
    if (
      !before ||
      !upserts ||
      patch.remove.some((id) => !before.has(id) || upserts.has(id))
    )
      invalid();
    const after = new Map(before);
    for (const id of patch.remove) after.delete(id);
    for (const [id, value] of upserts) after.set(id, value);
    const order = patch.order === undefined ? [...after.keys()] : patch.order;
    if (
      !keyList(order) ||
      order.length !== after.size ||
      order.some((id) => !after.has(id))
    )
      invalid();
    next[key] = order.map((id) => after.get(id));
  }
  return next;
}

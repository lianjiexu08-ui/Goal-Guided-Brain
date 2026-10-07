import { StoreReadIndex } from './store/read-index.mjs';
import { buildHandoffGraph } from './team-handoff-graph.mjs';
import { atomicHandoff } from './team-handoff-store.mjs';

const collection = 'chain-review-drafts';
const empty = () => ({ action: 'complete', note: '' });
const fail = (message, status = 400) =>
  Object.assign(new Error(message), { status });
export function chainReviewScope(store, teamId, messageId) {
  const { selected } = buildHandoffGraph(
    new StoreReadIndex(store),
    teamId,
    messageId,
  );
  return JSON.stringify([teamId, selected.id]);
}
export function validateChainDecision(value) {
  if (
    !value ||
    !['complete', 'end', 'reopen'].includes(value.action) ||
    typeof value.note !== 'string' ||
    value.note.length > 2000 ||
    typeof value.fingerprint !== 'string' ||
    !/^[a-f0-9]{64}$/.test(value.fingerprint) ||
    typeof value.requestId !== 'string' ||
    !/^[\w-]{1,100}$/.test(value.requestId)
  )
    throw fail('链路处理参数无效，请重新预览。');
  if (value.action !== 'complete' && !value.note.trim())
    throw fail('请填写结束跟进或重新打开的原因。');
  return {
    action: value.action,
    note: value.note.trim(),
    fingerprint: value.fingerprint,
    requestId: value.requestId,
  };
}
function read(store, key) {
  const record = store.records.get(collection, key);
  return { revision: record?.revision || 0, value: record?.value || empty() };
}
export function readChainReviewDraft(store, teamId, messageId) {
  return read(store, chainReviewScope(store, teamId, messageId));
}
export function saveChainReviewDraft(store, teamId, messageId, body) {
  const key = chainReviewScope(store, teamId, messageId);
  const value = body.value;
  if (
    !value ||
    !['complete', 'end', 'reopen'].includes(value.action) ||
    typeof value.note !== 'string' ||
    value.note.length > 2000 ||
    !Number.isSafeInteger(body.revision) ||
    body.revision < 0
  )
    throw fail('链路处理草稿无效。');
  const next = { action: value.action, note: value.note };
  if (value.pending !== undefined) {
    next.pending = validateChainDecision(value.pending);
    if (
      next.pending.action !== next.action ||
      next.pending.note !== next.note.trim()
    )
      throw fail('待确认请求与处理说明不一致。');
  }
  return atomicHandoff(store, () => {
    const current = read(store, key);
    if (current.revision !== body.revision)
      throw fail('另一设备已更新链路草稿，请核对两个版本。', 409);
    store.records.save(collection, { value: next }, key);
    return read(store, key);
  });
}
export function consumeChainReviewDraft(store, key, body, duplicate = false) {
  if (body.draftRevision === undefined) return;
  const current = read(store, key);
  const pending = current.value.pending;
  if (
    current.revision !== body.draftRevision ||
    !pending ||
    ['action', 'note', 'fingerprint', 'requestId'].some(
      (field) => pending[field] !== body[field],
    )
  ) {
    if (duplicate) return;
    throw fail('链路草稿已变化，请重新同步并审阅。', 409);
  }
  store.records.save(collection, { value: empty() }, key);
}

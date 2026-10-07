import { StoreReadIndex } from './store/read-index.mjs';
import { validHandoffSource } from './team-handoff-origin.mjs';

const fail = (message, status = 400) =>
  Object.assign(new Error(message), { status });
const collection = 'collaboration-drafts';
const keyFor = (teamId, messageId) =>
  JSON.stringify([teamId, messageId || null]);
const empty = (messageId) =>
  messageId
    ? { action: 'complete', note: '' }
    : { targetTeamId: '', content: '', acceptance: '' };
const text = (value, limit) =>
  typeof value === 'string' && value.length <= limit;
const id = (value) => typeof value === 'string' && /^[\w-]{1,100}$/.test(value);

function scope(store, teamId, messageId) {
  if (!store.teamSpace(teamId)) throw fail('团队不存在。', 404);
  if (messageId) {
    const read = new StoreReadIndex(store);
    const source = read.get('space-messages', messageId);
    if (!validHandoffSource(read, source) || source.fromTeamId !== teamId)
      throw fail('处理草稿不属于当前来源团队。', 404);
  }
}

function validate(value, messageId) {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw fail('草稿内容无效。');
  if (messageId) {
    if (
      !['complete', 'end', 'reopen'].includes(value.action) ||
      !text(value.note, 2000)
    )
      throw fail('处理草稿内容无效。');
    const result = { action: value.action, note: value.note };
    if (value.pending !== undefined) {
      const p = value.pending;
      if (
        !p ||
        p.action !== value.action ||
        p.note !== value.note.trim() ||
        !id(p.requestId) ||
        !text(p.fingerprint, 128) ||
        !p.fingerprint ||
        !Number.isSafeInteger(p.revision) ||
        p.revision < 0
      )
        throw fail('待确认处理请求无效。');
      result.pending = {
        action: p.action,
        note: p.note,
        fingerprint: p.fingerprint,
        revision: p.revision,
        requestId: p.requestId,
      };
    }
    return result;
  }
  if (
    !text(value.targetTeamId, 200) ||
    !text(value.content, 32000) ||
    !text(value.acceptance, 20000)
  )
    throw fail('协作草稿内容无效。');
  const result = {
    targetTeamId: value.targetTeamId,
    content: value.content,
    acceptance: value.acceptance,
  };
  if (value.clientMessageId !== undefined) {
    if (
      !id(value.clientMessageId) ||
      !value.targetTeamId ||
      !value.content.trim()
    )
      throw fail('待确认协作请求无效。');
    result.clientMessageId = value.clientMessageId;
  }
  if (value.followup !== undefined) {
    if (
      !value.followup ||
      !text(value.followup.messageId, 1000) ||
      !value.followup.messageId ||
      !text(value.followup.title, 160)
    )
      throw fail('原协作引用无效。');
    result.followup = {
      messageId: value.followup.messageId,
      title: value.followup.title,
    };
  }
  return result;
}

export function readCollaborationDraft(store, teamId, messageId = null) {
  scope(store, teamId, messageId);
  const saved = store.records.get(collection, keyFor(teamId, messageId));
  return {
    teamId,
    messageId,
    revision: saved?.revision || 0,
    value: saved?.value || empty(messageId),
  };
}

export function saveCollaborationDraft(store, teamId, messageId, body) {
  scope(store, teamId, messageId);
  const value = validate(body.value, messageId);
  if (!Number.isSafeInteger(body.revision) || body.revision < 0)
    throw fail('草稿版本无效。');
  // Keep an empty versioned record after clearing, so an offline device cannot
  // resurrect a consumed request by treating a missing record as revision zero.
  store.db.exec('SAVEPOINT collaboration_draft');
  try {
    const current = readCollaborationDraft(store, teamId, messageId);
    if (current.revision !== body.revision)
      throw fail('另一设备已更新草稿，请核对两个版本。', 409);
    store.records.save(
      collection,
      { teamId, messageId, revision: current.revision + 1, value },
      keyFor(teamId, messageId),
    );
    store.db.exec('RELEASE SAVEPOINT collaboration_draft');
    return readCollaborationDraft(store, teamId, messageId);
  } catch (error) {
    store.db.exec(
      'ROLLBACK TO SAVEPOINT collaboration_draft; RELEASE SAVEPOINT collaboration_draft',
    );
    throw error;
  }
}

// Called inside the business transaction. Older API callers can omit this
// guard; the UI must first persist its immutable pending request and revision.
export function consumeCollaborationDraft(
  store,
  teamId,
  messageId,
  body,
  duplicate = false,
) {
  if (body.draftRevision === undefined) return;
  const current = readCollaborationDraft(store, teamId, messageId);
  const v = current.value;
  const matches = messageId
    ? v.pending?.requestId === body.requestId &&
      v.pending.action === body.action &&
      v.pending.note === body.note.trim() &&
      v.pending.fingerprint === body.fingerprint &&
      v.pending.revision === body.revision
    : v.clientMessageId === body.clientMessageId &&
      v.targetTeamId === body.targetTeamId &&
      v.content.trim() === body.content.trim() &&
      v.acceptance.trim() === (body.acceptance || '').trim() &&
      (v.followup?.messageId || null) === (body.followupMessageId || null);
  if (!matches || current.revision !== body.draftRevision) {
    if (duplicate) return; // A late receipt must not erase a newer draft.
    throw fail('协作草稿已变化，请重新同步并审阅后提交。', 409);
  }
  const value = messageId
    ? empty(messageId)
    : { ...empty(null), targetTeamId: v.targetTeamId };
  store.records.save(
    collection,
    { teamId, messageId, revision: current.revision + 1, value },
    keyFor(teamId, messageId),
  );
}

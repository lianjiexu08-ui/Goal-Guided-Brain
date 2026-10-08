import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture } from './helpers/collaboration-chain-fixture.mjs';
import {
  previewChainReview,
  saveChainReview,
} from '../server/team-chain-review.mjs';
import {
  readChainReviewDraft,
  saveChainReviewDraft,
} from '../server/chain-review-drafts.mjs';
const endpoint = (source, row) =>
  `teams/${source.id}/collaboration-chain-review/${encodeURIComponent(row.sourceMessageId)}`;
const decision = (
  preview,
  action = 'end',
  requestId = crypto.randomUUID(),
) => ({
  action,
  note: action === 'complete' ? '' : 'Owner reviewed the entire scope',
  fingerprint: preview.fingerprint,
  requestId,
});

void test('HTTP whole-chain review includes history beyond the first page, is atomic and returns the original receipt on late retry', async (t) => {
  const { store, source, target, send, request } = await fixture(t);
  const root = await send();
  const rows = [root];
  for (let index = 0; index < 22; index++)
    rows.push(await send(root, target, index % 2 ? 'failed' : 'completed'));
  const unrelated = await send();
  const url = endpoint(source, root);
  const preview = (await request(url)).body;
  assert.equal(preview.items.length, 23);
  assert.equal(preview.options.complete.allowed, false);
  assert.equal(preview.options.end.allowed, true);
  const tasks = JSON.stringify(store.tasks());
  const body = decision(preview);
  const result = await request(url, body);
  assert.equal(result.status, 200);
  assert.equal(result.body.messageIds.length, 23);
  assert.equal(store.records.list('handoff-review-events').length, 23);
  assert.equal(
    store.records.get('handoff-reviews', unrelated.sourceMessageId),
    null,
  );
  assert.equal(JSON.stringify(store.tasks()), tasks);
  assert.equal(store.records.list('task-acceptance').length, 0);
  const reopen = decision((await request(url)).body, 'reopen');
  assert.equal((await request(url, reopen)).status, 200);
  const child = await send(root);
  const retry = await request(url, body);
  assert.deepEqual(retry.body, result.body);
  assert.equal(
    store.records.get('handoff-reviews', child.sourceMessageId),
    null,
  );
  assert.equal(store.records.list('handoff-review-events').length, 46);
  assert.equal(
    store.records.get('handoff-reviews', root.sourceMessageId).status,
    'open',
  );
  assert.equal(
    (await request(url, { ...body, note: 'Modified retry' })).status,
    409,
  );
});

void test('chain preview rejects added branches, changed content/results/replies and archived source before any batch write', async (t) => {
  for (const mutation of ['branch', 'content', 'result', 'reply', 'archived']) {
    const f = await fixture(t);
    const root = await f.send();
    const preview = previewChainReview(
      f.store,
      f.source.id,
      root.sourceMessageId,
    );
    if (mutation === 'branch') await f.send(root);
    if (mutation === 'content') {
      const row = f.store.records.get('space-messages', root.sourceMessageId);
      f.store.records.save(
        'space-messages',
        { ...row, content: 'Changed owner request' },
        row.id,
      );
    }
    if (mutation === 'result')
      f.store.updateTask(root.taskId, { result: 'Changed result' });
    if (mutation === 'reply')
      f.store.saveTeamMessage(
        {
          spaceId: f.source.id,
          kind: 'reply',
          content: 'New shared reply',
          relatedMessageId: root.sourceMessageId,
          taskId: root.taskId,
          fromTeamId: f.target.id,
          toTeamId: f.source.id,
        },
        `handoff-reply:${root.taskId}`,
      );
    if (mutation === 'archived')
      f.store.saveTeamSpace({ ...f.source, status: 'archived' }, f.source.id);
    assert.throws(
      () =>
        saveChainReview(
          f.store,
          f.source.id,
          root.sourceMessageId,
          decision(preview),
        ),
      { status: 409 },
      mutation,
    );
    assert.equal(f.store.records.list('handoff-reviews').length, 0);
    assert.equal(f.store.records.list('chain-review-receipts').length, 0);
  }
});

void test('complete requires every current acceptance, stale results can be re-reviewed, reopening never reruns tasks', async (t) => {
  const { store, source, target, send, request } = await fixture(t);
  const root = await send();
  const child = await send(root, target, 'queued');
  const url = endpoint(source, root);
  let preview = (await request(url)).body;
  assert.equal(preview.options.end.allowed, false);
  assert.equal((await request(url, decision(preview))).status, 409);
  store.updateTask(child.taskId, { status: 'completed' });
  for (const row of [root, child]) {
    store.records.save('artifacts', {
      taskId: row.taskId,
      kind: 'verification',
      status: 'verified',
      verified: true,
      requirementVersion: 1,
    });
    assert.equal(
      (await request(`tasks/${row.taskId}/accept`, { note: 'Owner accepted' }))
        .status,
      200,
    );
  }
  preview = (await request(url)).body;
  assert.equal(preview.options.complete.allowed, true);
  assert.equal((await request(url, decision(preview, 'complete'))).status, 200);
  store.updateTask(child.taskId, { result: 'A changed result' });
  preview = (await request(url)).body;
  assert.equal(preview.items[1].reviewStatus, 'stale');
  assert.equal(
    (await request(url, decision(preview, 'end'))).body.messageIds.length,
    1,
  );
  const tasks = JSON.stringify(store.tasks());
  preview = (await request(url)).body;
  assert.equal(
    (await request(url, decision(preview, 'reopen'))).body.messageIds.length,
    2,
  );
  assert.equal(JSON.stringify(store.tasks()), tasks);
  assert.ok(
    (await request(url)).body.items.every(
      (item) => item.reviewStatus === 'open',
    ),
  );
});

void test('failed final receipt write rolls back every review, audit event and consumed draft without notifications', async (t) => {
  const { store, source, send } = await fixture(t);
  const root = await send();
  await send(root);
  const preview = previewChainReview(store, source.id, root.sourceMessageId);
  const body = decision(preview);
  const saved = saveChainReviewDraft(store, source.id, root.sourceMessageId, {
    revision: 0,
    value: { action: body.action, note: body.note, pending: body },
  });
  const original = store.records.save.bind(store.records);
  const observer = store.records.onSave;
  const events = [];
  store.records.onSave = (change) => events.push(change);
  store.records.save = (collection, ...args) => {
    if (collection === 'chain-review-receipts')
      throw new Error('Injected disk failure');
    return original(collection, ...args);
  };
  try {
    assert.throws(
      () =>
        saveChainReview(store, source.id, root.sourceMessageId, {
          ...body,
          draftRevision: saved.revision,
        }),
      /Injected disk failure/,
    );
  } finally {
    store.records.save = original;
    store.records.onSave = observer;
  }
  assert.equal(store.records.list('handoff-reviews').length, 0);
  assert.equal(store.records.list('handoff-review-events').length, 0);
  assert.deepEqual(
    readChainReviewDraft(store, source.id, root.sourceMessageId),
    saved,
  );
  assert.equal(events.length, 0);
});

void test('versioned chain drafts prevent concurrent overwrite and stale receipt cannot erase a newer draft', async (t) => {
  const { store, source, send } = await fixture(t);
  const root = await send();
  const id = root.sourceMessageId;
  const body = decision(previewChainReview(store, source.id, id));
  const value = { action: body.action, note: body.note, pending: body };
  const draft = saveChainReviewDraft(store, source.id, id, {
    revision: 0,
    value,
  });
  assert.throws(
    () => saveChainReviewDraft(store, source.id, id, { revision: 0, value }),
    { status: 409 },
  );
  assert.throws(
    () => saveChainReview(store, source.id, id, { ...body, draftRevision: 0 }),
    { status: 409 },
  );
  assert.equal(store.records.list('handoff-reviews').length, 0);
  saveChainReview(store, source.id, id, {
    ...body,
    draftRevision: draft.revision,
  });
  const empty = readChainReviewDraft(store, source.id, id);
  assert.equal(empty.revision, 2);
  assert.equal(empty.value.note, '');
  const fresh = saveChainReviewDraft(store, source.id, id, {
    revision: empty.revision,
    value: { action: 'reopen', note: 'A new owner decision' },
  });
  saveChainReview(store, source.id, id, {
    ...body,
    draftRevision: draft.revision,
  });
  assert.deepEqual(readChainReviewDraft(store, source.id, id), fresh);
});

void test('HTTP chain review enforces ownership, complete provenance and required reasons', async (t) => {
  const { app, store, source, other, send, request } = await fixture(t);
  const root = await send();
  const url = endpoint(source, root);
  const preview = (await request(url)).body;
  assert.equal((await request(endpoint(other, root))).status, 404);
  assert.equal(
    (await request(url, { ...decision(preview), note: ' ' })).status,
    400,
  );
  store.records.remove('handoff-origins', root.sourceMessageId);
  const incomplete = (await request(url)).body;
  assert.equal(incomplete.incomplete, true);
  assert.equal(incomplete.options.end.allowed, false);
  assert.equal((await request(url, decision(incomplete))).status, 409);
  app.platform.auth.requireAuth = true;
  assert.equal((await request(url, undefined, 'agent-token')).status, 401);
  assert.equal(
    (await request(url, decision(preview), 'agent-token')).status,
    401,
  );
  assert.equal(
    (await request(`${url}/draft`, undefined, 'agent-token')).status,
    401,
  );
  assert.equal(store.records.list('handoff-reviews').length, 0);
});

void test('onward delegation closes all three teams together and preserves per-source audit ownership', async (t) => {
  const { commitTeamHandoff } =
    await import('../server/team-handoff-store.mjs');
  const { store, source, target, other, send, request } = await fixture(t);
  const root = await send();
  const onward = commitTeamHandoff({
    store,
    source: target,
    target: other,
    clientMessageId: 'onward-close',
    content: 'Review implementation',
    initiatorTaskId: root.taskId,
    createTask: (message) => {
      const task = store.createTask({
        role: other.pmRoleId,
        teamId: other.id,
        prompt: 'Review',
        workspace: store.workspace,
      });
      store.records.save(
        'task-meta',
        { teamId: other.id, spaceId: other.id, sourceMessageId: message.id },
        task.id,
      );
      return store.updateTask(task.id, { status: 'completed' });
    },
  });
  const url = endpoint(other, onward);
  const preview = (await request(url)).body;
  assert.equal(preview.teamCount, 3);
  assert.equal(preview.items.length, 2);
  assert.equal((await request(url, decision(preview))).status, 200);
  assert.equal(
    store.records.get('handoff-reviews', root.sourceMessageId).spaceId,
    source.id,
  );
  assert.equal(
    store.records.get('handoff-reviews', onward.sourceMessageId).spaceId,
    target.id,
  );
  assert.equal(
    new Set(
      store.records
        .list('handoff-review-events')
        .map((row) => row.chainReceiptId),
    ).size,
    1,
  );
});

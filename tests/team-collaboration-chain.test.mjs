import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture } from './helpers/collaboration-chain-fixture.mjs';

void test('HTTP chain connects nested follow-ups and branches, separates state and exposes shared replies only', async (t) => {
  const { app, store, source, target, request, send, endpoint } =
    await fixture(t);
  const root = await send();
  const child = await send(root);
  const grandchild = await send(child, target, 'queued');
  const sibling = await send(root, target, 'failed');
  const unrelated = await send();
  app.platform.control.publishHandoffResult(
    store.task(child.taskId),
    store.records.get('task-meta', child.taskId),
    'completed',
    'Shared reply to child',
  );
  store.saveTeamMessage({
    spaceId: target.id,
    kind: 'note',
    taskId: child.taskId,
    content: 'Private target note',
  });
  const reviewUrl = `teams/${source.id}/collaboration-review/${encodeURIComponent(sibling.sourceMessageId)}`;
  const snapshot = (await request(reviewUrl)).body;
  assert.equal(
    (
      await request(reviewUrl, {
        action: 'end',
        note: 'No longer needed',
        revision: snapshot.revision,
        fingerprint: snapshot.fingerprint,
        requestId: 'close-sibling',
      })
    ).status,
    200,
  );
  const before = JSON.stringify([
    store.tasks(),
    store.records.list('space-messages'),
    store.records.list('handoff-reviews'),
  ]);
  const result = await request(endpoint(child));
  assert.equal(result.status, 200);
  assert.deepEqual(
    result.body.items.map((row) => row.messageId),
    [root, child, grandchild, sibling].map((row) => row.sourceMessageId),
  );
  assert.deepEqual(
    result.body.items.map((row) => row.parentIndex),
    [null, 1, 2, 1],
  );
  assert.deepEqual(result.body.counts, {
    total: 4,
    active: 1,
    accepted: 0,
    open: 3,
    closed: 1,
    stale: 0,
  });
  assert.equal(result.body.selectedMessageId, child.sourceMessageId);
  assert.match(result.body.items[1].reply.content, /Shared reply to child$/);
  assert.equal(result.body.items[3].review.note, 'No longer needed');
  assert.equal(JSON.stringify(result.body).includes('Private'), false);
  assert.equal(JSON.stringify(result.body).includes(unrelated.taskId), false);
  assert.deepEqual(
    (await request(endpoint(child, target))).body.items,
    result.body.items,
  );
  assert.equal(
    (
      await request(
        `teams/${source.id}/collaboration-chain/${encodeURIComponent(`handoff-reply:${child.taskId}`)}`,
      )
    ).body.rootMessageId,
    root.sourceMessageId,
  );
  assert.equal(
    JSON.stringify([
      store.tasks(),
      store.records.list('space-messages'),
      store.records.list('handoff-reviews'),
    ]),
    before,
  );
});

void test('HTTP chain pagination scopes cursors, rejects changed topology and refreshes edited historical content', async (t) => {
  const { app, store, target, request, send, endpoint } = await fixture(t);
  const root = await send();
  const rows = [root];
  for (let index = 0; index < 22; index++) rows.push(await send(root));
  const page = await request(`${endpoint(root)}?limit=20`);
  assert.equal(page.body.items.length, 20);
  assert.equal(page.body.counts.total, 23);
  const cursor = encodeURIComponent(page.body.nextCursor);
  const next = await request(`${endpoint(root)}?after=${cursor}`);
  assert.equal(next.body.items.length, 3);
  assert.equal(next.body.nextCursor, null);
  assert.equal(
    new Set(
      [...page.body.items, ...next.body.items].map((row) => row.messageId),
    ).size,
    23,
  );
  assert.equal(
    (await request(`${endpoint(root, target)}?after=${cursor}`)).status,
    409,
  );
  const other = await send();
  assert.equal(
    (await request(`${endpoint(other)}?after=${cursor}`)).status,
    409,
  );
  for (const query of ['limit=0', 'limit=51', 'limit=1.5', 'limit=abc'])
    assert.equal((await request(`${endpoint(root)}?${query}`)).status, 400);
  assert.equal((await request(`${endpoint(root)}?after=invalid`)).status, 409);
  const first = store.records.get('space-messages', root.sourceMessageId);
  store.records.save(
    'space-messages',
    { ...first, content: 'Edited original request' },
    first.id,
  );
  assert.equal(
    (await request(endpoint(root))).body.items[0].content,
    'Edited original request',
  );
  await send(root);
  assert.equal(
    (await request(`${endpoint(root)}?after=${cursor}`)).status,
    409,
  );
  assert.equal((await request(endpoint(root))).body.counts.total, 24);
  store.records.remove('space-messages', root.sourceMessageId);
  const orphan = await request(endpoint(rows[1]));
  assert.equal(orphan.body.incomplete, true);
  assert.equal(orphan.body.counts.total, 1);
  assert.equal((await request(endpoint(root))).status, 404);
  app.platform.auth.requireAuth = true;
  assert.equal(
    (await request(endpoint(rows[1]), null, 'invalid-instance')).status,
    401,
  );
});

void test('HTTP chain refuses foreign and forged associations and detects cyclic references without leaking another pair', async (t) => {
  const { store, other, request, send, endpoint } = await fixture(t);
  const root = await send();
  const foreign = await send(null, other);
  assert.equal((await request(endpoint(root, other))).status, 404);
  const sourceRow = store.records.get('space-messages', root.sourceMessageId);
  store.records.save(
    'space-messages',
    { ...sourceRow, followupMessageId: foreign.sourceMessageId },
    sourceRow.id,
  );
  const chain = await request(endpoint(root));
  assert.equal(chain.body.incomplete, true);
  assert.equal(chain.body.counts.total, 1);
  assert.equal(JSON.stringify(chain.body).includes(foreign.taskId), false);
  store.records.save(
    'space-messages',
    { ...sourceRow, followupMessageId: sourceRow.id },
    sourceRow.id,
  );
  assert.equal((await request(endpoint(root))).status, 409);
  store.records.save('space-messages', sourceRow, sourceRow.id);
  const peer = store.records.get('space-messages', sourceRow.relatedMessageId);
  store.records.save(
    'space-messages',
    { ...peer, fromTeamId: other.id },
    peer.id,
  );
  assert.equal((await request(endpoint(root))).status, 404);
});

void test('chain summary keeps acceptance independent and turns changed closed work into stale review', async (t) => {
  const { store, source, request, send, endpoint } = await fixture(t);
  const root = await send();
  store.records.save('artifacts', {
    taskId: root.taskId,
    kind: 'verification',
    status: 'verified',
    verified: true,
    requirementVersion: 1,
  });
  assert.equal(
    (await request(`tasks/${root.taskId}/accept`, { note: 'Owner accepted' }))
      .status,
    200,
  );
  let chain = (await request(endpoint(root))).body;
  assert.equal(chain.counts.accepted, 1);
  assert.equal(chain.counts.open, 1);
  const reviewUrl = `teams/${source.id}/collaboration-review/${encodeURIComponent(root.sourceMessageId)}`;
  const review = (await request(reviewUrl)).body;
  assert.equal(
    (
      await request(reviewUrl, {
        action: 'complete',
        note: '',
        revision: review.revision,
        fingerprint: review.fingerprint,
        requestId: 'complete-root',
      })
    ).status,
    200,
  );
  assert.equal((await request(endpoint(root))).body.counts.closed, 1);
  store.updateTask(root.taskId, { result: 'Changed output' });
  chain = (await request(endpoint(root))).body;
  assert.equal(chain.counts.stale, 1);
  assert.equal(chain.counts.closed, 0);
});

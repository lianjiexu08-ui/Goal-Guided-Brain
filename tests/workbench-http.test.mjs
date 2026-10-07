import test from 'node:test';
import http from 'node:http';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createWorkbench } from '../server/index.mjs';
import { sandbox, tick } from './helpers/workbench-helpers.mjs';

test('HTTP journey: concurrent assistants, developer queue, cancellation, handoff, and secret boundary', async () => {
  const s = sandbox(),
    runtimes = [];
  const app = createWorkbench({
    ...s,
    requireCredential: false,
    runtimeFactory: (o) => {
      const fake = {
        options: o,
        start(prompt) {
          fake.prompt = prompt;
          runtimes.push(fake);
        },
        cancel() {
          o.onDone('cancelled', '已停止');
        },
        complete(result) {
          o.onResult(result);
          o.onDone('completed', '');
        },
      };
      return fake;
    },
  });
  await new Promise((r) => app.server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const request = async (p, body, method = 'POST') => {
    const r = await fetch(base + '/api/' + p, {
      method,
      headers: { 'Content-Type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: r.status, body: await r.json() };
  };
  try {
    const p = (await request('tasks', { role: 'product', prompt: '记账需求' }))
      .body;
    const d = (
      await request('tasks', { role: 'developer', prompt: '实现记账功能' })
    ).body;
    const d2 = (
      await request('tasks', {
        role: 'developer',
        prompt: '同一项目的第二个开发任务',
      })
    ).body;
    await tick();
    assert.equal(runtimes.length, 2);
    assert.equal(app.store.task(d2.id).status, 'queued');
    runtimes
      .find((r) => r.options.task.id === p.id)
      .complete('需求：支持新增收支；验收：列表显示新增记录。');
    const handoff = await request(`tasks/${p.id}/handoff`, {
      role: 'developer',
      note: '请实现这些需求并验证',
    });
    assert.equal(handoff.status, 201);
    assert.equal(handoff.body.sourceTaskId, p.id);
    assert.notEqual(handoff.body.sessionId, p.sessionId);
    await request(`tasks/${d.id}/cancel`, {});
    await tick();
    assert.equal(app.store.task(d.id).status, 'cancelled');
    assert.equal(app.store.task(d2.id).status, 'running');
    runtimes.find((r) => r.options.task.id === d2.id).complete('完成');
    await tick();
    const receiver = runtimes.find(
      (r) => r.options.task.id === handoff.body.id,
    );
    assert.match(receiver.prompt, /支持新增收支/);
    assert.match(receiver.prompt, /请实现这些需求并验证/);
    receiver.complete('已完成需求并验证。');
    assert.equal(
      (await request('tasks', { role: 'wrong', prompt: 'test' })).status,
      400,
    );
    const rejected = await fetch(base + '/api/tasks', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Origin: 'https://evil.example',
      },
      body: JSON.stringify({ role: 'product', prompt: '恶意请求' }),
    });
    assert.equal(rejected.status, 403);
    const badHost = await new Promise((resolve) => {
      http.get(
        base + '/api/state',
        { headers: { Host: 'evil.example' } },
        (r) => {
          r.resume();
          resolve(r.statusCode);
        },
      );
    });
    assert.equal(badHost, 403);
    await request('vault/initialize', {
      passphrase: 'fixture-private-vault-password',
    });
    const savedSettings = await request(
      'settings',
      {
        workspace: s.workspace,
        model: 'deepseek-v4-flash',
        apiKey: 'fixture-private-key',
      },
      'PUT',
    );
    assert.equal(savedSettings.status, 200);
    const state = await request('state', undefined, 'GET');
    assert.equal(state.body.config.hasApiKey, true);
    assert.ok(!JSON.stringify(state.body).includes('fixture-private-key'));
    assert.ok(!('context' in state.body.tasks[0]));
    assert.ok(state.body.tasks.every((task) => task.artifactCount === 0));
    assert.ok(
      state.body.tasks.every((task) => task.verificationStatus === null),
    );
    const inspectedTask = state.body.tasks[0];
    assert.equal(
      (
        await request(`tasks/${inspectedTask.id}/accept`, {
          note: '没有当前验证证据时不能交付。',
        })
      ).status,
      409,
    );
    app.store.records.save('artifacts', {
      taskId: inspectedTask.id,
      kind: 'verification',
      status: 'verified',
      name: 'npm test',
    });
    const withEvidence = await request('state', undefined, 'GET');
    const evidenceTask = withEvidence.body.tasks.find(
      (task) => task.id === inspectedTask.id,
    );
    assert.equal(evidenceTask.artifactCount, 1);
    assert.equal(evidenceTask.verificationStatus, 'verified');
    const inspectedDetail = await request(
      `tasks/${inspectedTask.id}`,
      undefined,
      'GET',
    );
    assert.equal(
      inspectedDetail.body.delivery.executionStatus,
      inspectedDetail.body.status,
    );
    assert.equal(inspectedDetail.body.delivery.acceptanceStatus, 'verified');
    assert.equal(
      inspectedDetail.body.delivery.deliveryStatus,
      'awaiting-owner',
    );
    assert.equal(inspectedDetail.body.delivery.evidenceCount, 1);
    assert.equal(inspectedDetail.body.delivery.hasVerificationEvidence, true);
    const accepted = await request(`tasks/${inspectedTask.id}/accept`, {
      note: '已检查验证输出，确认本次交付。',
    });
    assert.equal(accepted.status, 200);
    assert.equal(accepted.body.decision, 'accepted');
    assert.equal(accepted.body.delivery.deliveryStatus, 'accepted');
    assert.equal(
      (await request(`tasks/${inspectedTask.id}`, undefined, 'GET')).body
        .acceptance.decision,
      'accepted',
    );
    assert.equal(
      (await request(`tasks/${inspectedTask.id}/reject`, {})).status,
      400,
    );
    const rejectedDelivery = await request(`tasks/${inspectedTask.id}/reject`, {
      note: '请补充边界场景验证后重新提交。',
    });
    assert.equal(rejectedDelivery.status, 200);
    assert.equal(rejectedDelivery.body.decision, 'rejected');
    assert.equal(rejectedDelivery.body.delivery.deliveryStatus, 'rejected');
    const attention = await request('attention', undefined, 'GET');
    assert.ok(
      attention.body.items.some(
        (item) =>
          item.taskId === inspectedTask.id && item.kind === 'acceptance',
      ),
    );
    const managed = await request('manage', undefined, 'GET');
    const managedAcceptance = managed.body.attention.find(
      (item) => item.taskId === inspectedTask.id && item.kind === 'acceptance',
    );
    assert.equal(managedAcceptance.taskTitle, inspectedTask.title);
    assert.equal(managedAcceptance.deliveryStatus, 'rejected');
    app.store.records.save('artifacts', {
      taskId: inspectedTask.id,
      kind: 'verification',
      status: 'verified',
      name: 'npm test (补充验证)',
      requirementVersion: 1,
    });
    const resubmitted = await request(
      `tasks/${inspectedTask.id}`,
      undefined,
      'GET',
    );
    assert.equal(resubmitted.body.delivery.deliveryStatus, 'awaiting-owner');
    const acceptedAgain = await request(`tasks/${inspectedTask.id}/accept`, {
      note: '补充验证已通过，确认重新交付。',
    });
    assert.equal(acceptedAgain.status, 200);
    assert.equal(acceptedAgain.body.delivery.deliveryStatus, 'accepted');
    assert.equal(
      fs.statSync(path.join(s.dataDir, 'vault.json')).mode & 0o777,
      0o600,
    );
    assert.equal(fs.existsSync(path.join(s.dataDir, 'secrets.json')), false);
  } finally {
    await app.close();
    fs.rmSync(s.dir, { recursive: true, force: true });
  }
});

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createWorkbench } from '../server/index.mjs';

async function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ggb-model-metrics-'));
  const app = createWorkbench({
    workspace: path.join(directory, 'workspace'),
    dataDir: path.join(directory, 'data'),
    requireCredential: false,
  });
  await app.platform.ready;
  await new Promise((resolve) => app.server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const request = async (route, body, method = body === undefined ? 'GET' : 'POST') => {
    const response = await fetch(`${base}/api/${route}`, {
      method,
      headers: { 'Content-Type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: response.status, body: await response.json() };
  };
  t.after(async () => {
    await app.close();
    fs.rmSync(directory, { recursive: true, force: true });
  });
  return { app, request };
}

function saveAttempt(app, {
  task,
  teamId,
  jobId,
  groupId,
  providerId,
  providerName,
  model,
  status,
  startedAt,
  finishedAt,
  inputTokens,
  outputTokens,
  cost,
  routingCandidates = [],
}) {
  const { records } = app.store;
  records.save('task-meta', {
    jobId,
    groupId,
    teamId,
    spaceId: teamId,
    providerIds: [providerId],
    allowedProviderIds: [providerId],
    requirementVersion: 1,
  }, task.id);
  records.save('runtime-snapshots', {
    route: { providerId, providerName, model, routingCandidates },
  }, task.id);
  records.save('executions', {
    taskId: task.id,
    groupId,
    status,
    startedAt,
    finishedAt,
  }, task.id);
  records.save('usage', {
    taskId: task.id,
    groupId,
    jobId,
    turn: 1,
    inputTokens,
    outputTokens,
    totalTokens: inputTokens + outputTokens,
    cost,
    providerId,
    model,
  }, `${task.id}:1`);
  app.store.updateTask(task.id, { status, result: status === 'completed' ? '完成' : '', error: status === 'failed' ? '模型不可用' : '' });
}

test('model metrics aggregate retries by attempt and logical task, preserve unknown cost, and support filters', async (t) => {
  const { app, request } = await fixture(t);
  const alpha = app.platform.providers.save({
    id: 'metrics-provider-alpha',
    name: '指标 Alpha',
    protocol: 'openai-completions',
    baseUrl: 'http://127.0.0.1:1/v1',
    models: [{ id: 'metrics-alpha' }],
  });
  const beta = app.platform.providers.save({
    id: 'metrics-provider-beta',
    name: '指标 Beta',
    protocol: 'openai-completions',
    baseUrl: 'http://127.0.0.1:1/v1',
    models: [{ id: 'metrics-beta' }],
  });
  const team = app.store.saveTeamSpace({
    id: 'metrics-team',
    name: '指标研发团队',
    goal: '验证模型运行指标。',
    purpose: '验证模型运行指标。',
    memberRoleIds: ['project_manager', 'developer'],
    pmRoleId: 'project_manager',
  });
  const first = app.platform.newTask({
    role: 'developer',
    prompt: '第一次尝试',
    workspace: app.store.config.workspace,
    teamId: team.id,
    ownerInitiated: true,
    providerIds: [alpha.id],
    model: 'metrics-alpha',
    groupId: 'metrics-group',
    jobId: 'metrics-job',
  });
  const retry = app.platform.newTask({
    role: 'developer',
    prompt: '回退后重试',
    workspace: app.store.config.workspace,
    teamId: team.id,
    ownerInitiated: true,
    providerIds: [beta.id],
    model: 'metrics-beta',
    groupId: 'metrics-group',
    jobId: 'metrics-job',
    sourceTaskId: first.id,
  });
  saveAttempt(app, {
    task: first,
    teamId: team.id,
    jobId: 'metrics-job',
    groupId: 'metrics-group',
    providerId: alpha.id,
    providerName: alpha.name,
    model: 'metrics-alpha',
    status: 'failed',
    startedAt: 1000,
    finishedAt: 2500,
    inputTokens: 100,
    outputTokens: 50,
    cost: 0.1,
    routingCandidates: [
      { providerId: alpha.id, providerName: alpha.name, model: 'metrics-alpha', status: 'selected' },
      { providerId: beta.id, providerName: beta.name, status: 'ineligible', reason: '工具要求不满足' },
    ],
  });
  saveAttempt(app, {
    task: retry,
    teamId: team.id,
    jobId: 'metrics-job',
    groupId: 'metrics-group',
    providerId: beta.id,
    providerName: beta.name,
    model: 'metrics-beta',
    status: 'completed',
    startedAt: 3000,
    finishedAt: 5000,
    inputTokens: 200,
    outputTokens: 80,
    cost: 0.2,
    routingCandidates: [
      { providerId: alpha.id, providerName: alpha.name, model: 'metrics-alpha', status: 'unavailable', reason: 'HTTP 503' },
      { providerId: beta.id, providerName: beta.name, model: 'metrics-beta', status: 'selected' },
    ],
  });
  app.store.records.save('jobs', {
    ...app.store.records.get('jobs', 'metrics-job'),
    taskId: retry.id,
    status: 'completed',
  }, 'metrics-job');
  app.store.records.save('task-events', {
    taskId: first.id,
    type: 'routing/fallback',
    data: {
      from: { providerId: alpha.id, providerName: alpha.name, model: 'metrics-alpha' },
      to: { providerId: beta.id, providerName: beta.name, model: 'metrics-beta' },
    },
  }, 'metrics-fallback');
  app.store.records.save('artifacts', {
    taskId: retry.id,
    groupId: 'metrics-group',
    requirementVersion: 1,
    kind: 'verification',
    status: 'verified',
    verified: true,
    finishedAt: new Date(6000).toISOString(),
  }, 'metrics-verification');
  app.store.records.save('task-acceptance', {
    taskId: retry.id,
    groupId: 'metrics-group',
    decision: 'accepted',
    status: 'active',
    requirementVersion: 1,
    verificationId: 'metrics-verification',
  }, retry.id);

  const unknownCostTask = app.platform.newTask({
    role: 'project_manager',
    prompt: '未知价格模型任务',
    workspace: app.store.config.workspace,
    teamId: team.id,
    providerIds: [beta.id],
    model: 'metrics-beta',
    groupId: 'metrics-unknown',
    jobId: 'metrics-unknown-job',
  });
  saveAttempt(app, {
    task: unknownCostTask,
    teamId: team.id,
    jobId: 'metrics-unknown-job',
    groupId: 'metrics-unknown',
    providerId: beta.id,
    providerName: beta.name,
    model: 'metrics-beta',
    status: 'completed',
    startedAt: 7000,
    finishedAt: 9000,
    inputTokens: 20,
    outputTokens: 10,
    cost: null,
  });

  const result = await request('metrics/models');
  assert.equal(result.status, 200);
  assert.equal(result.body.totals.attempts, 3);
  assert.equal(result.body.totals.logicalTasks, 2);
  assert.equal(result.body.totals.fallbacks, 1);
  assert.equal(result.body.totals.accepted, 1);
  assert.equal(result.body.totals.verificationPassed, 1);
  assert.equal(result.body.totals.totalTokens, 460);
  assert.equal(result.body.totals.costKnown, false);
  assert.equal(result.body.totals.cost, null);
  const alphaItem = result.body.items.find((item) => item.model === 'metrics-alpha');
  const betaItem = result.body.items.find((item) => item.model === 'metrics-beta');
  assert.ok(alphaItem);
  assert.ok(betaItem);
  assert.equal(alphaItem.attempts, 1);
  assert.equal(alphaItem.failed, 1);
  assert.equal(alphaItem.fallbacks, 1);
  assert.equal(alphaItem.candidateDecisions.find((item) => item.status === 'ineligible').count, 1);
  assert.equal(betaItem.attempts, 2);
  assert.equal(betaItem.accepted, 1);
  assert.equal(betaItem.costKnown, false);
  assert.equal(betaItem.cost, null);
  assert.equal(betaItem.avgLatencyMs, 2000);
  assert.equal(betaItem.p50LatencyMs, 2000);

  const filtered = await request(`metrics/models?providerId=${encodeURIComponent(beta.id)}&roleId=project_manager`);
  assert.equal(filtered.status, 200);
  assert.equal(filtered.body.totals.attempts, 1);
  assert.equal(filtered.body.totals.logicalTasks, 1);
  assert.equal(filtered.body.totals.totalTokens, 30);
  assert.equal(filtered.body.totals.cost, null);
  assert.equal(filtered.body.items.length, 1);
  assert.equal(filtered.body.items[0].model, 'metrics-beta');
  assert.equal(filtered.body.items[0].roleId, 'project_manager');
});

test('model metrics reject an invalid time window', async (t) => {
  const { request } = await fixture(t);
  const result = await request('metrics/models?since=not-a-date');
  assert.equal(result.status, 400);
  assert.match(result.body.error, /since/);
});

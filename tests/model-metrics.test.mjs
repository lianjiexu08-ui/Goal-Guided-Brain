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

function saveQualityOnlyTask(app, {
  id,
  teamId,
  requirementVersion = 1,
  verification,
}) {
  const task = app.store.createTask({
    id,
    role: 'developer',
    prompt: `验收证据质量 ${id}`,
    workspace: app.store.config.workspace,
  });
  app.store.records.save(
    'task-meta',
    {
      teamId,
      spaceId: teamId,
      groupId: id,
      requirementVersion,
    },
    task.id,
  );
  if (verification)
    app.store.records.save(
      'artifacts',
      {
        taskId: task.id,
        groupId: id,
        requirementVersion: verification.requirementVersion ?? requirementVersion,
        kind: 'verification',
        status: verification.status,
        verified: verification.status === 'verified',
        finishedAt: new Date(7000).toISOString(),
      },
      `${id}-verification`,
    );
  app.store.updateTask(task.id, { status: 'completed', result: '完成' });
  return task;
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
  saveQualityOnlyTask(app, {
    id: 'metrics-stale-evidence',
    teamId: team.id,
    requirementVersion: 2,
    verification: { requirementVersion: 1, status: 'verified' },
  });
  saveQualityOnlyTask(app, {
    id: 'metrics-failed-evidence',
    teamId: team.id,
    verification: { status: 'failed' },
  });
  saveQualityOnlyTask(app, {
    id: 'metrics-awaiting-owner',
    teamId: team.id,
    verification: { status: 'verified' },
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
  const today = new Date().toISOString().slice(0, 10);
  assert.deepEqual(result.body.evidenceQuality, {
    completedTasks: 5,
    withVerification: 4,
    currentVerified: 2,
    missingCurrentEvidence: 3,
    staleEvidence: 1,
    failedEvidence: 1,
    pendingVerification: 1,
    accepted: 1,
    rejected: 0,
    awaitingOwner: 1,
    coverageRate: 40,
    verificationPassRate: 50,
    ownerDecisionRate: 50,
    acceptanceRate: 100,
    trend: [
      {
        date: today,
        completedTasks: 5,
        currentVerified: 2,
        missingCurrentEvidence: 3,
        coverageRate: 40,
      },
    ],
    byTaskType: [
      {
        taskType: 'development',
        taskTypeName: '开发',
        completedTasks: 4,
        withVerification: 4,
        currentVerified: 2,
        missingCurrentEvidence: 2,
        staleEvidence: 1,
        failedEvidence: 1,
        pendingVerification: 0,
        accepted: 1,
        rejected: 0,
        awaitingOwner: 1,
        coverageRate: 50,
        verificationPassRate: 50,
        ownerDecisionRate: 50,
        acceptanceRate: 100,
      },
      {
        taskType: 'planning',
        taskTypeName: '规划',
        completedTasks: 1,
        withVerification: 0,
        currentVerified: 0,
        missingCurrentEvidence: 1,
        staleEvidence: 0,
        failedEvidence: 0,
        pendingVerification: 1,
        accepted: 0,
        rejected: 0,
        awaitingOwner: 0,
        coverageRate: 0,
        verificationPassRate: null,
        ownerDecisionRate: null,
        acceptanceRate: null,
      },
    ],
    byTeam: [
      {
        teamId: team.id,
        teamName: team.name,
        completedTasks: 5,
        withVerification: 4,
        currentVerified: 2,
        missingCurrentEvidence: 3,
        staleEvidence: 1,
        failedEvidence: 1,
        pendingVerification: 1,
        accepted: 1,
        rejected: 0,
        awaitingOwner: 1,
        coverageRate: 40,
        verificationPassRate: 50,
        ownerDecisionRate: 50,
        acceptanceRate: 100,
      },
    ],
  });
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
  assert.equal(filtered.body.evidenceQuality.completedTasks, 1);
  assert.equal(filtered.body.evidenceQuality.currentVerified, 0);
  assert.equal(filtered.body.evidenceQuality.coverageRate, 0);
  assert.equal(filtered.body.evidenceQuality.verificationPassRate, null);
  assert.equal(filtered.body.filters.taskType, null);
  assert.deepEqual(filtered.body.evidenceQuality.trend, [
    {
      date: today,
      completedTasks: 1,
      currentVerified: 0,
      missingCurrentEvidence: 1,
      coverageRate: 0,
    },
  ]);
  const development = await request('metrics/models?taskType=development');
  assert.equal(development.status, 200);
  assert.equal(development.body.filters.taskType, 'development');
  assert.equal(development.body.evidenceQuality.completedTasks, 4);
  assert.deepEqual(development.body.evidenceQuality.byTaskType.map((item) => item.taskType), ['development']);
});

test('model metrics evidence trend follows date and filters', async (t) => {
  const { app, request } = await fixture(t);
  const team = app.store.saveTeamSpace({
    id: 'trend-team',
    name: '趋势团队',
    goal: '验证按日趋势。',
    purpose: '验证按日趋势。',
    memberRoleIds: ['project_manager', 'developer'],
    pmRoleId: 'project_manager',
  });
  const current = saveQualityOnlyTask(app, {
    id: 'trend-current',
    teamId: team.id,
    verification: { status: 'verified' },
  });
  const missing = saveQualityOnlyTask(app, {
    id: 'trend-missing',
    teamId: team.id,
  });
  app.store.db
    .prepare('UPDATE tasks SET createdAt=?,updatedAt=? WHERE id=?')
    .run(
      '2026-01-02T12:00:00.000Z',
      '2026-01-02T12:00:00.000Z',
      current.id,
    );
  app.store.db
    .prepare('UPDATE tasks SET createdAt=?,updatedAt=? WHERE id=?')
    .run(
      '2026-01-03T12:00:00.000Z',
      '2026-01-03T12:00:00.000Z',
      missing.id,
    );

  const result = await request(
    'metrics/models?teamId=trend-team&since=2026-01-01T00:00:00.000Z&until=2026-01-04T00:00:00.000Z',
  );
  assert.equal(result.status, 200);
  assert.deepEqual(result.body.evidenceQuality.trend, [
    {
      date: '2026-01-02',
      completedTasks: 1,
      currentVerified: 1,
      missingCurrentEvidence: 0,
      coverageRate: 100,
    },
    {
      date: '2026-01-03',
      completedTasks: 1,
      currentVerified: 0,
      missingCurrentEvidence: 1,
      coverageRate: 0,
    },
  ]);
});

test('task types persist on jobs, task metadata, and child tasks', async (t) => {
  const { app, request } = await fixture(t);
  const parent = app.platform.control.createJob({
    role: 'developer',
    prompt: '整理产品需求并落地功能',
    taskType: 'product',
  });
  assert.equal(parent.taskType, 'product');
  assert.equal(
    app.store.records.get('task-meta', parent.taskId).taskType,
    'product',
  );
  const child = app.platform.control.createJob({
    role: 'developer',
    prompt: '实现已确认的功能',
    parentJobId: parent.id,
  });
  assert.equal(child.taskType, 'product');
  assert.equal(
    app.store.records.get('task-meta', child.taskId).taskType,
    'product',
  );
  const direct = await request('tasks', {
    role: 'developer',
    prompt: '检查运行环境并处理部署问题',
    taskType: 'operations',
  });
  assert.equal(direct.status, 201);
  assert.equal(
    app.store.records.get('task-meta', direct.body.id).taskType,
    'operations',
  );
});

test('model metrics reject an invalid time window', async (t) => {
  const { request } = await fixture(t);
  const result = await request('metrics/models?since=not-a-date');
  assert.equal(result.status, 400);
  assert.match(result.body.error, /since/);
});

#!/usr/bin/env node
// Opt-in continuation of a disposable verify-live-delivery fixture, never a user project.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { createWorkbench } from '../server/index.mjs';
import { readPassword } from './live-password.mjs';

const root = fs.realpathSync(process.argv[2] || '.');
if (
  !path.basename(root).startsWith('ggb-live-delivery-') ||
  path.dirname(root) !== fs.realpathSync(os.tmpdir())
)
  throw Error('Only a temporary verify-live-delivery fixture is allowed.');
const original = JSON.parse(
  fs.readFileSync(path.join(root, 'report.json'), 'utf8'),
);
if (
  original.scenario !== 'confirmed team native delivery' ||
  original.verdict !== 'fail'
)
  throw Error('Expected a failed synthetic delivery report.');
const dataDir = path.join(root, 'data');
const workspace = path.join(root, 'workspace');
const oldTask = original.tasks.find((task) => task.role === 'developer');
if (!oldTask || oldTask.status !== 'cancelled')
  throw Error('Expected a stopped developer attempt.');
const previousPath = path.join(dataDir, 'executions', oldTask.id, 'workspace');
const digest = (directory) => {
  const result = {};
  const visit = (dir, prefix = '') => {
    for (const item of fs.readdirSync(dir, { withFileTypes: true })) {
      if (item.isSymbolicLink())
        throw Error('Unexpected symlink in synthetic evidence.');
      const relative = path.join(prefix, item.name);
      if (item.isDirectory()) visit(path.join(dir, item.name), relative);
      else
        result[relative] = createHash('sha256')
          .update(fs.readFileSync(path.join(dir, item.name)))
          .digest('hex');
    }
  };
  visit(directory);
  return JSON.stringify(result);
};
const sourceBefore = digest(workspace),
  previousBefore = digest(previousPath);
const report = {
  scenario: 'native interrupted delivery recovery',
  startedAt: new Date().toISOString(),
  priorTaskId: oldTask.id,
  additionalBudgetTokens: 120000,
  checks: {},
  verdict: 'incomplete',
};
let app,
  password = '';
console.log(JSON.stringify({ phase: 'password-input', evidence: root }));
try {
  password = await readPassword();
  fs.copyFileSync(
    path.join(os.homedir(), '.dsh-workbench/vault.json'),
    path.join(dataDir, 'vault.json'),
  );
  app = createWorkbench({ dataDir, workspace });
  await app.platform.ready;
  app.platform.auth.requireAuth = false;
  await app.platform.vault.unlock(password);
  password = '';
  if (
    app.store
      .tasks()
      .some((task) => ['running', 'queued'].includes(task.status))
  )
    throw Error('Fixture already has active work.');
  const usage = () =>
    app.store.records
      .list('usage')
      .reduce((sum, row) => sum + (Number(row.totalTokens) || 0), 0);
  report.beforeTokens = usage();
  const budgetTokens = report.beforeTokens + report.additionalBudgetTokens;
  const child = app.store.records
    .list('jobs')
    .find((job) => job.taskId === oldTask.id);
  const parent = app.store.records.get('jobs', child?.parentJobId);
  const team = app.store.teamSpace(original.teamId);
  if (
    !parent ||
    !team ||
    fs.realpathSync(team.workspace) !== workspace ||
    child.teamId !== team.id
  )
    throw Error('Fixture ownership does not match the original report.');
  await new Promise((resolve) => app.server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${app.server.address().port}/api/`;
  const request = async (route, body, method = body ? 'POST' : 'GET') => {
    const response = await fetch(base + route, {
      method,
      headers: { 'Content-Type': 'application/json' },
      ...(body ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(125000),
    });
    const value = await response.json();
    if (!response.ok)
      throw Error(`${route}: ${value.error || response.status}`);
    return value;
  };
  await request(
    `teams/${team.id}`,
    { autonomy: { ...team.autonomy, budgetTokens } },
    'PUT',
  );
  await request(`jobs/${parent.id}`, { budgetTokens }, 'PUT');
  await request(`teams/${team.id}/autonomy/resume`, {});
  await request(`jobs/${parent.id}/resume`, {});
  const resumed = await request(`jobs/${child.id}/resume`, {});
  report.resumedTaskId = resumed.taskId;
  const deadline = Date.now() + 300000;
  let previousState = '';
  while (Date.now() < deadline) {
    const tasks = app.store.tasks();
    const state = JSON.stringify(
      tasks.map(({ id, role, status }) => ({ id, role, status })),
    );
    if (state !== previousState) {
      console.log(
        JSON.stringify({ phase: 'execution', tasks: JSON.parse(state) }),
      );
      previousState = state;
    }
    if (tasks.every((task) => !['queued', 'running'].includes(task.status)))
      break;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  if (
    app.store
      .tasks()
      .some((task) => ['queued', 'running'].includes(task.status))
  )
    throw Error('Five-minute recovery limit exceeded.');
  const detail = await request(`tasks/${resumed.taskId}`);
  report.checks.restoredWorkspace =
    detail.executionWorkspace?.restoredFromTaskId === oldTask.id &&
    detail.executionWorkspace.path !== previousPath;
  report.checks.completedDeveloper = detail.status === 'completed';
  report.checks.submittedArtifact = detail.artifacts.some(
    (artifact) => artifact.kind !== 'verification',
  );
  const updatedParent = app.store.records.get('jobs', parent.id);
  report.summaryTaskId = updatedParent.summaryTaskId;
  report.checks.completedSummary =
    updatedParent.status === 'completed' && !!updatedParent.summaryTaskId;
  report.checks.noDuplicateDelegation =
    app.store.records.list('jobs').length === 2;
  if (!report.checks.completedDeveloper)
    throw Error('Recovered developer did not complete.');
  const modulePath = path.join(detail.executionWorkspace.path, 'ledger.mjs');
  report.verification = await request(`workspaces/${resumed.taskId}/verify`, {
    command: process.execPath,
    args: [
      fileURLToPath(
        new URL('./fixtures/live-ledger-check.mjs', import.meta.url),
      ),
      modulePath,
    ],
  });
  report.checks.independentVerification = report.verification.verified === true;
  const verified = await request(`tasks/${resumed.taskId}`);
  report.checks.noAutomaticAcceptance =
    verified.delivery.acceptanceDecision === null &&
    verified.delivery.deliveryStatus === 'awaiting-owner';
  if (report.verification.verified) {
    await request(`tasks/${resumed.taskId}/accept`, {
      note: '隔离样例恢复验收：独立金额、日期、溢出和不可变性检查通过。',
    });
    report.checks.ownerAccepted =
      (await request(`tasks/${resumed.taskId}`)).delivery.acceptanceDecision ===
      'accepted';
  }
} catch (error) {
  report.error = error.message;
} finally {
  password = '';
  if (app) {
    report.totalTokens = app.store.records
      .list('usage')
      .reduce((sum, row) => sum + (Number(row.totalTokens) || 0), 0);
    report.recoveryTokens = report.totalTokens - (report.beforeTokens || 0);
    report.tasks = app.store
      .tasks()
      .map(({ id, role, status, error }) => ({ id, role, status, error }));
    await app.close();
  }
  fs.rmSync(path.join(dataDir, 'vault.json'), { force: true });
  report.checks.sourcePreserved = digest(workspace) === sourceBefore;
  report.checks.previousFilesPreserved =
    digest(previousPath) === previousBefore;
  report.finishedAt = new Date().toISOString();
  report.verdict =
    !report.error && Object.values(report.checks).every(Boolean)
      ? 'pass'
      : 'fail';
  fs.writeFileSync(
    path.join(root, 'recovery-report.json'),
    JSON.stringify(report, null, 2),
    { mode: 0o600 },
  );
  console.log(JSON.stringify({ phase: 'finished', ...report }));
  process.exitCode = report.verdict === 'pass' ? 0 : 1;
}

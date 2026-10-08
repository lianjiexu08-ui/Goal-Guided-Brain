#!/usr/bin/env node
// Opt-in native multi-agent execution in a disposable, private workspace.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createWorkbench } from '../server/index.mjs';
import { readPassword } from './live-password.mjs';
const args = process.argv.slice(2);
const option = (name) => {
  const i = args.indexOf(name);
  return i < 0 ? '' : args[i + 1] || '';
};
const providerId = option('--provider'),
  model = option('--model');
if (!providerId || !model) {
  console.error(
    'Usage: node scripts/verify-live-delivery.mjs --provider ID --model ID',
  );
  process.exit(2);
}
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ggb-live-delivery-'));
const dataDir = path.join(root, 'data'),
  workspace = path.join(root, 'workspace');
fs.mkdirSync(dataDir, { mode: 0o700 });
fs.mkdirSync(workspace, { mode: 0o700 });
const specification = `# Monthly ledger utility acceptance
Create ledger.mjs exporting summarizeTransactions(rows) and ledger.test.mjs using node:test, without dependencies.
rows is an array of objects with date (strict valid YYYY-MM-DD Gregorian calendar date) and amount (string matching ^-?\\d+\\.\\d{2}$).
Return an array of {month, incomeCents, expenseCents, balanceCents}, sorted by YYYY-MM.
Positive amounts are income, negative amounts are positive expenseCents, balance is income minus expense.
Use exact integer cents; reject invalid input, invalid dates, malformed amounts and unsafe integer amounts or accumulated totals. Do not mutate inputs. Empty input returns []. Normalize negative zero to zero.
Run node --test ledger.test.mjs, include meaningful success, invalid-date, overflow and precision tests, and document API/commands in README.md.
Only modify your assigned workspace. No network, dependencies, Git commits, pushes, deployment or access to other projects.
Submit the actual code path and observed test results through submit_artifact. A separate owner-side oracle will verify your code; do not claim final owner acceptance.
`;
fs.writeFileSync(path.join(workspace, 'README.md'), specification);
const report = {
  scenario: 'confirmed team native delivery',
  budgetTokens: 200000,
  model,
  startedAt: new Date().toISOString(),
  checks: {},
  verdict: 'incomplete',
};
let app,
  passphrase = '';
console.log(JSON.stringify({ phase: 'password-input', evidence: root }));
try {
  passphrase = await readPassword();
  const response = await fetch('http://127.0.0.1:3089/api/providers', {
    signal: AbortSignal.timeout(10000),
  });
  if (!response.ok) throw Error('Cannot read local providers.');
  const provider = (await response.json()).find((p) => p.id === providerId);
  const spec = provider?.models.find((m) => m.id === model);
  if (!provider?.enabled || !provider.credentialId || !spec?.tools)
    throw Error('Choose a verified tool-capable provider/model.');
  fs.copyFileSync(
    path.join(os.homedir(), '.dsh-workbench/vault.json'),
    path.join(dataDir, 'vault.json'),
  );
  app = createWorkbench({ dataDir, workspace });
  await app.platform.ready;
  app.platform.auth.requireAuth = false;
  await app.platform.vault.unlock(passphrase);
  passphrase = '';
  app.store.records.save(
    'providers',
    { ...provider, models: [spec] },
    providerId,
  );
  for (const role of app.store.roles())
    app.store.saveRole(
      {
        ...role,
        model,
        providerIds: [providerId],
        workspaceMode: 'isolated',
        tools: {
          files: role.id === 'developer',
          terminal: role.id === 'developer',
          web: false,
        },
      },
      role.id,
    );
  // Recruitment has separate live coverage. This fixture starts after owner confirmation.
  const team = app.store.saveTeamSpace({
    name: '账本计算交付验收团队',
    goal: '实现并验证精确金额月度汇总模块',
    workspace,
    pmRoleId: 'project_manager',
    memberRoleIds: ['project_manager', 'developer'],
    recruitment: { phase: 'confirmed', confirmedAt: new Date().toISOString() },
    responsibilities: {
      project_manager: '分派开发、检查实际证据、等待所有者验收',
      developer: '独立实现模块、运行测试、提交产物',
    },
    autonomy: { mode: 'auto', maxDepth: 2, maxJobs: 4, budgetTokens: 200000 },
  });
  report.teamId = team.id;
  await new Promise((resolve) => app.server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${app.server.address().port}/api/`;
  const request = async (route, body) => {
    const response = await fetch(base + route, {
      method: body ? 'POST' : 'GET',
      headers: { 'Content-Type': 'application/json' },
      ...(body ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(125000),
    });
    const value = await response.json();
    if (!response.ok)
      throw Error(`${route}: ${value.error || response.status}`);
    return value;
  };
  const sent = await request(`teams/${team.id}/messages`, {
    clientMessageId: 'live-delivery',
    providerId,
    model,
    content: `团队已经由所有者确认，现在真正执行以下本地开发任务。请分派给 developer，项目经理不要代写代码。只需一个开发子任务；成员完成后总结真实产物与测试结果，等待所有者独立验证和验收。\n${specification}`,
  });
  report.rootTaskId = sent.taskId;
  const deadline = Date.now() + 300000;
  let previous = '';
  while (Date.now() < deadline) {
    const tasks = app.store.tasks();
    const state = tasks.map(({ id, role, status }) => ({ id, role, status }));
    const serialized = JSON.stringify(state);
    if (serialized !== previous) {
      console.log(JSON.stringify({ phase: 'execution', tasks: state }));
      previous = serialized;
    }
    if (
      tasks.length &&
      tasks.every((t) => !['queued', 'running'].includes(t.status))
    ) {
      const jobs = app.store.records.list('jobs');
      if (
        jobs.every(
          (j) =>
            !['queued', 'running', 'waiting_children', 'waiting'].includes(
              j.status,
            ),
        )
      )
        break;
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  const tasks = app.store.tasks();
  if (tasks.some((t) => ['queued', 'running'].includes(t.status)))
    throw Error('Five-minute execution limit exceeded.');
  report.tasks = tasks.map(({ id, role, status, result, error }) => ({
    id,
    role,
    status,
    result,
    error,
  }));
  const developer = tasks.find((t) => t.role === 'developer');
  report.checks.delegated = !!developer && developer.id !== sent.taskId;
  report.checks.completed = tasks.every((t) => t.status === 'completed');
  if (!developer || developer.status !== 'completed')
    throw Error('No completed developer task.');
  const detail = await request(`tasks/${developer.id}`);
  report.checks.submittedArtifact = detail.artifacts.some(
    (a) => a.kind !== 'verification',
  );
  report.beforeVerification = detail.delivery;
  const modulePath = path.join(detail.executionWorkspace.path, 'ledger.mjs');
  if (!fs.existsSync(modulePath) || fs.lstatSync(modulePath).isSymbolicLink())
    throw Error('Missing regular ledger.mjs in developer workspace.');
  const oracle = fileURLToPath(
    new URL('./fixtures/live-ledger-check.mjs', import.meta.url),
  );
  report.verification = await request(`workspaces/${developer.id}/verify`, {
    command: process.execPath,
    args: [oracle, modulePath],
  });
  report.checks.independentVerification = report.verification.verified === true;
  const verified = await request(`tasks/${developer.id}`);
  report.beforeAcceptance = verified.delivery;
  report.checks.noAutomaticAcceptance =
    verified.delivery.acceptanceDecision === null &&
    verified.delivery.deliveryStatus === 'awaiting-owner';
  if (report.verification.verified) {
    report.acceptance = await request(`tasks/${developer.id}/accept`, {
      note: '隔离验收：独立金额、日期、溢出和不可变性检查通过。仅接受此样例。',
    });
    report.afterAcceptance = (await request(`tasks/${developer.id}`)).delivery;
    report.checks.ownerAccepted =
      report.afterAcceptance.acceptanceDecision === 'accepted';
  }
  report.checks.sourcePreserved =
    fs.readFileSync(path.join(workspace, 'README.md'), 'utf8') ===
      specification && fs.readdirSync(workspace).length === 1;
  report.verdict = Object.values(report.checks).every(Boolean)
    ? 'pass'
    : 'fail';
} catch (error) {
  report.error = error.message;
  report.verdict = 'fail';
} finally {
  passphrase = '';
  if (app) {
    report.usage = app.store.records
      .list('usage')
      .map(({ taskId, totalTokens }) => ({ taskId, totalTokens }));
    report.tasks = app.store
      .tasks()
      .map(({ id, role, status, result, error }) => ({
        id,
        role,
        status,
        result,
        error,
      }));
    await app.close();
  }
  fs.rmSync(path.join(dataDir, 'vault.json'), { force: true });
  report.finishedAt = new Date().toISOString();
  fs.writeFileSync(
    path.join(root, 'report.json'),
    JSON.stringify(report, null, 2),
    { mode: 0o600 },
  );
  console.log(
    JSON.stringify({
      phase: 'finished',
      verdict: report.verdict,
      checks: report.checks,
      error: report.error,
      report: path.join(root, 'report.json'),
    }),
  );
  process.exitCode = report.verdict === 'pass' ? 0 : 1;
}

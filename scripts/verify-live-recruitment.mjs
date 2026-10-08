#!/usr/bin/env node
// Opt-in real-model acceptance. Never imported by the deterministic test suite.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createWorkbench } from '../server/index.mjs';

const args = process.argv.slice(2);
function option(name) {
  const index = args.indexOf(name);
  return index < 0 ? '' : args[index + 1] || '';
}
const providerId = option('--provider');
const model = option('--model');
const probeTools = args.includes('--probe-tools');
const clarificationFile = option('--clarification-file');
if (!providerId || !model) {
  console.error(
    'Usage: node scripts/verify-live-recruitment.mjs --provider ID --model ID [--probe-tools] [--clarification-file PATH]\nReads the existing vault password from stdin. Calls a real provider in an isolated workspace.',
  );
  process.exit(2);
}
const sourceDir =
  option('--source-data') || path.join(os.homedir(), '.dsh-workbench');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ggb-live-recruitment-'));
const dataDir = path.join(root, 'data');
const workspace = path.join(root, 'workspace');
fs.mkdirSync(dataDir, { mode: 0o700 });
fs.mkdirSync(workspace, { mode: 0o700 });
console.log(JSON.stringify({ phase: 'password-input', evidence: root }));
let passphrase = '';
function readPassword() {
  return new Promise((resolve, reject) => {
    let value = '';
    const wasRaw = process.stdin.isRaw;
    const cleanup = () => {
      if (process.stdin.isTTY) process.stdin.setRawMode(!!wasRaw);
      process.stdin.off('data', onData);
      process.stdin.off('end', onEnd);
      process.stdin.pause();
    };
    const onEnd = () => {
      cleanup();
      reject(Error('Vault password was not supplied.'));
    };
    const onData = (chunk) => {
      for (const char of chunk.toString()) {
        if (char === '\u0003') {
          onEnd();
          return;
        }
        if (char === '\n' || char === '\r') {
          cleanup();
          resolve(value);
          return;
        }
        if (char === '\u007f' || char === '\b') value = value.slice(0, -1);
        else value += char;
      }
    };
    if (process.stdin.isTTY) process.stdin.setRawMode(true);
    process.stdin.on('data', onData);
    process.stdin.once('end', onEnd);
    process.stdin.resume();
  });
}
const report = {
  scenario: '家庭账本团队招募',
  startedAt: new Date().toISOString(),
  model,
  turns: [],
  checks: {},
  verdict: 'incomplete',
};
let app;
try {
  passphrase = await readPassword();
  const response = await fetch('http://127.0.0.1:3089/api/providers', {
    signal: AbortSignal.timeout(10000),
  });
  if (!response.ok)
    throw Error(`Source provider list returned HTTP ${response.status}`);
  const rows = await response.json();
  const provider = (rows.items || rows).find((item) => item.id === providerId);
  const spec = provider?.models?.find((item) => item.id === model);
  if (
    !provider?.enabled ||
    !provider.credentialId ||
    !spec ||
    (!probeTools && spec.tools !== true)
  )
    throw Error(
      'Choose an enabled configured model with verified tool support and a credential.',
    );
  fs.copyFileSync(
    path.join(sourceDir, 'vault.json'),
    path.join(dataDir, 'vault.json'),
  );
  app = createWorkbench({ dataDir, workspace });
  await app.platform.ready;
  app.platform.auth.requireAuth = false; // Only this ephemeral loopback test service.
  await app.platform.vault.unlock(passphrase);
  passphrase = '';
  app.store.records.save(
    'providers',
    { ...provider, models: [spec] },
    providerId,
  );
  if (probeTools) {
    report.probe = await app.platform.providers.probe(providerId, {
      model,
      toolTest: true,
    });
    console.log(JSON.stringify({ phase: 'tool-probe', ...report.probe }));
    if (!report.probe.ok)
      throw Error(`Tool probe failed: ${report.probe.error}`);
  }
  for (const role of app.store.roles())
    app.store.saveRole(
      {
        ...role,
        providerIds: [providerId],
        model,
        tools: { files: false, web: false, terminal: false },
      },
      role.id,
    );
  app.store.saveProfile({ language: 'zh-CN', verbosity: 'concise' });
  await new Promise((resolve) => app.server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${app.server.address().port}/api/`;
  const request = async (route, body) => {
    const result = await fetch(base + route, {
      method: body ? 'POST' : 'GET',
      headers: { 'Content-Type': 'application/json' },
      ...(body ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(10000),
    });
    const value = await result.json();
    if (!result.ok)
      throw Error(`Test API ${route}: ${value.error || result.status}`);
    return value;
  };
  const budgetTokens = Number(option('--budget-tokens') || 60000);
  if (
    !Number.isSafeInteger(budgetTokens) ||
    budgetTokens < 1000 ||
    budgetTokens > 120000
  )
    throw Error(
      'Acceptance budget must be an integer from 1000 through 120000 tokens.',
    );
  report.budgetTokens = budgetTokens;
  const team = await request('teams', {
    name: '待招募团队',
    goal: '澄清家庭账本第一阶段目标和团队职责。',
    workspace,
    pmRoleId: 'project_manager',
    memberRoleIds: ['project_manager'],
    providerId,
    model,
    recruitment: { phase: 'discovery' },
    autonomy: { mode: 'assist', maxDepth: 1, maxJobs: 4, budgetTokens },
  });
  report.teamId = team.id;
  report.providerName = provider.name;
  const initialRoles = app.store.roles().length;
  const prompts = [
    '我需要一个团队帮我开发一个家庭账本网页工具。先和我厘清需求，不要马上开始开发；每次只问最关键的几个问题。',
    '第一阶段只做 CSV 导入和月度收支汇总，个人本地使用、单用户、不登录，同时支持手机和电脑。技术栈 React/TypeScript、Node.js、SQLite，计划一周内完成；暂时没有项目代码。不能连接银行、不能发布部署、不能修改生产数据。请继续确认会影响团队职责和验收的剩余问题。',
    '补齐验收：CSV 为 UTF-8，最多 1000 行，列是日期、分类、金额、备注；金额保留两位小数，正数收入、负数支出。非法日期和金额给出行号与原因，重复行由用户确认处理；导入和月度汇总要有自动化测试。月度汇总展示总收入、总支出、净结余和分类小计，使用账本日期归属月份；手机通过同一局域网访问电脑，不需要离线同步。手机控件至少 44px。工作目录使用当前团队目录，这次只确认方案，不读写文件、不联网查资料、不运行终端、不派发任务。最多 3 名成员（含项目经理），每人职责和交付物清楚，模型沿用当前已配置可用模型。请现在保存待确认的团队方案，等我点击确认。',
  ];
  for (const [index, content] of prompts.entries()) {
    const sent = await request(`teams/${team.id}/messages`, {
      content,
      clientMessageId: `live-turn-${index + 1}`,
      providerId,
      model,
    });
    console.log(
      JSON.stringify({
        phase: 'turn-running',
        turn: index + 1,
        taskId: sent.taskId,
      }),
    );
    const deadline = Date.now() + 150000;
    let task;
    while (Date.now() < deadline) {
      task = app.store.task(sent.taskId);
      if (!['queued', 'running'].includes(task.status)) break;
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    if (['queued', 'running'].includes(task.status)) {
      await request(`tasks/${task.id}/cancel`, {});
      throw Error(
        `Turn ${index + 1} exceeded the 150-second acceptance limit.`,
      );
    }
    const space = app.store.teamSpace(team.id);
    report.turns.push({
      turn: index + 1,
      taskId: task.id,
      sessionId: task.sessionId,
      status: task.status,
      prompt: content,
      response: task.result,
      error: task.error,
      phase: space.recruitment.phase,
    });
    console.log(
      JSON.stringify({
        phase: 'turn-finished',
        turn: index + 1,
        status: task.status,
        recruitment: space.recruitment.phase,
      }),
    );
    report.proposal = space.recruitment.proposal || null;
    if (task.status !== 'completed')
      throw Error(
        `Turn ${index + 1} did not complete: ${task.error || task.status}`,
      );
    // A synthetic owner can answer an unresolved charter once; never erase
    // open questions or weaken the confirmation gate to make a run pass.
    if (
      index === 2 &&
      space.recruitment.proposal?.openQuestions?.length &&
      clarificationFile
    ) {
      const clarification = fs.readFileSync(clarificationFile, 'utf8').trim();
      if (!clarification || clarification.length > 10000)
        throw Error('Clarification must contain 1 through 10000 characters.');
      report.clarificationQuestions = [
        ...space.recruitment.proposal.openQuestions,
      ];
      prompts.push(clarification);
    }
  }
  const before = app.store.teamSpace(team.id);
  const proposal = before.recruitment.proposal;
  report.proposal = proposal || null;
  report.checks = {
    sameSession: new Set(report.turns.map((turn) => turn.sessionId)).size === 1,
    discoveryFirst: report.turns[0].phase === 'discovery',
    proposalPersisted: before.recruitment.phase === 'proposed' && !!proposal,
    workSpecificName: !!proposal?.teamName?.includes('家庭账本'),
    boundedTeam: proposal?.members?.length >= 2 && proposal.members.length <= 3,
    concreteResponsibilities: !!proposal?.members?.every(
      (member) => member.responsibility && member.deliverables?.length,
    ),
    readyForConfirmation: proposal?.ready === true,
    noPrematureMembers:
      app.store.roles().length === initialRoles &&
      before.memberRoleIds.length === 1,
    noDelegatedTasks: app.store
      .tasks()
      .every((task) => task.role === team.pmRoleId),
  };
  if (Object.values(report.checks).every(Boolean)) {
    const confirmed = await request(`teams/${team.id}/recruitment/confirm`, {
      version: proposal.version,
    });
    report.checks.ownerConfirmation =
      confirmed.recruitment?.phase === 'confirmed' &&
      confirmed.memberRoleIds.length === proposal.members.length;
    report.checks.noAutomaticExecution =
      app.store.tasks().length === prompts.length;
  }
  report.verdict = Object.values(report.checks).every(Boolean)
    ? 'pass'
    : 'fail';
} catch (error) {
  report.error = error.message;
  report.verdict = 'fail';
} finally {
  passphrase = '';
  if (app) {
    if (report.teamId) {
      const finalTeam = app.store.teamSpace(report.teamId);
      report.finalTeamStatus = finalTeam?.status;
      report.proposal = finalTeam?.recruitment?.proposal || null;
    }
    report.usage = app.store.records
      .list('usage')
      .map(({ taskId, inputTokens, outputTokens, totalTokens }) => ({
        taskId,
        inputTokens,
        outputTokens,
        totalTokens,
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

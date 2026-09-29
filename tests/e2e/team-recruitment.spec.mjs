import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { Store } from '../../server/store.mjs';

const dataDir = process.env.GGB_E2E_DATA_DIR || path.join(os.tmpdir(), 'ggb-browser-e2e-fixture');

function seedProposedRecruitment() {
  const store = new Store(dataDir, process.cwd(), { seedProjectManager: true });
  try {
    const teamName = '待确认开发团队';
    // Reuse the fixture team when the desktop project has already exercised
    // this flow. Playwright projects share one isolated database per run.
    const team = store.teamSpaces().find((space) =>
      space.recruitment?.proposal?.teamName === teamName,
    ) || store.teamSpaces().find((space) => space.recruitment?.phase === 'confirmed');
    if (!team) throw new Error('E2E fixture requires a seeded team.');
    const proposal = {
      version: 1,
      teamName,
      goal: '交付一条可测试的产品开发流程。',
      purpose: '负责需求拆解、代码实现和验收准备。',
      size: 2,
      members: [
        {
          memberId: 'manager',
          roleId: 'project_manager',
          name: '项目经理',
          responsibility: '澄清目标、安排任务并汇总交付。',
          deliverables: ['团队计划', '交付总结'],
          skills: [],
          skillIds: [],
          capabilityIds: [],
          providerIds: [],
          tools: [],
          toolAccess: null,
          modelHint: '',
          dependencies: [],
        },
        {
          memberId: 'developer',
          roleId: 'developer',
          name: '开发交付助手',
          responsibility: '实现功能并运行自动化测试。',
          deliverables: ['可运行代码', '测试结果'],
          skills: [],
          skillIds: [],
          capabilityIds: [],
          providerIds: [],
          tools: [],
          toolAccess: null,
          modelHint: '',
          dependencies: ['manager'],
        },
      ],
      openQuestions: [],
      ready: true,
      createdAt: new Date().toISOString(),
    };
    store.saveTeamSpace({
      ...team,
      name: '待确认需求',
      goal: proposal.goal,
      purpose: proposal.purpose,
      memberRoleIds: ['project_manager'],
      recruitment: {
        ...team.recruitment,
        phase: 'proposed',
        sessionId: null,
        turns: 1,
        brief: proposal.goal,
        proposal,
        confirmedAt: null,
      },
    }, team.id);
    return { teamId: team.id, teamName };
  } finally {
    store.close();
  }
}

function seedModelTeams() {
  const store = new Store(dataDir, process.cwd(), { seedProjectManager: true });
  try {
    const providers = [
      {
        id: 'e2e-provider-alpha',
        name: 'E2E Alpha Provider',
        protocol: 'openai-completions',
        baseUrl: 'http://127.0.0.1:1',
        credentialId: '',
        enabled: true,
        priority: 1,
        health: {
          ok: true,
          model: 'e2e-alpha-model',
          status: 200,
          checkedAt: new Date().toISOString(),
          latencyMs: 318,
          toolTest: false,
        },
        models: [{
          id: 'e2e-alpha-model',
          name: 'Alpha Model',
          tools: false,
          vision: false,
          contextWindow: 128000,
          inputPrice: null,
          outputPrice: null,
        }],
      },
      {
        id: 'e2e-provider-beta',
        name: 'E2E Beta Provider',
        protocol: 'openai-completions',
        baseUrl: 'http://127.0.0.1:1',
        credentialId: '',
        enabled: true,
        priority: 2,
        health: {
          ok: false,
          model: 'e2e-beta-model',
          status: 503,
          checkedAt: new Date().toISOString(),
          latencyMs: 742,
          toolTest: false,
          error: '接口返回 HTTP 503',
        },
        models: [{
          id: 'e2e-beta-model',
          name: 'Beta Model',
          tools: false,
          vision: false,
          contextWindow: 128000,
          inputPrice: null,
          outputPrice: null,
        }],
      },
    ];
    for (const provider of providers) store.records.save('providers', provider, provider.id);
    const seeded = store.teamSpaces().find((space) => space.recruitment?.phase === 'confirmed');
    if (!seeded) throw new Error('E2E fixture requires a seeded team.');
    const teams = [
      {
        slug: 'alpha',
        name: 'Alpha 模型团队',
        goal: '验证 Alpha 团队的模型路由隔离。',
        providerId: 'e2e-provider-alpha',
        model: 'e2e-alpha-model',
      },
      {
        slug: 'beta',
        name: 'Beta 模型团队',
        goal: '验证 Beta 团队的模型路由隔离。',
        providerId: 'e2e-provider-beta',
        model: 'e2e-beta-model',
      },
    ];
    const result = {};
    for (const input of teams) {
      const existing = store.teamSpaces().find((space) => space.name === input.name) || (input.slug === 'alpha' ? seeded : undefined);
      const saved = store.saveTeamSpace({
        ...existing,
        name: input.name,
        goal: input.goal,
        purpose: input.goal,
        model: input.model,
        providerId: input.providerId,
        workspace: process.cwd(),
        pmRoleId: 'project_manager',
        memberRoleIds: ['project_manager'],
        responsibilities: { project_manager: '验证团队模型路由。' },
        memberSettings: {
          project_manager: {
            label: '项目经理',
            responsibility: '验证团队模型路由。',
            modelHint: input.model,
            providerIds: [input.providerId],
          },
        },
        recruitment: {
          ...existing?.recruitment,
          phase: 'confirmed',
          sessionId: null,
          turns: 1,
          brief: input.goal,
          proposal: null,
          confirmedAt: new Date().toISOString(),
        },
      }, existing?.id);
      result[input.slug] = {
        id: saved.id,
        name: saved.name,
        providerId: input.providerId,
        model: input.model,
      };
    }
    return result;
  } finally {
    store.close();
  }
}

function seedModelMetrics() {
  const teams = seedModelTeams();
  const store = new Store(dataDir, process.cwd(), { seedProjectManager: true });
  try {
    const attempts = [
      {
        id: 'metrics-alpha-attempt',
        teamId: teams.alpha.id,
        providerId: 'e2e-provider-alpha',
        model: 'e2e-alpha-model',
        status: 'completed',
        tokens: { inputTokens: 120, outputTokens: 40, totalTokens: 160 },
        cost: 0.003,
      },
      {
        id: 'metrics-beta-attempt',
        teamId: teams.beta.id,
        providerId: 'e2e-provider-beta',
        model: 'e2e-beta-model',
        status: 'failed',
        tokens: { inputTokens: 90, outputTokens: 20, totalTokens: 110 },
        cost: null,
      },
    ];
    for (const input of attempts) {
      const task = store.createTask({
        role: 'project_manager',
        prompt: `E2E 模型指标 ${input.id}`,
        workspace: process.cwd(),
      });
      const jobId = `job-${input.id}`;
      const groupId = `group-${input.id}`;
      store.records.save('jobs', {
        title: task.title,
        goal: task.prompt,
        role: task.role,
        groupId,
        batchId: groupId,
        status: input.status,
        taskId: task.id,
        nodeId: 'local',
        workspace: process.cwd(),
        workspaceKey: 'default',
        requirementVersion: 1,
        budgetTokens: 200000,
        maxDurationMinutes: 30,
        permissions: [],
        spaceId: input.teamId,
        teamId: input.teamId,
      }, jobId);
      store.records.save('task-meta', {
        jobId,
        groupId,
        batchId: groupId,
        nodeId: 'local',
        workspaceKey: 'default',
        workspaceMode: 'isolated',
        providerIds: [input.providerId],
        allowedProviderIds: [input.providerId],
        requirementVersion: 1,
        spaceId: input.teamId,
        teamId: input.teamId,
      }, task.id);
      store.records.save('runtime-snapshots', {
        route: {
          providerId: input.providerId,
          model: input.model,
          routingCandidates: [{ providerId: input.providerId, model: input.model, status: 'selected' }],
        },
      }, task.id);
      store.records.save('executions', {
        taskId: task.id,
        groupId,
        status: input.status,
        startedAt: 1000,
        finishedAt: input.status === 'completed' ? 2500 : 2200,
      }, task.id);
      store.records.save('usage', {
        taskId: task.id,
        groupId,
        jobId,
        turn: 1,
        ...input.tokens,
        cost: input.cost,
        providerId: input.providerId,
        model: input.model,
      }, `${task.id}:1`);
      store.updateTask(task.id, { status: input.status, error: input.status === 'failed' ? 'fixture failure' : '' });
    }
    return teams;
  } finally {
    store.close();
  }
}

function seedCapabilityBinding() {
  const store = new Store(dataDir, process.cwd(), { seedProjectManager: true });
  try {
    const capabilityId = 'e2e-bound-capability';
    store.records.save('capabilities', {
      id: capabilityId,
      name: 'E2E 证据整理能力',
      kind: 'skill',
      version: '1.0.0',
      source: 'e2e',
      enabled: true,
      compatibility: 'partial',
      diagnostics: ['需要先检查执行节点。'],
      description: '验证能力绑定范围展示。',
      tools: [],
    }, capabilityId);
    const role = store.role('product');
    store.saveRole({ ...role, capabilityIds: [capabilityId] }, role.id);
    return { capabilityId, roleId: role.id };
  } finally {
    store.close();
  }
}

function seedConfirmedTeams() {
  const store = new Store(dataDir, process.cwd(), { seedProjectManager: true });
  try {
    const teams = [
      {
        slug: 'operations',
        name: '线上运维团队',
        goal: '负责线上服务稳定性、监控和故障处理。',
        message: '线上运维团队的项目经理动态',
      },
      {
        slug: 'development',
        name: '研发交付团队',
        goal: '负责产品功能开发、测试和版本交付。',
        message: '研发交付团队的项目经理动态',
      },
    ];
    const result = {};
    for (const input of teams) {
      const existing = store.teamSpaces().find((space) => space.name === input.name);
      const saved = store.saveTeamSpace({
        ...existing,
        name: input.name,
        goal: input.goal,
        purpose: input.goal,
        workspace: process.cwd(),
        pmRoleId: 'project_manager',
        memberRoleIds: ['project_manager'],
        recruitment: {
          ...existing?.recruitment,
          phase: 'confirmed',
          sessionId: null,
          turns: 1,
          brief: input.goal,
          proposal: null,
          confirmedAt: new Date().toISOString(),
        },
      }, existing?.id);
      store.saveTeamMessage({
        spaceId: saved.id,
        teamId: saved.id,
        clientMessageId: `e2e-${input.slug}-message`,
        kind: 'reply',
        senderType: 'agent',
        senderId: 'project_manager',
        content: input.message,
        status: 'sent',
      }, `e2e-${input.slug}-message`);
      result[input.slug] = { ...input, id: saved.id };
    }
    // Keep the historic keys used by the existing tests while returning the
    // durable ids needed by route-cache assertions.
    return { development: result.operations, operations: result.development };
  } finally {
    store.close();
  }
}

function seedTeamKnowledge() {
  const store = new Store(dataDir, process.cwd(), { seedProjectManager: true });
  try {
    const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const create = (name, goal) => store.saveTeamSpace({
      name: `${name} ${suffix}`,
      goal,
      purpose: goal,
      workspace: process.cwd(),
      pmRoleId: 'project_manager',
      memberRoleIds: ['project_manager'],
      recruitment: { phase: 'confirmed', sessionId: null, turns: 1, brief: goal, proposal: null, confirmedAt: new Date().toISOString() },
    });
    const development = create('知识研发团队', '验证研发团队知识隔离。');
    const operations = create('知识运维团队', '验证运维团队知识隔离。');
    store.saveKnowledge({
      title: '研发团队专属约定',
      content: '研发变更必须包含自动化测试。',
      scope: 'team',
      teamId: development.id,
      state: 'confirmed',
      source: '研发团队 fixture',
    });
    store.saveKnowledge({
      title: '运维团队专属约定',
      content: '生产发布必须先执行回滚演练。',
      scope: 'team',
      teamId: operations.id,
      state: 'confirmed',
      source: '运维团队 fixture',
    });
    return { development, operations };
  } finally {
    store.close();
  }
}

function seedCollaborationTeams() {
  const teams = seedConfirmedTeams();
  const store = new Store(dataDir, process.cwd(), { seedProjectManager: true });
  try {
    const source = store.teamSpace(teams.development.id);
    const target = store.teamSpace(teams.operations.id);
    if (!source || !target) throw new Error('E2E fixture requires two confirmed teams.');
    store.saveTeamSpace({
      ...source,
      collaboration: {
        enabled: true,
        autoHandoff: true,
        sharedBoard: true,
        allowedTeamIds: [target.id],
      },
    }, source.id);
    store.saveTeamSpace({
      ...target,
      collaboration: {
        enabled: true,
        autoHandoff: true,
        sharedBoard: true,
        allowedTeamIds: [source.id],
      },
    }, target.id);
    return { source: { ...teams.development, id: source.id }, target: { ...teams.operations, id: target.id } };
  } finally {
    store.close();
  }
}

function seedLongTimelineTeam() {
  const store = new Store(dataDir, process.cwd(), { seedProjectManager: true });
  try {
    const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const saved = store.saveTeamSpace({
      name: `长期交付团队 ${suffix}`,
      goal: '验证团队可以持续追溯更早的动态。',
      purpose: '验证时间线分页和游标去重。',
      workspace: process.cwd(),
      pmRoleId: 'project_manager',
      memberRoleIds: ['project_manager'],
      recruitment: {
        phase: 'confirmed',
        sessionId: null,
        turns: 1,
        brief: '验证时间线分页。',
        proposal: null,
        confirmedAt: new Date().toISOString(),
      },
    });
    for (let index = 0; index < 125; index += 1) {
      store.saveTeamMessage({
        spaceId: saved.id,
        teamId: saved.id,
        clientMessageId: `timeline-page-${suffix}-${index}`,
        kind: 'reply',
        senderType: 'agent',
        senderId: 'project_manager',
        content: `分页回归消息 ${index}`,
        status: 'sent',
      }, `timeline-page-${suffix}-${index}`);
    }
    return { id: saved.id, name: saved.name };
  } finally {
    store.close();
  }
}

function seedRiskTeams() {
  const store = new Store(dataDir, process.cwd(), { seedProjectManager: true });
  try {
    const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const teams = [
      { name: `风险研发团队 ${suffix}`, status: 'failed', error: '研发执行需要重试。' },
      { name: `风险运维团队 ${suffix}`, status: 'blocked', error: '运维任务等待人工处理。' },
    ].map((input) => {
      const team = store.saveTeamSpace({
        name: input.name,
        goal: '验证跨团队风险收件箱。',
        purpose: '验证风险按团队和类型筛选。',
        workspace: process.cwd(),
        pmRoleId: 'project_manager',
        memberRoleIds: ['project_manager'],
        recruitment: {
          phase: 'confirmed',
          sessionId: null,
          turns: 1,
          brief: '验证跨团队风险收件箱。',
          proposal: null,
          confirmedAt: new Date().toISOString(),
        },
      });
      const task = store.createTask({
        role: 'project_manager',
        prompt: `${input.name}风险任务`,
        workspace: process.cwd(),
      });
      store.records.save('task-meta', {
        spaceId: team.id,
        teamId: team.id,
        workspaceMode: 'isolated',
        attachmentIds: [],
      }, task.id);
      store.updateTask(task.id, { status: input.status, error: input.error });
      return { ...input, id: team.id, taskId: task.id };
    });
    store.records.save('attention', {
      teamId: teams[1].id,
      status: 'open',
      kind: 'manual-review',
      title: '运维团队需要确认',
      detail: '请确认运维任务的恢复边界。',
    }, `e2e-risk-attention-${suffix}`);
    return { source: teams[0], target: teams[1] };
  } finally {
    store.close();
  }
}

function seedDraftRecoveryTeams() {
  const store = new Store(dataDir, process.cwd(), { seedProjectManager: true });
  try {
    const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const inputs = [
      {
        slug: 'alpha',
        name: `服务端草稿团队 A ${suffix}`,
        goal: '验证草稿跨刷新恢复，并保持团队隔离。',
      },
      {
        slug: 'beta',
        name: `服务端草稿团队 B ${suffix}`,
        goal: '验证不同团队拥有独立的服务端草稿。',
      },
    ];
    const result = {};
    for (const input of inputs) {
      const saved = store.saveTeamSpace({
        name: input.name,
        goal: input.goal,
        purpose: input.goal,
        workspace: process.cwd(),
        pmRoleId: 'project_manager',
        memberRoleIds: ['project_manager'],
        recruitment: {
          phase: 'confirmed',
          sessionId: null,
          turns: 1,
          brief: input.goal,
          proposal: null,
          confirmedAt: new Date().toISOString(),
        },
      });
      result[input.slug] = { ...input, id: saved.id };
    }
    return result;
  } finally {
    store.close();
  }
}

// Two independent server drafts let the browser test exercise both sides of
// the optimistic-concurrency contract. The first changes different lines on
// each device (which should merge automatically); the second changes the same
// text (which must remain an explicit user decision).
function seedDraftMergeTeams() {
  const store = new Store(dataDir, process.cwd(), { seedProjectManager: true });
  try {
    const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const create = (slug, base) => {
      const goal = `验证多设备草稿 ${slug} ${suffix}。`;
      const saved = store.saveTeamSpace({
        name: `多设备草稿团队 ${slug} ${suffix}`,
        goal,
        purpose: goal,
        workspace: process.cwd(),
        pmRoleId: 'project_manager',
        memberRoleIds: ['project_manager'],
        recruitment: {
          phase: 'confirmed',
          sessionId: null,
          turns: 1,
          brief: goal,
          proposal: null,
          confirmedAt: new Date().toISOString(),
        },
      });
      const draft = store.saveTeamDraft({
        spaceId: saved.id,
        roleId: 'project_manager',
        content: base,
        attachmentIds: [],
      });
      return {
        slug,
        name: saved.name,
        id: saved.id,
        base,
        revision: draft.revision,
      };
    };
    return {
      merge: create('自动合并', '初始标题\n初始正文'),
      conflict: create('冲突决策', '共同草稿'),
    };
  } finally {
    store.close();
  }
}

function seedTeamTemplateSource() {
  const store = new Store(dataDir, process.cwd(), { seedProjectManager: true });
  try {
    const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const goal = '负责平台功能开发、自动化测试和版本交付。';
    const source = store.saveTeamSpace({
      name: `模板来源研发团队 ${suffix}`,
      goal,
      purpose: '把需求稳定地交付到线上。',
      teamType: 'development',
      workspace: process.cwd(),
      workspaceMode: 'isolated',
      pmRoleId: 'project_manager',
      memberRoleIds: ['project_manager', 'developer'],
      responsibilities: { developer: '实现功能并运行自动化测试。' },
      memberSettings: { developer: { label: '主开发', modelHint: 'template-model', capabilityIds: ['development-workflow'] } },
      model: 'template-model',
      providerId: 'template-provider',
      recruitment: { phase: 'confirmed', sessionId: null, turns: 1, brief: goal, proposal: null, confirmedAt: new Date().toISOString() },
    });
    store.saveTeamMessage({
      spaceId: source.id,
      teamId: source.id,
      clientMessageId: `template-source-${suffix}`,
      kind: 'reply',
      senderType: 'agent',
      senderId: 'project_manager',
      content: '来源团队历史消息，复制时不能带走。',
      status: 'sent',
    }, `template-source-message-${suffix}`);
    const sourceTask = store.createTask({
      role: 'project_manager',
      prompt: '来源团队历史任务，复制时不能带走。',
      workspace: process.cwd(),
      teamId: source.id,
      spaceId: source.id,
    });
    store.records.save('task-meta', { teamId: source.id, spaceId: source.id }, sourceTask.id);
    return { source };
  } finally {
    store.close();
  }
}

function sidebarLocator(page) {
  const mobile = (page.viewportSize()?.width || 1024) < 768;
  return page.locator(mobile
    ? '[data-sidebar="sidebar"][data-mobile="true"]'
    : '[data-sidebar="sidebar"]');
}

async function openMobileSidebar(page) {
  const sidebar = sidebarLocator(page);
  if ((page.viewportSize()?.width || 1024) < 768) {
    // A previous navigation closes the Sheet with a short exit animation. Let
    // that portal settle before deciding whether a fresh open is required.
    await page.waitForTimeout(350);
    const visible = await sidebar.isVisible().catch(() => false);
    const hasNavigation = visible && await sidebar
      .locator('button')
      .filter({ hasText: '团队招募' })
      .count()
      .catch(() => 0);
    if (hasNavigation) return sidebar;
    if (visible) await expect(sidebar).toBeHidden({ timeout: 1_000 }).catch(() => {});
    const trigger = page.getByRole('button', { name: 'Toggle Sidebar', exact: true }).first();
    await expect(trigger).toBeVisible();
    await trigger.click({ force: true });
    await expect(sidebar).toBeVisible();
    await expect(sidebar.locator('button').filter({ hasText: '团队招募' }).first()).toBeVisible();
    return sidebar;
  }
  if (await sidebar.isVisible().catch(() => false)) return sidebar;
  return page.locator('body');
}

async function clickNavigation(page, label) {
  await openMobileSidebar(page);
  await page.waitForTimeout(500);
  const navigation = sidebarLocator(page).locator('button').filter({ hasText: label }).first();
  await expect(navigation).toBeVisible();
  await navigation.click({ force: true });
}

async function recruitmentPage(page) {
  await page.goto('/');
  await openMobileSidebar(page);
  await page.waitForTimeout(500);
  const navigation = sidebarLocator(page).locator('button').filter({ hasText: '团队招募' }).first();
  await expect(navigation).toBeVisible();
  await navigation.click();
  await expect(page.getByRole('heading', { name: '发布需求，招募团队' })).toBeVisible();
  return page.locator('textarea[aria-label^="发送给"]');
}

test.describe('团队招募核心流程', () => {
  test('保存团队模板并创建独立副本，重新确认身份和边界', async ({ page }) => {
    const { source } = seedTeamTemplateSource();
    await page.goto('/');
    await openMobileSidebar(page);
    const sourceNav = sidebarLocator(page).locator('button').filter({ hasText: source.name }).first();
    await expect(sourceNav).toBeVisible();
    await sourceNav.click({ force: true });
    await expect(page.getByRole('heading', { name: source.name })).toBeVisible();
    await clickNavigation(page, '团队动态');
    await page.getByRole('button', { name: '保存为模板', exact: true }).click();
    await expect(page.getByRole('heading', { name: '保存团队模板', exact: true })).toBeVisible();
    const templateName = `研发模板 ${Date.now()}`;
    await page.getByRole('textbox', { name: '模板名称', exact: true }).fill(templateName);
    await page.getByRole('button', { name: '保存模板', exact: true }).click();
    await expect(page.getByText(`团队“${source.name}”已保存为模板`, { exact: true })).toBeVisible();

    await page.getByRole('button', { name: '新建团队', exact: true }).click();
    await expect(page.getByRole('heading', { name: '手动创建团队', exact: true })).toBeVisible();
    const templatePicker = page.getByRole('combobox', { name: '选择团队模板', exact: true });
    await expect(templatePicker).toBeVisible();
    await templatePicker.selectOption({ label: templateName });
    const copyName = `支付交付团队 ${Date.now()}`;
    const copyGoal = '负责支付链路的开发、测试和上线。';
    await page.getByRole('textbox', { name: '团队名称', exact: true }).fill(copyName);
    await page.getByRole('textbox', { name: '团队职责 / 目标', exact: true }).fill(copyGoal);
    await page.getByRole('textbox', { name: '工作目录', exact: true }).fill(process.cwd());
    await page.getByRole('button', { name: '创建团队', exact: true }).click();
    await expect(page.getByText(new RegExp(`已从模板创建团队“${copyName}`))).toBeVisible();
    await expect(page.getByRole('heading', { name: copyName })).toBeVisible();

    const copied = await page.evaluate(async (name) => {
      const teams = await fetch('/api/teams').then((response) => response.json());
      const team = teams.find((item) => item.name === name);
      const detail = await fetch(`/api/teams/${team.id}`).then((response) => response.json());
      return { team, detail };
    }, copyName);
    expect(copied.team).toMatchObject({
      name: copyName,
      goal: copyGoal,
      model: 'template-model',
      providerId: 'template-provider',
    });
    expect(copied.team.memberRoleIds).toEqual(['project_manager', 'developer']);
    expect(copied.team.memberSettings.developer.label).toBe('主开发');
    expect(copied.team.collaboration.allowedTeamIds).toEqual([]);
    expect(copied.detail.messages).toEqual([]);
    expect(copied.detail.tasks).toEqual([]);
  });

  test('招募页面显示可跨设备继续的会话同步状态', async ({ page }) => {
    await recruitmentPage(page);
    await expect(page.getByText('招募会话已同步，可在其他设备继续', { exact: true })).toBeVisible();
  });

  test('草稿跨页面恢复，发布新需求不会复用旧草稿', async ({ page }) => {
    const composer = await recruitmentPage(page);
    const draft = '为开发团队建立一条可验收的交付流程';
    await composer.fill(draft);

    await clickNavigation(page, '助手与模型');
    await expect(page.getByRole('heading', { name: '我的助手' })).toBeVisible();
    await clickNavigation(page, '团队招募');
    await expect(composer).toHaveValue(draft);

    await page.getByRole('button', { name: '另起需求', exact: true }).click();
    await expect(page.getByRole('heading', { name: '发布需求，招募团队' })).toBeVisible();
    await expect(page.locator('textarea[aria-label^="发送给"]')).toHaveValue('');

    const cachedDrafts = await page.evaluate(() => {
      const raw = window.localStorage.getItem('ggb.composer-drafts.v1');
      return raw ? Object.values(JSON.parse(raw).drafts || {}) : [];
    });
    expect(cachedDrafts).toContain(draft);
  });

  test('服务端草稿可跨刷新恢复，并按团队保持隔离', async ({ page }) => {
    const teams = seedDraftRecoveryTeams();
    const openTeam = async (team) => {
      await openMobileSidebar(page);
      const navigation = sidebarLocator(page).locator('button').filter({ hasText: team.name }).first();
      await expect(navigation).toBeVisible();
      await navigation.click({ force: true });
      await expect(page.getByRole('heading', { name: team.name })).toBeVisible();
    };
    const readDraft = (team) => page.evaluate(async ({ spaceId }) => {
      const response = await fetch(`/api/drafts?spaceId=${encodeURIComponent(spaceId)}&role=project_manager`);
      return { status: response.status, body: await response.json() };
    }, { spaceId: team.id });

    await page.goto('/');
    await openTeam(teams.alpha);
    const alphaComposer = page.locator('textarea[aria-label^="发送给"]');
    const alphaDraft = `服务端恢复草稿 ${Date.now()}`;
    await alphaComposer.fill(alphaDraft);
    await expect.poll(async () => {
      const result = await readDraft(teams.alpha);
      return result.body.content;
    }).toBe(alphaDraft);
    const stored = await readDraft(teams.alpha);
    expect(stored).toMatchObject({
      status: 200,
      body: { content: alphaDraft, roleId: 'project_manager' },
    });

    // Remove the browser-only copy so a reload proves that the server draft,
    // rather than localStorage, restores the composer.
    await page.evaluate(() => window.localStorage.removeItem('ggb.composer-drafts.v1'));
    await page.reload();
    await openTeam(teams.alpha);
    await expect(page.locator('textarea[aria-label^="发送给"]')).toHaveValue(alphaDraft);

    await openTeam(teams.beta);
    const betaComposer = page.locator('textarea[aria-label^="发送给"]');
    await expect(betaComposer).toHaveValue('');
    const betaDraft = `另一团队草稿 ${Date.now()}`;
    await betaComposer.fill(betaDraft);
    await expect.poll(async () => {
      const result = await readDraft(teams.beta);
      return result.body.content;
    }).toBe(betaDraft);

    await openTeam(teams.alpha);
    await expect(page.locator('textarea[aria-label^="发送给"]')).toHaveValue(alphaDraft);
    const betaRemote = await readDraft(teams.beta);
    expect(betaRemote.body.content).toBe(betaDraft);
  });

  test('多设备草稿会自动合并非重叠修改，并为重叠冲突提供版本选择', async ({ page }) => {
    const teams = seedDraftMergeTeams();
    const openTeam = async (team) => {
      await openMobileSidebar(page);
      const navigation = sidebarLocator(page).locator('button').filter({ hasText: team.name }).first();
      await expect(navigation).toBeVisible();
      await navigation.click({ force: true });
      await expect(page.getByRole('heading', { name: team.name })).toBeVisible();
    };
    const readDraft = (team) => page.evaluate(async ({ spaceId }) => {
      const response = await fetch(`/api/drafts?spaceId=${encodeURIComponent(spaceId)}&role=project_manager`);
      return { status: response.status, body: await response.json() };
    }, { spaceId: team.id });
    const writeRemoteDraft = (team, revision, content) => page.evaluate(async ({ spaceId, revision, content }) => {
      const response = await fetch('/api/drafts', {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          spaceId,
          roleId: 'project_manager',
          content,
          attachmentIds: [],
          revision,
        }),
      });
      return { status: response.status, body: await response.json() };
    }, { spaceId: team.id, revision, content });

    await page.goto('/');
    await openTeam(teams.merge);
    const mergeComposer = page.locator('textarea[aria-label^="发送给"]');
    await expect(mergeComposer).toHaveValue(teams.merge.base);
    const mergeInitial = await readDraft(teams.merge);
    expect(mergeInitial).toMatchObject({ status: 200, body: { revision: teams.merge.revision } });

    // Device A edits the first line while device B edits the second line. The
    // browser's three-way merge should retain both edits after the 409 retry.
    await mergeComposer.fill('本机标题\n初始正文');
    const remoteMerge = await writeRemoteDraft(teams.merge, mergeInitial.body.revision, '初始标题\n远端正文');
    expect(remoteMerge.status).toBe(200);
    await expect.poll(async () => (await readDraft(teams.merge)).body.content, { timeout: 15_000 })
      .toBe('本机标题\n远端正文');
    await expect(mergeComposer).toHaveValue('本机标题\n远端正文');
    await expect(page.locator('.draft-sync-status')).toContainText('草稿已同步');

    await openTeam(teams.conflict);
    const conflictComposer = page.locator('textarea[aria-label^="发送给"]');
    await expect(conflictComposer).toHaveValue(teams.conflict.base);
    const conflictInitial = await readDraft(teams.conflict);
    await conflictComposer.fill('本机版本');
    const remoteConflict = await writeRemoteDraft(teams.conflict, conflictInitial.body.revision, '远端版本');
    expect(remoteConflict.status).toBe(200);

    // Overlapping edits remain visible until the owner chooses which version
    // should win; the UI must never silently discard either device's text.
    const conflictPanel = page.getByRole('alert').filter({ hasText: '其他设备' });
    await expect(conflictPanel).toBeVisible({ timeout: 15_000 });
    await expect(conflictPanel).toContainText('本机版本');
    await expect(conflictPanel).toContainText('远端版本');
    await conflictPanel.getByRole('button', { name: /使用其他设备版本/ }).click();
    await expect(conflictComposer).toHaveValue('远端版本');
    await expect.poll(async () => (await readDraft(teams.conflict)).body.content).toBe('远端版本');
    await expect(page.locator('.draft-sync-status')).toContainText('草稿已同步');

    // Exercise the other explicit decision as well: choosing the local copy
    // must retry against the observed remote revision and overwrite it.
    const localChoiceInitial = await readDraft(teams.conflict);
    await conflictComposer.fill('本机覆盖版本');
    const remoteForLocalChoice = await writeRemoteDraft(
      teams.conflict,
      localChoiceInitial.body.revision,
      '远端第二版本',
    );
    expect(remoteForLocalChoice.status).toBe(200);
    const secondConflictPanel = page.getByRole('alert').filter({ hasText: '其他设备' });
    await expect(secondConflictPanel).toBeVisible({ timeout: 15_000 });
    await secondConflictPanel.getByRole('button', { name: /保留本机并覆盖远端/ }).click();
    await expect(conflictComposer).toHaveValue('本机覆盖版本');
    await expect.poll(async () => (await readDraft(teams.conflict)).body.content).toBe('本机覆盖版本');
    await expect(page.locator('.draft-sync-status')).toContainText('草稿已同步');
  });

  test('刷新后保留后台任务视图和当前团队上下文', async ({ page }) => {
    const teams = seedConfirmedTeams();
    const team = teams.development;
    await page.goto('/');
    await openMobileSidebar(page);
    const teamNavigation = sidebarLocator(page).locator('button').filter({ hasText: team.name }).first();
    await expect(teamNavigation).toBeVisible();
    await teamNavigation.click({ force: true });
    await expect(page.getByRole('heading', { name: team.name })).toBeVisible();
    await clickNavigation(page, '团队动态');
    await expect(page.getByRole('heading', { name: team.name })).toBeVisible();
    await expect(page.getByText('风险/阻塞', { exact: true })).toBeVisible();
    await expect(page.getByText('最近交付证据 0 项', { exact: true })).toBeVisible();

    await clickNavigation(page, '后台任务');
    await expect(page.getByRole('heading', { name: '让工作持续推进。' })).toBeVisible();
    await expect.poll(() => page.evaluate(() => {
      const raw = window.localStorage.getItem('ggb.workspace-route.v1');
      return raw ? JSON.parse(raw) : null;
    })).toMatchObject({ spaceId: team.id, view: 'tasks' });

    await page.reload();
    await expect(page.getByRole('heading', { name: '让工作持续推进。' })).toBeVisible();
    await expect.poll(() => page.evaluate(() => {
      const raw = window.localStorage.getItem('ggb.workspace-route.v1');
      return raw ? JSON.parse(raw) : null;
    })).toMatchObject({ spaceId: team.id, view: 'tasks' });

    // Switching back to the team view proves the selected team survived the
    // utility-page remount; a reset to the first team would expose a different
    // heading or activity stream here.
    await clickNavigation(page, '团队动态');
    await expect(page.getByRole('heading', { name: team.name })).toBeVisible();
  });

  test('拖入图片保存真实二进制附件，并在需求草稿中显示文件卡片', async ({ page }) => {
    const composer = await recruitmentPage(page);
    await composer.fill('请识别这张设计图中的交付要求');
    const pngBytes = [137, 80, 78, 71, 13, 10, 26, 10, 0, 1, 2, 3];
    const attachmentDir = path.join(dataDir, 'attachments');
    const existingFiles = fs.existsSync(attachmentDir)
      ? fs.readdirSync(attachmentDir).filter((name) => name.endsWith('.bin'))
      : [];
    await page.locator('.composer').evaluate((element, bytes) => {
      const transfer = new DataTransfer();
      transfer.items.add(new File([new Uint8Array(bytes)], 'design.png', { type: 'image/png' }));
      for (const type of ['dragenter', 'dragover', 'drop']) {
        const event = new DragEvent(type, { bubbles: true, cancelable: true });
        Object.defineProperty(event, 'dataTransfer', { value: transfer });
        element.dispatchEvent(event);
      }
    }, pngBytes);

    await expect(page.getByRole('button', { name: /design\.png/ })).toBeVisible();
    await expect(page.getByText(/已添加 1 个附件/)).toBeVisible();

    await expect.poll(() => {
      if (!fs.existsSync(attachmentDir)) return [];
      return fs.readdirSync(attachmentDir).filter((name) => name.endsWith('.bin'));
    }).toHaveLength(existingFiles.length + 1);
    const currentFiles = fs.readdirSync(attachmentDir).filter((name) => name.endsWith('.bin'));
    const newFile = currentFiles.find((name) => !existingFiles.includes(name));
    expect(newFile).toBeTruthy();
    const stored = fs.readFileSync(path.join(attachmentDir, newFile));
    expect([...stored]).toEqual(pngBytes);
  });

  test('确认 Team Charter 后进入我的团队并保留重命名后的团队身份', async ({ page }) => {
    const { teamName, teamId } = seedProposedRecruitment();
    const composer = await recruitmentPage(page);
    const draftPicker = page.getByRole('combobox', { name: '选择需求草稿', exact: true });
    await draftPicker.click();
    await page.getByRole('option', { name: `需求草稿 · 待确认需求`, exact: true }).click();
    await expect(page.getByRole('heading', { name: teamName })).toBeVisible();
    await expect(page.getByRole('button', { name: '确认创建团队', exact: true })).toBeVisible();

    await page.getByRole('button', { name: '确认创建团队', exact: true }).click();
    await expect(page.getByText(/已确认，项目经理可以开始安排任务/)).toBeVisible();
    await openMobileSidebar(page);
    const createdTeamNav = page.getByRole('button', { name: new RegExp(`${teamName}.*交付`) });
    await expect(createdTeamNav).toBeVisible();
    if ((page.viewportSize()?.width || 1024) < 768) await createdTeamNav.click({ force: true });

    await page.getByRole('button', { name: '重命名', exact: true }).click();
    await expect(page.getByRole('dialog')).toBeVisible();
    const renamed = '开发交付团队';
    await page.getByLabel('团队名称').fill(renamed);
    await page.getByRole('button', { name: '保存名称', exact: true }).click();
    await expect(page.getByRole('heading', { name: renamed })).toBeVisible();
    await expect(page.getByText(`团队已重命名为“${renamed}”`)).toBeVisible();
    await page.getByRole('button', { name: '团队设置', exact: true }).click();
    const settings = page.getByRole('dialog');
    await expect(settings).toBeVisible();
    const workspaceMode = settings.getByRole('combobox', { name: '默认执行目录', exact: true });
    await workspaceMode.click();
    await page.getByRole('option', { name: '快照目录', exact: true }).click();
    await settings.getByRole('button', { name: '保存团队设置', exact: true }).click();
    await expect(page.getByText(`团队“${renamed}”设置已保存`)).toBeVisible();
    const savedTeam = await page.evaluate(async ({ id }) => {
      const state = await fetch('/api/state').then((response) => response.json());
      return state.spaces.find((space) => space.id === id);
    }, { id: teamId });
    expect(savedTeam).toMatchObject({ id: teamId, name: renamed, workspaceMode: 'snapshot' });
    await openMobileSidebar(page);
    await expect(page.getByRole('button', { name: new RegExp(`${renamed}.*交付`) })).toBeVisible();
    await expect(composer).toHaveValue('');
  });

  test('团队设置可以把跨团队协作限制到明确的目标团队', async ({ page }) => {
    const teams = seedConfirmedTeams();
    const source = teams.development;
    const target = teams.operations;
    await page.goto('/');
    await openMobileSidebar(page);
    const navigation = sidebarLocator(page).locator('button').filter({ hasText: source.name }).first();
    await expect(navigation).toBeVisible();
    await navigation.click({ force: true });
    await expect(page.getByRole('heading', { name: source.name })).toBeVisible();

    await page.getByRole('button', { name: '团队设置', exact: true }).click();
    const settings = page.getByRole('dialog');
    await expect(settings).toBeVisible();
    const targetOption = settings.getByRole('checkbox', { name: `允许协作：${target.name}`, exact: true });
    await expect(targetOption).toBeVisible();
    await targetOption.check();
    await settings.getByRole('button', { name: '保存团队设置', exact: true }).click();
    await expect(page.getByText(`团队“${source.name}”设置已保存`)).toBeVisible();

    const saved = await page.evaluate(async ({ id }) => {
      const state = await fetch('/api/state').then((response) => response.json());
      return state.spaces.find((space) => space.id === id);
    }, { id: source.id });
    expect(saved.collaboration).toMatchObject({
      enabled: true,
      allowedTeamIds: [target.id],
    });
    const collaborators = await page.evaluate(async ({ id }) => {
      const response = await fetch(`/api/teams/${id}/collaborators`);
      return response.json();
    }, { id: source.id });
    expect(collaborators.map((item) => item.id)).toEqual([target.id]);
  });

  test('两个已创建团队切换时保留各自动态和草稿上下文', async ({ page }) => {
    const { development, operations } = seedConfirmedTeams();
    await page.goto('/');

    const openTeam = async (team) => {
      await openMobileSidebar(page);
      const navigation = sidebarLocator(page).locator('button').filter({ hasText: team.name }).first();
      await expect(navigation).toBeVisible();
      await navigation.click({ force: true });
      await expect(page.getByRole('heading', { name: team.name })).toBeVisible();
    };

    await openTeam(development);
    const developmentComposer = page.locator('textarea[aria-label^="发送给"]');
    await developmentComposer.fill('研发团队专属草稿');
    await clickNavigation(page, '团队动态');
    await expect(page.getByText('统一时间线', { exact: true })).toBeVisible();
    const developmentTimeline = page.locator('[aria-label="团队统一时间线"]');
    await expect(developmentTimeline.getByText(development.message, { exact: true })).toBeVisible();
    await expect(page.getByRole('region', { name: '团队协作控制台', exact: true }).getByText(development.message, { exact: true })).toHaveCount(0);
    await developmentTimeline.getByRole('tab', { name: '证据', exact: true }).click();
    await expect(developmentTimeline.getByText('当前筛选没有记录', { exact: true })).toBeVisible();
    await developmentTimeline.getByRole('tab', { name: '全部', exact: true }).click();
    await expect(developmentTimeline.getByText(development.message, { exact: true })).toBeVisible();

    await openTeam(operations);
    const operationsComposer = page.locator('textarea[aria-label^="发送给"]');
    await expect(operationsComposer).toHaveValue('');
    await clickNavigation(page, '团队动态');
    await expect(page.getByText('统一时间线', { exact: true })).toBeVisible();
    const operationsTimeline = page.locator('[aria-label="团队统一时间线"]');
    await expect(operationsTimeline.getByText(operations.message, { exact: true })).toBeVisible();
    await expect(operationsTimeline.getByText(development.message, { exact: true })).toHaveCount(0);
    await expect(page.getByRole('region', { name: '团队协作控制台', exact: true }).getByText(operations.message, { exact: true })).toHaveCount(0);

    // A reload must preserve the active team route instead of falling back to
    // the first confirmed team and exposing another team's draft.
    await page.reload();
    await expect(page.getByRole('heading', { name: operations.name })).toBeVisible();
    // RouteCache now also restores the last utility view. Re-enter the team's
    // conversation explicitly before asserting the composer state.
    await openTeam(operations);
    await expect(page.locator('textarea[aria-label^="发送给"]')).toHaveValue('');

    await openTeam(development);
    await expect(page.locator('textarea[aria-label^="发送给"]')).toHaveValue('研发团队专属草稿');
  });

  test('两个团队切换模型后将 provider 与 model 精确传给团队消息', async ({ page }) => {
    const teams = seedModelTeams();
    const requests = [];
    await page.route('**/api/spaces/*/messages', async (route) => {
      const request = route.request();
      const body = request.postDataJSON();
      requests.push({ url: request.url(), body });
      await route.fulfill({
        status: 201,
        contentType: 'application/json',
        body: JSON.stringify({
          id: `e2e-message-${requests.length}`,
          spaceId: new URL(request.url()).pathname.split('/')[3],
          clientMessageId: body.clientMessageId,
          kind: 'request',
          senderType: 'owner',
          senderId: 'owner',
          content: body.content,
          status: 'sent',
          sessionId: `e2e-session-${requests.length}`,
        }),
      });
    });
    await page.goto('/');

    const openTeam = async (team) => {
      await openMobileSidebar(page);
      const navigation = sidebarLocator(page).locator('button').filter({ hasText: team.name }).first();
      await expect(navigation).toBeVisible();
      await navigation.click({ force: true });
      await expect(page.getByRole('heading', { name: team.name })).toBeVisible();
    };
    const selectModelAndSend = async (team, initialKey, selectedKey, prompt) => {
      await openTeam(team);
      const selector = page.getByRole('combobox', { name: '选择模型', exact: true });
      const initial = initialKey === 'alpha'
        ? 'e2e-provider-alpha::e2e-alpha-model'
        : 'e2e-provider-beta::e2e-beta-model';
      await expect(selector).toHaveValue(initial);
      const selected = selectedKey === 'alpha'
        ? 'e2e-provider-alpha::e2e-alpha-model'
        : 'e2e-provider-beta::e2e-beta-model';
      await selector.selectOption(selected);
      await expect(selector).toHaveValue(selected);
      const composer = page.locator('textarea[aria-label^="发送给"]');
      await composer.fill(prompt);
      const previousRequestCount = requests.length;
      await page.getByRole('button', { name: '发送任务', exact: true }).click();
      await expect.poll(() => requests.length).toBe(previousRequestCount + 1);
      return requests[requests.length - 1];
    };

    // Each team starts on a different route. Switch to the other team/model
    // pair before sending so a visible label change alone cannot pass.
    const alphaRequest = await selectModelAndSend(teams.alpha, 'alpha', 'beta', 'Alpha 团队使用 Beta 模型');
    expect(alphaRequest.url).toContain(`/api/spaces/${teams.alpha.id}/messages`);
    expect(alphaRequest.body).toMatchObject({
      providerId: 'e2e-provider-beta',
      model: 'e2e-beta-model',
      content: 'Alpha 团队使用 Beta 模型',
    });
    expect(alphaRequest.body.allowModelWithoutTools).toBe(true);

    const betaRequest = await selectModelAndSend(teams.beta, 'beta', 'alpha', 'Beta 团队使用 Alpha 模型');
    expect(betaRequest.url).toContain(`/api/spaces/${teams.beta.id}/messages`);
    expect(betaRequest.body).toMatchObject({
      providerId: 'e2e-provider-alpha',
      model: 'e2e-alpha-model',
      content: 'Beta 团队使用 Alpha 模型',
    });
    expect(betaRequest.body.allowModelWithoutTools).toBe(true);
    expect(requests).toHaveLength(2);

    // The PUT performed by the switcher is durable and scoped per team; read
    // the real API state to guard against a request-body-only false positive.
    const state = await page.evaluate(async ({ alphaId, betaId }) => {
      const next = await fetch('/api/state').then((response) => response.json());
      return {
        alpha: next.spaces.find((space) => space.id === alphaId),
        beta: next.spaces.find((space) => space.id === betaId),
      };
    }, { alphaId: teams.alpha.id, betaId: teams.beta.id });
    const alpha = state.alpha;
    const beta = state.beta;
    expect(alpha).toMatchObject({
      providerId: 'e2e-provider-beta',
      model: 'e2e-beta-model',
      memberSettings: {
        project_manager: {
          providerIds: ['e2e-provider-beta'],
          modelHint: 'e2e-beta-model',
        },
      },
    });
    expect(beta).toMatchObject({
      providerId: 'e2e-provider-alpha',
      model: 'e2e-alpha-model',
      memberSettings: {
        project_manager: {
          providerIds: ['e2e-provider-alpha'],
          modelHint: 'e2e-alpha-model',
        },
      },
    });
  });

  test('模型切换器显示最近探测状态并保留明确选择', async ({ page }) => {
    const teams = seedModelTeams();
    await page.goto('/');
    await openMobileSidebar(page);
    await sidebarLocator(page).locator('button').filter({ hasText: teams.alpha.name }).first().click({ force: true });
    await expect(page.getByRole('heading', { name: teams.alpha.name })).toBeVisible();
    const selector = page.getByRole('combobox', { name: '选择模型', exact: true });
    await expect(selector.locator(`option[value="e2e-provider-alpha::e2e-alpha-model"]`)).toContainText('最近检查通过');
    await selector.selectOption('e2e-provider-beta::e2e-beta-model');
    await expect(selector).toHaveValue('e2e-provider-beta::e2e-beta-model');
    await expect(selector.locator(`option[value="e2e-provider-beta::e2e-beta-model"]`)).toContainText('最近检查失败');
    await expect(page.getByText(/最近一次连通性检查失败：接口返回 HTTP 503/)).toBeVisible();
  });

  test('模型管理显示真实运行指标并支持按团队筛选', async ({ page }) => {
    const teams = seedModelMetrics();
    await page.goto('/');
    await clickNavigation(page, '模型管理');
    await expect(page.getByRole('heading', { name: '模型管理' })).toBeVisible();
    const panel = page.getByRole('region', { name: '模型运行指标', exact: true });
    await expect(panel).toBeVisible();
    // Earlier flows in this shared browser fixture may leave other model
    // attempts behind; assert the two rows created by this fixture directly.
    const fixtureRows = panel.getByTestId('model-metrics-row').filter({ hasText: /e2e-(alpha|beta)-model/ });
    await expect(fixtureRows).toHaveCount(2);
    await expect(panel.getByTestId('model-metrics-row').filter({ hasText: 'e2e-alpha-model' })).toBeVisible();
    await expect(panel.getByTestId('model-metrics-row').filter({ hasText: 'e2e-beta-model' })).toBeVisible();
    await expect(panel.getByTestId('model-metrics-row').filter({ hasText: 'e2e-beta-model' }).getByText('未知', { exact: true })).toBeVisible();
    await panel.getByRole('combobox', { name: '指标团队', exact: true }).selectOption(teams.alpha.id);
    await expect(panel.getByTestId('model-metrics-row').filter({ hasText: 'e2e-alpha-model' })).toHaveCount(1);
    await expect(panel.getByTestId('model-metrics-row').filter({ hasText: 'e2e-alpha-model' })).toBeVisible();
    await expect(panel.getByTestId('model-metrics-row').filter({ hasText: 'e2e-beta-model' })).toHaveCount(0);
  });

  test('知识库按当前团队隔离团队专属知识', async ({ page }) => {
    const teams = seedTeamKnowledge();
    await page.goto('/');
    await openMobileSidebar(page);
    await sidebarLocator(page).locator('button').filter({ hasText: teams.development.name }).first().click({ force: true });
    await expect(page.getByRole('heading', { name: teams.development.name })).toBeVisible();
    await clickNavigation(page, '知识库');
    await expect(page.getByRole('heading', { name: '每次工作，都有积累。' })).toBeVisible();
    const cards = page.locator('.knowledge-card-wrapper');
    await expect(cards.filter({ hasText: '研发团队专属约定' })).toHaveCount(1);
    await expect(cards.filter({ hasText: '运维团队专属约定' })).toHaveCount(0);
    await expect(page.getByText('团队共享', { exact: true }).first()).toBeVisible();
  });

  test('助手编辑器显示能力兼容状态和现有绑定范围', async ({ page }) => {
    const fixture = seedCapabilityBinding();
    await page.goto('/');
    await clickNavigation(page, '助手与模型');
    await expect(page.getByRole('heading', { name: '我的助手' })).toBeVisible();
    await page.getByRole('button', { name: '编辑产品助手', exact: true }).click();
    const dialog = page.getByRole('dialog');
    await expect(dialog).toBeVisible();
    await dialog.getByRole('tab', { name: '工具与 Skills', exact: true }).click();
    const capability = dialog.getByRole('checkbox', { name: '绑定能力：E2E 证据整理能力', exact: true });
    await expect(capability).toBeChecked();
    await expect(dialog.getByText(/部分兼容/)).toBeVisible();
    await expect(dialog.getByText(/中风险/)).toBeVisible();
    await expect(dialog.getByText(/1 个助手/)).toBeVisible();
    await expect(dialog.getByText('需要先检查执行节点。')).toBeVisible();
    expect(fixture.capabilityId).toBeTruthy();
  });

  test('团队时间线可以加载更早动态并保持筛选入口', async ({ page }) => {
    const team = seedLongTimelineTeam();
    await page.goto('/');
    await openMobileSidebar(page);
    await sidebarLocator(page).locator('button').filter({ hasText: team.name }).first().click({ force: true });
    await expect(page.getByRole('heading', { name: team.name })).toBeVisible();
    await clickNavigation(page, '团队动态');
    const timeline = page.locator('[aria-label="团队统一时间线"]');
    await expect(timeline.getByRole('button', { name: '更早动态', exact: true })).toBeVisible();
    await timeline.getByRole('button', { name: '更早动态', exact: true }).click();
    await expect(timeline.getByText('分页回归消息 0', { exact: true })).toBeVisible();
    await expect(timeline.getByRole('button', { name: '更早动态', exact: true })).toHaveCount(0);
  });

  test('后台任务提供跨团队风险筛选并可回到对应团队', async ({ page }) => {
    const teams = seedRiskTeams();
    await page.goto('/');
    await clickNavigation(page, '后台任务');
    const inbox = page.getByRole('region', { name: '跨团队风险', exact: true });
    await expect(inbox).toBeVisible();
    await inbox.getByRole('combobox', { name: '风险团队', exact: true }).selectOption(teams.target.id);
    await expect(inbox.getByText('2 项待处理', { exact: true })).toBeVisible();
    await expect(inbox.locator('.risk-inbox-item').filter({ hasText: teams.target.name }).first()).toBeVisible();
    await expect(inbox.locator('.risk-inbox-item').filter({ hasText: teams.source.name })).toHaveCount(0);
    await inbox.getByRole('combobox', { name: '风险类型', exact: true }).selectOption('attention');
    await expect(inbox.getByText('运维团队需要确认', { exact: true })).toBeVisible();
    await inbox.getByRole('button', { name: '打开风险 运维团队需要确认', exact: true }).click();
    await expect(page.getByRole('heading', { name: teams.target.name })).toBeVisible();
  });

  test('团队动态支持跨团队统一时间线筛选并回到对应团队', async ({ page }) => {
    const teams = seedConfirmedTeams();
    await page.goto('/');
    await openMobileSidebar(page);
    await sidebarLocator(page).locator('button').filter({ hasText: teams.development.name }).first().click({ force: true });
    await expect(page.getByRole('heading', { name: teams.development.name })).toBeVisible();
    await clickNavigation(page, '团队动态');
    const timeline = page.getByRole('region', { name: '跨团队统一时间线', exact: true });
    await expect(timeline).toBeVisible();
    const teamScope = timeline.getByRole('combobox', { name: '统一时间线团队', exact: true });
    await teamScope.selectOption(teams.development.id);
    await expect(timeline.locator('.cross-team-timeline-item').filter({ hasText: teams.development.name }).first()).toBeVisible();
    await teamScope.selectOption(teams.operations.id);
    await expect(timeline.locator('.cross-team-timeline-item').filter({ hasText: teams.operations.name }).first()).toBeVisible();
    await expect(timeline.locator('.cross-team-timeline-item').filter({ hasText: teams.development.name })).toHaveCount(0);
    await timeline.locator('.cross-team-timeline-item').filter({ hasText: teams.operations.name }).first().click();
    await expect(page.getByRole('heading', { name: teams.operations.name })).toBeVisible();
  });

  test('团队协作控制台可以委派目标并显示任务回传入口', async ({ page }) => {
    const teams = seedCollaborationTeams();
    const collaborationRequests = [];
    await page.goto('/');
    await page.route('**/api/teams/*/collaborate', async (route) => {
      const request = route.request();
      collaborationRequests.push({ url: request.url(), body: request.postDataJSON() });
      await route.fulfill({
        status: 201,
        contentType: 'application/json',
        body: JSON.stringify({
          id: 'e2e-handoff-message',
          spaceId: teams.target.id,
          teamId: teams.target.id,
          kind: 'handoff',
          senderType: 'team',
          senderId: teams.source.id,
          fromTeamId: teams.source.id,
          toTeamId: teams.target.id,
          content: request.postDataJSON().content,
          status: 'sent',
          taskId: 'e2e-collaboration-task',
          sourceTeamId: teams.source.id,
          targetTeamId: teams.target.id,
          sessionId: 'e2e-collaboration-session',
        }),
      });
    });
    await openMobileSidebar(page);
    await sidebarLocator(page).locator('button').filter({ hasText: teams.source.name }).first().click({ force: true });
    await expect(page.getByRole('heading', { name: teams.source.name })).toBeVisible();
    await clickNavigation(page, '团队动态');
    const console = page.getByRole('region', { name: '团队协作控制台', exact: true });
    await expect(console).toBeVisible();
    await expect(console.getByRole('combobox', { name: '选择协作目标团队', exact: true })).toHaveValue(teams.target.id);
    await expect(console.locator('.team-collaboration-target').getByText(teams.target.name, { exact: true })).toBeVisible();

    const goal = `请回传 ${Date.now()} 的发布检查清单。`;
    await console.getByRole('textbox', { name: '协作目标', exact: true }).fill(goal);
    await console.getByRole('button', { name: '发起跨团队协作', exact: true }).click();
    await expect(console.getByText(/协作请求已发送给/)).toBeVisible();
    await expect(console.getByRole('button', { name: '查看任务', exact: true })).toBeVisible();
    await expect.poll(() => collaborationRequests.length).toBe(1);
    expect(collaborationRequests[0].url).toContain(`/api/teams/${teams.source.id}/collaborate`);
    expect(collaborationRequests[0].body).toMatchObject({ targetTeamId: teams.target.id, content: goal });

    await openMobileSidebar(page);
    await sidebarLocator(page).locator('button').filter({ hasText: teams.target.name }).first().click({ force: true });
    await expect(page.getByRole('heading', { name: teams.target.name })).toBeVisible();
    await clickNavigation(page, '团队动态');
    const targetConsole = page.getByRole('region', { name: '团队协作控制台', exact: true });
    await expect(targetConsole).toBeVisible();
  });

  test('desktop/mobile 连续20次切换时团队模型、动态和草稿保持隔离', async ({ page }) => {
    const teams = seedModelTeams();
    const requests = [];
    const messages = new Map();
    await page.route('**/api/spaces/**', async (route) => {
      const request = route.request();
      const url = new URL(request.url());
      const parts = url.pathname.split('/').filter(Boolean);
      const spaceId = parts[2];
      if (request.method() === 'POST' && parts[3] === 'messages') {
        const body = request.postDataJSON();
        const entry = {
          id: `stress-message-${requests.length + 1}`,
          spaceId,
          clientMessageId: body.clientMessageId,
          kind: 'request',
          senderType: 'owner',
          senderId: 'owner',
          content: body.content,
          status: 'sent',
          sessionId: `stress-session-${requests.length + 1}`,
        };
        requests.push({ url: request.url(), body });
        messages.set(spaceId, [...(messages.get(spaceId) || []), entry]);
        await route.fulfill({ status: 201, contentType: 'application/json', body: JSON.stringify(entry) });
        return;
      }
      if (request.method() === 'GET' && parts.length === 3) {
        const response = await route.fetch();
        const payload = await response.json();
        payload.messages = [...(payload.messages || []), ...(messages.get(spaceId) || [])];
        await route.fulfill({ response, json: payload });
        return;
      }
      await route.continue();
    });
    await page.goto('/');
    const openTeam = async (team) => {
      await openMobileSidebar(page);
      const navigation = sidebarLocator(page).locator('button').filter({ hasText: team.name }).first();
      await expect(navigation).toBeVisible();
      await navigation.click({ force: true });
      await expect(page.getByRole('heading', { name: team.name })).toBeVisible();
    };
    const options = {
      alpha: { key: 'e2e-provider-alpha::e2e-alpha-model', providerId: 'e2e-provider-alpha', model: 'e2e-alpha-model' },
      beta: { key: 'e2e-provider-beta::e2e-beta-model', providerId: 'e2e-provider-beta', model: 'e2e-beta-model' },
    };
    const teamByIndex = [teams.alpha, teams.beta];
    await openTeam(teams.alpha);
    await page.locator('textarea[aria-label^="发送给"]').fill('alpha 保留草稿');
    await openTeam(teams.beta);
    await page.locator('textarea[aria-label^="发送给"]').fill('beta 保留草稿');
    await openTeam(teams.alpha);
    await expect(page.locator('textarea[aria-label^="发送给"]')).toHaveValue('alpha 保留草稿');
    await openTeam(teams.beta);
    await expect(page.locator('textarea[aria-label^="发送给"]')).toHaveValue('beta 保留草稿');
    for (let index = 0; index < 20; index += 1) {
      const team = teamByIndex[index % 2];
      const key = team === teams.alpha ? 'alpha' : 'beta';
      const selected = options[key];
      await openTeam(team);
      const selector = page.getByRole('combobox', { name: '选择模型', exact: true });
      await selector.selectOption(selected.key);
      await expect(selector).toHaveValue(selected.key);
      const composer = page.locator('textarea[aria-label^="发送给"]');
      const draft = `${key} 专属草稿 ${index}`;
      await composer.fill(draft);
      await page.getByRole('button', { name: '发送任务', exact: true }).click();
      await expect.poll(() => requests.length).toBe(index + 1);
      const sent = requests[index];
      expect(sent.url).toContain(`/api/spaces/${team.id}/messages`);
      expect(sent.body).toMatchObject({
        providerId: selected.providerId,
        model: selected.model,
        content: draft,
      });
      // Keep a second draft after sending so switching back validates the
      // localStorage key for this team independently.
      await composer.fill(`${key} 保留草稿`);
      await openTeam(teamByIndex[(index + 1) % 2]);
    }
    expect(requests).toHaveLength(20);
    for (const team of teamByIndex) {
      await openTeam(team);
      const key = team === teams.alpha ? 'alpha' : 'beta';
      const detail = await page.evaluate(async (id) => fetch(`/api/spaces/${id}`).then((response) => response.json()), team.id);
      expect(detail.messages.filter((message) => message.content.startsWith(`${key} 专属草稿`))).toHaveLength(10);
      expect(detail.messages.filter((message) => message.content.startsWith(`${key === 'alpha' ? 'beta' : 'alpha'} 专属草稿`))).toHaveLength(0);
    }
    await openTeam(teams.alpha);
    await page.locator('textarea[aria-label^="发送给"]').fill('alpha 保留草稿');
    await openTeam(teams.beta);
    await page.locator('textarea[aria-label^="发送给"]').fill('beta 保留草稿');
    await page.reload();
    await openTeam(teams.alpha);
    await expect(page.locator('textarea[aria-label^="发送给"]')).toHaveValue('alpha 保留草稿');
    await openTeam(teams.beta);
    await expect(page.locator('textarea[aria-label^="发送给"]')).toHaveValue('beta 保留草稿');
  });

});

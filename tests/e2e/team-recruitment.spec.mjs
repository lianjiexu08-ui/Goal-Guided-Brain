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
        health: null,
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
        health: null,
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
    }
    return { development: teams[0], operations: teams[1] };
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
    const { teamName } = seedProposedRecruitment();
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
    await openMobileSidebar(page);
    await expect(page.getByRole('button', { name: new RegExp(`${renamed}.*交付`) })).toBeVisible();
    await expect(composer).toHaveValue('');
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
    await expect(page.getByText(development.message, { exact: true })).toBeVisible();

    await openTeam(operations);
    const operationsComposer = page.locator('textarea[aria-label^="发送给"]');
    await expect(operationsComposer).toHaveValue('');
    await clickNavigation(page, '团队动态');
    await expect(page.getByText(operations.message, { exact: true })).toBeVisible();
    await expect(page.getByText(development.message, { exact: true })).toHaveCount(0);

    // A reload must preserve the active team route instead of falling back to
    // the first confirmed team and exposing another team's draft.
    await page.reload();
    await expect(page.getByRole('heading', { name: operations.name })).toBeVisible();
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

});

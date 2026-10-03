import os from 'node:os';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { Store } from '../../server/store.mjs';

const dataDir =
  process.env.GGB_E2E_DATA_DIR ||
  path.join(os.tmpdir(), 'ggb-browser-e2e-fixture');

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
      const existing = store
        .teamSpaces()
        .find((space) => space.name === input.name);
      const saved = store.saveTeamSpace(
        {
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
        },
        existing?.id,
      );
      store.saveTeamMessage(
        {
          spaceId: saved.id,
          teamId: saved.id,
          clientMessageId: `e2e-${input.slug}-message`,
          kind: 'reply',
          senderType: 'agent',
          senderId: 'project_manager',
          content: input.message,
          status: 'sent',
        },
        `e2e-${input.slug}-message`,
      );
      result[input.slug] = { ...input, id: saved.id };
    }
    // Keep the historic keys used by the existing tests while returning the
    // durable ids needed by route-cache assertions.
    return { development: result.operations, operations: result.development };
  } finally {
    store.close();
  }
}

function sidebarLocator(page) {
  const mobile = (page.viewportSize()?.width || 1024) < 768;
  return page.locator(
    mobile
      ? '[data-sidebar="sidebar"][data-mobile="true"]'
      : '[data-sidebar="sidebar"]',
  );
}

async function openMobileSidebar(page) {
  const sidebar = sidebarLocator(page);
  if ((page.viewportSize()?.width || 1024) < 768) {
    // A previous navigation closes the Sheet with a short exit animation. Let
    // that portal settle before deciding whether a fresh open is required.
    await page.waitForTimeout(350);
    const visible = await sidebar.isVisible().catch(() => false);
    const hasNavigation =
      visible &&
      (await sidebar
        .locator('button')
        .filter({ hasText: '团队招募' })
        .count()
        .catch(() => 0));
    if (hasNavigation) return sidebar;
    if (visible)
      await expect(sidebar)
        .toBeHidden({ timeout: 1_000 })
        .catch(() => {});
    const trigger = page
      .getByRole('button', { name: 'Toggle Sidebar', exact: true })
      .first();
    await expect(trigger).toBeVisible();
    await trigger.click({ force: true });
    await expect(sidebar).toBeVisible();
    await expect(
      sidebar.locator('button').filter({ hasText: '团队招募' }).first(),
    ).toBeVisible();
    return sidebar;
  }
  if (await sidebar.isVisible().catch(() => false)) return sidebar;
  return page.locator('body');
}

async function openDraftTeam(page, team) {
  await openMobileSidebar(page);
  const navigation = sidebarLocator(page)
    .locator('button')
    .filter({ hasText: team.name })
    .first();
  await expect(navigation).toBeVisible();
  await navigation.click({ force: true });
  await expect(page.getByRole('heading', { name: team.name })).toBeVisible();
}

async function readDraftFromApi(page, team) {
  const response = await page.request.get(
    `/api/drafts?spaceId=${encodeURIComponent(team.id)}&role=project_manager`,
  );
  return { status: response.status(), body: await response.json() };
}

async function writeDraftFromApi(
  page,
  team,
  revision,
  content,
  attachmentIds = [],
) {
  const response = await page.request.put('/api/drafts', {
    data: {
      spaceId: team.id,
      roleId: 'project_manager',
      content,
      attachmentIds,
      revision,
    },
  });
  return { status: response.status(), body: await response.json() };
}

test.describe('草稿恢复与移动端返回', () => {
  test('离线编辑多个团队后恢复网络，自动同步草稿清空和附件状态且不发送消息', async ({
    page,
    context,
  }) => {
    const teams = seedDraftRecoveryTeams();
    await page.goto('/');
    await openDraftTeam(page, teams.alpha);
    const composer = page.locator('textarea[aria-label^="发送给"]');

    const addAttachment = async (name, content) => {
      await page.locator('input[aria-label="选择要添加的文件"]').setInputFiles({
        name,
        mimeType: 'text/plain',
        buffer: Buffer.from(content),
      });
      await expect(
        page.getByRole('button', { name: new RegExp(name) }),
      ).toBeVisible();
    };
    await composer.fill('alpha 在线草稿');
    await addAttachment('alpha-offline.txt', 'alpha attachment');
    await expect
      .poll(() =>
        readDraftFromApi(page, teams.alpha).then((result) => result.body),
      )
      .toMatchObject({ content: 'alpha 在线草稿' });
    const alphaBeforeOffline = await readDraftFromApi(page, teams.alpha);
    const alphaAttachmentId = alphaBeforeOffline.body.attachments?.[0]?.id;
    expect(alphaAttachmentId).toBeTruthy();

    await openDraftTeam(page, teams.beta);
    const betaComposer = page.locator('textarea[aria-label^="发送给"]');
    await betaComposer.fill('beta 在线草稿');
    await addAttachment('beta-offline.txt', 'beta attachment');
    await expect
      .poll(() =>
        readDraftFromApi(page, teams.beta).then((result) => result.body),
      )
      .toMatchObject({ content: 'beta 在线草稿' });
    const betaBeforeOffline = await readDraftFromApi(page, teams.beta);
    const betaAttachmentId = betaBeforeOffline.body.attachments?.[0]?.id;
    expect(betaAttachmentId).toBeTruthy();

    const sideEffectRequests = [];
    const onRequest = (request) => {
      if (
        request.method() === 'POST' &&
        /\/api\/(?:spaces\/[^/]+\/messages|tasks)(?:\/|$)/.test(
          new URL(request.url()).pathname,
        )
      )
        sideEffectRequests.push(request.url());
    };
    page.on('request', onRequest);
    await context.setOffline(true);

    await openDraftTeam(page, teams.alpha);
    await page.locator('textarea[aria-label^="发送给"]').fill('');
    await page.getByRole('button', { name: /alpha-offline\.txt/ }).click();
    await openDraftTeam(page, teams.beta);
    await page.locator('textarea[aria-label^="发送给"]').fill('beta 离线编辑');

    await context.setOffline(false);
    await page.evaluate(() => window.dispatchEvent(new Event('online')));
    await expect
      .poll(
        () => readDraftFromApi(page, teams.alpha).then((result) => result.body),
        { timeout: 20_000 },
      )
      .toMatchObject({ content: '', attachmentIds: [] });
    await expect
      .poll(
        () => readDraftFromApi(page, teams.beta).then((result) => result.body),
        { timeout: 20_000 },
      )
      .toMatchObject({
        content: 'beta 离线编辑',
        attachmentIds: [betaAttachmentId],
      });
    expect(alphaAttachmentId).not.toBe(betaAttachmentId);
    expect(sideEffectRequests).toEqual([]);
    page.off('request', onRequest);
  });

  test('仅草稿接口中断时保留待同步草稿，刷新后恢复请求自动重试', async ({
    page,
  }) => {
    const teams = seedDraftRecoveryTeams();
    await page.goto('/');
    await openDraftTeam(page, teams.alpha);
    const composer = page.locator('textarea[aria-label^="发送给"]');
    const pending = `草稿接口暂不可用 ${Date.now()}`;
    const abortDraftRequests = (route) => route.abort();
    await page.route('**/api/drafts*', abortDraftRequests);
    await composer.fill(pending);
    await expect(page.locator('.draft-sync-status')).toContainText(
      '服务暂不可用',
    );
    await page.reload();
    await openDraftTeam(page, teams.alpha);
    await expect(composer).toHaveValue(pending);

    await page.unroute('**/api/drafts*', abortDraftRequests);
    await page.evaluate(() => window.dispatchEvent(new Event('online')));
    await expect
      .poll(
        () =>
          readDraftFromApi(page, teams.alpha).then(
            (result) => result.body.content,
          ),
        { timeout: 20_000 },
      )
      .toBe(pending);
    await expect(page.locator('.draft-sync-status')).toContainText(
      '草稿已同步',
    );
  });

  test('离线并行修改刷新后保留冲突，自动重试不会覆盖远端版本', async ({
    page,
    context,
  }) => {
    const teams = seedDraftMergeTeams();
    await page.goto('/');
    await openDraftTeam(page, teams.conflict);
    const composer = page.locator('textarea[aria-label^="发送给"]');
    const initial = await readDraftFromApi(page, teams.conflict);
    const localContent = '本机离线版本';
    const remoteContent = '其他设备版本';
    const abortDraftRequests = (route) => route.abort();
    await page.route('**/api/drafts*', abortDraftRequests);
    await context.setOffline(true);
    await composer.fill(localContent);
    const remote = await writeDraftFromApi(
      page,
      teams.conflict,
      initial.body.revision,
      remoteContent,
    );
    expect(remote.status).toBe(200);

    await context.setOffline(false);
    await page.reload();
    await openDraftTeam(page, teams.conflict);
    await expect(composer).toHaveValue(localContent);
    await page.unroute('**/api/drafts*', abortDraftRequests);
    await page.evaluate(() => window.dispatchEvent(new Event('online')));

    const conflictPanel = page
      .getByRole('alert')
      .filter({ hasText: '其他设备' });
    await expect(conflictPanel).toBeVisible({ timeout: 20_000 });
    await expect(conflictPanel).toContainText(localContent);
    await expect(conflictPanel).toContainText(remoteContent);
    await page.waitForTimeout(2_500);
    await expect
      .poll(() =>
        readDraftFromApi(page, teams.conflict).then(
          (result) => result.body.content,
        ),
      )
      .toBe(remoteContent);

    await conflictPanel
      .getByRole('button', { name: /使用其他设备版本/ })
      .click();
    await expect(composer).toHaveValue(remoteContent);
    await expect
      .poll(() =>
        readDraftFromApi(page, teams.conflict).then(
          (result) => result.body.content,
        ),
      )
      .toBe(remoteContent);
  });

  test('手机端系统返回先关闭弹层，再保留当前工作台', async ({ page }) => {
    seedConfirmedTeams();
    await page.goto('/');
    const mobile = (page.viewportSize()?.width || 1024) < 768;
    if (!mobile) {
      await expect(page.getByTestId('mobile-context-bar')).toBeHidden();
      return;
    }

    const context = page.getByTestId('mobile-context-bar');
    await context
      .getByRole('button', { name: '切换团队和工作空间', exact: true })
      .click();
    const switcher = page.getByRole('dialog');
    await expect(switcher).toBeVisible();
    const workspaceUrl = page.url();
    await page.goBack();
    await expect(switcher).toBeHidden();
    expect(page.url()).toBe(workspaceUrl);
    await expect(context).toBeVisible();

    await page
      .getByRole('button', { name: '更多', exact: true })
      .click({ force: true });
    const sidebar = sidebarLocator(page);
    await expect(sidebar).toBeVisible();
    await page.goBack();
    await expect(sidebar).toBeHidden();
    expect(page.url()).toBe(workspaceUrl);
  });
});

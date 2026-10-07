import { expect, test } from '@playwright/test';
import {
  clickNavigation,
  markNodeOnline,
  openMobileSidebar,
  recruitmentPage,
  seedCapabilityBinding,
  seedConfirmedTeams,
  seedHighRiskCapability,
  seedHighRiskRecruitment,
  seedModelTeams,
  seedNodeLifecycleFixtures,
  seedProposedRecruitment,
  seedTeamKnowledge,
  sidebarLocator,
} from './team-recruitment-fixtures.mjs';

test.describe('团队运营与协作回归', () => {
  test('团队动态可以暂停和恢复团队自治', async ({ page }) => {
    const teams = seedConfirmedTeams();
    await page.goto('/');
    await openMobileSidebar(page);
    await sidebarLocator(page)
      .locator('button')
      .filter({ hasText: teams.development.name })
      .first()
      .click({ force: true });
    await expect(
      page.getByRole('heading', { name: teams.development.name }),
    ).toBeVisible();
    await clickNavigation(page, '团队动态');

    const pause = page.getByRole('button', {
      name: '暂停团队自治',
      exact: true,
    });
    await expect(pause).toBeVisible();
    await pause.click();
    await expect(
      page.getByRole('button', { name: '恢复团队自治', exact: true }),
    ).toBeVisible();
    await expect(
      page.getByText('自治已暂停 · 新任务不会派发', { exact: true }),
    ).toBeVisible();
    const paused = await page.evaluate(
      async (id) =>
        fetch(`/api/teams/${id}`).then((response) => response.json()),
      teams.development.id,
    );
    expect(paused.status).toBe('paused');

    await page
      .getByRole('button', { name: '恢复团队自治', exact: true })
      .click();
    await expect(
      page.getByRole('button', { name: '暂停团队自治', exact: true }),
    ).toBeVisible();
    const resumed = await page.evaluate(
      async (id) =>
        fetch(`/api/teams/${id}`).then((response) => response.json()),
      teams.development.id,
    );
    expect(resumed.status).toBe('active');
  });

  test('团队动态可以归档和恢复团队并保留历史记录', async ({ page }) => {
    const teams = seedConfirmedTeams();
    await page.goto('/');
    await openMobileSidebar(page);
    await sidebarLocator(page)
      .locator('button')
      .filter({ hasText: teams.development.name })
      .first()
      .click({ force: true });
    await clickNavigation(page, '团队动态');

    page.once('dialog', (dialog) => dialog.accept());
    await page.getByRole('button', { name: '归档团队', exact: true }).click();
    await expect(
      page.getByText(
        `团队“${teams.development.name}”已归档，历史记录仍可恢复。`,
        {
          exact: true,
        },
      ),
    ).toBeVisible();
    await openMobileSidebar(page);
    await expect(
      page.getByRole('button', {
        name: `恢复团队 ${teams.development.name}`,
        exact: true,
      }),
    ).toBeVisible();
    const archived = await page.evaluate(
      async (id) =>
        fetch(`/api/teams/${id}`).then((response) => response.json()),
      teams.development.id,
    );
    expect(archived.status).toBe('archived');
    expect(archived.messages.length).toBeGreaterThan(0);

    await page
      .getByRole('button', {
        name: `恢复团队 ${teams.development.name}`,
        exact: true,
      })
      .click();
    await expect(
      page.getByRole('heading', { name: teams.development.name }),
    ).toBeVisible();
    const restored = await page.evaluate(
      async (id) =>
        fetch(`/api/teams/${id}`).then((response) => response.json()),
      teams.development.id,
    );
    expect(restored.status).toBe('active');
    expect(restored.archivedAt).toBeNull();
  });

  test('团队设置可以配置自治拆解层级、活跃任务和 Token 预算', async ({
    page,
  }) => {
    const teams = seedConfirmedTeams();
    await page.goto('/');
    await openMobileSidebar(page);
    await sidebarLocator(page)
      .locator('button')
      .filter({ hasText: teams.development.name })
      .first()
      .click({ force: true });
    await expect(
      page.getByRole('heading', { name: teams.development.name }),
    ).toBeVisible();
    await clickNavigation(page, '团队动态');
    await page.getByRole('button', { name: '团队设置', exact: true }).click();
    const settings = page.getByRole('dialog');
    await settings.getByRole('spinbutton', { name: /最大拆解层级/ }).fill('2');
    await settings.getByRole('spinbutton', { name: /活跃任务上限/ }).fill('6');
    await settings
      .getByRole('spinbutton', { name: /团队 Token 预算/ })
      .fill('50000');
    await settings
      .getByRole('button', { name: '保存团队设置', exact: true })
      .click();
    await expect(
      page.getByText(`团队“${teams.development.name}”设置已保存`, {
        exact: true,
      }),
    ).toBeVisible();
    const summary = page.locator('[aria-label="团队自治限额"]');
    await expect(summary).toContainText('活跃任务上限 · 6');
    await expect(summary).toContainText('最大拆解 · 2 层');
    await expect(summary).toContainText('Token 预算 · 50,000');
    const usage = page.locator('[aria-label="团队自治用量"]');
    await expect(usage).toContainText('0 / 50,000 tokens');
    await expect(usage).toContainText('剩余 50,000 tokens');
    const saved = await page.evaluate(
      async (id) =>
        (await fetch(`/api/teams/${id}`).then((response) => response.json()))
          .autonomy,
      teams.development.id,
    );
    expect(saved).toMatchObject({
      maxDepth: 2,
      maxJobs: 6,
      budgetTokens: 50000,
    });
  });

  test('执行节点配对向导生成跨平台启动命令且不泄露长期凭据', async ({
    page,
  }) => {
    await page.goto('/');
    await clickNavigation(page, '执行节点');
    await expect(page.getByRole('heading', { name: '执行节点' })).toBeVisible();
    await page.getByRole('button', { name: '配对节点', exact: true }).click();
    const dialog = page.getByRole('dialog');
    await dialog
      .getByRole('textbox', { name: '节点名称' })
      .fill('E2E 跨平台节点');
    await dialog
      .getByRole('button', { name: '生成配对码', exact: true })
      .click();
    await expect(
      dialog.getByText('macOS / Linux', { exact: true }),
    ).toBeVisible();
    await expect(
      dialog.getByText('Windows PowerShell', { exact: true }),
    ).toBeVisible();
    const shell = dialog.locator('.manage-pairing');
    await expect(shell).toHaveText(/^[a-f0-9]{32}$/);
    const commands = dialog.locator('pre');
    await expect(commands.nth(0)).toContainText('--control-url');
    await expect(commands.nth(0)).toContainText('ggb node');
    await expect(commands.nth(0)).toContainText('--workspace');
    await expect(commands.nth(0)).toContainText('--pair');
    await expect(commands.nth(1)).toContainText('$HOME');
    await dialog
      .getByRole('textbox', { name: '节点本机工作目录' })
      .fill('/tmp/ggb-e2e-node');
    await expect(commands.nth(0)).toContainText('/tmp/ggb-e2e-node');
    const text = await dialog.innerText();
    expect(text).not.toContain('tokenHash');
    expect(text).not.toContain('node-identity.json');
    await page.keyboard.press('Escape');
  });

  test('执行节点详情持续刷新并为撤销节点提供重新配对入口', async ({ page }) => {
    seedNodeLifecycleFixtures();
    await page.goto('/');
    await clickNavigation(page, '执行节点');
    await expect(page.getByRole('heading', { name: '执行节点' })).toBeVisible();

    const offline = page.getByRole('button', {
      name: 'E2E 离线节点',
      exact: true,
    });
    await expect(offline).toBeVisible();
    await offline.click();
    let dialog = page.getByRole('dialog');
    await expect(dialog).toContainText('离线');
    await expect(
      dialog.getByRole('button', { name: '刷新状态', exact: true }),
    ).toBeVisible();
    await dialog.getByRole('button', { name: '刷新状态', exact: true }).click();
    await expect(dialog).toContainText('重新运行启动命令');
    const offlineState = await page.evaluate(async () => {
      const response = await fetch('/api/manage');
      return response.json();
    });
    const offlineAttention = offlineState.attention.find(
      (item) =>
        item.kind === 'node-offline' && item.nodeId === 'e2e-offline-node',
    );
    expect(offlineAttention).toMatchObject({ status: 'open' });
    const offlineNotification = offlineState.notifications.find(
      (item) => item.attentionId === offlineAttention.id,
    );
    expect(offlineNotification).toMatchObject({ read: false });
    markNodeOnline('e2e-offline-node');
    await expect(dialog).toContainText('在线', { timeout: 7_000 });
    const recoveredState = await page.evaluate(async () => {
      const response = await fetch('/api/manage');
      return response.json();
    });
    expect(
      recoveredState.attention.find((item) => item.id === offlineAttention.id),
    ).toMatchObject({ status: 'resolved' });
    expect(
      recoveredState.notifications.find(
        (item) => item.attentionId === offlineAttention.id,
      ),
    ).toMatchObject({ read: true });
    await page.keyboard.press('Escape');

    const revoked = page.getByRole('button', {
      name: 'E2E 已撤销节点',
      exact: true,
    });
    await expect(revoked).toBeVisible();
    await revoked.click();
    dialog = page.getByRole('dialog');
    await expect(dialog).toContainText('已撤销');
    await dialog
      .getByRole('button', { name: '重新配对节点', exact: true })
      .click();
    dialog = page.getByRole('dialog');
    await expect(dialog.getByRole('textbox', { name: '节点名称' })).toHaveValue(
      'E2E 已撤销节点-repaired',
    );
    await dialog
      .getByRole('button', { name: '生成配对码', exact: true })
      .click();
    await expect(dialog.locator('.manage-pairing')).toHaveText(
      /^[a-f0-9]{32}$/,
    );
    await expect(dialog).not.toContainText('fixture-token-hash');
    await page.keyboard.press('Escape');
  });

  test('确认 Team Charter 后进入我的团队并保留重命名后的团队身份', async ({
    page,
  }) => {
    const { teamName, teamId } = seedProposedRecruitment();
    const composer = await recruitmentPage(page);
    const draftPicker = page.getByRole('combobox', {
      name: '选择需求草稿',
      exact: true,
    });
    await draftPicker.click();
    await page
      .getByRole('option', { name: `需求草稿 · 待确认需求`, exact: true })
      .click();
    await expect(page.getByRole('heading', { name: teamName })).toBeVisible();
    await expect(page.getByTestId('recruitment-status-card')).toContainText(
      '方案待确认',
    );
    await expect(page.getByTestId('recruitment-status-card')).toContainText(
      '确认后才会创建成员并进入“我的团队”',
    );
    await expect(
      page.getByRole('button', { name: '确认创建团队', exact: true }),
    ).toBeVisible();

    await page
      .getByRole('button', { name: '确认创建团队', exact: true })
      .click();
    await expect(
      page.getByText(/已确认，项目经理可以开始安排任务/),
    ).toBeVisible();
    await openMobileSidebar(page);
    const createdTeamNav = page.getByRole('button', {
      name: new RegExp(`${teamName}.*交付`),
    });
    await expect(createdTeamNav).toBeVisible();
    if ((page.viewportSize()?.width || 1024) < 768)
      await createdTeamNav.click({ force: true });

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
    const workspaceMode = settings.getByRole('combobox', {
      name: '默认执行目录',
      exact: true,
    });
    await workspaceMode.click();
    await page.getByRole('option', { name: '快照目录', exact: true }).click();
    await settings
      .getByRole('button', { name: '保存团队设置', exact: true })
      .click();
    await expect(page.getByText(`团队“${renamed}”设置已保存`)).toBeVisible();
    const savedTeam = await page.evaluate(
      async ({ id }) => {
        const state = await fetch('/api/state').then((response) =>
          response.json(),
        );
        return state.spaces.find((space) => space.id === id);
      },
      { id: teamId },
    );
    expect(savedTeam).toMatchObject({
      id: teamId,
      name: renamed,
      workspaceMode: 'snapshot',
    });
    await openMobileSidebar(page);
    await expect(
      page.getByRole('button', { name: new RegExp(`${renamed}.*交付`) }),
    ).toBeVisible();
    await expect(composer).toHaveValue('');
  });

  test('团队设置可以把跨团队协作限制到明确的目标团队', async ({ page }) => {
    const teams = seedConfirmedTeams();
    const source = teams.development;
    const target = teams.operations;
    await page.goto('/');
    await openMobileSidebar(page);
    const navigation = sidebarLocator(page)
      .locator('button')
      .filter({ hasText: source.name })
      .first();
    await expect(navigation).toBeVisible();
    await navigation.click({ force: true });
    await expect(
      page.getByRole('heading', { name: source.name }),
    ).toBeVisible();

    await page.getByRole('button', { name: '团队设置', exact: true }).click();
    const settings = page.getByRole('dialog');
    await expect(settings).toBeVisible();
    const targetOption = settings.getByRole('checkbox', {
      name: `允许协作：${target.name}`,
      exact: true,
    });
    await expect(targetOption).toBeVisible();
    await targetOption.check();
    await settings
      .getByRole('button', { name: '保存团队设置', exact: true })
      .click();
    await expect(
      page.getByText(`团队“${source.name}”设置已保存`),
    ).toBeVisible();

    const saved = await page.evaluate(
      async ({ id }) => {
        const state = await fetch('/api/state').then((response) =>
          response.json(),
        );
        return state.spaces.find((space) => space.id === id);
      },
      { id: source.id },
    );
    expect(saved.collaboration).toMatchObject({
      enabled: true,
      allowedTeamIds: [target.id],
    });
    const collaborators = await page.evaluate(
      async ({ id }) => {
        const response = await fetch(`/api/teams/${id}/collaborators`);
        return response.json();
      },
      { id: source.id },
    );
    expect(collaborators.map((item) => item.id)).toEqual([target.id]);
  });

  test('两个已创建团队切换时保留各自动态和草稿上下文', async ({ page }) => {
    const { development, operations } = seedConfirmedTeams();
    await page.goto('/');

    const openTeam = async (team) => {
      await openMobileSidebar(page);
      const navigation = sidebarLocator(page)
        .locator('button')
        .filter({ hasText: team.name })
        .first();
      await expect(navigation).toBeVisible();
      await navigation.click({ force: true });
      await expect(
        page.getByRole('heading', { name: team.name }),
      ).toBeVisible();
    };

    await openTeam(development);
    const developmentComposer = page.locator('textarea[aria-label^="发送给"]');
    await developmentComposer.fill('研发团队专属草稿');
    await clickNavigation(page, '团队动态');
    await expect(page.getByText('统一时间线', { exact: true })).toBeVisible();
    const developmentTimeline = page.locator('[aria-label="团队统一时间线"]');
    await expect(
      developmentTimeline.getByText(development.message, { exact: true }),
    ).toBeVisible();
    await expect(
      page
        .getByRole('region', { name: '团队协作控制台', exact: true })
        .getByText(development.message, { exact: true }),
    ).toHaveCount(0);
    await developmentTimeline
      .getByRole('tab', { name: '证据', exact: true })
      .click();
    await expect(
      developmentTimeline.getByText('当前筛选没有记录', { exact: true }),
    ).toBeVisible();
    await developmentTimeline
      .getByRole('tab', { name: '全部', exact: true })
      .click();
    await expect(
      developmentTimeline.getByText(development.message, { exact: true }),
    ).toBeVisible();

    await openTeam(operations);
    const operationsComposer = page.locator('textarea[aria-label^="发送给"]');
    await expect(operationsComposer).toHaveValue('');
    await clickNavigation(page, '团队动态');
    await expect(page.getByText('统一时间线', { exact: true })).toBeVisible();
    const operationsTimeline = page.locator('[aria-label="团队统一时间线"]');
    await expect(
      operationsTimeline.getByText(operations.message, { exact: true }),
    ).toBeVisible();
    await expect(
      operationsTimeline.getByText(development.message, { exact: true }),
    ).toHaveCount(0);
    await expect(
      page
        .getByRole('region', { name: '团队协作控制台', exact: true })
        .getByText(operations.message, { exact: true }),
    ).toHaveCount(0);

    // A reload must preserve the active team route instead of falling back to
    // the first confirmed team and exposing another team's draft.
    await page.reload();
    await expect(
      page.getByRole('heading', { name: operations.name }),
    ).toBeVisible();
    // RouteCache now also restores the last utility view. Re-enter the team's
    // conversation explicitly before asserting the composer state.
    await openTeam(operations);
    await expect(page.locator('textarea[aria-label^="发送给"]')).toHaveValue(
      '',
    );

    await openTeam(development);
    await expect(page.locator('textarea[aria-label^="发送给"]')).toHaveValue(
      '研发团队专属草稿',
    );
  });

  test('两个团队切换模型后将 provider 与 model 精确传给团队消息', async ({
    page,
  }) => {
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
      const navigation = sidebarLocator(page)
        .locator('button')
        .filter({ hasText: team.name })
        .first();
      await expect(navigation).toBeVisible();
      await navigation.click({ force: true });
      await expect(
        page.getByRole('heading', { name: team.name }),
      ).toBeVisible();
    };
    const selectModelAndSend = async (
      team,
      initialKey,
      selectedKey,
      prompt,
    ) => {
      await openTeam(team);
      const selector = page.getByRole('combobox', {
        name: '选择模型',
        exact: true,
      });
      const initial =
        initialKey === 'alpha'
          ? 'e2e-provider-alpha::e2e-alpha-model'
          : 'e2e-provider-beta::e2e-beta-model';
      await expect(selector).toHaveValue(initial);
      const selected =
        selectedKey === 'alpha'
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
    const alphaRequest = await selectModelAndSend(
      teams.alpha,
      'alpha',
      'beta',
      'Alpha 团队使用 Beta 模型',
    );
    expect(alphaRequest.url).toContain(
      `/api/spaces/${teams.alpha.id}/messages`,
    );
    expect(alphaRequest.body).toMatchObject({
      providerId: 'e2e-provider-beta',
      model: 'e2e-beta-model',
      content: 'Alpha 团队使用 Beta 模型',
    });
    expect(alphaRequest.body.allowModelWithoutTools).toBe(true);

    const betaRequest = await selectModelAndSend(
      teams.beta,
      'beta',
      'alpha',
      'Beta 团队使用 Alpha 模型',
    );
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
    const state = await page.evaluate(
      async ({ alphaId, betaId }) => {
        const next = await fetch('/api/state').then((response) =>
          response.json(),
        );
        return {
          alpha: next.spaces.find((space) => space.id === alphaId),
          beta: next.spaces.find((space) => space.id === betaId),
        };
      },
      { alphaId: teams.alpha.id, betaId: teams.beta.id },
    );
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
    await sidebarLocator(page)
      .locator('button')
      .filter({ hasText: teams.alpha.name })
      .first()
      .click({ force: true });
    await expect(
      page.getByRole('heading', { name: teams.alpha.name }),
    ).toBeVisible();
    const selector = page.getByRole('combobox', {
      name: '选择模型',
      exact: true,
    });
    await expect(
      selector.locator(`option[value="e2e-provider-alpha::e2e-alpha-model"]`),
    ).toContainText('最近检查通过');
    await selector.selectOption('e2e-provider-beta::e2e-beta-model');
    await expect(selector).toHaveValue('e2e-provider-beta::e2e-beta-model');
    await expect(
      selector.locator(`option[value="e2e-provider-beta::e2e-beta-model"]`),
    ).toContainText('最近检查失败');
    await expect(
      page.getByText(/最近一次连通性检查失败：接口返回 HTTP 503/),
    ).toBeVisible();
  });

  test('知识库按当前团队隔离团队专属知识', async ({ page }) => {
    const teams = seedTeamKnowledge();
    await page.goto('/');
    await openMobileSidebar(page);
    await sidebarLocator(page)
      .locator('button')
      .filter({ hasText: teams.development.name })
      .first()
      .click({ force: true });
    await expect(
      page.getByRole('heading', { name: teams.development.name }),
    ).toBeVisible();
    await clickNavigation(page, '知识库');
    await expect(
      page.getByRole('heading', { name: '每次工作，都有积累。' }),
    ).toBeVisible();
    const cards = page.locator('.knowledge-card-wrapper');
    await expect(cards.filter({ hasText: '研发团队专属约定' })).toHaveCount(1);
    await expect(cards.filter({ hasText: '运维团队专属约定' })).toHaveCount(0);
    await expect(
      page.getByText('团队共享', { exact: true }).first(),
    ).toBeVisible();
  });

  test('知识库明确标记过期版本，避免用户误以为仍会注入新任务', async ({
    page,
  }) => {
    const teams = seedTeamKnowledge();
    await page.goto('/');
    const created = await page.evaluate(async (teamId) => {
      const response = await fetch('/api/knowledge', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          title: '已过期的发布约定',
          content: '这条知识只能用于历史追溯。',
          scope: 'team',
          teamId,
          state: 'confirmed',
          source: '旧版运维评审',
          expiresAt: '2000-01-01T00:00:00.000Z',
        }),
      });
      return { status: response.status, body: await response.json() };
    }, teams.development.id);
    expect(created.status).toBe(200);
    await openMobileSidebar(page);
    await sidebarLocator(page)
      .locator('button')
      .filter({ hasText: teams.development.name })
      .first()
      .click({ force: true });
    await expect(
      page.getByRole('heading', { name: teams.development.name }),
    ).toBeVisible();
    await clickNavigation(page, '知识库');
    const card = page
      .locator('.knowledge-card-wrapper')
      .filter({ hasText: '已过期的发布约定' });
    await expect(card).toHaveCount(1);
    await expect(
      card.getByText('已过期 · 不会自动注入', { exact: true }),
    ).toBeVisible();
    await expect(card.getByText('v1', { exact: false })).toBeVisible();
  });

  test('知识复核风险可以从后台任务直接打开对应知识', async ({ page }) => {
    const teams = seedTeamKnowledge();
    await page.goto('/');
    const created = await page.evaluate(async (teamId) => {
      const response = await fetch('/api/knowledge', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          title: '需要复核的团队规范',
          content: '这条规范需要重新确认。',
          scope: 'team',
          teamId,
          state: 'confirmed',
          source: '风险入口 fixture',
          expiresAt: '2000-01-01T00:00:00.000Z',
        }),
      });
      return { status: response.status, body: await response.json() };
    }, teams.development.id);
    expect(created.status).toBe(200);
    const sidebar = await openMobileSidebar(page);
    await sidebar
      .locator('button')
      .filter({ hasText: teams.development.name })
      .first()
      .click({ force: true });
    await expect(
      page.getByRole('heading', { name: teams.development.name }),
    ).toBeVisible();
    await clickNavigation(page, '后台任务');
    const inbox = page.getByRole('region', { name: '跨团队风险', exact: true });
    await expect(inbox).toBeVisible();
    await inbox
      .getByRole('combobox', { name: '风险团队', exact: true })
      .selectOption(teams.development.id);
    await inbox
      .getByRole('combobox', { name: '风险类型', exact: true })
      .selectOption('knowledge');
    const risk = inbox
      .locator('.risk-inbox-item')
      .filter({ hasText: '需要复核的团队规范' });
    await expect(risk).toHaveCount(1);
    await risk.click();
    const dialog = page.getByRole('dialog');
    await expect(
      dialog.getByRole('heading', { name: '编辑知识' }),
    ).toBeVisible();
    await expect(dialog.locator('input').first()).toHaveValue(
      '需要复核的团队规范',
    );
  });

  test('通知管理页聚合风险并保留直接处理入口', async ({ page }) => {
    const teams = seedTeamKnowledge();
    await page.goto('/');
    const created = await page.evaluate(async (teamId) => {
      const response = await fetch('/api/knowledge', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          title: '通知中心需要复核的规范',
          content: '通知中心入口需要回到知识编辑。',
          scope: 'team',
          teamId,
          state: 'confirmed',
          source: '通知中心 fixture',
          expiresAt: '2000-01-01T00:00:00.000Z',
        }),
      });
      return { status: response.status, body: await response.json() };
    }, teams.development.id);
    expect(created.status).toBe(200);
    const sidebar = await openMobileSidebar(page);
    await sidebar
      .getByRole('button', { name: '需要你处理', exact: true })
      .click();
    await expect(
      page.getByRole('heading', { name: '需要你处理' }),
    ).toBeVisible();
    const inbox = page.getByRole('region', { name: '跨团队风险', exact: true });
    await expect(inbox).toBeVisible();
    await inbox
      .getByRole('combobox', { name: '风险团队', exact: true })
      .selectOption(teams.development.id);
    await inbox
      .getByRole('combobox', { name: '风险类型', exact: true })
      .selectOption('knowledge');
    const risk = inbox
      .locator('.risk-inbox-item')
      .filter({ hasText: '通知中心需要复核的规范' });
    await expect(risk).toHaveCount(1);
    await risk.click();
    await expect(page.getByRole('heading', { name: '编辑知识' })).toBeVisible();
  });

  test('助手编辑器显示能力兼容状态和现有绑定范围', async ({ page }) => {
    const fixture = seedCapabilityBinding();
    await page.goto('/');
    await clickNavigation(page, '助手与模型');
    await expect(page.getByRole('heading', { name: '我的助手' })).toBeVisible();
    await page
      .getByRole('button', { name: '编辑产品助手', exact: true })
      .click();
    const dialog = page.getByRole('dialog');
    await expect(dialog).toBeVisible();
    await dialog
      .getByRole('tab', { name: '工具与 Skills', exact: true })
      .click();
    const capability = dialog.getByRole('checkbox', {
      name: '绑定能力：E2E 证据整理能力',
      exact: true,
    });
    await expect(capability).toBeChecked();
    await expect(dialog.getByText(/部分兼容/)).toBeVisible();
    await expect(dialog.getByText(/中风险/)).toBeVisible();
    await expect(
      capability.locator('xpath=..').getByText(/1 个助手/),
    ).toBeVisible();
    await expect(dialog.getByText('需要先检查执行节点。')).toBeVisible();
    expect(fixture.capabilityId).toBeTruthy();
  });

  test('能力中心启用中高风险能力必须确认并留下审计记录', async ({ page }) => {
    const fixture = seedHighRiskCapability();
    await page.goto('/');
    await clickNavigation(page, '能力中心');
    const row = page
      .locator('.manage-row')
      .filter({ hasText: fixture.name })
      .first();
    await expect(row).toBeVisible();
    await row.getByRole('button', { name: fixture.name, exact: true }).click();
    const dialog = page.getByRole('dialog');
    await expect(dialog).toBeVisible();
    const risk = dialog.getByRole('region', {
      name: '能力风险评估',
      exact: true,
    });
    await expect(risk).toBeVisible();
    await expect(risk.getByText('高风险', { exact: true })).toBeVisible();
    const confirm = risk.getByRole('button', {
      name: '确认风险并启用能力',
      exact: true,
    });
    await expect(confirm).toBeVisible();
    await confirm.click();
    await expect(dialog).toBeHidden();
    const detail = await page.evaluate(
      async (id) =>
        fetch(`/api/capabilities/${id}`).then((response) => response.json()),
      fixture.capabilityId,
    );
    expect(detail.enabled).toBe(true);
    expect(
      detail.audits.some(
        (audit) => audit.action === 'enable' && audit.confirmed === true,
      ),
    ).toBe(true);
  });

  test('Team Charter 绑定中高风险能力前必须逐项确认并留下绑定审计', async ({
    page,
  }) => {
    const fixture = seedHighRiskRecruitment();
    const composer = await recruitmentPage(page);
    const draftPicker = page.getByRole('combobox', {
      name: '选择需求草稿',
      exact: true,
    });
    await draftPicker.click();
    await page
      .getByRole('option', { name: new RegExp('需求草稿 · 待确认高风险需求') })
      .click();
    await expect(
      page.getByRole('heading', { name: fixture.teamName }),
    ).toBeVisible();
    const review = page
      .locator('.recruitment-capability-review')
      .filter({ hasText: fixture.capabilityName });
    await expect(review).toBeVisible();
    const confirm = page.getByRole('button', {
      name: '确认创建团队',
      exact: true,
    });
    await expect(confirm).toBeDisabled();
    await review.getByRole('checkbox').check();
    await expect(confirm).toBeEnabled();
    await confirm.click();
    await expect(
      page.getByText(/已确认，项目经理可以开始安排任务/),
    ).toBeVisible();
    const detail = await page.evaluate(async (id) => {
      const response = await fetch(`/api/capabilities/${id}`, {
        cache: 'no-store',
      });
      return { status: response.status, body: await response.json() };
    }, fixture.capabilityId);
    expect(detail.status).toBe(200);
    expect(
      detail.body.audits.some(
        (audit) =>
          audit.action === 'bind' &&
          audit.confirmed === true &&
          audit.teamId === fixture.teamId,
      ),
    ).toBe(true);
    await expect(composer).toHaveValue('');
  });
});

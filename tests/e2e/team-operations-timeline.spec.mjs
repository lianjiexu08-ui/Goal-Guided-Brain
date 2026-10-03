import { expect, test } from '@playwright/test';
import { Store } from '../../server/store.mjs';
import {
  clickNavigation,
  dataDir,
  openMobileSidebar,
  seedCollaborationTeams,
  seedConfirmedTeams,
  seedLongTimelineTeam,
  seedModelTeams,
  seedRiskTeams,
  sidebarLocator,
} from './team-recruitment-fixtures.mjs';

test.describe('团队运营与协作：时间线与协作', () => {
  test('团队时间线可以加载更早动态并保持筛选入口', async ({ page }) => {
    const team = seedLongTimelineTeam();
    await page.goto('/');
    await openMobileSidebar(page);
    await sidebarLocator(page)
      .locator('button')
      .filter({ hasText: team.name })
      .first()
      .click({ force: true });
    await expect(page.getByRole('heading', { name: team.name })).toBeVisible();
    await clickNavigation(page, '团队动态');
    const timeline = page.locator('[aria-label="团队统一时间线"]');
    await expect(
      timeline.getByRole('button', { name: '更早动态', exact: true }),
    ).toBeVisible();
    await timeline
      .getByRole('button', { name: '更早动态', exact: true })
      .click();
    await expect(
      timeline.getByText('分页回归消息 0', { exact: true }),
    ).toBeVisible();
    await expect(
      timeline.getByRole('button', { name: '更早动态', exact: true }),
    ).toHaveCount(0);
  });

  test('团队动态通过实时事件流接收新消息', async ({ page }) => {
    const teams = seedConfirmedTeams();
    const providerId = 'e2e-live-team-provider';
    const store = new Store(dataDir, process.cwd(), {
      seedProjectManager: true,
    });
    try {
      store.records.save(
        'providers',
        {
          id: providerId,
          name: 'E2E live team provider',
          protocol: 'openai-completions',
          baseUrl: 'http://127.0.0.1:1',
          credentialId: '',
          enabled: true,
          priority: 1,
          models: [
            {
              id: 'e2e-live-team-model',
              tools: false,
              vision: false,
              contextWindow: 128000,
            },
          ],
        },
        providerId,
      );
      const existing = store.teamSpace(teams.development.id);
      store.saveTeamSpace(
        { ...existing, providerId, model: 'e2e-live-team-model' },
        existing.id,
      );
    } finally {
      store.close();
    }
    await page.goto('/');
    await openMobileSidebar(page);
    const navigation = sidebarLocator(page)
      .locator('button')
      .filter({ hasText: teams.development.name })
      .first();
    await expect(navigation).toBeVisible();
    await navigation.click({ force: true });
    await expect(
      page.getByRole('heading', { name: teams.development.name }),
    ).toBeVisible();
    const streamRequest = page.waitForRequest(
      (request) =>
        request
          .url()
          .includes(`/api/spaces/${teams.development.id}/events/stream`),
      { timeout: 10_000 },
    );
    await clickNavigation(page, '团队动态');
    await streamRequest;
    const timeline = page.locator('[aria-label="团队统一时间线"]');
    await expect(timeline).toBeVisible();
    const message = `实时团队消息 ${Date.now()}`;
    const sent = await page.evaluate(
      async ({ id, providerId, message }) => {
        const response = await fetch(`/api/spaces/${id}/messages`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            clientMessageId: `e2e-live-${Date.now()}`,
            content: message,
            providerId,
            model: 'e2e-live-team-model',
          }),
        });
        return { status: response.status, body: await response.json() };
      },
      { id: teams.development.id, providerId, message },
    );
    expect(sent.status).toBe(201);
    await expect(timeline.getByText(message, { exact: true })).toBeVisible({
      timeout: 10_000,
    });
  });

  test('后台任务提供跨团队风险筛选并可回到对应团队', async ({ page }) => {
    const teams = seedRiskTeams();
    await page.goto('/');
    const sidebar = await openMobileSidebar(page);
    const targetNavigation = sidebar
      .locator('button')
      .filter({ hasText: teams.target.name })
      .first();
    await expect(targetNavigation.locator('.team-risk-badge')).toHaveText('2');
    await expect(targetNavigation.locator('.team-risk-badge')).toHaveAttribute(
      'aria-label',
      '2 项待处理',
    );
    await clickNavigation(page, '后台任务');
    const inbox = page.getByRole('region', { name: '跨团队风险', exact: true });
    await expect(inbox).toBeVisible();
    await inbox
      .getByRole('combobox', { name: '风险团队', exact: true })
      .selectOption(teams.target.id);
    await expect(inbox.getByText('2 项待处理', { exact: true })).toBeVisible();
    await expect(
      inbox
        .locator('.risk-inbox-item')
        .filter({ hasText: teams.target.name })
        .first(),
    ).toBeVisible();
    await expect(
      inbox.locator('.risk-inbox-item').filter({ hasText: teams.source.name }),
    ).toHaveCount(0);
    await inbox
      .getByRole('combobox', { name: '风险类型', exact: true })
      .selectOption('attention');
    await expect(
      inbox.getByRole('option', { name: '计划逾期', exact: true }),
    ).toBeAttached();
    await expect(
      inbox.getByText('运维团队需要确认', { exact: true }),
    ).toBeVisible();
    await inbox
      .getByRole('button', { name: '打开风险 运维团队需要确认', exact: true })
      .click();
    await expect(
      page.getByRole('heading', { name: teams.target.name }),
    ).toBeVisible();
  });

  test('团队动态支持跨团队统一时间线筛选并回到对应团队', async ({ page }) => {
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
    const timeline = page.getByRole('region', {
      name: '跨团队统一时间线',
      exact: true,
    });
    await expect(timeline).toBeVisible();
    const teamScope = timeline.getByRole('combobox', {
      name: '统一时间线团队',
      exact: true,
    });
    await teamScope.selectOption(teams.development.id);
    await expect(
      timeline
        .locator('.cross-team-timeline-item')
        .filter({ hasText: teams.development.name })
        .first(),
    ).toBeVisible();
    await teamScope.selectOption(teams.operations.id);
    await expect(
      timeline
        .locator('.cross-team-timeline-item')
        .filter({ hasText: teams.operations.name })
        .first(),
    ).toBeVisible();
    await expect(
      timeline
        .locator('.cross-team-timeline-item')
        .filter({ hasText: teams.development.name }),
    ).toHaveCount(0);
    await timeline
      .locator('.cross-team-timeline-item')
      .filter({ hasText: teams.operations.name })
      .first()
      .click();
    await expect(
      page.getByRole('heading', { name: teams.operations.name }),
    ).toBeVisible();
  });

  test('团队协作控制台可以委派目标并显示任务回传入口', async ({ page }) => {
    const teams = seedCollaborationTeams();
    const collaborationRequests = [];
    await page.goto('/');
    await page.route('**/api/teams/*/collaborate', async (route) => {
      const request = route.request();
      collaborationRequests.push({
        url: request.url(),
        body: request.postDataJSON(),
      });
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
    await sidebarLocator(page)
      .locator('button')
      .filter({ hasText: teams.source.name })
      .first()
      .click({ force: true });
    await expect(
      page.getByRole('heading', { name: teams.source.name }),
    ).toBeVisible();
    await clickNavigation(page, '团队动态');
    const console = page.getByRole('region', {
      name: '团队协作控制台',
      exact: true,
    });
    await expect(console).toBeVisible();
    await expect(
      console.getByRole('combobox', { name: '选择协作目标团队', exact: true }),
    ).toHaveValue(teams.target.id);
    await expect(
      console
        .locator('.team-collaboration-target')
        .getByText(teams.target.name, { exact: true }),
    ).toBeVisible();

    const goal = `请回传 ${Date.now()} 的发布检查清单。`;
    const acceptance = '回传检查清单、风险等级和可执行的回滚步骤。';
    await console
      .getByRole('textbox', { name: '协作目标', exact: true })
      .fill(goal);
    await console
      .getByRole('textbox', { name: '协作验收标准', exact: true })
      .fill(acceptance);
    await console
      .getByRole('button', { name: '预览并发起协作', exact: true })
      .click();
    await expect(
      console.getByRole('region', { name: '协作发送前审阅', exact: true }),
    ).toContainText(acceptance);
    await console
      .getByRole('button', { name: '确认并发起协作', exact: true })
      .click();
    await expect(console.getByText(/协作请求已发送给/)).toBeVisible();
    await expect(
      console.getByRole('button', { name: '查看任务', exact: true }),
    ).toBeVisible();
    await expect.poll(() => collaborationRequests.length).toBe(1);
    expect(collaborationRequests[0].url).toContain(
      `/api/teams/${teams.source.id}/collaborate`,
    );
    expect(collaborationRequests[0].body).toMatchObject({
      targetTeamId: teams.target.id,
      content: goal,
      acceptance,
    });

    await openMobileSidebar(page);
    await sidebarLocator(page)
      .locator('button')
      .filter({ hasText: teams.target.name })
      .first()
      .click({ force: true });
    await expect(
      page.getByRole('heading', { name: teams.target.name }),
    ).toBeVisible();
    await clickNavigation(page, '团队动态');
    const targetConsole = page.getByRole('region', {
      name: '团队协作控制台',
      exact: true,
    });
    await expect(targetConsole).toBeVisible();
  });

  test('desktop/mobile 连续20次切换时团队模型、动态和草稿保持隔离', async ({
    page,
  }) => {
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
        await route.fulfill({
          status: 201,
          contentType: 'application/json',
          body: JSON.stringify(entry),
        });
        return;
      }
      if (request.method() === 'GET' && parts.length === 3) {
        const response = await route.fetch();
        const payload = await response.json();
        payload.messages = [
          ...(payload.messages || []),
          ...(messages.get(spaceId) || []),
        ];
        await route.fulfill({ response, json: payload });
        return;
      }
      await route.continue();
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
    const options = {
      alpha: {
        key: 'e2e-provider-alpha::e2e-alpha-model',
        providerId: 'e2e-provider-alpha',
        model: 'e2e-alpha-model',
      },
      beta: {
        key: 'e2e-provider-beta::e2e-beta-model',
        providerId: 'e2e-provider-beta',
        model: 'e2e-beta-model',
      },
    };
    const teamByIndex = [teams.alpha, teams.beta];
    await openTeam(teams.alpha);
    await page.locator('textarea[aria-label^="发送给"]').fill('alpha 保留草稿');
    await openTeam(teams.beta);
    await page.locator('textarea[aria-label^="发送给"]').fill('beta 保留草稿');
    await openTeam(teams.alpha);
    await expect(page.locator('textarea[aria-label^="发送给"]')).toHaveValue(
      'alpha 保留草稿',
    );
    await openTeam(teams.beta);
    await expect(page.locator('textarea[aria-label^="发送给"]')).toHaveValue(
      'beta 保留草稿',
    );
    for (let index = 0; index < 20; index += 1) {
      const team = teamByIndex[index % 2];
      const key = team === teams.alpha ? 'alpha' : 'beta';
      const selected = options[key];
      await openTeam(team);
      const selector = page.getByRole('combobox', {
        name: '选择模型',
        exact: true,
      });
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
      const detail = await page.evaluate(
        async (id) =>
          fetch(`/api/spaces/${id}`).then((response) => response.json()),
        team.id,
      );
      expect(
        detail.messages.filter((message) =>
          message.content.startsWith(`${key} 专属草稿`),
        ),
      ).toHaveLength(10);
      expect(
        detail.messages.filter((message) =>
          message.content.startsWith(
            `${key === 'alpha' ? 'beta' : 'alpha'} 专属草稿`,
          ),
        ),
      ).toHaveLength(0);
    }
    await openTeam(teams.alpha);
    await page.locator('textarea[aria-label^="发送给"]').fill('alpha 保留草稿');
    await openTeam(teams.beta);
    await page.locator('textarea[aria-label^="发送给"]').fill('beta 保留草稿');
    await page.reload();
    await openTeam(teams.alpha);
    await expect(page.locator('textarea[aria-label^="发送给"]')).toHaveValue(
      'alpha 保留草稿',
    );
    await openTeam(teams.beta);
    await expect(page.locator('textarea[aria-label^="发送给"]')).toHaveValue(
      'beta 保留草稿',
    );
  });
});

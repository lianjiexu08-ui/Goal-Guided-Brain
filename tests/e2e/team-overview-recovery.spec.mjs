import { expect, test } from '@playwright/test';
import { seedRiskTeams } from './team-recruitment-fixtures.mjs';
import { clickNavigation } from './team-recruitment-helpers.mjs';

const surfaces = [
  {
    endpoint: 'risks',
    navigation: '后台任务',
    region: '跨团队风险',
    team: '风险团队',
    kind: '风险类型',
    row: '.risk-inbox-item',
    more: '加载更早风险',
    refresh: '刷新跨团队风险',
    empty: '当前没有需要处理的跨团队风险。',
  },
  {
    endpoint: 'timeline',
    navigation: '团队动态',
    region: '跨团队统一时间线',
    team: '统一时间线团队',
    kind: '统一时间线类型',
    row: '.cross-team-timeline-item',
    more: '加载更早动态',
    refresh: '刷新跨团队时间线',
    empty: '当前筛选没有团队动态。',
  },
];

function result(team, tag = '首批', hasMore = false) {
  return {
    items: [
      {
        id: `${team.id}-${tag}`,
        teamId: team.id,
        teamName: team.name,
        kind: 'execution',
        type: 'task',
        status: 'failed',
        title: tag,
        detail: tag,
        error: tag,
        updatedAt: '2026-10-07T00:00:00.000Z',
        at: '2026-10-07T00:00:00.000Z',
      },
    ],
    total: hasMore ? 2 : 1,
    hasMore,
  };
}

async function open(page, surface, teams) {
  await page.route(`**/api/${surface.endpoint}?*`, (route) => {
    const teamId = new URL(route.request().url()).searchParams.get('teamId');
    return route.fulfill({
      json: result(teamId === teams.target.id ? teams.target : teams.source),
    });
  });
  await page.goto('/');
  await clickNavigation(page, surface.navigation);
  const panel = page.getByRole('region', { name: surface.region, exact: true });
  await expect(panel.locator(surface.row)).toHaveCount(1);
  return panel;
}

for (const surface of surfaces) {
  for (const lateStatus of [200, 503]) {
    test(`${surface.region}忽略旧筛选延迟 ${lateStatus} 响应`, async ({
      page,
    }) => {
      const teams = seedRiskTeams();
      const panel = await open(page, surface, teams);
      const selector = panel.getByRole('combobox', {
        name: surface.team,
        exact: true,
      });
      let release;
      let intercepted = false;
      let settled = false;
      const gate = new Promise((resolve) => {
        release = resolve;
      });
      await page.route(`**/api/${surface.endpoint}?*`, async (route) => {
        if (
          new URL(route.request().url()).searchParams.get('teamId') !==
          teams.source.id
        )
          return route.fallback();
        intercepted = true;
        await gate;
        try {
          await route.fulfill({
            status: lateStatus,
            json:
              lateStatus === 200
                ? result(teams.source, '过期结果')
                : { error: '过期请求失败' },
          });
        } catch {
          /* Scope changes may abort the obsolete request. */
        } finally {
          settled = true;
        }
      });
      try {
        await selector.selectOption(teams.source.id);
        await expect.poll(() => intercepted).toBe(true);
        await expect(panel.locator(surface.row)).toHaveCount(0);
        await expect(panel).toHaveAttribute('aria-busy', 'true');
        await selector.selectOption(teams.target.id);
        await expect(panel.locator(surface.row)).toContainText(
          teams.target.name,
        );
        release();
        await expect.poll(() => settled).toBe(true);
        await expect(panel.locator(surface.row)).toContainText(
          teams.target.name,
        );
        await expect(panel.getByRole('alert')).toHaveCount(0);
        await expect(panel).toHaveAttribute('aria-busy', 'false');
      } finally {
        release();
        await page.unrouteAll({ behavior: 'wait' });
      }
    });
  }

  test(`${surface.region}读取失败可重试且刷新失败保留结果`, async ({
    page,
  }) => {
    const teams = seedRiskTeams();
    const panel = await open(page, surface, teams);
    let fail = true;
    await page.route(`**/api/${surface.endpoint}?*`, (route) =>
      fail
        ? route.fulfill({ status: 503, json: { error: '暂时无法读取' } })
        : route.fallback(),
    );
    const selector = panel.getByRole('combobox', {
      name: surface.team,
      exact: true,
    });
    await selector.selectOption(teams.target.id);
    await expect(panel.getByRole('alert')).toContainText('暂时无法读取');
    await expect(panel.getByText(surface.empty, { exact: true })).toHaveCount(
      0,
    );
    await expect(panel.locator(surface.row)).toHaveCount(0);
    if (surface.endpoint === 'risks')
      await expect(panel).not.toContainText('0 项待处理');
    if (test.info().project.name === 'mobile') {
      for (const width of [320, 393]) {
        await page.setViewportSize({ width, height: 851 });
        await expect
          .poll(() =>
            page.evaluate(
              () => document.documentElement.scrollWidth <= window.innerWidth,
            ),
          )
          .toBe(true);
        const retryBox = await panel
          .getByRole('button', { name: '重试', exact: true })
          .boundingBox();
        expect(retryBox.height).toBeGreaterThanOrEqual(44);
      }
    }
    await panel.screenshot({ path: test.info().outputPath('read-error.png') });
    fail = false;
    await panel.getByRole('button', { name: '重试', exact: true }).click();
    await expect(panel.locator(surface.row)).toContainText(teams.target.name);
    fail = true;
    await panel
      .getByRole('button', { name: surface.refresh, exact: true })
      .click();
    await expect(panel.getByRole('alert')).toContainText(
      '刷新失败，当前显示上次成功获取的数据。',
    );
    await expect(panel.locator(surface.row)).toContainText(teams.target.name);
    fail = false;
    await panel.getByRole('button', { name: '重试', exact: true }).click();
    await expect(panel.getByRole('alert')).toHaveCount(0);
    await expect(selector).toHaveValue(teams.target.id);
  });

  test(`${surface.region}分页失败可恢复且旧分页不会混入新筛选`, async ({
    page,
  }) => {
    const teams = seedRiskTeams();
    const panel = await open(page, surface, teams);
    let fail = true;
    let delay = false;
    let release;
    let intercepted = false;
    let settled = false;
    const gate = new Promise((resolve) => {
      release = resolve;
    });
    await page.route(`**/api/${surface.endpoint}?*`, async (route) => {
      const query = new URL(route.request().url()).searchParams;
      if (query.get('teamId') !== teams.source.id || query.has('kind'))
        return route.fallback();
      if (!query.has('before'))
        return route.fulfill({ json: result(teams.source, '第一页', true) });
      if (fail)
        return route.fulfill({ status: 503, json: { error: '分页暂不可用' } });
      if (delay) {
        intercepted = true;
        await gate;
      }
      try {
        const response = result(
          teams.source,
          delay ? '过期分页' : '第二页',
          delay,
        );
        // Overlapping pages must not create duplicate cards.
        response.items.unshift(...result(teams.source, '第一页').items);
        await route.fulfill({ json: response });
      } catch {
        /* Scope changes may abort this request. */
      } finally {
        settled = true;
      }
    });
    try {
      await panel
        .getByRole('combobox', { name: surface.team, exact: true })
        .selectOption(teams.source.id);
      await panel
        .getByRole('button', { name: surface.more, exact: true })
        .click();
      await expect(panel.getByRole('alert')).toContainText('分页暂不可用');
      await expect(panel.locator(surface.row)).toHaveCount(1);
      fail = false;
      await panel.getByRole('button', { name: '重试', exact: true }).click();
      await expect(panel.locator(surface.row)).toHaveCount(2);
      await expect(panel.locator(surface.row).last()).toContainText('第二页');
      await panel
        .getByRole('button', { name: surface.refresh, exact: true })
        .click();
      await expect(panel.locator(surface.row)).toHaveCount(1);
      delay = true;
      settled = false;
      await panel
        .getByRole('button', { name: surface.more, exact: true })
        .click();
      await expect.poll(() => intercepted).toBe(true);
      await panel
        .getByRole('combobox', { name: surface.kind, exact: true })
        .selectOption('execution');
      await expect(panel.locator(surface.row)).toHaveCount(1);
      await expect(panel.locator(surface.row)).toContainText('首批');
      release();
      await expect.poll(() => settled).toBe(true);
      await expect(panel.locator(surface.row)).toHaveCount(1);
      await expect(panel.locator(surface.row)).not.toContainText('过期分页');
      await expect(
        panel.getByRole('button', { name: surface.more, exact: true }),
      ).toHaveCount(0);
    } finally {
      release();
      await page.unrouteAll({ behavior: 'wait' });
    }
  });
}

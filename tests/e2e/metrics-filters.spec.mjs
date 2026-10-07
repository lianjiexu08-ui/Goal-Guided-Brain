import { expect, test } from '@playwright/test';
import {
  clickNavigation,
  sidebarLocator,
} from './team-recruitment-helpers.mjs';
import { seedModelMetrics } from './team-recruitment-fixtures.mjs';

test('指标高级筛选收起后保留条件，可单独移除或全部重置', async ({ page }) => {
  const teams = seedModelMetrics();
  await page.goto('/');
  await clickNavigation(page, '模型管理');
  const panel = page.getByTestId('model-metrics-panel');
  await expect(panel.getByTestId('model-metrics-row').first()).toBeVisible();
  const provider = panel.getByRole('combobox', {
    name: '指标供应商',
    exact: true,
  });
  const disclosure = panel.locator('summary').filter({ hasText: '更多筛选' });
  await expect(provider).toBeHidden();
  await panel
    .getByRole('combobox', { name: '指标团队', exact: true })
    .selectOption(teams.alpha.id);
  await panel
    .getByRole('combobox', { name: '指标时间范围', exact: true })
    .selectOption('7d');
  await disclosure.click();
  await provider.selectOption('e2e-provider-alpha');
  await panel
    .getByRole('combobox', { name: '指标模型', exact: true })
    .selectOption('e2e-alpha-model');
  await expect(panel.getByTestId('model-metrics-row')).toHaveCount(1);
  await disclosure.click();
  await expect(provider).toBeHidden();
  await expect(disclosure).toContainText('已选 2 项');
  await expect(
    panel.getByRole('button', {
      name: '清除模型筛选：e2e-alpha-model',
      exact: true,
    }),
  ).toBeVisible();
  await panel
    .getByRole('button', { name: '清除模型筛选：e2e-alpha-model', exact: true })
    .click();
  await expect(disclosure).toContainText('已选 1 项');
  await disclosure.click();
  await expect(provider).toHaveValue('e2e-provider-alpha');
  await expect(
    panel.getByRole('combobox', { name: '指标模型', exact: true }),
  ).toHaveValue('');
  await expect(
    panel.getByRole('combobox', { name: '指标团队', exact: true }),
  ).toHaveValue(teams.alpha.id);
  const resetResponse = page.waitForResponse((response) => {
    const url = new URL(response.url());
    return url.pathname === '/api/metrics/models' && !url.search;
  });
  await panel
    .getByRole('button', { name: '重置全部筛选', exact: true })
    .click();
  await resetResponse;
  await expect(provider).toHaveValue('');
  await expect(
    panel.getByRole('combobox', { name: '指标团队', exact: true }),
  ).toHaveValue('');
  await expect(
    panel.getByRole('combobox', { name: '指标时间范围', exact: true }),
  ).toHaveValue('all');
  await expect(panel.getByLabel('已选指标筛选')).toHaveCount(0);
});

test('指标紧凑布局在窄屏保留可触控筛选和完整摘要', async ({
  page,
}, testInfo) => {
  seedModelMetrics();
  await page.goto('/');
  await clickNavigation(page, '模型管理');
  if (testInfo.project.name === 'mobile')
    await expect(sidebarLocator(page)).toBeHidden();
  const panel = page.getByTestId('model-metrics-panel');
  await expect(panel.getByTestId('model-metrics-row').first()).toBeVisible();
  const widths = testInfo.project.name === 'mobile' ? [320, 393] : [1280];
  for (const width of widths) {
    await page.setViewportSize({ width, height: 851 });
    await panel
      .getByRole('heading', { name: '模型运行指标' })
      .scrollIntoViewIfNeeded();
    const layout = await panel.evaluate((element) => {
      const filters = element.querySelector('.model-metrics-filter-controls');
      const summary = element.querySelector('.model-metrics-summary');
      const selects = [...element.querySelectorAll('select')].filter((item) =>
        item.checkVisibility(),
      );
      return {
        pageWidth: document.documentElement.scrollWidth,
        viewport: innerWidth,
        filterHeight: filters.getBoundingClientRect().height,
        summaryHeight: summary.getBoundingClientRect().height,
        touchHeights: selects.map(
          (item) => item.getBoundingClientRect().height,
        ),
      };
    });
    expect(layout.pageWidth).toBeLessThanOrEqual(layout.viewport);
    expect(layout.touchHeights).toHaveLength(3);
    expect(Math.min(...layout.touchHeights)).toBeGreaterThanOrEqual(44);
    if (width < 560) {
      expect(layout.filterHeight).toBeLessThan(230);
      expect(layout.summaryHeight).toBeLessThan(260);
    }
    await testInfo.attach(`metrics-${width}px`, {
      body: await page.screenshot(),
      contentType: 'image/png',
    });
  }
});

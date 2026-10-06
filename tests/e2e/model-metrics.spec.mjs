import { expect, test } from '@playwright/test';
import { clickNavigation } from './team-recruitment-helpers.mjs';
import { seedModelMetrics } from './team-recruitment-fixtures.mjs';

test.describe('模型运行指标回归', () => {
  test('模型管理显示真实运行指标并支持按团队筛选', async ({ page }) => {
    const teams = seedModelMetrics();
    await page.goto('/');
    await clickNavigation(page, '模型管理');
    await expect(page.getByRole('heading', { name: '模型管理' })).toBeVisible();
    const panel = page.getByRole('region', {
      name: '模型运行指标',
      exact: true,
    });
    await expect(panel).toBeVisible();
    // Earlier flows in this shared browser fixture may leave other model
    // attempts behind; assert the two rows created by this fixture directly.
    const fixtureRows = panel
      .getByTestId('model-metrics-row')
      .filter({ hasText: /e2e-(alpha|beta)-model/ });
    await expect(fixtureRows).toHaveCount(2);
    await expect(
      panel
        .getByTestId('model-metrics-row')
        .filter({ hasText: 'e2e-alpha-model' }),
    ).toBeVisible();
    await expect(
      panel
        .getByTestId('model-metrics-row')
        .filter({ hasText: 'e2e-beta-model' }),
    ).toBeVisible();
    const evidenceQuality = panel.getByTestId('model-evidence-quality');
    await expect(evidenceQuality).toBeVisible();
    await expect(evidenceQuality).toContainText('当前证据覆盖率');
    // The desktop and mobile projects share a fixture directory, so other
    // completed tasks may be present in the global card. The team filter
    // below asserts the exact evidence state for this fixture.
    await expect(evidenceQuality).toContainText('待补证据');
    await expect(evidenceQuality).toContainText('Alpha 模型团队');
    await expect(evidenceQuality).toContainText('Beta 模型团队');
    const evidenceTrend = panel.getByTestId('model-evidence-trend');
    await expect(evidenceTrend).toBeVisible();
    await expect(evidenceTrend).toContainText('按日趋势');
    await expect(
      evidenceTrend.getByTestId('model-evidence-trend-row').first(),
    ).toBeVisible();
    await expect(
      panel
        .getByTestId('model-metrics-row')
        .filter({ hasText: 'e2e-beta-model' })
        .getByText('未知', { exact: true }),
    ).toBeVisible();
    const timeWindow = panel.getByRole('combobox', {
      name: '指标时间范围',
      exact: true,
    });
    await expect(timeWindow).toHaveValue('all');
    const sevenDayRequest = page.waitForRequest(
      (request) =>
        request.url().includes('/api/metrics/models') &&
        Boolean(new URL(request.url()).searchParams.get('since')),
    );
    await timeWindow.selectOption('7d');
    const request = await sevenDayRequest;
    expect(new URL(request.url()).searchParams.get('since')).toBeTruthy();
    await expect(timeWindow).toHaveValue('7d');
    await expect(evidenceQuality).toContainText('最近 7 天');
    const metricsViewport = await panel
      .locator('.model-metrics-table-wrap')
      .evaluate((element) => ({
        clientWidth: element.clientWidth,
        scrollWidth: element.scrollWidth,
      }));
    expect(metricsViewport.scrollWidth).toBeLessThanOrEqual(
      metricsViewport.clientWidth + 1,
    );
    await panel
      .getByRole('combobox', { name: '指标团队', exact: true })
      .selectOption(teams.alpha.id);
    await expect(
      panel
        .getByTestId('model-metrics-row')
        .filter({ hasText: 'e2e-alpha-model' }),
    ).toHaveCount(1);
    await expect(
      panel
        .getByTestId('model-metrics-row')
        .filter({ hasText: 'e2e-alpha-model' }),
    ).toBeVisible();
    await expect(
      panel
        .getByTestId('model-metrics-row')
        .filter({ hasText: 'e2e-beta-model' }),
    ).toHaveCount(0);
    await expect(evidenceQuality).toContainText('待补证据 1');
  });
});

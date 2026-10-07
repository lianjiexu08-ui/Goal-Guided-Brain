import { expect, test } from '@playwright/test';
import { clickNavigation } from './team-recruitment-helpers.mjs';
import { seedModelMetrics } from './team-recruitment-fixtures.mjs';

const endpoint = '**/api/metrics/models*';

async function openMetrics(page) {
  await page.goto('/');
  await clickNavigation(page, '模型管理');
  const panel = page.getByTestId('model-metrics-panel');
  await expect(panel.getByTestId('model-metrics-row').first()).toBeVisible();
  return panel;
}

for (const lateStatus of [200, 503]) {
  test(`指标筛选忽略旧团队的延迟 ${lateStatus} 响应`, async ({ page }) => {
    const teams = seedModelMetrics();
    const panel = await openMetrics(page);
    const selector = panel.getByRole('combobox', {
      name: '指标团队',
      exact: true,
    });
    let release;
    let intercepted = false;
    let settled = false;
    const gate = new Promise((resolve) => {
      release = resolve;
    });
    await page.route(endpoint, async (route) => {
      if (
        new URL(route.request().url()).searchParams.get('teamId') !==
        teams.alpha.id
      )
        return route.continue();
      const response = await route.fetch();
      intercepted = true;
      await gate;
      try {
        if (lateStatus === 200) await route.fulfill({ response });
        else
          await route.fulfill({
            status: 503,
            json: { error: '旧团队请求失败' },
          });
      } catch {
        // Changing scope may already have aborted this obsolete request.
      } finally {
        settled = true;
      }
    });
    try {
      await selector.selectOption(teams.alpha.id);
      await expect.poll(() => intercepted).toBe(true);
      await expect(panel).toHaveAttribute('aria-busy', 'true');
      await expect(panel.getByTestId('model-metrics-row')).toHaveCount(0);
      await expect(panel.getByTestId('model-evidence-quality')).toHaveCount(0);
      await selector.selectOption(teams.beta.id);
      await expect(panel.getByTestId('model-metrics-row')).toHaveCount(1);
      await expect(panel.getByTestId('model-metrics-row')).toContainText(
        'e2e-beta-model',
      );
      release();
      await expect.poll(() => settled).toBe(true);
      await expect(selector).toHaveValue(teams.beta.id);
      await expect(panel.getByTestId('model-metrics-row')).toContainText(
        'e2e-beta-model',
      );
      await expect(panel.getByRole('alert')).toHaveCount(0);
      await expect(panel).toHaveAttribute('aria-busy', 'false');
    } finally {
      release();
      await page.unrouteAll({ behavior: 'wait' });
    }
  });
}

test('指标读取失败可重试，保留筛选且不误报空数据', async ({ page }) => {
  const teams = seedModelMetrics();
  const panel = await openMetrics(page);
  let fail = true;
  await page.route(endpoint, async (route) => {
    if (fail)
      return route.fulfill({
        status: 503,
        json: { error: '指标服务暂时离线' },
      });
    return route.continue();
  });
  const selector = panel.getByRole('combobox', {
    name: '指标团队',
    exact: true,
  });
  await selector.selectOption(teams.beta.id);
  await expect(panel.getByRole('alert')).toContainText('指标服务暂时离线');
  await expect(
    panel.getByText('当前筛选没有模型运行记录', { exact: true }),
  ).toHaveCount(0);
  await expect(panel.getByTestId('model-task-type-comparison')).toHaveCount(0);
  await expect(selector).toHaveValue(teams.beta.id);
  fail = false;
  await panel.getByRole('button', { name: '重新加载指标' }).click();
  await expect(panel.getByRole('alert')).toHaveCount(0);
  await expect(panel.getByTestId('model-metrics-row')).toHaveCount(1);
  await expect(panel.getByTestId('model-metrics-row')).toContainText(
    'e2e-beta-model',
  );
  await expect(selector).toHaveValue(teams.beta.id);
});

test('后台指标刷新失败保留同一筛选的上次结果并提示过期', async ({ page }) => {
  const teams = seedModelMetrics();
  const panel = await openMetrics(page);
  await panel
    .getByRole('combobox', { name: '指标团队', exact: true })
    .selectOption(teams.alpha.id);
  const rows = panel.getByTestId('model-metrics-row');
  await expect(rows).toHaveCount(1);
  await expect(rows).toContainText('e2e-alpha-model');
  let fail = true;
  await page.route(endpoint, async (route) => {
    if (fail)
      return route.fulfill({ status: 503, json: { error: '刷新暂不可用' } });
    return route.continue();
  });
  await expect(panel.getByRole('alert')).toContainText('刷新暂不可用', {
    timeout: 15000,
  });
  await expect(panel).toContainText('刷新失败，当前显示上次成功获取的数据。');
  await expect(rows).toContainText('e2e-alpha-model');
  fail = false;
  await panel.getByRole('button', { name: '重新加载指标' }).click();
  await expect(panel.getByRole('alert')).toHaveCount(0);
  await expect(rows).toContainText('e2e-alpha-model');
});

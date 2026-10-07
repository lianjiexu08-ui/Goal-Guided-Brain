import { expect, test } from '@playwright/test';
import { seedConfirmedTeams } from './team-recruitment-fixtures.mjs';
import { clickNavigation } from './team-recruitment-helpers.mjs';

function gate() {
  let release;
  const promise = new Promise((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

async function selectOnStartup(page, team) {
  await page.addInitScript(
    ({ id, role }) => {
      localStorage.setItem(
        'ggb.workspace-route.v1',
        JSON.stringify({
          spaceId: id,
          role,
          view: 'workspace',
        }),
      );
    },
    { id: team.id, role: 'project_manager' },
  );
}

test('首次慢连接显示真实加载状态，轮询不重复，恢复后首击招募可用', async ({
  page,
}) => {
  seedConfirmedTeams();
  const held = gate();
  let reads = 0;
  await page.clock.install();
  await page.route('**/api/state', async (route) => {
    reads += 1;
    await held.promise;
    await route.continue().catch(() => {});
  });
  try {
    await page.goto('/');
    const loading = page.getByRole('region', { name: '连接工作台' });
    await expect(loading).toContainText('正在准备你的工作台');
    await expect(page.getByText('服务已连接', { exact: true })).toHaveCount(0);
    await expect(page.locator('textarea')).toHaveCount(0);
    await page.clock.fastForward(4500);
    expect(reads).toBe(1);
    if (test.info().project.name === 'mobile') {
      await page.setViewportSize({ width: 320, height: 851 });
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth,
        ),
      ).toBe(true);
    }
    await page.screenshot({ path: test.info().outputPath('loading.png') });
    held.release();
    await expect(loading).toHaveCount(0);
    await clickNavigation(page, '团队招募');
    await expect(
      page.getByRole('combobox', { name: '选择需求草稿', exact: true }),
    ).toBeVisible();
    await expect(
      page.getByText('招募会话已同步，可在其他设备继续', { exact: true }),
    ).toBeVisible();
  } finally {
    held.release();
  }
});

test('首次连接失败可手动重试，并恢复上次团队而不误建招募', async ({ page }) => {
  const { development } = seedConfirmedTeams();
  await selectOnStartup(page, development);
  let fail = true;
  let creates = 0;
  page.on('request', (request) => {
    if (
      request.method() === 'POST' &&
      new URL(request.url()).pathname === '/api/spaces'
    )
      creates += 1;
  });
  await page.route('**/api/state', (route) =>
    fail
      ? route.fulfill({
          status: 503,
          json: { error: 'fixture 服务暂时不可用' },
        })
      : route.continue(),
  );
  await page.goto('/');
  await expect(
    page.getByRole('heading', { name: '暂时无法打开工作台' }),
  ).toBeVisible();
  await expect(page.getByRole('alert')).toContainText('fixture 服务暂时不可用');
  const retry = page.getByRole('button', { name: '重新连接', exact: true });
  expect((await retry.boundingBox()).height).toBeGreaterThanOrEqual(44);
  await page.screenshot({
    path: test.info().outputPath('connection-error.png'),
  });
  fail = false;
  await retry.click();
  await expect(
    page.getByRole('heading', { name: development.name }),
  ).toBeVisible();
  await expect(page.getByText('服务已连接', { exact: true })).toBeVisible();
  expect(creates).toBe(0);
});

test('连接挂起有超时提示，重试后仍可恢复', async ({ page }) => {
  seedConfirmedTeams();
  const held = gate();
  let hang = true;
  let reads = 0;
  await page.clock.install();
  await page.route('**/api/state', async (route) => {
    reads += 1;
    if (hang) await held.promise;
    await route.continue().catch(() => {});
  });
  try {
    await page.goto('/');
    await expect.poll(() => reads).toBe(1);
    await page.clock.fastForward(15001);
    await expect(page.getByRole('alert')).toContainText('连接超时');
    hang = false;
    await page.getByRole('button', { name: '重新连接', exact: true }).click();
    await expect(page.getByText('服务已连接', { exact: true })).toBeVisible();
  } finally {
    held.release();
  }
});

test('后台断连保留团队和草稿，并通过重试恢复连接状态', async ({ page }) => {
  const { development } = seedConfirmedTeams();
  await selectOnStartup(page, development);
  await page.goto('/');
  await expect(
    page.getByRole('heading', { name: development.name }),
  ).toBeVisible();
  const composer = page.locator('textarea[aria-label^="发送给"]');
  await composer.fill('断连期间继续整理需求');
  let fail = true;
  await page.route('**/api/state', (route) =>
    fail
      ? route.fulfill({ status: 503, json: { error: 'fixture disconnected' } })
      : route.continue(),
  );
  const alert = page.locator('.error-banner');
  await expect(alert).toContainText('当前显示上次读取的内容');
  await expect(composer).toHaveValue('断连期间继续整理需求');
  await composer.fill('断连期间完成的草稿仍保留');
  fail = false;
  await alert.getByRole('button', { name: '重试', exact: true }).click();
  await expect(alert).toHaveCount(0);
  await expect(composer).toHaveValue('断连期间完成的草稿仍保留');
  await expect(
    page.getByRole('heading', { name: development.name }),
  ).toBeVisible();
});

for (const status of [200, 503]) {
  test(`重命名后的新状态不会被延迟 ${status} 轮询覆盖`, async ({ page }) => {
    const { development } = seedConfirmedTeams();
    await selectOnStartup(page, development);
    await page.goto('/');
    await expect(
      page.getByRole('heading', { name: development.name }),
    ).toBeVisible();
    const held = gate();
    let captured = false;
    let snapshotReady = false;
    let settled = false;
    await page.route('**/api/state', async (route) => {
      if (captured) return route.continue();
      captured = true;
      const response = await route.fetch();
      const snapshot = await response.json();
      expect(
        snapshot.spaces.find((team) => team.id === development.id).name,
      ).toBe(development.name);
      snapshotReady = true;
      await held.promise;
      try {
        await route.fulfill({
          status,
          json: status === 200 ? snapshot : { error: '旧请求失败' },
        });
      } catch {
        /* Superseded requests are intentionally aborted. */
      } finally {
        settled = true;
      }
    });
    try {
      await expect.poll(() => snapshotReady).toBe(true);
      await page.getByRole('button', { name: '重命名', exact: true }).click();
      const renamed = `连接恢复团队 ${Date.now()}`;
      await page.getByLabel('团队名称').fill(renamed);
      await page.getByRole('button', { name: '保存名称', exact: true }).click();
      await expect(page.getByRole('heading', { name: renamed })).toBeVisible();
      held.release();
      await expect.poll(() => settled).toBe(true);
      await expect(page.getByRole('heading', { name: renamed })).toBeVisible();
      await expect(page.locator('.error-banner')).toHaveCount(0);
    } finally {
      held.release();
    }
  });
}

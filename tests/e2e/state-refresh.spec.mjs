import { expect, test } from '@playwright/test';
import { Store } from '../../server/store.mjs';
import {
  dataDir,
  seedConversationScrollTeam,
} from './conversation-scroll-fixtures.mjs';

async function openTeam(page) {
  const team = seedConversationScrollTeam();
  await page.addInitScript((spaceId) => {
    localStorage.setItem(
      'ggb.workspace-route.v1',
      JSON.stringify({ spaceId, role: 'project_manager', view: 'workspace' }),
    );
  }, team.id);
  await page.goto('/');
  await expect(page.getByRole('heading', { name: team.name })).toBeVisible();
  return team;
}

const isState = (response) => new URL(response.url()).pathname === '/api/state';

test('迟到的增量阶段不能永久覆盖 304 确认的状态', async ({ page }) => {
  const store = new Store(dataDir, process.cwd(), { seedProjectManager: true });
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  let held = false;
  let releaseIncremental;
  const incrementalGate = new Promise((resolve) => {
    releaseIncremental = resolve;
  });
  try {
    const team = store.saveTeamSpace({
      name: `临时消息需求 ${Date.now()}`,
      goal: '验证增量同步和条件刷新的状态一致性',
      pmRoleId: 'project_manager',
      memberRoleIds: ['project_manager'],
      recruitment: { phase: 'discovery' },
    });
    await page.addInitScript(
      (spaceId) =>
        localStorage.setItem(
          'ggb.workspace-route.v1',
          JSON.stringify({
            spaceId,
            role: 'project_manager',
            view: 'workspace',
          }),
        ),
      team.id,
    );
    await page.goto('/');
    await expect(
      page.getByText('招募会话已同步，可在其他设备继续', { exact: true }),
    ).toBeVisible();
    await page.route('**/api/state', async (route) => {
      if (!held && route.request().headers()['if-none-match']) {
        held = true;
        await gate;
      }
      await route.continue().catch(() => {});
    });
    let delivered = false;
    // Simulate an older incremental reply arriving after the current full
    // snapshot. Hold later incremental reads so only the 304 can reconcile it.
    await page.route(
      `**/api/spaces/${team.id}/recruitment?*`,
      async (route) => {
        if (delivered) {
          await incrementalGate;
          return route.continue().catch(() => {});
        }
        delivered = true;
        const response = await route.fetch();
        const body = await response.json();
        body.recruitment.phase = 'proposed';
        await route.fulfill({ response, json: body });
      },
    );
    await expect.poll(() => held).toBe(true);
    const status = page.getByTestId('recruitment-status-card');
    await expect(status).toHaveClass(/recruitment-status-proposed/);
    const confirmed = page.waitForResponse(isState);
    release();
    expect((await confirmed).status()).toBe(304);
    await expect(status).toHaveClass(/recruitment-status-discovery/);
    await expect(page.locator('.error-banner')).toHaveCount(0);
  } finally {
    release();
    releaseIncremental();
    store.close();
  }
});

test('未变化轮询使用真实 304，保留阅读和草稿，外部修改随后同步', async ({
  page,
}) => {
  const team = await openTeam(page);
  const composer = page.locator('textarea[aria-label^="发送给"]');
  await composer.fill('阅读旧消息时继续整理需求');
  const messages = page.getByTestId('message-area');
  await expect
    .poll(() =>
      messages.evaluate(
        (el) => el.scrollHeight - el.scrollTop - el.clientHeight,
      ),
    )
    .toBeLessThanOrEqual(80);
  await messages.evaluate((el) => {
    el.scrollTop = 100;
    el.dispatchEvent(new Event('scroll'));
  });
  await expect(
    page.getByRole('button', { name: '回到最新消息', exact: true }),
  ).toBeVisible();
  const unchanged = await page.waitForResponse(
    (response) => isState(response) && response.status() === 304,
  );
  expect(unchanged.headers().etag).toBe(
    unchanged.request().headers()['if-none-match'],
  );
  expect(unchanged.headers()['cache-control']).toBe('no-store');
  await expect(composer).toHaveValue('阅读旧消息时继续整理需求');
  expect(await messages.evaluate((el) => el.scrollTop)).toBeLessThan(160);
  await expect(page.locator('.error-banner')).toHaveCount(0);

  const renamed = `其他设备更新 ${team.name}`;
  const next = page.waitForResponse(
    (response) => isState(response) && response.status() === 200,
  );
  const store = new Store(dataDir, process.cwd(), { seedProjectManager: true });
  try {
    store.saveTeamSpace({ name: renamed }, team.id);
  } finally {
    store.close();
  }
  const changed = await next;
  expect(changed.headers().etag).not.toBe(unchanged.headers().etag);
  await expect(page.getByRole('heading', { name: renamed })).toBeVisible();
  await expect(composer).toHaveValue('阅读旧消息时继续整理需求');
  expect(await messages.evaluate((el) => el.scrollTop)).toBeLessThan(160);
});

test('延迟的 304 不覆盖重命名后的状态或后续刷新版本', async ({ page }) => {
  await openTeam(page);
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  let oldEtag = '';
  let captured = false;
  let settled = false;
  await page.route('**/api/state', async (route) => {
    if (captured || !route.request().headers()['if-none-match'])
      return route.continue();
    captured = true;
    const response = await route.fetch();
    expect(response.status()).toBe(304);
    oldEtag = response.headers().etag;
    await gate;
    try {
      await route.fulfill({ response });
    } catch {
      /* Explicit refresh supersedes and aborts the older poll. */
    } finally {
      settled = true;
    }
  });
  try {
    await expect.poll(() => oldEtag).not.toBe('');
    await page.getByRole('button', { name: '重命名', exact: true }).click();
    const renamed = `条件刷新团队 ${Date.now()}`;
    await page.getByLabel('团队名称').fill(renamed);
    const fullRefresh = page.waitForResponse(
      (response) =>
        isState(response) &&
        response.status() === 200 &&
        !response.request().headers()['if-none-match'],
    );
    await page.getByRole('button', { name: '保存名称', exact: true }).click();
    const fresh = await fullRefresh;
    const newEtag = fresh.headers().etag;
    expect(newEtag).not.toBe(oldEtag);
    await expect(page.getByRole('heading', { name: renamed })).toBeVisible();
    release();
    await expect.poll(() => settled).toBe(true);
    const subsequent = await page.waitForResponse(
      (response) => isState(response) && response.status() === 304,
    );
    expect(subsequent.request().headers()['if-none-match']).toBe(newEtag);
    await expect(page.getByRole('heading', { name: renamed })).toBeVisible();
    await expect(page.locator('.error-banner')).toHaveCount(0);
  } finally {
    release();
  }
});

test('没有本地状态时拒绝异常 304，并通过完整重试恢复', async ({ page }) => {
  let reject = true;
  await page.route('**/api/state', (route) =>
    reject
      ? route.fulfill({ status: 304, headers: { etag: '"unknown-state"' } })
      : route.continue(),
  );
  await page.goto('/');
  await expect(page.getByRole('alert')).toContainText('无法匹配的状态版本');
  await expect(page.locator('textarea')).toHaveCount(0);
  reject = false;
  const fresh = page.waitForResponse(
    (response) => isState(response) && response.status() === 200,
  );
  await page.getByRole('button', { name: '重新连接', exact: true }).click();
  expect((await fresh).request().headers()['if-none-match']).toBeUndefined();
  await expect(page.getByText('服务已连接', { exact: true })).toBeVisible();
});

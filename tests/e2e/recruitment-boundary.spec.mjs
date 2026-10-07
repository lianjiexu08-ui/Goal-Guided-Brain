import { randomUUID } from 'node:crypto';
import { expect, test } from '@playwright/test';
import { Store } from '../../server/store.mjs';
import {
  clickNavigation,
  openMobileSidebar,
  sidebarLocator,
} from './team-recruitment-helpers.mjs';

function seed(phase = 'discovery') {
  const store = new Store(process.env.GGB_E2E_DATA_DIR, process.cwd(), {
    seedProjectManager: true,
  });
  try {
    return store.saveTeamSpace({
      name: `支付链路需求 ${randomUUID().slice(0, 8)}`,
      goal: '澄清支付链路的开发和验收要求',
      pmRoleId: 'project_manager',
      memberRoleIds: ['project_manager'],
      workspace: process.cwd(),
      recruitment: { phase },
    });
  } finally {
    store.close();
  }
}

async function showOnly(page, team, view) {
  await page.addInitScript(
    ({ id, view }) => {
      localStorage.removeItem('ggb.workspace-route.v1');
      if (view)
        localStorage.setItem(
          'ggb.workspace-route.v1',
          JSON.stringify({
            spaceId: id,
            role: 'project_manager',
            view,
          }),
        );
    },
    { id: team.id, view },
  );
  await page.route('**/api/state', async (route) => {
    const response = await route.fetch({
      headers: { ...route.request().headers(), 'if-none-match': '' },
    });
    const state = await response.json();
    state.spaces = state.spaces.filter((space) => space.id === team.id);
    const { etag: _etag, ...headers } = response.headers();
    await route.fulfill({ response, headers, json: state });
  });
}

for (const view of [undefined, 'workspace', 'team']) {
  test(`未确认草稿在 ${view || '首次打开'} 入口保持招募身份和可读名称`, async ({
    page,
  }) => {
    const draft = seed();
    await showOnly(page, draft, view);
    if (!view && test.info().project.name === 'mobile') {
      await page.setViewportSize({ width: 320, height: 851 });
    }
    await page.goto('/');
    await expect(page.getByRole('heading', { level: 1 })).toContainText(
      '发布需求，招募团队',
    );
    await expect(page.getByTestId('recruitment-status-card')).toContainText(
      '需求草稿',
    );
    const picker = page.getByRole('combobox', {
      name: '选择需求草稿',
      exact: true,
    });
    await expect(picker).toContainText(`需求草稿 · ${draft.name}`);
    await expect(picker).not.toContainText(draft.id);
    await expect(
      page.getByRole('button', { name: '重命名', exact: true }),
    ).toHaveCount(0);
    const composer = page.locator('textarea[aria-label^="发送给"]');
    await composer.fill('先保留交付范围，确认后再创建成员');
    await page.reload();
    await expect(page.getByRole('heading', { level: 1 })).toContainText(
      '发布需求，招募团队',
    );
    await expect(composer).toHaveValue('先保留交付范围，确认后再创建成员');
    if (!view) {
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth,
        ),
      ).toBe(true);
      await page.screenshot({
        path: test.info().outputPath('recruitment.png'),
      });
    }
    await openMobileSidebar(page);
    await expect(
      sidebarLocator(page).getByRole('button', {
        name: '团队确认后会显示在这里',
        exact: true,
      }),
    ).toBeVisible();
    expect(
      await page.evaluate(
        () => JSON.parse(localStorage.getItem('ggb.workspace-route.v1')).view,
      ),
    ).toBe('recruitment');
  });
}

test('草稿上下文中的管理页面刷新后仍保留管理入口', async ({ page }) => {
  const draft = seed();
  await showOnly(page, draft, 'models');
  await page.goto('/');
  await expect(
    page.getByRole('heading', { name: '模型管理', exact: true }),
  ).toBeVisible();
  await page.reload();
  await expect(
    page.getByRole('heading', { name: '模型管理', exact: true }),
  ).toBeVisible();
  await clickNavigation(page, '团队招募');
  await expect(page.getByTestId('recruitment-status-card')).toContainText(
    draft.name,
  );
});

test('已确认团队不会因旧招募缓存重新显示为需求草稿', async ({ page }) => {
  const team = seed('confirmed');
  await showOnly(page, team, 'recruitment');
  await page.goto('/');
  await expect(page.getByRole('heading', { level: 1 })).toContainText(
    team.name,
  );
  await expect(page.getByTestId('recruitment-status-card')).toHaveCount(0);
  await expect(
    page.getByRole('combobox', { name: '选择团队', exact: true }),
  ).toContainText(team.name);
  await expect(
    page.getByRole('button', { name: '重命名', exact: true }),
  ).toBeVisible();
});

test('另一设备确认团队后页面身份更新且草稿不丢失', async ({ page }) => {
  const draft = seed();
  await showOnly(page, draft, 'recruitment');
  await page.goto('/');
  const composer = page.locator('textarea[aria-label^="发送给"]');
  await composer.fill('确认后继续讨论的工作事项');
  // Simulate the durable result of owner confirmation on a second device.
  const store = new Store(process.env.GGB_E2E_DATA_DIR, process.cwd());
  try {
    store.saveTeamSpace(
      {
        ...draft,
        name: '支付链路开发团队',
        recruitment: {
          ...draft.recruitment,
          phase: 'confirmed',
          confirmedAt: new Date().toISOString(),
        },
      },
      draft.id,
    );
  } finally {
    store.close();
  }
  await expect(page.getByRole('heading', { level: 1 })).toContainText(
    '支付链路开发团队',
  );
  await expect(page.getByTestId('recruitment-status-card')).toHaveCount(0);
  await expect(composer).toHaveValue('确认后继续讨论的工作事项');
  expect(
    await page.evaluate(
      () => JSON.parse(localStorage.getItem('ggb.workspace-route.v1')).view,
    ),
  ).toBe('workspace');
});

test('无可用空间时显示招募入口，点击后才创建独立草稿', async ({ page }) => {
  let createdId = '';
  let creates = 0;
  await page.route('**/api/state', async (route) => {
    const response = await route.fetch({
      headers: { ...route.request().headers(), 'if-none-match': '' },
    });
    const state = await response.json();
    state.spaces = state.spaces.filter((space) => space.id === createdId);
    const { etag: _etag, ...headers } = response.headers();
    await route.fulfill({ response, headers, json: state });
  });
  await page.route('**/api/spaces', async (route) => {
    if (route.request().method() !== 'POST') return route.continue();
    const response = await route.fetch();
    const team = await response.json();
    createdId = team.id;
    creates += 1;
    expect(team.recruitment.phase).toBe('discovery');
    await route.fulfill({ response, json: team });
  });
  await page.goto('/');
  const empty = page.getByRole('region', { name: '开始团队招募' });
  await expect(empty).toBeVisible();
  await expect(page.locator('textarea')).toHaveCount(0);
  expect(creates).toBe(0);
  await empty
    .getByRole('button', { name: '开始发布需求', exact: true })
    .click();
  await expect(page.getByTestId('recruitment-status-card')).toContainText(
    '需求草稿',
  );
  await expect(page.locator('textarea[aria-label^="发送给"]')).toBeVisible();
  expect(creates).toBe(1);
});

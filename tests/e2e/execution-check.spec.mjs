import path from 'node:path';
import { expect, test } from '@playwright/test';
import { Store } from '../../server/store.mjs';

const panel = (page) =>
  page.getByRole('region', { name: '本机执行检查', exact: true });
const inspect = (page) => panel(page).getByRole('button');
async function open(page) {
  const store = new Store(process.env.GGB_E2E_DATA_DIR, process.cwd(), {
    seedProjectManager: true,
  });
  let team;
  try {
    team = store.saveTeamSpace({
      name: `执行检查 ${crypto.randomUUID().slice(0, 8)}`,
      goal: '核对项目执行环境',
      workspace: process.cwd(),
      pmRoleId: 'project_manager',
      memberRoleIds: ['project_manager'],
      recruitment: { phase: 'confirmed' },
    });
  } finally {
    store.close();
  }
  await page.addInitScript(
    (id) =>
      localStorage.setItem(
        'ggb.workspace-route.v1',
        JSON.stringify({
          spaceId: id,
          role: 'project_manager',
          view: 'workspace',
        }),
      ),
    team.id,
  );
  await page.goto('/');
  await expect(page.locator('textarea[aria-label^="发送给"]')).toBeVisible();
  return team;
}

test('团队目录检查使用真实文件系统，不保存或运行任务，修正目录后继续原草稿', async ({
  page,
  request,
}) => {
  const team = await open(page);
  const composer = page.locator('textarea[aria-label^="发送给"]');
  await composer.fill('核对环境后继续开发订单页面');
  await page.locator('.workspace-path').click();
  const dialog = page.getByRole('dialog');
  const input = dialog.getByLabel('工作目录', { exact: true });
  const missing = path.join(
    process.env.GGB_E2E_DATA_DIR,
    'not-created-by-check',
  );
  await input.fill(missing);
  await inspect(page).click();
  await expect(panel(page)).toContainText('目录不存在');
  const state = await (await request.get('/api/state')).json();
  expect(state.spaces.find((row) => row.id === team.id).workspace).toBe(
    process.cwd(),
  );
  expect(
    state.tasks.filter(
      (row) => row.teamId === team.id || row.spaceId === team.id,
    ),
  ).toHaveLength(0);
  await input.fill(path.join(process.cwd(), 'package.json'));
  await expect(panel(page)).not.toContainText('目录不存在');
  await inspect(page).click();
  await expect(panel(page)).toContainText('这个路径是文件');
  await input.fill(process.cwd());
  await inspect(page).click();
  await expect(panel(page)).toContainText('目录存在，当前服务可以读取和进入');
  await expect(panel(page)).toContainText('不代表引擎启动');
  await dialog
    .getByRole('button', { name: '保存团队设置', exact: true })
    .click();
  await expect(dialog).toBeHidden();
  await expect(composer).toHaveValue('核对环境后继续开发订单页面');
});

test('修改目录隔离迟到结果，失败和无效响应可重试，刷新失败保留上次检查', async ({
  page,
}) => {
  await open(page);
  await page.locator('.workspace-path').click();
  const input = page
    .getByRole('dialog')
    .getByLabel('工作目录', { exact: true });
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  let count = 0;
  await page.route('**/api/execution-check', async (route) => {
    count++;
    if (count === 1) {
      await gate;
      await route
        .fulfill({
          json: {
            checkedAt: new Date().toISOString(),
            checks: [
              { id: 'workspace', status: 'pass', detail: '迟到的旧目录结果' },
              { id: 'engine', status: 'pass', detail: '旧引擎结果' },
            ],
          },
        })
        .catch(() => {});
    } else if (count === 2 || count === 5) {
      await route.fulfill({
        status: 503,
        json: { error: '检查服务暂时不可用' },
      });
    } else if (count === 3) {
      await route.fulfill({ json: { checks: [] } });
    } else {
      await route.continue();
    }
  });
  await inspect(page).click();
  await expect.poll(() => count).toBe(1);
  await input.fill(process.cwd() + path.sep + '.');
  release();
  await expect(inspect(page)).toBeEnabled();
  await inspect(page).click();
  await expect(panel(page).getByRole('alert')).toHaveText('检查服务暂时不可用');
  await expect(panel(page)).not.toContainText('迟到的旧目录结果');
  await inspect(page).click();
  await expect(panel(page).getByRole('alert')).toHaveText(
    '检查结果无效，请重试。',
  );
  await inspect(page).click();
  await expect(panel(page)).toContainText('当前服务可以读取和进入');
  await inspect(page).click();
  await expect(panel(page).getByRole('alert')).toHaveText('检查服务暂时不可用');
  await expect(panel(page)).toContainText('上次检查');
  await expect(panel(page)).toContainText('当前服务可以读取和进入');
  await expect(input).toHaveValue(process.cwd() + path.sep + '.');
});

test('工作空间设置共享执行检查，手机窄屏长路径不溢出且操作可达', async ({
  page,
}) => {
  await open(page);
  if (test.info().project.name === 'mobile') {
    await page.setViewportSize({ width: 320, height: 851 });
    await page.getByRole('button', { name: '打开设置', exact: true }).click();
  } else {
    await page.locator('button.environment').click();
  }
  const dialog = page.getByRole('dialog', {
    name: '工作空间设置',
    exact: true,
  });
  await expect(dialog).toBeVisible();
  const input = dialog.getByLabel('工作目录', { exact: true });
  await input.fill(path.join(process.cwd(), '很长的项目名称'.repeat(15)));
  await inspect(page).click();
  await expect(panel(page)).toContainText('目录不存在');
  await input.fill(process.cwd());
  await inspect(page).click();
  await expect(panel(page)).toContainText('当前服务可以读取和进入');
  await inspect(page).scrollIntoViewIfNeeded();
  const box = await inspect(page).boundingBox();
  expect(box.height).toBeGreaterThanOrEqual(44);
  expect(box.x).toBeGreaterThanOrEqual(0);
  expect(box.x + box.width).toBeLessThanOrEqual(page.viewportSize().width);
  expect(
    await panel(page).evaluate(
      (element) => element.scrollWidth <= element.clientWidth,
    ),
  ).toBe(true);
  await page.screenshot({
    path: test.info().outputPath('execution-check.png'),
  });
});

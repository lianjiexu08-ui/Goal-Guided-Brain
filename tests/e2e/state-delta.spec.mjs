import { expect, test } from '@playwright/test';
import { Store } from '../../server/store.mjs';
import {
  dataDir,
  seedConversationScrollTeam,
} from './conversation-scroll-fixtures.mjs';

function write(callback) {
  const store = new Store(dataDir, process.cwd(), { seedProjectManager: true });
  try {
    return callback(store);
  } finally {
    store.close();
  }
}
async function open(page, team) {
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
  await expect(page.getByRole('heading', { name: team.name })).toBeVisible();
}
const isState = (response) => new URL(response.url()).pathname === '/api/state';

test('真实增量刷新同步修改、删除和新任务，保留阅读位置、草稿与其他团队隔离', async ({
  page,
}) => {
  const current = seedConversationScrollTeam({ count: 45 });
  const other = seedConversationScrollTeam({ count: 3 });
  await open(page, current);
  const area = page.getByTestId('message-area');
  const composer = page.locator('textarea[aria-label^="发送给"]');
  await composer.fill('增量刷新中的未发送需求');
  await area.evaluate((el) => {
    el.scrollTop = 200;
    el.dispatchEvent(new Event('scroll'));
  });
  await expect(
    page.getByRole('button', { name: '回到最新消息', exact: true }),
  ).toBeVisible();
  const unchanged = await page.waitForResponse(
    (response) => isState(response) && response.status() === 304,
  );
  expect(unchanged.request().headers()['x-ggb-state-delta']).toBe('1');
  const incoming = page.waitForResponse(
    (response) =>
      isState(response) &&
      response.headers()['x-ggb-state-format'] === 'delta-v1',
  );
  write((store) => {
    store.updateTask(current.taskIds[40], { result: '当前团队的新回复' });
    store.db.prepare('DELETE FROM tasks WHERE id = ?').run(current.taskIds[42]);
    const task = store.createTask({
      role: 'project_manager',
      prompt: '另一个团队的新增需求',
    });
    store.records.save(
      'task-meta',
      { spaceId: other.id, teamId: other.id },
      task.id,
    );
    store.updateTask(task.id, {
      status: 'completed',
      result: '另一团队的独立交付',
    });
  });
  const delta = await incoming;
  const payload = await delta.json();
  expect(payload.baseEtag).toBe(unchanged.headers().etag);
  expect(payload.rows.tasks.remove).toContain(current.taskIds[42]);
  await expect(area).toContainText('当前团队的新回复');
  await expect(
    area.locator(`[data-turn-id="${current.taskIds[42]}"]`),
  ).toHaveCount(0);
  await expect(area).not.toContainText('另一团队的独立交付');
  await expect(composer).toHaveValue('增量刷新中的未发送需求');
  await expect
    .poll(() => area.evaluate((el) => Math.abs(el.scrollTop - 200)))
    .toBeLessThan(3);
  await page.getByRole('combobox', { name: '选择团队', exact: true }).click();
  await page.getByRole('option', { name: other.name, exact: true }).click();
  await expect(area).toContainText('另一团队的独立交付');
  await expect(area).not.toContainText('当前团队的新回复');
  await expect(page.locator('.error-banner')).toHaveCount(0);
});

for (const invalid of ['wrong-base', 'missing-row', 'missing-format']) {
  test(`损坏增量 ${invalid} 保留当前内容并通过完整读取恢复`, async ({
    page,
  }) => {
    const team = seedConversationScrollTeam({ count: 5 });
    await open(page, team);
    const composer = page.locator('textarea[aria-label^="发送给"]');
    await composer.fill('错误响应不能清除的草稿');
    let broken = true;
    await page.route('**/api/state', (route) => {
      if (!broken) return route.continue();
      return route.fulfill({
        status: 200,
        headers: {
          etag: '"changed"',
          ...(invalid === 'missing-format'
            ? {}
            : { 'x-ggb-state-format': 'delta-v1' }),
        },
        json: {
          format: 'ggb-state-delta-v1',
          baseEtag:
            invalid === 'wrong-base'
              ? '"wrong"'
              : route.request().headers()['if-none-match'],
          set: {},
          remove: [],
          rows: { tasks: { upsert: [], remove: [], order: ['missing'] } },
        },
      });
    });
    await expect(page.getByRole('alert')).toContainText(
      '当前显示上次读取的内容',
    );
    await expect(page.getByTestId('message-area')).toContainText(
      '历史任务 4 已完成',
    );
    await expect(composer).toHaveValue('错误响应不能清除的草稿');
    broken = false;
    const recovered = page.waitForResponse(
      (response) => isState(response) && response.status() === 200,
    );
    await page
      .getByRole('alert')
      .getByRole('button', { name: '重试', exact: true })
      .click();
    const response = await recovered;
    expect(response.request().headers()['if-none-match']).toBeUndefined();
    expect(response.request().headers()['x-ggb-state-delta']).toBeUndefined();
    expect(response.headers()['x-ggb-state-format']).toBeUndefined();
    await expect(page.locator('.error-banner')).toHaveCount(0);
    await expect(composer).toHaveValue('错误响应不能清除的草稿');
  });
}

test('延迟的旧增量不会覆盖主动刷新后的团队名称', async ({ page }) => {
  const team = seedConversationScrollTeam();
  await open(page, team);
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  let captured = false;
  let ready = false;
  let settled = false;
  const oldName = `中间版本 ${team.name}`;
  await page.route('**/api/state', async (route) => {
    if (captured || !route.request().headers()['x-ggb-state-delta'])
      return route.continue();
    captured = true;
    write((store) => store.saveTeamSpace({ name: oldName }, team.id));
    const response = await route.fetch();
    expect(response.headers()['x-ggb-state-format']).toBe('delta-v1');
    ready = true;
    await gate;
    try {
      await route.fulfill({ response });
    } catch {
      /* Superseded reads abort. */
    } finally {
      settled = true;
    }
  });
  try {
    await expect.poll(() => ready).toBe(true);
    const renamed = `最终名称 ${team.name}`;
    await page.getByRole('button', { name: '重命名', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: '重命名团队' });
    await dialog.getByRole('textbox').fill(renamed);
    await dialog.getByRole('button', { name: /保存/ }).click();
    await expect(page.getByRole('heading', { name: renamed })).toBeVisible();
    release();
    await expect.poll(() => settled).toBe(true);
    await page.waitForResponse(
      (response) => isState(response) && response.status() === 304,
    );
    await expect(page.getByRole('heading', { name: renamed })).toBeVisible();
    await expect(page.locator('.error-banner')).toHaveCount(0);
  } finally {
    release();
  }
});

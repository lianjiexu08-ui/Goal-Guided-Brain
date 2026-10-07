import { expect, test } from '@playwright/test';
import { Store } from '../../server/store.mjs';
import {
  clickNavigation,
  dataDir,
  seedLongTimelineTeam,
  seedCollaborationTeams,
} from './team-recruitment-fixtures.mjs';

function write(callback) {
  const store = new Store(dataDir, process.cwd(), { seedProjectManager: true });
  try {
    return callback(store);
  } finally {
    store.close();
  }
}
function fixture() {
  const team = seedLongTimelineTeam();
  const task = write((store) => {
    const task = store.createTask({
      role: 'project_manager',
      prompt: '时间线旧任务需求',
    });
    store.records.save(
      'task-meta',
      { teamId: team.id, spaceId: team.id },
      task.id,
    );
    store.updateTask(task.id, {
      status: 'failed',
      result: '完整旧任务回复仍可搜索',
      error: '旧任务失败原因',
    });
    store.db
      .prepare('UPDATE tasks SET createdAt=?, updatedAt=? WHERE id=?')
      .run('2020-01-01T00:00:00.000Z', '2020-01-01T00:00:00.000Z', task.id);
    store.records.save('artifacts', {
      taskId: task.id,
      kind: 'verification',
      name: '超过首屏范围的旧证据',
      status: 'verified',
      verified: true,
      finishedAt: '2020-01-01T00:00:00.000Z',
    });
    return task;
  });
  return { ...team, task };
}
async function open(page, team) {
  await page.addInitScript((id) => {
    const key = `ggb-test-route-initialized:${id}`;
    if (sessionStorage.getItem(key)) return;
    sessionStorage.setItem(key, '1');
    localStorage.setItem(
      'ggb.workspace-route.v1',
      JSON.stringify({
        spaceId: id,
        role: 'project_manager',
        view: 'workspace',
      }),
    );
  }, team.id);
  const response = page.waitForResponse(
    (res) => new URL(res.url()).pathname === '/api/state',
  );
  await page.goto('/');
  await expect(page.getByRole('heading', { name: team.name })).toBeVisible();
  return (await response).json();
}
const panel = (page) =>
  page.getByRole('region', { name: '团队统一时间线', exact: true });

test('最近协作按需读取，刷新后保留委派与回传且只显示最新八条', async ({
  page,
}) => {
  const teams = seedCollaborationTeams();
  write((store) => {
    for (let i = 0; i < 9; i++) {
      const message = store.saveTeamMessage({
        spaceId: teams.source.id,
        kind: i === 8 ? 'reply' : 'handoff',
        fromTeamId: teams.target.id,
        toTeamId: teams.source.id,
        content: `协作历史 ${i}`,
      });
      store.records.save(
        'space-messages',
        { ...message, createdAt: `2020-01-01T00:00:0${i}.000Z` },
        message.id,
      );
    }
    for (let i = 0; i < 130; i++)
      store.saveTeamMessage({
        spaceId: teams.source.id,
        content: `普通消息 ${i}`,
      });
  });
  let fail = true;
  await page.route(`**/api/spaces/${teams.source.id}/timeline?*`, (route) => {
    if (
      new URL(route.request().url()).searchParams.get('kind') ===
        'collaboration' &&
      fail
    )
      return route.fulfill({ status: 503, json: { error: '协作历史离线' } });
    return route.continue();
  });
  await open(page, teams.source);
  await clickNavigation(page, '团队动态');
  const history = page.locator('.team-collaboration-history');
  await expect(history.getByRole('alert')).toContainText('协作历史离线');
  await expect(history).not.toContainText('发起一次协作后');
  fail = false;
  await history.getByRole('button', { name: '重试', exact: true }).click();
  await expect(history.locator('article')).toHaveCount(8);
  await expect(history).toContainText('协作历史 8');
  await expect(history).toContainText('目标团队回传');
  await expect(history).not.toContainText('协作历史 0');
  await expect(history).not.toContainText('普通消息');
  await page.reload();
  await expect(history.locator('article')).toHaveCount(8);
  await expect(history).toContainText('协作历史 1');
  write((store) =>
    store.saveTeamMessage({
      spaceId: teams.source.id,
      kind: 'handoff',
      fromTeamId: teams.target.id,
      content: '最新协作记录',
    }),
  );
  await expect(history).toContainText('最新协作记录');
  await expect(history.locator('article')).toHaveCount(8);
  await expect(history).not.toContainText('协作历史 1');
});

test('首次状态不装载团队活动，进入动态后加载与失败状态明确，筛选可找到旧证据', async ({
  page,
}) => {
  const team = fixture();
  let count = 0;
  let fail = true;
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  await page.route(`**/api/spaces/${team.id}/timeline?*`, async (route) => {
    count++;
    if (fail) {
      await gate;
      return route.fulfill({ status: 503, json: { error: '时间线暂时离线' } });
    }
    return route.continue();
  });
  try {
    const state = await open(page, team);
    expect(state.teamActivityDeferred).toBe(true);
    expect(
      state.spaces.every(
        (space) => !('messages' in space) && !('timeline' in space),
      ),
    ).toBe(true);
    expect(state.tasks.find((task) => task.id === team.task.id).result).toBe(
      '完整旧任务回复仍可搜索',
    );
    expect(count).toBe(0);
    await clickNavigation(page, '团队动态');
    await expect(
      page.getByText('继续与当前团队协作', { exact: true }),
    ).toBeVisible();
    await expect(page.locator('.pm-flow')).toHaveText(
      '推进任务跟踪进展验收交付',
    );
    const timeline = panel(page);
    await expect(timeline.getByText('正在读取团队动态…')).toBeVisible();
    await expect(timeline).not.toContainText('还没有团队动态');
    release();
    await expect(timeline.getByRole('alert')).toContainText('时间线暂时离线');
    await expect(timeline).not.toContainText('还没有团队动态');
    fail = false;
    await timeline.getByRole('button', { name: '重试', exact: true }).click();
    await expect(
      timeline.getByText('分页回归消息 124', { exact: true }),
    ).toBeVisible();
    await expect(timeline).not.toContainText('超过首屏范围的旧证据');
    const evidence = timeline.getByRole('tab', { name: '证据', exact: true });
    expect((await evidence.boundingBox()).height).toBeGreaterThanOrEqual(44);
    await evidence.click();
    await expect(timeline).toContainText('超过首屏范围的旧证据');
    await expect(timeline).not.toContainText('分页回归消息');
    await timeline.getByRole('tab', { name: '风险', exact: true }).click();
    await expect(timeline).toContainText('旧任务失败原因');
    await expect(timeline).not.toContainText('超过首屏范围的旧证据');
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
    await timeline.scrollIntoViewIfNeeded();
    await page.screenshot({
      path: test.info().outputPath('lazy-team-timeline.png'),
    });
  } finally {
    release();
  }
});

test('更早动态失败重试原游标，刷新已展开历史可同步旧记录修改和删除', async ({
  page,
}) => {
  const team = fixture();
  await open(page, team);
  await clickNavigation(page, '团队动态');
  const timeline = panel(page);
  await timeline.getByRole('tab', { name: '消息', exact: true }).click();
  const older = timeline.getByRole('button', { name: '更早动态', exact: true });
  await expect(older).toBeEnabled();
  let failPage = true;
  let failedCursor;
  let retriedCursor;
  await page.route(`**/api/spaces/${team.id}/timeline?*`, (route) => {
    const cursor = new URL(route.request().url()).searchParams.get('before');
    if (cursor && failPage) {
      failedCursor = cursor;
      return route.fulfill({ status: 503, json: { error: '历史页连接中断' } });
    }
    if (cursor && failedCursor) retriedCursor = cursor;
    return route.continue();
  });
  await older.click();
  await expect(timeline.getByRole('alert')).toContainText('已加载内容仍保留');
  await expect(timeline).toContainText('分页回归消息 124');
  failPage = false;
  await timeline.getByRole('button', { name: '重试', exact: true }).click();
  await expect(
    timeline.getByText('分页回归消息 0', { exact: true }),
  ).toBeVisible();
  expect(retriedCursor).toBe(failedCursor);
  write((store) => {
    const messages = store.teamMessages(team.id);
    const changed = messages.find(
      (message) => message.content === '分页回归消息 0',
    );
    store.records.save(
      'space-messages',
      { ...changed, content: '旧页消息已修订' },
      changed.id,
    );
    const removed = messages.find(
      (message) => message.content === '分页回归消息 1',
    );
    store.records.remove('space-messages', removed.id);
  });
  await timeline.getByRole('button', { name: '刷新团队时间线' }).click();
  await expect(
    timeline.getByText('旧页消息已修订', { exact: true }),
  ).toBeVisible();
  await expect(
    timeline.getByText('分页回归消息 1', { exact: true }),
  ).toHaveCount(0);
  await expect(
    timeline.getByText('分页回归消息 124', { exact: true }),
  ).toBeVisible();
  await expect(
    timeline.getByRole('button', { name: '更早动态', exact: true }),
  ).toHaveCount(0);
  expect(await timeline.locator('.team-message').count()).toBe(124);
  await page.unroute(`**/api/spaces/${team.id}/timeline?*`);
  await page.route(`**/api/spaces/${team.id}/timeline?*`, (route) =>
    route.fulfill({ status: 503, json: { error: '刷新暂时失败' } }),
  );
  await timeline.getByRole('button', { name: '刷新团队时间线' }).click();
  await expect(timeline.getByRole('alert')).toContainText(
    '当前显示上次读取的动态',
  );
  await expect(timeline).toContainText('旧页消息已修订');
});

for (const status of [200, 503]) {
  test(`迟到的 ${status} 时间线响应不覆盖新筛选`, async ({ page }) => {
    const team = fixture();
    await open(page, team);
    await clickNavigation(page, '团队动态');
    const timeline = panel(page);
    await expect(timeline).toContainText('分页回归消息 124');
    let release;
    const gate = new Promise((resolve) => {
      release = resolve;
    });
    let held = false;
    let settled = false;
    await page.route(`**/api/spaces/${team.id}/timeline?*`, async (route) => {
      if (
        new URL(route.request().url()).searchParams.get('kind') !== 'messages'
      )
        return route.continue();
      const response = await route.fetch();
      held = true;
      await gate;
      try {
        await route.fulfill(
          status === 200
            ? { response }
            : { status, json: { error: '旧筛选请求失败' } },
        );
      } catch {
        /* Superseded requests abort. */
      } finally {
        settled = true;
      }
    });
    try {
      await timeline.getByRole('tab', { name: '消息', exact: true }).click();
      await expect.poll(() => held).toBe(true);
      await expect(timeline).not.toContainText('分页回归消息');
      await timeline.getByRole('tab', { name: '证据', exact: true }).click();
      await expect(timeline).toContainText('超过首屏范围的旧证据');
      release();
      await expect.poll(() => settled).toBe(true);
      await expect(timeline).not.toContainText('分页回归消息');
      await expect(timeline.getByRole('alert')).toHaveCount(0);
    } finally {
      release();
    }
  });
}

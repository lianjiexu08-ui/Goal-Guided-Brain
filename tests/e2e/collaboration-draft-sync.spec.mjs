import { expect, test } from '@playwright/test';
import { Store } from '../../server/store.mjs';
import { clickNavigation, dataDir } from './team-recruitment-fixtures.mjs';
const panel = (page) =>
  page.getByRole('region', { name: '团队协作控制台', exact: true });
const goal = (page) =>
  panel(page).getByRole('textbox', { name: '协作目标', exact: true });
const sync = (page) =>
  panel(page).getByRole('region', { name: '协作草稿同步', exact: true });
const withStore = (fn) => {
  const store = new Store(dataDir, process.cwd(), { seedProjectManager: true });
  try {
    return fn(store);
  } finally {
    store.close();
  }
};
function seed() {
  return withStore((store) => {
    const suffix = crypto.randomUUID().slice(0, 8);
    const nodeId = `draft-sync-${suffix}`;
    store.records.save(
      'nodes',
      { name: 'Draft sync offline', status: 'offline' },
      nodeId,
    );
    store.records.save(
      'providers',
      {
        name: 'Draft sync fixture',
        protocol: 'openai-compatible',
        enabled: false,
        priority: 999,
        baseUrl: 'http://127.0.0.1:1',
        models: [],
      },
      `draft-provider-${suffix}`,
    );
    const role = store.saveRole({
      ...store.role('project_manager'),
      id: undefined,
      name: `Draft manager ${suffix}`,
      nodeId,
    });
    const create = (name) =>
      store.saveTeamSpace({
        name: `${name} ${suffix}`,
        goal: '验证跨设备协作',
        workspace: process.cwd(),
        pmRoleId: role.id,
        memberRoleIds: [role.id],
        recruitment: {
          phase: 'confirmed',
          confirmedAt: new Date().toISOString(),
        },
        collaboration: { enabled: true, autoHandoff: true, allowedTeamIds: [] },
      });
    return { source: create('草稿来源'), target: create('草稿目标') };
  });
}
async function open(page, team) {
  await page.addInitScript((id) => {
    if (sessionStorage.getItem('draft-sync-opened')) return;
    sessionStorage.setItem('draft-sync-opened', '1');
    localStorage.setItem(
      'ggb.workspace-route.v1',
      JSON.stringify({
        spaceId: id,
        role: 'project_manager',
        view: 'workspace',
      }),
    );
  }, team.id);
  await page.goto('http://127.0.0.1:3288/');
  await expect(page.getByRole('heading', { name: team.name })).toBeVisible();
  await clickNavigation(page, '团队动态');
}
async function peer(browser, info) {
  const context = await browser.newContext({
    ...info.project.use,
    baseURL: 'http://127.0.0.1:3288',
  });
  return { context, page: await context.newPage() };
}
test.afterEach(() =>
  withStore((store) => {
    for (const job of store.records.list('jobs')) {
      if (
        !job.nodeId?.startsWith('draft-sync-') ||
        !['queued', 'running', 'waiting'].includes(job.status)
      )
        continue;
      store.updateTask(job.taskId, { status: 'cancelled' });
      store.records.save('jobs', { ...job, status: 'cancelled' }, job.id);
    }
  }),
);

test('协作草稿跨独立设备恢复，离线刷新保留，冲突选择后同步且不会自动派发', async ({
  page,
  browser,
}, info) => {
  const { source, target } = seed();
  const other = await peer(browser, info);
  try {
    let posts = 0;
    for (const p of [page, other.page])
      await p.route('**/collaborate', (route) => {
        posts++;
        return route.continue();
      });
    await open(page, source);
    await panel(page)
      .getByRole('combobox', { name: '选择协作目标团队' })
      .selectOption(target.id);
    await goal(page).fill('先检查发布前置条件');
    await expect(sync(page)).toContainText('草稿已同步');
    await open(other.page, source);
    await expect(goal(other.page)).toHaveValue('先检查发布前置条件');
    let offline = true;
    await other.page.route('**/collaboration-draft*', (route) =>
      offline ? route.abort('failed') : route.continue(),
    );
    await goal(other.page).fill('手机离线补充的部署要求');
    await expect(sync(other.page)).toContainText('暂未同步');
    await other.page.reload();
    await expect(goal(other.page)).toHaveValue('手机离线补充的部署要求');
    await goal(page).fill('桌面更新的发布目标');
    await expect(sync(page)).toContainText('草稿已同步');
    offline = false;
    await sync(other.page)
      .getByRole('button', { name: '重试同步草稿' })
      .click();
    const conflict = sync(other.page).getByRole('group', {
      name: '协作草稿版本冲突',
    });
    await expect(conflict).toBeVisible();
    await expect(
      conflict.getByRole('textbox', { name: '协作草稿本机版本' }),
    ).toHaveValue(/手机离线补充/);
    await expect(
      conflict.getByRole('textbox', { name: '协作草稿服务端版本' }),
    ).toHaveValue(/桌面更新/);
    expect(
      await other.page
        .locator('.team-page')
        .evaluate((e) => e.scrollWidth <= e.clientWidth + 1),
    ).toBe(true);
    await conflict.scrollIntoViewIfNeeded();
    await other.page.screenshot({
      path: info.outputPath('draft-conflict.png'),
    });
    await conflict.getByRole('button', { name: '保留本机版本' }).click();
    await expect(sync(other.page)).toContainText('草稿已同步');
    await expect(goal(page)).toHaveValue('手机离线补充的部署要求');
    expect(posts).toBe(0);
  } finally {
    await other.context.close();
  }
});

test('另一设备确认未送达请求，原设备重试同一请求且不重复创建任务', async ({
  page,
  browser,
}, info) => {
  const { source, target } = seed();
  const other = await peer(browser, info);
  try {
    const bodies = [];
    let first = true;
    await page.route('**/collaborate', (route) => {
      bodies.push(route.request().postDataJSON());
      if (first) {
        first = false;
        return route.abort('failed');
      }
      return route.continue();
    });
    await other.page.route('**/collaborate', (route) => {
      bodies.push(route.request().postDataJSON());
      return route.continue();
    });
    await open(page, source);
    await panel(page)
      .getByRole('combobox', { name: '选择协作目标团队' })
      .selectOption(target.id);
    await goal(page).fill('跨设备确认同一部署请求');
    await panel(page).getByRole('button', { name: '预览并发起协作' }).click();
    await panel(page).getByRole('button', { name: '确认并发起协作' }).click();
    await expect(
      panel(page).getByRole('button', { name: '重试确认送达' }),
    ).toBeVisible();
    await open(other.page, source);
    await expect(goal(other.page)).toHaveValue('跨设备确认同一部署请求');
    await expect(goal(other.page)).toBeDisabled();
    await panel(other.page)
      .getByRole('button', { name: '重试确认送达' })
      .click();
    await expect(panel(other.page)).toContainText('协作请求已发送给');
    await goal(other.page).fill('下一项协作的草稿');
    await expect(sync(other.page)).toContainText('草稿已同步');
    await page.reload();
    await panel(page).getByRole('button', { name: '重试确认送达' }).click();
    await expect(goal(page)).toHaveValue('下一项协作的草稿');
    expect(bodies).toHaveLength(3);
    expect(new Set(bodies.map((body) => body.clientMessageId)).size).toBe(1);
    const tasks = withStore((store) =>
      store.records
        .list('space-messages')
        .filter((m) => m.fromTeamId === source.id && m.kind === 'handoff'),
    );
    expect(tasks).toHaveLength(2);
    expect(new Set(tasks.map((m) => m.taskId)).size).toBe(1);
  } finally {
    await other.context.close();
  }
});

test('处理说明跨设备同步与冲突核对，实际收尾清空草稿且保留一次审计', async ({
  page,
  browser,
  request,
}, info) => {
  const { source, target } = seed();
  const response = await request.post(
    `http://127.0.0.1:3289/api/teams/${source.id}/collaborate`,
    {
      data: {
        targetTeamId: target.id,
        content: '草稿同步收尾测试',
        clientMessageId: crypto.randomUUID(),
      },
    },
  );
  expect(response.status()).toBe(201);
  const sent = await response.json();
  withStore((store) => {
    store.updateTask(sent.taskId, { status: 'cancelled' });
    const meta = store.records.get('task-meta', sent.taskId);
    const job = store.records.get('jobs', meta.jobId);
    store.records.save('jobs', { ...job, status: 'cancelled' }, job.id);
  });
  const other = await peer(browser, info);
  const review = (p) => panel(p).getByRole('region', { name: '协作收尾处理' });
  const note = (p) => review(p).getByRole('textbox', { name: '协作处理说明' });
  const status = (p) => review(p).getByRole('region', { name: '处理草稿同步' });
  try {
    await open(page, source);
    await panel(page)
      .getByRole('button', { name: '处理协作', exact: true })
      .click();
    await review(page)
      .getByRole('combobox', { name: '协作处理方式' })
      .selectOption('end');
    await note(page).fill('阶段目标调整');
    await expect(status(page)).toContainText('草稿已同步');
    await open(other.page, source);
    await panel(other.page)
      .getByRole('button', { name: '处理协作', exact: true })
      .click();
    await expect(note(other.page)).toHaveValue('阶段目标调整');
    let offline = true;
    await other.page.route('**/collaboration-draft?messageId=*', (route) =>
      offline ? route.abort('failed') : route.continue(),
    );
    await note(other.page).fill('手机处理意见');
    await expect(status(other.page)).toContainText('暂未同步');
    await note(page).fill('桌面确认取消本次发布');
    await expect(status(page)).toContainText('草稿已同步');
    offline = false;
    await status(other.page)
      .getByRole('button', { name: '重试同步草稿' })
      .click();
    await status(other.page)
      .getByRole('button', { name: '使用服务端版本' })
      .click();
    await expect(note(other.page)).toHaveValue('桌面确认取消本次发布');
    await review(other.page)
      .getByRole('button', { name: '结束跟进', exact: true })
      .click();
    await expect(panel(other.page)).toContainText(
      '已结束跟进（不代表验收通过）',
    );
    await expect(note(page)).toHaveValue('');
    const events = withStore((store) =>
      store.records
        .list('handoff-review-events')
        .filter((e) => e.messageId === sent.sourceMessageId),
    );
    expect(events).toHaveLength(1);
    expect(events[0].note).toBe('桌面确认取消本次发布');
  } finally {
    await other.context.close();
  }
});

test('同浏览器另一标签页确认回执并写入新草稿，不覆盖原页刷新后的待确认请求', async ({
  page,
  context,
}) => {
  const { source, target } = seed();
  const other = await context.newPage();
  try {
    let first = true;
    const ids = [];
    await page.route('**/collaborate', async (route) => {
      ids.push(route.request().postDataJSON().clientMessageId);
      const response = await route.fetch();
      if (first) {
        first = false;
        await route.abort('failed');
      } else await route.fulfill({ response });
    });
    await open(page, source);
    await panel(page)
      .getByRole('combobox', { name: '选择协作目标团队' })
      .selectOption(target.id);
    await goal(page).fill('原标签页的待确认请求');
    await panel(page).getByRole('button', { name: '预览并发起协作' }).click();
    await panel(page).getByRole('button', { name: '确认并发起协作' }).click();
    await expect(
      panel(page).getByRole('button', { name: '重试确认送达' }),
    ).toBeVisible();
    await open(other, source);
    await panel(other).getByRole('button', { name: '重试确认送达' }).click();
    await expect(goal(other)).toHaveValue('');
    await goal(other).fill('另一标签页的新草稿');
    await expect(sync(other)).toContainText('草稿已同步');
    await page.reload();
    await expect(goal(page)).toHaveValue('原标签页的待确认请求');
    await panel(page).getByRole('button', { name: '重试确认送达' }).click();
    await expect(goal(page)).toHaveValue('另一标签页的新草稿');
    expect(ids).toHaveLength(2);
    expect(ids[0]).toBe(ids[1]);
  } finally {
    await other.close();
  }
});

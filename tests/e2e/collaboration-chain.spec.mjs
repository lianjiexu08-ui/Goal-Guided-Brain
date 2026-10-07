import { expect, test } from '@playwright/test';
import { Store } from '../../server/store.mjs';
import { commitTeamHandoff } from '../../server/team-handoff-store.mjs';
import { clickNavigation, dataDir } from './team-recruitment-fixtures.mjs';

function withStore(fn) {
  const store = new Store(dataDir, process.cwd(), { seedProjectManager: true });
  try {
    return fn(store);
  } finally {
    store.close();
  }
}
function seed() {
  return withStore((store) => {
    const suffix = crypto.randomUUID();
    const nodeId = `chain-offline-${suffix}`;
    store.records.save(
      'nodes',
      { name: 'Chain browser fixture', status: 'offline' },
      nodeId,
    );
    const role = store.saveRole({
      ...store.role('project_manager'),
      id: undefined,
      name: `Chain PM ${suffix.slice(0, 8)}`,
      nodeId,
    });
    const makeTeam = (name) =>
      store.saveTeamSpace({
        name: `${name} ${suffix}`,
        goal: 'Chain inspection',
        workspace: process.cwd(),
        pmRoleId: role.id,
        memberRoleIds: [role.id],
        recruitment: {
          phase: 'confirmed',
          confirmedAt: new Date().toISOString(),
        },
        collaboration: { enabled: true, autoHandoff: true, allowedTeamIds: [] },
      });
    const source = makeTeam('链路来源');
    const target = makeTeam('链路目标');
    const rows = [];
    for (let index = 0; index < 24; index++) {
      const content =
        index === 23 ? '另一条独立协作' : `链路请求 ${index}：发布前检查`;
      const handoff = commitTeamHandoff({
        store,
        source,
        target,
        clientMessageId: `chain-${suffix}-${index}`,
        content,
        followupMessageId:
          index === 0 || index === 23
            ? null
            : rows[index === 2 ? 1 : 0].sourceMessageId,
        createTask: (message) => {
          const task = store.createTask({
            role: role.id,
            teamId: target.id,
            prompt: content,
            workspace: process.cwd(),
          });
          store.records.save(
            'task-meta',
            {
              teamId: target.id,
              spaceId: target.id,
              sourceMessageId: message.id,
              nodeId,
            },
            task.id,
          );
          return store.updateTask(task.id, {
            status: index === 21 ? 'failed' : 'completed',
            result: '未共享的内部任务输出',
          });
        },
      });
      const row = store.records.get('space-messages', handoff.sourceMessageId);
      store.db
        .prepare('UPDATE records SET createdAt=? WHERE collection=? AND id=?')
        .run(
          new Date(
            Date.UTC(2026, 0, index === 0 ? 30 : index + 1),
          ).toISOString(),
          'space-messages',
          row.id,
        );
      rows.push(handoff);
    }
    const root = rows[0];
    store.saveTeamMessage(
      {
        spaceId: source.id,
        kind: 'reply',
        fromTeamId: target.id,
        toTeamId: source.id,
        relatedMessageId: root.sourceMessageId,
        taskId: root.task.id,
        content: '共享回传：检查完成，附件证据待确认。',
        status: 'answered',
      },
      `handoff-reply:${root.task.id}`,
    );
    return { source, target, rows };
  });
}
const consolePanel = (page) =>
  page.getByRole('region', { name: '团队协作控制台', exact: true });
const chain = (page) =>
  page.getByRole('region', { name: '协作链路', exact: true });
const article = (page, content) =>
  consolePanel(page)
    .locator('article.team-collaboration-item')
    .filter({ has: page.locator('summary > span', { hasText: content }) })
    .first();
async function open(page, data) {
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
    data.source.id,
  );
  await page.goto('/');
  await expect(
    page.getByRole('heading', { name: data.source.name }),
  ).toBeVisible();
  await clickNavigation(page, '团队动态');
  await expect(article(page, '链路请求 0：')).toBeVisible();
}

test('协作链路从追问定位完整分支，执行验收分开显示并保留协作草稿', async ({
  page,
}) => {
  const data = seed();
  await open(page, data);
  const composer = consolePanel(page).getByRole('textbox', {
    name: '协作目标',
    exact: true,
  });
  await composer.fill('保留我的新协作草稿');
  const trigger = article(page, '链路请求 22：').getByRole('button', {
    name: '查看协作链路',
  });
  await trigger.click();
  await expect(chain(page).locator('li')).toHaveCount(23);
  await expect(
    chain(page).getByRole('heading', { name: '协作链路', exact: true }),
  ).toBeFocused();
  await expect(chain(page).locator('li[aria-current="step"]')).toContainText(
    '#23',
  );
  await chain(page).getByRole('button', { name: '定位当前请求' }).click();
  await expect(chain(page).locator('li[aria-current="step"]')).toBeFocused();
  await expect(chain(page)).toContainText('#3 接续 #2');
  await expect(chain(page).getByLabel('整条链路状态')).toContainText(
    '23 次请求',
  );
  await expect(chain(page).getByLabel('整条链路状态')).toContainText(
    '0 已验收',
  );
  await expect(chain(page)).not.toContainText('另一条独立协作');
  await chain(page).getByText('查看回传 #1', { exact: true }).click();
  await expect(chain(page)).toContainText('共享回传：检查完成');
  await expect(chain(page)).not.toContainText('未共享的内部任务输出');
  const overflow = await chain(page).evaluate(
    (element) => element.scrollWidth > element.clientWidth + 1,
  );
  expect(overflow).toBe(false);
  for (const name of ['刷新链路', '收起链路', '查看第 1 次任务']) {
    const box = await chain(page)
      .getByRole('button', { name, exact: true })
      .boundingBox();
    expect(box.height).toBeGreaterThanOrEqual(44);
  }
  await chain(page)
    .getByRole('heading', { name: '协作链路', exact: true })
    .scrollIntoViewIfNeeded();
  await page.screenshot({
    path: test.info().outputPath('collaboration-chain.png'),
  });
  await chain(page).getByRole('button', { name: '收起链路' }).click();
  await expect(trigger).toBeFocused();
  await expect(composer).toHaveValue('保留我的新协作草稿');
});

test('链路分页失败保留记录，重试原游标，刷新同步已展开历史的修改', async ({
  page,
}) => {
  const data = seed();
  let fail = true;
  const cursors = [];
  await page.route('**/collaboration-chain/**', async (route) => {
    const cursor = new URL(route.request().url()).searchParams.get('after');
    if (cursor) {
      cursors.push(cursor);
      if (fail)
        return route.fulfill({
          status: 503,
          contentType: 'application/json',
          body: JSON.stringify({ error: '分页暂时不可用' }),
        });
    }
    return route.continue();
  });
  await open(page, data);
  await article(page, '链路请求 0：')
    .getByRole('button', { name: '查看协作链路' })
    .click();
  await expect(chain(page).locator('li')).toHaveCount(20);
  await chain(page).getByRole('button', { name: '加载后续请求' }).click();
  await expect(chain(page).getByRole('alert')).toContainText('分页暂时不可用');
  await expect(chain(page).locator('li')).toHaveCount(20);
  fail = false;
  await chain(page).getByRole('button', { name: '重试读取链路' }).click();
  await expect(chain(page).locator('li')).toHaveCount(23);
  expect(cursors[0]).toBe(cursors[1]);
  withStore((store) => {
    const row = store.records.get(
      'space-messages',
      data.rows[22].sourceMessageId,
    );
    store.records.save(
      'space-messages',
      { ...row, content: '已经修改的最后一次请求' },
      row.id,
    );
  });
  await chain(page).getByRole('button', { name: '刷新链路' }).click();
  await expect(chain(page).locator('li')).toHaveCount(23);
  await expect(chain(page)).toContainText('已经修改的最后一次请求');
  await chain(page).getByRole('button', { name: '查看第 23 次任务' }).click();
  await expect(
    page.getByRole('heading', { name: data.target.name }),
  ).toBeVisible();
  await expect(
    page.locator(`[data-turn-id="${data.rows[22].task.id}"]`),
  ).toBeVisible();
});

test('链路首次失败可恢复，切换到另一条请求后迟到响应不覆盖当前链路', async ({
  page,
}) => {
  const data = seed();
  let failures = 1;
  let held = null;
  let hold = false;
  const rootPath = encodeURIComponent(data.rows[0].sourceMessageId);
  await page.route('**/collaboration-chain/**', async (route) => {
    if (failures) {
      failures--;
      return route.fulfill({
        status: 503,
        contentType: 'application/json',
        body: JSON.stringify({ error: '首次读取失败' }),
      });
    }
    if (hold && route.request().url().includes(rootPath)) {
      held = route;
      return;
    }
    return route.continue();
  });
  await open(page, data);
  await article(page, '链路请求 0：')
    .getByRole('button', { name: '查看协作链路' })
    .click();
  await expect(chain(page).getByRole('alert')).toContainText('首次读取失败');
  await expect(chain(page).locator('li')).toHaveCount(0);
  await chain(page).getByRole('button', { name: '重试读取链路' }).click();
  await expect(chain(page).locator('li')).toHaveCount(20);
  hold = true;
  await chain(page).getByRole('button', { name: '刷新链路' }).click();
  await expect.poll(() => Boolean(held)).toBe(true);
  await article(page, '另一条独立协作')
    .getByRole('button', { name: '查看协作链路' })
    .click();
  await expect(chain(page).locator('li')).toHaveCount(1);
  await expect(chain(page)).toContainText('另一条独立协作');
  await held.continue().catch(() => {});
  await expect(chain(page)).not.toContainText('链路请求 0：');
  await expect(chain(page).locator('li')).toHaveCount(1);
});

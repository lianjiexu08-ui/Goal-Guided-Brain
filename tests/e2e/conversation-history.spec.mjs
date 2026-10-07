import { expect, test } from '@playwright/test';
import { Store } from '../../server/store.mjs';
import {
  dataDir,
  seedConversationScrollTeam,
} from './conversation-scroll-fixtures.mjs';

function withStore(callback) {
  const store = new Store(dataDir, process.cwd(), { seedProjectManager: true });
  try {
    return callback(store);
  } finally {
    store.close();
  }
}

async function open(page, id, role = 'project_manager') {
  await page.addInitScript(
    ({ id, role }) =>
      localStorage.setItem(
        'ggb.workspace-route.v1',
        JSON.stringify({ spaceId: id, role, view: 'workspace' }),
      ),
    { id, role },
  );
  await page.goto('/');
  await expect(page.getByTestId('message-area')).toBeVisible();
}

async function scrollTop(area) {
  await area.evaluate((el) => {
    el.scrollTop = 0;
    el.dispatchEvent(new Event('scroll'));
  });
}

test('长对话按轮展开，补载与上方内容更新保持阅读位置，回到最新收起历史', async ({
  page,
}) => {
  const team = seedConversationScrollTeam({ count: 95 });
  if (test.info().project.name === 'mobile')
    await page.setViewportSize({ width: 320, height: 851 });
  await open(page, team.id);
  const area = page.getByTestId('message-area');
  const turns = area.locator('.turn');
  await expect(turns).toHaveCount(30);
  await expect(area).toContainText('已显示 30 / 95 轮对话');
  await expect
    .poll(() => area.evaluate((el) => el.clientHeight))
    .toBeGreaterThan(180);
  await expect
    .poll(() =>
      page.locator('.conversation-top h1').evaluate((el) => {
        const title = el
          .querySelector('.conversation-title-text')
          .getBoundingClientRect();
        const badge = el.querySelector('.quiet-badge').getBoundingClientRect();
        return Math.abs(
          title.top + title.height / 2 - badge.top - badge.height / 2,
        );
      }),
    )
    .toBeLessThan(2);
  const composer = page.locator('textarea[aria-label^="发送给"]');
  await composer.fill('展开历史时保留当前需求草稿');
  await scrollTop(area);
  const earlier = page.getByRole('button', { name: /加载更早对话/ });
  expect((await earlier.boundingBox()).height).toBeGreaterThanOrEqual(44);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await earlier.scrollIntoViewIfNeeded();
  const anchorId = await turns.first().getAttribute('data-turn-id');
  const anchor = area.locator(`[data-turn-id="${anchorId}"]`);
  const offset = () =>
    anchor.evaluate(
      (el) =>
        el.getBoundingClientRect().top -
        el.closest('.message-area').getBoundingClientRect().top,
    );
  const before = await offset();
  await earlier.click();
  await expect(turns).toHaveCount(60);
  await expect
    .poll(async () => Math.abs((await offset()) - before))
    .toBeLessThan(3);

  const firstLoadedId = await turns.first().getAttribute('data-turn-id');
  const updated = '较早回复补充了很长的验证证据。';
  withStore((store) =>
    store.updateTask(firstLoadedId, {
      result: Array.from(
        { length: 35 },
        (_, i) => `段落 ${i}：${updated}`,
      ).join('\n\n'),
    }),
  );
  await expect(
    area.locator(`[data-turn-id="${firstLoadedId}"] .prose-result`),
  ).toContainText(updated);
  await expect
    .poll(async () => Math.abs((await offset()) - before))
    .toBeLessThan(3);
  await expect(composer).toHaveValue('展开历史时保留当前需求草稿');

  for (const count of [90, 95]) {
    await scrollTop(area);
    await earlier.click();
    await expect(turns).toHaveCount(count);
  }
  expect(
    await turns.evaluateAll(
      (nodes) => new Set(nodes.map((node) => node.dataset.turnId)).size,
    ),
  ).toBe(95);
  await expect(area.locator(`[data-turn-id="${team.taskIds[0]}"]`)).toHaveCount(
    1,
  );
  await scrollTop(area);
  await expect(area.getByText('已到最早的对话')).toBeVisible();
  await page.screenshot({
    path: test.info().outputPath('expanded-history.png'),
  });
  await page.getByRole('button', { name: '回到最新消息', exact: true }).click();
  await expect(turns).toHaveCount(30);
  await expect
    .poll(() =>
      area.evaluate((el) => el.scrollHeight - el.scrollTop - el.clientHeight),
    )
    .toBeLessThanOrEqual(80);
  const next = withStore((store) => {
    const task = store.createTask({
      role: 'project_manager',
      prompt: '历史展开后收到的新任务',
    });
    store.records.save(
      'task-meta',
      { teamId: team.id, spaceId: team.id },
      task.id,
    );
    store.updateTask(task.id, {
      status: 'completed',
      result: '继续跟随最新交付。',
    });
    return task;
  });
  await expect(area.locator(`[data-turn-id="${next.id}"]`)).toBeVisible();
  await expect(turns).toHaveCount(30);
  await expect
    .poll(() =>
      area.evaluate((el) => el.scrollHeight - el.scrollTop - el.clientHeight),
    )
    .toBeLessThanOrEqual(80);
});

test('切换成员会话重置历史窗口并定位到新会话末尾，草稿继续保留', async ({
  page,
}) => {
  const fixture = withStore((store) => {
    const team = store.saveTeamSpace({
      name: `成员历史 ${Date.now()}`,
      goal: '验证成员会话的独立历史窗口',
      pmRoleId: 'project_manager',
      memberRoleIds: ['project_manager', 'developer'],
      recruitment: { phase: 'confirmed' },
    });
    const sessions = ['甲', '乙'].map((label) => {
      let sessionId;
      const title = `${team.name} ${label}会话`;
      for (let i = 0; i < 35; i++) {
        const task = store.createTask({
          role: 'developer',
          prompt: i ? `${label}会话的任务 ${i}` : title,
          sessionId,
          teamId: team.id,
        });
        sessionId = task.sessionId;
        store.records.save(
          'task-meta',
          { teamId: team.id, spaceId: team.id },
          task.id,
        );
        store.updateTask(task.id, {
          status: 'completed',
          result: `${label}会话交付 ${i}`,
        });
      }
      return { title, sessionId };
    });
    return { team, sessions };
  });
  await open(page, fixture.team.id, 'developer');
  const select = async (session) => {
    await page.getByRole('combobox', { name: '选择会话', exact: true }).click();
    await page
      .getByRole('option', { name: session.title, exact: true })
      .click();
  };
  await select(fixture.sessions[0]);
  const area = page.getByTestId('message-area');
  await expect(area.locator('.turn')).toHaveCount(30);
  await scrollTop(area);
  await page.getByRole('button', { name: /加载更早对话/ }).click();
  await expect(area.locator('.turn')).toHaveCount(35);
  const composer = page.locator('textarea[aria-label^="发送给"]');
  await composer.fill('同一助手尚未发出的想法');
  await select(fixture.sessions[1]);
  await expect(area.locator('.turn')).toHaveCount(30);
  await expect(area).not.toContainText('甲会话交付');
  await expect(area).toContainText('乙会话交付 34');
  await expect
    .poll(() =>
      area.evaluate((el) => el.scrollHeight - el.scrollTop - el.clientHeight),
    )
    .toBeLessThanOrEqual(80);
  await expect(composer).toHaveValue('同一助手尚未发出的想法');
});

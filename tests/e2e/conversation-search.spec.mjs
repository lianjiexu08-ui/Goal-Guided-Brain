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

async function openTeam(page, id, role = 'project_manager') {
  await page.addInitScript(
    ({ id, role }) => {
      if (!localStorage.getItem('ggb.workspace-route.v1'))
        localStorage.setItem(
          'ggb.workspace-route.v1',
          JSON.stringify({ spaceId: id, role, view: 'workspace' }),
        );
    },
    { id, role },
  );
  await page.goto('/');
  await expect(page.getByTestId('message-area')).toBeVisible();
}

async function search(page, query) {
  await page.getByRole('button', { name: '搜索当前对话', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '搜索当前对话' });
  await expect(dialog).toBeVisible();
  await expect(
    dialog.getByRole('textbox', { name: '对话搜索关键词' }),
  ).toBeFocused();
  await dialog.getByRole('textbox', { name: '对话搜索关键词' }).fill(query);
  return dialog;
}

test('搜索未展开的历史与回复，逐页查看全部结果，定位原文且保留草稿', async ({
  page,
}) => {
  const team = seedConversationScrollTeam({ count: 65 });
  withStore((store) => {
    store.updateTask(team.taskIds[2], {
      result: '排查记录：ReleaseGate [v2] 的验证证据已就绪。',
    });
    store.updateTask(team.taskIds[4], {
      result: '文本样例：<script>window.untrustedSearch = true</script>',
    });
  });
  if (test.info().project.name === 'mobile')
    await page.setViewportSize({ width: 320, height: 851 });
  await openTeam(page, team.id);
  const area = page.getByTestId('message-area');
  await expect(area.locator('.turn')).toHaveCount(30);
  const composer = page.locator('textarea[aria-label^="发送给"]');
  await composer.fill('搜索历史时保留的需求草稿');
  const trigger = page.getByRole('button', {
    name: '搜索当前对话',
    exact: true,
  });
  expect((await trigger.boundingBox()).height).toBeGreaterThanOrEqual(44);
  const dialog = await search(page, '历史对话任务');
  await expect(dialog.getByRole('status')).toContainText('找到 65 轮对话');
  const results = dialog.locator('.conversation-search-result');
  await expect(results).toHaveCount(20);
  await expect(results.first()).toContainText('历史对话任务 64');
  for (const count of [40, 60, 65]) {
    await dialog.getByRole('button', { name: /显示更多结果/ }).click();
    await expect(results).toHaveCount(count);
  }
  await expect(results.last()).toContainText('历史对话任务 0');
  const input = dialog.getByRole('textbox', { name: '对话搜索关键词' });
  await input.fill('  releasegate [V2]  ');
  await expect(results).toHaveCount(1);
  await expect(results.first()).toContainText('助手回复');
  await expect(results.first().locator('mark')).toHaveText('ReleaseGate [v2]');
  expect(await dialog.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(
    true,
  );
  const bounds = await dialog.boundingBox();
  const viewport = page.viewportSize();
  expect(bounds.x).toBeGreaterThanOrEqual(0);
  expect(bounds.y).toBeGreaterThanOrEqual(0);
  expect(bounds.x + bounds.width).toBeLessThanOrEqual(viewport.width);
  expect(bounds.y + bounds.height).toBeLessThanOrEqual(viewport.height);
  await page.screenshot({
    path: test.info().outputPath('conversation-search.png'),
  });
  if (test.info().project.name === 'mobile') {
    // A reduced viewport represents the space left while a software keyboard
    // is open; real device keyboard behavior remains a separate release gate.
    await page.setViewportSize({ width: 320, height: 480 });
    const close = dialog.getByRole('button', { name: '关闭对话搜索' });
    await expect
      .poll(() =>
        close.evaluate((el) => {
          const rect = el.getBoundingClientRect();
          return el.contains(
            document.elementFromPoint(
              rect.x + rect.width / 2,
              rect.y + rect.height / 2,
            ),
          );
        }),
      )
      .toBe(true);
    await expect
      .poll(() => dialog.evaluate((el) => el.getBoundingClientRect().bottom))
      .toBeLessThanOrEqual(480);
    await expect(input).toBeInViewport();
    await results.first().scrollIntoViewIfNeeded();
    await expect(results.first()).toBeInViewport();
    await page.setViewportSize({ width: 320, height: 851 });
  }
  await results.first().click();
  await expect(dialog).not.toBeVisible();
  const target = area.locator(`[data-turn-id="${team.taskIds[2]}"]`);
  await expect(target).toBeFocused();
  await expect(target).toHaveAttribute('data-search-target', '');
  await expect
    .poll(() =>
      target.evaluate((el) =>
        Math.abs(
          el.getBoundingClientRect().top -
            el.closest('.message-area').getBoundingClientRect().top -
            12,
        ),
      ),
    )
    .toBeLessThan(3);
  await expect(composer).toHaveValue('搜索历史时保留的需求草稿');
  await expect(
    page.getByRole('button', { name: '回到最新消息', exact: true }),
  ).toBeVisible();
  // Polling updates above the selected turn must not dislodge the result.
  withStore((store) =>
    store.updateTask(team.taskIds[2], {
      result: 'ReleaseGate [v2]：原文已由后台更新。',
    }),
  );
  await expect(target).toContainText('原文已由后台更新');
  await expect
    .poll(() =>
      target.evaluate((el) =>
        Math.abs(
          el.getBoundingClientRect().top -
            el.closest('.message-area').getBoundingClientRect().top -
            12,
        ),
      ),
    )
    .toBeLessThan(3);
  await page.getByRole('button', { name: '回到最新消息', exact: true }).click();
  await expect(area.locator('.turn')).toHaveCount(30);
  await expect(area.locator('[data-search-target]')).toHaveCount(0);
  await search(page, '<script>');
  await expect(results).toHaveCount(1);
  await expect(results.first()).toContainText('<script>');
  expect(await page.evaluate(() => window.untrustedSearch)).toBeUndefined();
  await input.fill('后台新增的可检索回复');
  await expect(results).toHaveCount(0);
  withStore((store) =>
    store.updateTask(team.taskIds[6], { result: '后台新增的可检索回复' }),
  );
  await expect(results).toHaveCount(1);
  await expect(results.first()).toContainText('后台新增的可检索回复');
  await input.fill('完全不存在的需求');
  await expect(results).toHaveCount(0);
  await expect(dialog).toContainText('没有找到匹配的对话');
  await dialog.getByRole('button', { name: '清空对话搜索' }).click();
  await expect(input).toHaveValue('');
  await expect(input).toBeFocused();
  await expect(dialog.getByRole('status')).toContainText('当前共 65 轮对话');
  if (test.info().project.name === 'mobile') {
    const url = page.url();
    await page.goBack();
    expect(page.url()).toBe(url);
  } else await page.keyboard.press('Escape');
  await expect(dialog).not.toBeVisible();
  await expect(trigger).toBeFocused();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
});

test('搜索范围随团队和成员会话切换，不带入上一个会话的关键词与结果', async ({
  page,
}) => {
  const teamA = seedConversationScrollTeam({ count: 2 });
  const fixture = withStore((store) => {
    store.updateTask(teamA.taskIds[0], { result: '甲团队独有交付证据' });
    const teamB = store.saveTeamSpace({
      name: `搜索隔离 ${Date.now()}`,
      goal: '验证搜索边界',
      pmRoleId: 'project_manager',
      memberRoleIds: ['project_manager', 'developer'],
      recruitment: { phase: 'confirmed' },
    });
    const sessions = ['甲', '乙'].map((label) => {
      const task = store.createTask({
        role: 'developer',
        prompt: `${label}成员独立需求`,
        teamId: teamB.id,
      });
      store.records.save(
        'task-meta',
        { teamId: teamB.id, spaceId: teamB.id },
        task.id,
      );
      store.updateTask(task.id, {
        status: 'completed',
        result: `${label}成员独有内容`,
      });
      return { task, label };
    });
    return { teamB, sessions };
  });
  await openTeam(page, teamA.id);
  let dialog = await search(page, '甲团队独有');
  await expect(dialog.locator('.conversation-search-result')).toHaveCount(1);
  await dialog.getByRole('button', { name: '关闭对话搜索' }).click();
  await page.getByRole('combobox', { name: '选择团队', exact: true }).click();
  await page
    .getByRole('option', { name: fixture.teamB.name, exact: true })
    .click();
  await expect(
    page.getByRole('button', { name: '搜索当前对话', exact: true }),
  ).toBeDisabled();
  // Open the member view through the same persisted route used on reload.
  await page.evaluate(
    (id) =>
      localStorage.setItem(
        'ggb.workspace-route.v1',
        JSON.stringify({ spaceId: id, role: 'developer', view: 'workspace' }),
      ),
    fixture.teamB.id,
  );
  await page.reload();
  const choose = async (session) => {
    await page.getByRole('combobox', { name: '选择会话', exact: true }).click();
    await page
      .getByRole('option', {
        name: `${session.label}成员独立需求`,
        exact: true,
      })
      .click();
  };
  await choose(fixture.sessions[0]);
  dialog = await search(page, '甲成员独有');
  await expect(dialog.locator('.conversation-search-result')).toHaveCount(1);
  await dialog.getByRole('button', { name: '关闭对话搜索' }).click();
  await choose(fixture.sessions[1]);
  await page.getByRole('button', { name: '搜索当前对话', exact: true }).click();
  await expect(
    dialog.getByRole('textbox', { name: '对话搜索关键词' }),
  ).toHaveValue('');
  await dialog
    .getByRole('textbox', { name: '对话搜索关键词' })
    .fill('甲成员独有');
  await expect(dialog.locator('.conversation-search-result')).toHaveCount(0);
  await dialog
    .getByRole('textbox', { name: '对话搜索关键词' })
    .fill('乙成员独有');
  await expect(dialog.locator('.conversation-search-result')).toHaveCount(1);
});

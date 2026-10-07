import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { Store } from '../../server/store.mjs';
import { seedConversationScrollTeam } from './conversation-scroll-fixtures.mjs';

function withStore(callback) {
  const store = new Store(process.env.GGB_E2E_DATA_DIR, process.cwd(), {
    seedProjectManager: true,
  });
  try {
    return callback(store);
  } finally {
    store.close();
  }
}

async function openTeam(page, id, role = 'project_manager') {
  await page.addInitScript(
    ({ id, role }) => {
      // Only initialize once; later reloads must use the app's persisted route.
      if (!sessionStorage.getItem('context-fixture')) {
        localStorage.setItem(
          'ggb.workspace-route.v1',
          JSON.stringify({ spaceId: id, role, view: 'workspace' }),
        );
        sessionStorage.setItem('context-fixture', 'true');
      }
    },
    { id, role },
  );
  await page.goto('/');
}

function seedDirectories() {
  return withStore((store) => {
    const suffix = randomUUID().slice(0, 8);
    const teams = ['alpha', 'beta'].map((name) =>
      store.saveTeamSpace({
        name: `${name} 目录团队 ${suffix}`,
        goal: '验证团队上下文',
        workspace: path.join(process.env.GGB_E2E_DATA_DIR, `${name}-${suffix}`),
        pmRoleId: 'project_manager',
        memberRoleIds: ['project_manager', 'developer'],
        recruitment: { phase: 'confirmed' },
      }),
    );
    return teams;
  });
}

test('团队目录随团队切换和刷新恢复，目录入口打开对应团队设置', async ({
  page,
}) => {
  const [alpha, beta] = seedDirectories();
  await openTeam(page, alpha.id);
  const directory = page.locator('.workspace-path');
  await expect(directory).toContainText(path.basename(alpha.workspace));
  await expect(directory).toHaveAttribute('title', new RegExp(alpha.workspace));
  await directory.click();
  const dialog = page.getByRole('dialog');
  await expect(dialog.getByLabel('团队名称', { exact: true })).toHaveValue(
    alpha.name,
  );
  await expect(dialog.getByLabel('工作目录', { exact: true })).toHaveValue(
    alpha.workspace,
  );
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
  await page.getByRole('combobox', { name: '选择团队', exact: true }).click();
  await page.getByRole('option', { name: beta.name, exact: true }).click();
  await expect(directory).toContainText(path.basename(beta.workspace));
  await page.reload();
  await expect(directory).toContainText(path.basename(beta.workspace));
  await directory.click();
  await expect(dialog.getByLabel('工作目录', { exact: true })).toHaveValue(
    beta.workspace,
  );
});

test('成员的新会话使用团队目录，选择历史会话时显示原目录', async ({ page }) => {
  const [alpha, beta] = seedDirectories();
  withStore((store) => {
    const task = store.createTask({
      role: 'developer',
      prompt: '历史成员会话',
      workspace: alpha.workspace,
    });
    store.records.save(
      'task-meta',
      { spaceId: alpha.id, teamId: alpha.id },
      task.id,
    );
    store.updateTask(task.id, {
      status: 'completed',
      result: '旧目录中的交付',
    });
    store.saveTeamSpace({ ...alpha, workspace: beta.workspace }, alpha.id);
  });
  await openTeam(page, alpha.id, 'developer');
  const directory = page.locator('.workspace-path');
  await expect(directory).toContainText(path.basename(beta.workspace));
  await page.getByRole('combobox', { name: '选择会话', exact: true }).click();
  await page.getByRole('option', { name: '历史成员会话', exact: true }).click();
  await expect(directory).toContainText(path.basename(alpha.workspace));
  await page.getByRole('button', { name: '新会话', exact: true }).click();
  await expect(directory).toContainText(path.basename(beta.workspace));
  await page.reload();
  await expect(directory).toContainText(path.basename(beta.workspace));
});

test('已有招募对话收起说明并保留阅读区域，展开和实时更新不打断阅读', async ({
  page,
}) => {
  const team = seedConversationScrollTeam();
  withStore((store) => {
    const current = store.teamSpace(team.id);
    store.saveTeamSpace(
      {
        ...current,
        recruitment: {
          ...current.recruitment,
          phase: 'discovery',
          confirmedAt: null,
        },
      },
      team.id,
    );
  });
  const mobile = test.info().project.name === 'mobile';
  await page.setViewportSize(
    mobile ? { width: 393, height: 851 } : { width: 1280, height: 720 },
  );
  await openTeam(page, team.id);
  const area = page.getByTestId('message-area');
  const toggle = page.getByRole('button', {
    name: '需求草稿 · 正在澄清 查看说明',
  });
  await expect(toggle).toHaveAttribute('aria-expanded', 'false');
  await expect(page.getByTestId('recruitment-status-card')).toBeHidden();
  await expect(page.locator('.recruitment-next-step')).toContainText('下一步');
  await expect
    .poll(async () => (await area.boundingBox()).height)
    .toBeGreaterThan(180);
  await expect
    .poll(() =>
      area.evaluate(
        (element) =>
          element.scrollHeight - element.scrollTop - element.clientHeight,
      ),
    )
    .toBeLessThanOrEqual(40);
  await area.evaluate((element) => {
    element.scrollTop = 120;
    element.dispatchEvent(new Event('scroll'));
  });
  await expect(
    page.getByRole('button', { name: '回到最新消息' }),
  ).toBeVisible();
  await toggle.click();
  await expect(page.getByTestId('recruitment-status-card')).toBeVisible();
  await expect(page.getByTestId('recruitment-status-card')).toContainText(
    team.name,
  );
  await page
    .getByRole('button', { name: '需求草稿 · 正在澄清 收起说明' })
    .click();
  await expect
    .poll(() => area.evaluate((element) => element.scrollTop))
    .toBe(120);
  withStore((store) =>
    store.updateTask(team.latestTaskId, {
      result: '新结果已同步，不打断正在阅读的旧消息。',
    }),
  );
  await expect(
    page.getByText('新结果已同步，不打断正在阅读的旧消息。'),
  ).toHaveCount(1);
  await expect
    .poll(() => area.evaluate((element) => element.scrollTop))
    .toBe(120);
  await page.screenshot({
    path: test.info().outputPath('compact-recruitment.png'),
  });
  await page.getByRole('button', { name: '回到最新消息' }).click();
  await expect
    .poll(() =>
      area.evaluate(
        (element) =>
          element.scrollHeight - element.scrollTop - element.clientHeight,
      ),
    )
    .toBeLessThanOrEqual(80);
  await page.reload();
  await expect(toggle).toHaveAttribute('aria-expanded', 'false');
});

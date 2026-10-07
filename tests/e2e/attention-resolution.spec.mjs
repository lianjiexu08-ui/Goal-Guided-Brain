import { randomUUID } from 'node:crypto';
import { expect, test } from '@playwright/test';
import { Store } from '../../server/store.mjs';
import { clickNavigation } from './team-recruitment-helpers.mjs';

function seedDecision() {
  const store = new Store(process.env.GGB_E2E_DATA_DIR, process.cwd(), {
    seedProjectManager: true,
  });
  try {
    const id = randomUUID();
    const title = `确认发布安排 ${id.slice(0, 8)}`;
    const team = store.saveTeamSpace({
      name: `决策闭环团队 ${id.slice(0, 8)}`,
      goal: '验证处理决定可持久化。',
      workspace: process.cwd(),
      memberRoleIds: ['project_manager'],
      pmRoleId: 'project_manager',
      recruitment: {
        phase: 'confirmed',
        confirmedAt: new Date().toISOString(),
      },
    });
    store.records.save(
      'attention',
      {
        kind: 'decision',
        status: 'open',
        title,
        detail: '请确认本次发布的时间安排。',
        teamId: team.id,
        spaceId: team.id,
      },
      id,
    );
    store.records.save(
      'notifications',
      {
        name: title,
        attentionId: id,
        message: '请确认发布安排',
        read: false,
        spaceId: team.id,
      },
      `attention:${id}`,
    );
    return { id, title, teamId: team.id };
  } finally {
    store.close();
  }
}

test('处理团队事项后风险消失、通知已读且刷新保留处理结果', async ({ page }) => {
  const fixture = seedDecision();
  await page.goto('/');
  await clickNavigation(page, '需要你处理');
  const risk = page.getByRole('region', { name: '跨团队风险', exact: true });
  await risk
    .getByRole('combobox', { name: '风险团队', exact: true })
    .selectOption(fixture.teamId);
  await expect(
    risk.getByRole('button', {
      name: `打开风险 ${fixture.title}`,
      exact: true,
    }),
  ).toBeVisible();
  await page.getByRole('tab', { name: '待处理事项', exact: true }).click();
  const row = page.locator('.manage-row').filter({ hasText: fixture.title });
  await row.getByRole('button', { name: fixture.title, exact: true }).click();
  const dialog = page.getByRole('dialog', { name: fixture.title, exact: true });
  await dialog
    .getByRole('textbox', { name: '处理结果', exact: true })
    .fill('已与负责人确认，明早九点再发布。');
  await dialog
    .getByRole('button', { name: '提交处理结果', exact: true })
    .click();
  await expect(dialog).toBeHidden();
  await expect(row).toContainText('已处理');
  await expect(
    risk.getByRole('button', {
      name: `打开风险 ${fixture.title}`,
      exact: true,
    }),
  ).toHaveCount(0);
  await expect(risk).toContainText('0 项待处理');
  await page.getByRole('tab', { name: '通知', exact: true }).click();
  const notification = page
    .locator('.manage-row')
    .filter({ hasText: fixture.title });
  await expect(notification).toContainText('已读');
  await expect(
    notification.getByRole('button', { name: '标记已读', exact: true }),
  ).toHaveCount(0);
  await page.reload();
  await page.getByRole('tab', { name: '待处理事项', exact: true }).click();
  await page
    .locator('.manage-row')
    .filter({ hasText: fixture.title })
    .getByRole('button', { name: fixture.title, exact: true })
    .click();
  await expect(dialog.getByLabel('事项处理记录')).toContainText(
    '已与负责人确认，明早九点再发布。',
  );
  await expect(
    dialog.getByRole('button', { name: '提交处理结果', exact: true }),
  ).toHaveCount(0);
});

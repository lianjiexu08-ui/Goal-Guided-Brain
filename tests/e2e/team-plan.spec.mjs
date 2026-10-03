import { expect, test } from '@playwright/test';
import {
  clickNavigation,
  openMobileSidebar,
  seedConfirmedTeams,
  sidebarLocator,
} from './team-recruitment-fixtures.mjs';

test.describe('团队目标计划回归', () => {
  test('团队动态可以维护目标和里程碑计划', async ({ page }) => {
    const teams = seedConfirmedTeams();
    await page.goto('/');
    await openMobileSidebar(page);
    await sidebarLocator(page)
      .locator('button')
      .filter({ hasText: teams.development.name })
      .first()
      .click({ force: true });
    await clickNavigation(page, '团队动态');
    const plan = page.getByRole('region', { name: '团队目标与里程碑' });
    await expect(plan).toBeVisible();

    await plan.getByRole('button', { name: '编辑团队目标' }).click();
    await plan
      .getByRole('textbox', { name: '团队目标' })
      .fill('把运维目标拆成可验收的阶段。');
    await plan.getByRole('button', { name: '保存目标', exact: true }).click();
    await expect(plan).toContainText('把运维目标拆成可验收的阶段。');

    await plan.getByRole('button', { name: '添加里程碑', exact: true }).click();
    await plan.getByPlaceholder('里程碑标题').fill('完成健康检查和回滚演练');
    await plan
      .getByPlaceholder('验收说明（可选）')
      .fill('保存检查报告和回滚记录。');
    await plan.getByRole('button', { name: '保存', exact: true }).click();
    await expect(plan).toContainText('完成健康检查和回滚演练');
    await plan
      .getByRole('button', { name: '完成健康检查和回滚演练：未开始' })
      .click();
    await expect(plan).toContainText('100%');

    const saved = await page.evaluate(
      async (id) => ({
        team: await fetch(`/api/teams/${id}`).then((response) =>
          response.json(),
        ),
        plan: await fetch(`/api/teams/${id}/plan`).then((response) =>
          response.json(),
        ),
      }),
      teams.development.id,
    );
    expect(saved.team.goal).toBe('把运维目标拆成可验收的阶段。');
    expect(saved.plan.milestones[0].status).toBe('completed');
  });
});

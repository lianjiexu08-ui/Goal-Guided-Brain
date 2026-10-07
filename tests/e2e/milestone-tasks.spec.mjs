import { randomUUID } from 'node:crypto';
import { expect, test } from '@playwright/test';
import { Store } from '../../server/store.mjs';
import {
  clickNavigation,
  openMobileSidebar,
  sidebarLocator,
} from './team-recruitment-helpers.mjs';

function seed() {
  const store = new Store(process.env.GGB_E2E_DATA_DIR, process.cwd(), {
    seedProjectManager: true,
  });
  try {
    const team = (name) =>
      store.saveTeamSpace({
        name: `${name} ${randomUUID().slice(0, 8)}`,
        goal: '验证里程碑交付关联',
        workspace: process.cwd(),
        pmRoleId: 'project_manager',
        memberRoleIds: ['project_manager', 'developer'],
        recruitment: { phase: 'confirmed' },
      });
    const teams = {
      development: team('里程碑研发团队'),
      operations: team('里程碑运维团队'),
    };
    const create = (spaceId, title, accepted) => {
      const task = store.createTask({
        role: 'developer',
        prompt: title,
        workspace: process.cwd(),
      });
      store.records.save(
        'task-meta',
        { spaceId, requirementVersion: 1 },
        task.id,
      );
      store.updateTask(task.id, {
        status: 'completed',
        title,
        result: '本地确定性测试已完成。',
      });
      const verification = store.records.save('artifacts', {
        taskId: task.id,
        kind: 'verification',
        name: 'npm test',
        status: 'verified',
        verified: true,
        requirementVersion: 1,
        output: 'tests passed',
      });
      if (accepted)
        store.records.save(
          'task-acceptance',
          {
            taskId: task.id,
            decision: 'accepted',
            status: 'active',
            requirementVersion: 1,
            verificationId: verification.id,
            decidedBy: 'owner',
            note: '已复核交付',
            decidedAt: new Date().toISOString(),
          },
          task.id,
        );
      return { id: task.id, title };
    };
    const suffix = randomUUID().slice(0, 8);
    const accepted = create(teams.development.id, `实现接口 ${suffix}`, true);
    const pending = create(teams.development.id, `验证回滚 ${suffix}`, false);
    const foreign = create(teams.operations.id, `外部团队任务 ${suffix}`, true);
    store.saveTeamPlan(teams.development.id, {
      milestones: [
        {
          id: 'release',
          title: '发布可验收版本',
          status: 'active',
          taskIds: [],
        },
      ],
    });
    return { teams, accepted, pending, foreign };
  } finally {
    store.close();
  }
}

async function open(page, fixture) {
  await page.goto('/');
  await openMobileSidebar(page);
  await sidebarLocator(page)
    .locator('button')
    .filter({ hasText: fixture.teams.development.name })
    .first()
    .click({ force: true });
  await clickNavigation(page, '团队动态');
  const plan = page.getByRole('region', {
    name: '团队目标与里程碑',
    exact: true,
  });
  await expect(plan).toContainText('发布可验收版本');
  return plan;
}

test('里程碑关联本团队任务并区分手动完成与实际验收', async ({ page }) => {
  const fixture = seed();
  const plan = await open(page, fixture);
  const links = plan.getByRole('region', {
    name: '发布可验收版本关联任务',
    exact: true,
  });
  await links.getByRole('button', { name: '关联任务', exact: true }).click();
  await expect(
    links.getByRole('checkbox', { name: new RegExp(fixture.foreign.title) }),
  ).toHaveCount(0);
  await links.getByRole('searchbox').fill(fixture.accepted.title);
  await links
    .getByRole('checkbox', { name: new RegExp(fixture.accepted.title) })
    .check();
  await links.getByRole('searchbox').fill(fixture.pending.title);
  await links
    .getByRole('checkbox', { name: new RegExp(fixture.pending.title) })
    .check();
  await links.getByRole('button', { name: '保存关联', exact: true }).click();
  await expect(links).toContainText('1/2 项任务已验收');
  await expect(links).toContainText('交付：待你验收');
  await plan
    .getByRole('button', { name: '发布可验收版本：进行中', exact: true })
    .click();
  await expect(plan).toContainText('1/1 项手动标记完成');
  await expect(links).toContainText('1/2 项任务已验收');
  await page.reload();
  await expect(links).toContainText('1/2 项任务已验收');
  await links
    .locator('.milestone-task-links button')
    .filter({ hasText: fixture.pending.title })
    .click();
  const detail = page.getByRole('dialog', { name: '执行记录', exact: true });
  await expect(detail).toContainText(fixture.pending.title);
  await expect(detail).toContainText('待你验收');
  await detail
    .getByRole('textbox', { name: '验收备注', exact: true })
    .fill('已复核回滚验证证据。');
  await detail.getByRole('button', { name: '通过交付', exact: true }).click();
  await expect(detail).toContainText('已交付');
  await detail.getByRole('button', { name: 'Close', exact: true }).click();
  await expect(links).toContainText('2/2 项任务已验收');
  // New requirements invalidate the previous acceptance without changing the plan.
  const store = new Store(process.env.GGB_E2E_DATA_DIR, process.cwd());
  try {
    store.records.save(
      'task-meta',
      {
        ...store.records.get('task-meta', fixture.accepted.id),
        requirementVersion: 2,
      },
      fixture.accepted.id,
    );
  } finally {
    store.close();
  }
  await expect(links).toContainText('1/2 项任务已验收', { timeout: 15000 });
  await links
    .getByRole('button', { name: '管理关联任务', exact: true })
    .click();
  await links
    .getByRole('checkbox', { name: new RegExp(fixture.accepted.title) })
    .uncheck();
  await links.getByRole('button', { name: '保存关联', exact: true }).click();
  await expect(links).toContainText('1/1 项任务已验收');
  if (test.info().project.name === 'mobile') {
    await page.setViewportSize({ width: 320, height: 851 });
    await expect
      .poll(() =>
        page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
      )
      .toBe(true);
  }
  await links.screenshot({
    path: test.info().outputPath('milestone-linked.png'),
    animations: 'disabled',
  });
});

test('关联保存失败及版本冲突保留选择，重新加载后核对再保存', async ({
  page,
}) => {
  const fixture = seed();
  const plan = await open(page, fixture);
  const links = plan.getByRole('region', {
    name: '发布可验收版本关联任务',
    exact: true,
  });
  await links.getByRole('button', { name: '关联任务', exact: true }).click();
  const checkbox = links.getByRole('checkbox', {
    name: new RegExp(fixture.pending.title),
  });
  await checkbox.check();
  let fail = true;
  await page.route(
    `**/api/spaces/${fixture.teams.development.id}/plan`,
    (route) =>
      route.request().method() === 'PUT' && fail
        ? route.fulfill({ status: 503, json: { error: '计划服务暂不可用' } })
        : route.continue(),
  );
  await links.getByRole('button', { name: '保存关联', exact: true }).click();
  await expect(plan.getByRole('alert')).toContainText('计划服务暂不可用');
  await expect(checkbox).toBeChecked();
  fail = false;
  const endpoint = `/api/teams/${fixture.teams.development.id}/plan`;
  const previous = await (await page.request.get(endpoint)).json();
  const updated = await page.request.put(endpoint, {
    data: { ...previous, summary: '另一设备更新后的目标' },
  });
  expect(updated.ok()).toBe(true);
  await links.getByRole('button', { name: '保存关联', exact: true }).click();
  await expect(plan.getByRole('alert')).toContainText('记录已更新');
  await expect(checkbox).toBeChecked();
  await plan.getByRole('button', { name: '重新加载计划', exact: true }).click();
  await expect(plan).toContainText('另一设备更新后的目标');
  await expect(checkbox).toBeChecked();
  await links.getByRole('button', { name: '保存关联', exact: true }).click();
  await expect(links).toContainText('0/1 项任务已验收');
  await expect(plan.getByRole('alert')).toHaveCount(0);
  const saved = await (await page.request.get(endpoint)).json();
  expect(saved.summary).toBe('另一设备更新后的目标');
  expect(saved.milestones[0].taskIds).toEqual([fixture.pending.id]);
});

test('计划目标、里程碑和边界保存失败时保留输入并可修正', async ({ page }) => {
  const fixture = seed();
  const plan = await open(page, fixture);
  let fail = true;
  await page.route(
    `**/api/spaces/${fixture.teams.development.id}/plan`,
    (route) =>
      route.request().method() === 'PUT' && fail
        ? route.fulfill({ status: 503, json: { error: '保存暂不可用' } })
        : route.continue(),
  );
  await plan.getByRole('button', { name: '编辑团队目标', exact: true }).click();
  await plan
    .getByRole('textbox', { name: '团队目标', exact: true })
    .fill('已讨论好的新目标');
  await plan.getByRole('button', { name: '保存目标', exact: true }).click();
  await expect(plan.getByRole('alert')).toContainText('保存暂不可用');
  await expect(
    plan.getByRole('textbox', { name: '团队目标', exact: true }),
  ).toHaveValue('已讨论好的新目标');
  fail = false;
  await plan.getByRole('button', { name: '保存目标', exact: true }).click();
  await expect(
    plan.getByRole('textbox', { name: '团队目标', exact: true }),
  ).toHaveCount(0);
  await plan.getByRole('button', { name: '添加里程碑', exact: true }).click();
  await plan.getByPlaceholder('里程碑标题').fill('补充边界测试');
  await plan.getByPlaceholder('验收说明（可选）').fill('保存测试证据');
  fail = true;
  await plan.getByRole('button', { name: '保存', exact: true }).click();
  await expect(plan.getByRole('alert')).toContainText('保存暂不可用');
  await expect(plan.getByPlaceholder('里程碑标题')).toHaveValue('补充边界测试');
  await expect(plan.getByPlaceholder('验收说明（可选）')).toHaveValue(
    '保存测试证据',
  );
  fail = false;
  await plan.getByRole('button', { name: '保存', exact: true }).click();
  await expect(
    plan.getByRole('button', { name: '补充边界测试：未开始', exact: true }),
  ).toBeVisible();
  await plan.getByRole('button', { name: '编辑计划边界', exact: true }).click();
  await plan
    .getByRole('spinbutton', { name: '计划预算', exact: true })
    .fill('500');
  await plan.getByRole('button', { name: '保存边界', exact: true }).click();
  await expect(plan.getByRole('alert')).toContainText('计划预算需要在');
  await expect(
    plan.getByRole('spinbutton', { name: '计划预算', exact: true }),
  ).toHaveValue('500');
  await plan
    .getByRole('spinbutton', { name: '计划预算', exact: true })
    .fill('5000');
  await plan.getByRole('button', { name: '保存边界', exact: true }).click();
  await expect(plan.getByRole('alert')).toHaveCount(0);
  await expect(plan).toContainText('计划上限 5,000');
});

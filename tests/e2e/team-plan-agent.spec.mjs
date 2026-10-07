import { randomUUID } from 'node:crypto';
import { expect, test } from '@playwright/test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { Store } from '../../server/store.mjs';
import { ControlPlane } from '../../server/control.mjs';
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
    const team = store.saveTeamSpace({
      name: `计划协作团队 ${randomUUID().slice(0, 8)}`,
      goal: '由真实证据驱动阶段进展',
      workspace: process.cwd(),
      pmRoleId: 'project_manager',
      memberRoleIds: ['project_manager', 'developer'],
      recruitment: { phase: 'confirmed' },
    });
    const actor = store.createTask({
      role: 'project_manager',
      prompt: '维护团队阶段',
      workspace: process.cwd(),
    });
    store.records.save(
      'task-meta',
      { spaceId: team.id, groupId: actor.id, requirementVersion: 1 },
      actor.id,
    );
    const claim = new ControlPlane({ store }).claimLocal(actor);
    const child = store.createTask({
      role: 'developer',
      prompt: '提供可复核实现',
      workspace: process.cwd(),
    });
    store.records.save(
      'task-meta',
      { spaceId: team.id, groupId: actor.id, requirementVersion: 1 },
      child.id,
    );
    store.updateTask(child.id, {
      status: 'completed',
      result: '实现已通过验证，等待人工验收。',
    });
    store.records.save('artifacts', {
      taskId: child.id,
      kind: 'verification',
      name: 'npm test',
      status: 'verified',
      verified: true,
      requirementVersion: 1,
      output: 'fixture tests passed',
    });
    return { team, actorId: actor.id, taskId: child.id, token: claim.token };
  } finally {
    store.close();
  }
}
const result = (response) => {
  expect(response.isError, response.content[0].text).not.toBe(true);
  return JSON.parse(response.content[0].text);
};

test('项目经理通过真实 MCP 维护里程碑，用户验收后才能完成并在页面留下记录', async ({
  page,
}) => {
  const fixture = seed();
  const client = new Client({ name: 'plan-browser-fixture', version: '1' });
  try {
    await client.connect(
      new StreamableHTTPClientTransport(
        new URL('http://127.0.0.1:3289/api/mcp'),
        {
          requestInit: {
            headers: { Authorization: `Bearer ${fixture.token}` },
          },
        },
      ),
    );
    await page.goto('/');
    await openMobileSidebar(page);
    await sidebarLocator(page)
      .locator('button')
      .filter({ hasText: fixture.team.name })
      .first()
      .click({ force: true });
    await clickNavigation(page, '团队动态');
    const plan = page.getByRole('region', {
      name: '团队目标与里程碑',
      exact: true,
    });
    await expect(plan).toContainText('还没有里程碑');
    await plan
      .getByRole('button', { name: '编辑团队目标', exact: true })
      .click();
    const draft = plan.getByRole('textbox', { name: '团队目标', exact: true });
    await draft.fill('用户正在编辑的目标不会被后台更新覆盖');
    const current = result(
      await client.callTool({ name: 'read_team_plan', arguments: {} }),
    );
    const created = result(
      await client.callTool({
        name: 'upsert_team_milestone',
        arguments: {
          id: 'core',
          title: '核心功能交付',
          status: 'active',
          taskIds: [fixture.taskId],
          expectedRevision: current.revision,
          note: '关联已完成执行，等待所有者查看验证证据。',
        },
      }),
    );
    await expect(
      plan.getByRole('button', { name: '加载最新计划', exact: true }),
    ).toBeVisible({ timeout: 15000 });
    await expect(draft).toHaveValue('用户正在编辑的目标不会被后台更新覆盖');
    await plan
      .getByRole('button', { name: '加载最新计划', exact: true })
      .click();
    await expect(draft).toHaveValue('用户正在编辑的目标不会被后台更新覆盖');
    await expect(plan.getByLabel('最近项目经理更新')).toContainText(
      '等待所有者查看验证证据',
    );
    const denied = await client.callTool({
      name: 'upsert_team_milestone',
      arguments: {
        id: 'core',
        status: 'completed',
        expectedRevision: created.plan.revision,
        note: '尝试提前完成',
      },
    });
    expect(denied.isError).toBe(true);
    await expect(
      plan.getByRole('button', { name: '核心功能交付：进行中', exact: true }),
    ).toBeVisible();
    const links = plan.getByRole('region', {
      name: '核心功能交付关联任务',
      exact: true,
    });
    await links.locator('.milestone-task-links button').click();
    const dialog = page.getByRole('dialog', { name: '执行记录', exact: true });
    await dialog
      .getByRole('textbox', { name: '验收备注', exact: true })
      .fill('检查当前版本验证后同意交付。');
    await dialog.getByRole('button', { name: '通过交付', exact: true }).click();
    await expect(dialog).toContainText('已交付');
    await dialog.getByRole('button', { name: 'Close', exact: true }).click();
    result(
      await client.callTool({
        name: 'upsert_team_milestone',
        arguments: {
          id: 'core',
          status: 'completed',
          expectedRevision: created.plan.revision,
          note: '所关联任务已通过当前版本所有者验收，完成此阶段。',
        },
      }),
    );
    await plan
      .getByRole('button', { name: '加载最新计划', exact: true })
      .click();
    await expect(
      plan.getByRole('button', { name: '核心功能交付：已完成', exact: true }),
    ).toBeVisible();
    await expect(links).toContainText('1/1 项任务已验收');
    await expect(plan.getByLabel('最近项目经理更新')).toContainText(
      '完成此阶段',
    );
    await expect(draft).toHaveValue('用户正在编辑的目标不会被后台更新覆盖');
    await plan.getByRole('button', { name: '保存目标', exact: true }).click();
    await expect(draft).toHaveCount(0);
    await page.reload();
    await expect(plan).toContainText('用户正在编辑的目标不会被后台更新覆盖');
    await expect(plan.getByLabel('最近项目经理更新')).toContainText(
      '完成此阶段',
    );
    if (test.info().project.name === 'mobile') {
      await page.setViewportSize({ width: 320, height: 851 });
      await expect
        .poll(() =>
          page.evaluate(
            () => document.documentElement.scrollWidth <= innerWidth,
          ),
        )
        .toBe(true);
    }
    await plan.screenshot({
      path: test.info().outputPath('agent-plan.png'),
      animations: 'disabled',
    });
  } finally {
    await client.close();
    const store = new Store(process.env.GGB_E2E_DATA_DIR, process.cwd());
    try {
      new ControlPlane({ store }).revokeExecution(fixture.actorId);
      store.updateTask(fixture.actorId, { status: 'completed' });
    } finally {
      store.close();
    }
  }
});

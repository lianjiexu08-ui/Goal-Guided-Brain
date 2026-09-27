import { randomUUID } from 'node:crypto';
import { expect, test } from '@playwright/test';
import { Store } from '../../server/store.mjs';

const dataDir = process.env.GGB_E2E_DATA_DIR;

function seedFailedJob() {
  const store = new Store(dataDir, process.cwd(), { seedProjectManager: true });
  try {
    const groupId = randomUUID();
    const task = store.createTask({
      role: 'developer',
      prompt: 'E2E 验证失败执行可以恢复并保留旧结果',
      workspace: process.cwd(),
    });
    const job = store.records.save(
      'jobs',
      {
        title: '失败恢复验收任务',
        goal: 'E2E 验证失败执行可以恢复并保留旧结果',
        role: 'developer',
        groupId,
        batchId: randomUUID(),
        status: 'failed',
        taskId: task.id,
        nodeId: 'local',
        workspace: process.cwd(),
        workspaceKey: 'default',
        requirementVersion: 1,
        depth: 0,
        budgetTokens: 200000,
        maxDurationMinutes: 30,
        permissions: [],
        spaceId: null,
        teamId: null,
      },
      `e2e-recovery-${groupId}`,
    );
    store.records.save(
      'task-meta',
      {
        jobId: job.id,
        groupId,
        batchId: job.batchId,
        nodeId: 'local',
        workspaceKey: 'default',
        workspaceMode: 'isolated',
        providerIds: ['e2e-recovery-provider'],
        allowedProviderIds: ['e2e-recovery-provider'],
        dependencies: [],
        permissions: [],
        requirementVersion: 1,
        contextExtra: '',
        attachmentIds: [],
        spaceId: null,
        teamId: null,
        sourceMessageId: null,
      },
      task.id,
    );
    store.updateTask(task.id, {
      status: 'failed',
      result: '旧实例的部分结果，必须保留供复核。',
      error: 'E2E fixture：模型供应商暂时不可用。',
    });
    // A provider record lets the normal retry route create the replacement
    // attempt without making the test depend on a real API credential.
    store.records.save(
      'providers',
      {
        name: 'E2E recovery provider',
        protocol: 'openai-completions',
        baseUrl: 'http://127.0.0.1:9/v1',
        credentialId: null,
        enabled: true,
        priority: 1,
        models: [{ id: 'e2e-recovery-model', name: 'E2E recovery model', tools: true }],
      },
      'e2e-recovery-provider',
    );
    store.records.save(
      'runtime-snapshots',
      {
        route: {
          providerId: 'e2e-recovery-provider',
          providerName: 'E2E recovery provider',
          protocol: 'openai-completions',
          model: 'e2e-recovery-model',
          routingCandidates: [
            {
              providerId: 'e2e-recovery-provider',
              providerName: 'E2E recovery provider',
              model: 'e2e-recovery-model',
              priority: 1,
              status: 'selected',
            },
          ],
        },
      },
      task.id,
    );
    store.records.save('task-events', {
      taskId: task.id,
      type: 'routing/fallback',
      data: {
        from: {
          providerId: 'e2e-primary-provider',
          providerName: 'E2E primary provider',
          model: 'e2e-primary-model',
        },
        to: {
          providerId: 'e2e-recovery-provider',
          providerName: 'E2E recovery provider',
          model: 'e2e-recovery-model',
        },
        reason: 'E2E fixture：主模型暂时不可用。',
      },
      at: new Date().toISOString(),
    });
    return { taskId: task.id, jobId: job.id };
  } finally {
    store.close();
  }
}

function seedAcceptanceJob({ rejected = false } = {}) {
  const store = new Store(dataDir, process.cwd(), { seedProjectManager: true });
  try {
    const groupId = randomUUID();
    const task = store.createTask({
      role: 'developer',
      prompt: 'E2E 验收决定可以通过交付或退回复核',
      workspace: process.cwd(),
    });
    const job = store.records.save(
      'jobs',
      {
        title: '交付验收闭环任务',
        goal: '实现并验证验收决定闭环。',
        acceptance: '通过测试并由所有者确认交付。',
        role: 'developer',
        groupId,
        batchId: randomUUID(),
        status: 'completed',
        taskId: task.id,
        nodeId: 'local',
        workspace: process.cwd(),
        workspaceKey: 'default',
        requirementVersion: 1,
        depth: 0,
        budgetTokens: 200000,
        maxDurationMinutes: 30,
        permissions: [],
        spaceId: null,
        teamId: null,
      },
      `e2e-acceptance-${groupId}`,
    );
    store.records.save(
      'task-meta',
      {
        jobId: job.id,
        groupId,
        batchId: job.batchId,
        nodeId: 'local',
        workspaceKey: 'default',
        workspaceMode: 'isolated',
        requirementVersion: 1,
        dependencies: [],
        permissions: [],
        contextExtra: '',
        attachmentIds: [],
        spaceId: null,
        teamId: null,
      },
      task.id,
    );
    store.updateTask(task.id, {
      status: 'completed',
      result: '测试已通过，等待所有者验收。',
    });
    const verification = store.records.save('artifacts', {
      taskId: task.id,
      groupId,
      requirementVersion: 1,
      kind: 'verification',
      name: 'npm test',
      status: 'verified',
      verified: true,
      output: '140 tests passed',
      finishedAt: new Date().toISOString(),
    }, `e2e-acceptance-verification-${groupId}`);
    if (rejected) {
      store.records.save('task-acceptance', {
        taskId: task.id,
        groupId,
        jobId: job.id,
        decision: 'rejected',
        status: 'active',
        note: '请补充边界场景验证后重新提交。',
        requirementVersion: 1,
        verificationId: verification.id,
        decidedBy: 'owner',
        decidedAt: new Date().toISOString(),
      }, task.id);
      store.records.save('attention', {
        taskId: task.id,
        groupId,
        jobId: job.id,
        status: 'open',
        kind: 'acceptance',
        title: '交付被退回复核',
        detail: '请补充边界场景验证后重新提交。',
        requirementVersion: 1,
      }, `acceptance:${task.id}:1`);
    }
    return { taskId: task.id };
  } finally {
    store.close();
  }
}

test('协作任务详情提供失败原因和执行实例重试入口', async ({ page }) => {
  const fixture = seedFailedJob();
  await page.goto('/');
  const mobile = (page.viewportSize()?.width || 1024) < 768;
  if (mobile) {
    await page.getByRole('button', { name: 'Toggle Sidebar', exact: true }).click();
    await expect(page.locator('[data-sidebar="sidebar"][data-mobile="true"]')).toBeVisible();
  }
  const sidebar = page.locator(
    mobile ? '[data-sidebar="sidebar"][data-mobile="true"]' : '[data-sidebar="sidebar"]',
  );
  await sidebar.getByRole('button', { name: '协作任务', exact: true }).click();
  await expect(page.getByRole('heading', { name: '协作任务' })).toBeVisible();
  await page.getByRole('button', { name: '失败恢复验收任务', exact: true }).first().click();
  const detail = page.getByRole('dialog', { name: '失败恢复验收任务' });
  await expect(detail.getByText('恢复说明', { exact: true })).toBeVisible();
  await expect(detail.getByText('E2E fixture：模型供应商暂时不可用。', { exact: true }).first()).toBeVisible();
  await expect(detail.getByRole('button', { name: '重试此执行实例', exact: true })).toBeVisible();
  await detail.getByRole('button', { name: 'E2E 验证失败执行可以恢复并保留旧结果', exact: true }).click();
  await expect(detail.getByText('模型路由', { exact: true })).toBeVisible();
  await expect(detail.getByRole('definition').filter({ hasText: 'e2e-recovery-model' })).toBeVisible();
  await expect(detail.getByText('已自动切换模型', { exact: true })).toBeVisible();

  await detail.getByRole('button', { name: '重试此执行实例', exact: true }).click();
  await expect.poll(async () =>
    page.locator('h3').filter({ hasText: '执行实例' }).textContent(),
  ).toMatch(/· 2/);
  await expect(detail.getByText(new RegExp(`恢复自执行实例 · ${fixture.taskId}`))).toBeVisible();
});

test('协作任务详情支持所有者验收决定', async ({ page }) => {
  seedAcceptanceJob();
  await page.goto('/');
  const mobile = (page.viewportSize()?.width || 1024) < 768;
  if (mobile) {
    await page.getByRole('button', { name: 'Toggle Sidebar', exact: true }).click();
    await expect(page.locator('[data-sidebar="sidebar"][data-mobile="true"]')).toBeVisible();
  }
  const sidebar = page.locator(
    mobile ? '[data-sidebar="sidebar"][data-mobile="true"]' : '[data-sidebar="sidebar"]',
  );
  await sidebar.getByRole('button', { name: '协作任务', exact: true }).click();
  await expect(page.getByRole('heading', { name: '协作任务' })).toBeVisible();
  await page.getByRole('button', { name: '交付验收闭环任务', exact: true }).first().click();
  const detail = page.getByRole('dialog', { name: '交付验收闭环任务' });
  await detail.getByRole('button', { name: 'E2E 验收决定可以通过交付或退回复核', exact: true }).click();
  await expect(detail.getByText('交付判断', { exact: true })).toBeVisible();
  await expect(detail.getByText('待你验收', { exact: true }).first()).toBeVisible();
  await expect(detail.getByText(/通过测试并由所有者确认交付。/)).toBeVisible();
  const note = detail.getByRole('textbox', { name: '验收备注' });
  await note.fill('已检查测试输出，确认交付。');
  await detail.getByRole('button', { name: '通过交付', exact: true }).click();
  await expect(detail.getByText('已交付', { exact: true }).first()).toBeVisible();
  await expect(detail.getByText(/已检查测试输出，确认交付。/).first()).toBeVisible();
});

test('需要你处理可以直接打开关联执行和交付状态', async ({ page }) => {
  seedAcceptanceJob({ rejected: true });
  await page.goto('/');
  const mobile = (page.viewportSize()?.width || 1024) < 768;
  if (mobile) {
    await page.getByRole('button', { name: 'Toggle Sidebar', exact: true }).click();
    await expect(page.locator('[data-sidebar="sidebar"][data-mobile="true"]')).toBeVisible();
  }
  const sidebar = page.locator(
    mobile ? '[data-sidebar="sidebar"][data-mobile="true"]' : '[data-sidebar="sidebar"]',
  );
  await sidebar.getByRole('button', { name: '需要你处理', exact: true }).click();
  await expect(page.getByRole('heading', { name: '需要你处理' })).toBeVisible();
  await page.getByRole('button', { name: '交付被退回复核', exact: true }).first().click();
  const detail = page.getByRole('dialog', { name: '交付被退回复核' });
  await expect(detail.getByText('关联执行', { exact: true })).toBeVisible();
  await expect(detail.getByText('交付验收闭环任务', { exact: true })).toBeVisible();
  await detail.getByRole('button', { name: '查看执行与交付', exact: true }).click();
  await expect(detail.getByText('交付判断', { exact: true })).toBeVisible();
  await expect(detail.getByText('已退回复核', { exact: true }).first()).toBeVisible();
});

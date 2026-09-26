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

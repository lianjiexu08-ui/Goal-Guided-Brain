import { expect, test } from '@playwright/test';
import { Store } from '../../server/store.mjs';
import {
  openMobileSidebar,
  sidebarLocator,
} from './team-recruitment-helpers.mjs';
import {
  dataDir,
  seedConversationScrollTeam,
} from './conversation-scroll-fixtures.mjs';

test.describe('对话阅读位置回归', () => {
  test('上滑阅读历史任务时提供回到最新，并可回到底部', async ({ page }) => {
    const team = seedConversationScrollTeam();
    await page.goto('/');
    await openMobileSidebar(page);
    await sidebarLocator(page)
      .locator('button')
      .filter({ hasText: team.name })
      .first()
      .click({ force: true });
    await expect(page.getByRole('heading', { name: team.name })).toBeVisible();

    const messageArea = page.locator('[data-testid="message-area"]');
    await expect(messageArea).toBeVisible();
    await expect
      .poll(() =>
        messageArea.evaluate((element) => element.scrollHeight > element.clientHeight),
      )
      .toBe(true);
    await messageArea.evaluate((element) => {
      element.scrollTop = 0;
      element.dispatchEvent(new Event('scroll'));
    });
    const jumpButton = page.getByRole('button', {
      name: '回到最新消息',
      exact: true,
    });
    await expect(jumpButton).toBeVisible();

    const store = new Store(dataDir, process.cwd(), {
      seedProjectManager: true,
    });
    try {
      store.updateTask(team.latestTaskId, {
        result: '同一任务更新了更完整的交付结果，但不能打断旧消息阅读。',
      });
    } finally {
      store.close();
    }
    await page.waitForTimeout(2_300);
    await expect(jumpButton).toBeVisible();
    await expect
      .poll(() =>
        messageArea.evaluate(
          (element) =>
            element.scrollHeight - element.scrollTop - element.clientHeight,
        ),
      )
      .toBeGreaterThan(120);
    await jumpButton.click();
    await expect
      .poll(() =>
        messageArea.evaluate(
          (element) =>
            element.scrollHeight - element.scrollTop - element.clientHeight,
        ),
      )
      .toBeLessThanOrEqual(80);
  });
});

import { expect } from '@playwright/test';

export function sidebarLocator(page) {
  const mobile = (page.viewportSize()?.width || 1024) < 768;
  return page.locator(
    mobile
      ? '[data-sidebar="sidebar"][data-mobile="true"]'
      : '[data-sidebar="sidebar"]',
  );
}

export async function openMobileSidebar(page) {
  const sidebar = sidebarLocator(page);
  if ((page.viewportSize()?.width || 1024) < 768) {
    // Wait for the actual closing portal instead of adding a delay to every
    // navigation. A visible exiting Sheet must not be mistaken for an open one.
    await expect(sidebar.and(page.locator('[data-closed]'))).toHaveCount(0);
    if (await sidebar.isVisible()) return sidebar;
    const trigger = page
      .getByRole('button', { name: 'Toggle Sidebar', exact: true })
      .first();
    await expect(trigger).toBeVisible();
    await trigger.click();
    await expect(sidebar).toBeVisible();
    await expect(
      sidebar.locator('button').filter({ hasText: '团队招募' }).first(),
    ).toBeVisible();
    return sidebar;
  }
  if (await sidebar.isVisible().catch(() => false)) return sidebar;
  return page.locator('body');
}

export async function clickNavigation(page, label) {
  await openMobileSidebar(page);
  await page.waitForTimeout(500);
  const navigation = sidebarLocator(page)
    .locator('button')
    .filter({ hasText: label })
    .first();
  await expect(navigation).toBeVisible();
  await navigation.click();
}

export async function recruitmentPage(page) {
  await page.goto('/');
  await openMobileSidebar(page);
  await page.waitForTimeout(500);
  const navigation = sidebarLocator(page)
    .locator('button')
    .filter({ hasText: '团队招募' })
    .first();
  await expect(navigation).toBeVisible();
  await navigation.click();
  await expect(
    page.getByRole('heading', { name: '发布需求，招募团队' }),
  ).toBeVisible();
  return page.locator('textarea[aria-label^="发送给"]');
}

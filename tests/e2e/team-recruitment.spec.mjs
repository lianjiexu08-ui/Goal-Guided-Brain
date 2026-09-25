import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, test } from '@playwright/test';

const dataDir = process.env.GGB_E2E_DATA_DIR || path.join(os.tmpdir(), 'ggb-browser-e2e-fixture');

function sidebarLocator(page) {
  const mobile = (page.viewportSize()?.width || 1024) < 768;
  return page.locator(mobile
    ? '[data-sidebar="sidebar"][data-mobile="true"]'
    : '[data-sidebar="sidebar"]');
}

async function openMobileSidebar(page) {
  const sidebar = sidebarLocator(page);
  if ((page.viewportSize()?.width || 1024) < 768) {
    // A previous navigation closes the Sheet with a short exit animation. Let
    // that portal settle before deciding whether a fresh open is required.
    await page.waitForTimeout(350);
    const visible = await sidebar.isVisible().catch(() => false);
    const hasNavigation = visible && await sidebar
      .locator('button')
      .filter({ hasText: '团队招募' })
      .count()
      .catch(() => 0);
    if (hasNavigation) return sidebar;
    if (visible) await expect(sidebar).toBeHidden({ timeout: 1_000 }).catch(() => {});
    const trigger = page.getByRole('button', { name: 'Toggle Sidebar', exact: true }).first();
    await expect(trigger).toBeVisible();
    await trigger.click({ force: true });
    await expect(sidebar).toBeVisible();
    await expect(sidebar.locator('button').filter({ hasText: '团队招募' }).first()).toBeVisible();
    return sidebar;
  }
  if (await sidebar.isVisible().catch(() => false)) return sidebar;
  return page.locator('body');
}

async function clickNavigation(page, label) {
  await openMobileSidebar(page);
  await page.waitForTimeout(500);
  const navigation = sidebarLocator(page).locator('button').filter({ hasText: label }).first();
  await expect(navigation).toBeVisible();
  await navigation.click({ force: true });
}

async function recruitmentPage(page) {
  await page.goto('/');
  await openMobileSidebar(page);
  await page.waitForTimeout(500);
  const navigation = sidebarLocator(page).locator('button').filter({ hasText: '团队招募' }).first();
  await expect(navigation).toBeVisible();
  await navigation.click();
  await expect(page.getByRole('heading', { name: '发布需求，招募团队' })).toBeVisible();
  return page.locator('textarea[aria-label^="发送给"]');
}

test.describe('团队招募核心流程', () => {
  test('草稿跨页面恢复，发布新需求不会复用旧草稿', async ({ page }) => {
    const composer = await recruitmentPage(page);
    const draft = '为开发团队建立一条可验收的交付流程';
    await composer.fill(draft);

    await clickNavigation(page, '助手与模型');
    await expect(page.getByRole('heading', { name: '我的助手' })).toBeVisible();
    await clickNavigation(page, '团队招募');
    await expect(composer).toHaveValue(draft);

    await page.getByRole('button', { name: '另起需求', exact: true }).click();
    await expect(page.getByRole('heading', { name: '发布需求，招募团队' })).toBeVisible();
    await expect(page.locator('textarea[aria-label^="发送给"]')).toHaveValue('');

    const cachedDrafts = await page.evaluate(() => {
      const raw = window.localStorage.getItem('ggb.composer-drafts.v1');
      return raw ? Object.values(JSON.parse(raw).drafts || {}) : [];
    });
    expect(cachedDrafts).toContain(draft);
  });

  test('拖入图片保存真实二进制附件，并在需求草稿中显示文件卡片', async ({ page }) => {
    const composer = await recruitmentPage(page);
    await composer.fill('请识别这张设计图中的交付要求');
    const pngBytes = [137, 80, 78, 71, 13, 10, 26, 10, 0, 1, 2, 3];
    const attachmentDir = path.join(dataDir, 'attachments');
    const existingFiles = fs.existsSync(attachmentDir)
      ? fs.readdirSync(attachmentDir).filter((name) => name.endsWith('.bin'))
      : [];
    await page.locator('.composer').evaluate((element, bytes) => {
      const transfer = new DataTransfer();
      transfer.items.add(new File([new Uint8Array(bytes)], 'design.png', { type: 'image/png' }));
      for (const type of ['dragenter', 'dragover', 'drop']) {
        const event = new DragEvent(type, { bubbles: true, cancelable: true });
        Object.defineProperty(event, 'dataTransfer', { value: transfer });
        element.dispatchEvent(event);
      }
    }, pngBytes);

    await expect(page.getByRole('button', { name: /design\.png/ })).toBeVisible();
    await expect(page.getByText(/已添加 1 个附件/)).toBeVisible();

    await expect.poll(() => {
      if (!fs.existsSync(attachmentDir)) return [];
      return fs.readdirSync(attachmentDir).filter((name) => name.endsWith('.bin'));
    }).toHaveLength(existingFiles.length + 1);
    const currentFiles = fs.readdirSync(attachmentDir).filter((name) => name.endsWith('.bin'));
    const newFile = currentFiles.find((name) => !existingFiles.includes(name));
    expect(newFile).toBeTruthy();
    const stored = fs.readFileSync(path.join(attachmentDir, newFile));
    expect([...stored]).toEqual(pngBytes);
  });
});

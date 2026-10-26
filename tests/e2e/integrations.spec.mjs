import { createHmac } from 'node:crypto';
import http from 'node:http';
import { expect, test } from '@playwright/test';

// 集成出口 E2E：真实后端 + 本地 webhook 接收器，覆盖
// 创建 → 出站测试（HMAC 签名）→ 投递记录 → 编辑掩码 的完整链路。

function sidebarLocator(page) {
  const mobile = (page.viewportSize()?.width || 1024) < 768;
  return page.locator(mobile
    ? '[data-sidebar="sidebar"][data-mobile="true"]'
    : '[data-sidebar="sidebar"]');
}

async function openNavigation(page, label) {
  const sidebar = sidebarLocator(page);
  if ((page.viewportSize()?.width || 1024) < 768) {
    await page.waitForTimeout(350);
    const visible = await sidebar.isVisible().catch(() => false);
    if (!visible || !(await sidebar.locator('button').filter({ hasText: '团队招募' }).count().catch(() => 0))) {
      if (visible) await expect(sidebar).toBeHidden({ timeout: 1_000 }).catch(() => {});
      const trigger = page.getByRole('button', { name: 'Toggle Sidebar', exact: true }).first();
      await expect(trigger).toBeVisible();
      await trigger.click({ force: true });
      await expect(sidebar).toBeVisible();
    }
  }
  const navigation = sidebar.locator('button').filter({ hasText: label }).first();
  await expect(navigation).toBeVisible();
  await navigation.click({ force: true });
}

test('集成出口：创建 webhook、签名出站、投递记录与密钥掩码', async ({ page }) => {
  test.setTimeout(120_000);
  // 本地 webhook 接收器：记录请求与签名头，返回 200。
  const received = [];
  const receiver = http.createServer((request, response) => {
    let body = '';
    request.on('data', chunk => { body += chunk; });
    request.on('end', () => {
      received.push({ url: request.url, signature: request.headers['x-ggb-signature'] || '', body });
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end('{}');
    });
  });
  await new Promise(resolve => receiver.listen(0, '127.0.0.1', resolve));
  const receiverPort = receiver.address().port;
  try {

  await page.goto('/');
  await openNavigation(page, '集成出口');
  await expect(page.getByRole('heading', { name: '集成出口' })).toBeVisible();

  // 新建 webhook 集成
  await page.getByRole('button', { name: '新建集成出口' }).click();
  await page.getByLabel('渠道类型').selectOption('webhook');
  await page.getByLabel('名称', { exact: true }).fill('E2E 出站 276818');
  await page.getByLabel('Webhook 地址', { exact: true }).fill(`http://127.0.0.1:${receiverPort}/hook`);
  await page.getByLabel('签名密钥（HMAC，入站必填）', { exact: true }).fill('e2e-hmac-secret');
  await page.getByRole('button', { name: '保存' }).click();
  await expect(page.locator('body')).toContainText('E2E 出站 276818');

  // 打开编辑器：发送测试消息 → 接收器收到带签名的 JSON 信封
  await page.getByRole('button', { name: '编辑 E2E 出站 276818' }).first().click();
  await expect(page.getByRole('heading', { name: '编辑集成出口' })).toBeVisible();
  await page.getByRole('button', { name: '发送测试消息' }).click();
  await expect(page.locator('body')).toContainText('测试消息已发送', { timeout: 15_000 });
  await expect.poll(() => received.length, { timeout: 10_000 }).toBeGreaterThanOrEqual(1);
  const hit = received[received.length - 1];
  const expected = createHmac('sha256', 'e2e-hmac-secret').update(hit.body).digest('hex');
  expect(hit.signature).toBe(expected);
  expect(JSON.parse(hit.body).event).toBe('test');

  // 投递记录出现在编辑器里
  await expect(page.locator('body')).toContainText('最近投递记录');
  await expect(page.locator('body').getByText('已启用', { exact: true }).first()).toBeVisible();

  // 编辑回显掩码密钥（不覆盖真实值）：改名字保存后仍能签名成功
  await page.getByLabel('名称', { exact: true }).fill('E2E 出站 276818 改名');
  await page.getByRole('button', { name: '保存' }).click();
  await expect(page.getByRole('dialog')).toBeHidden();
  await expect(page.locator('body')).toContainText('E2E 出站 276818 改名');
  await page.getByRole('button', { name: '编辑 E2E 出站 276818 改名' }).first().click();
  await expect(page.getByRole('heading', { name: '编辑集成出口' })).toBeVisible();
  await page.getByRole('button', { name: '发送测试消息' }).click();
  await expect.poll(() => received.length, { timeout: 10_000 }).toBeGreaterThanOrEqual(2);
  const second = received[received.length - 1];
  const expectedSecond = createHmac('sha256', 'e2e-hmac-secret').update(second.body).digest('hex');
  expect(second.signature).toBe(expectedSecond);
  } finally {
    await new Promise(resolve => receiver.close(resolve));
  }
});

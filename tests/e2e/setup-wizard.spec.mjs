import http from 'node:http';
import { expect, test } from '@playwright/test';

// 首次配置向导 E2E：全新数据目录 → 引导卡 → 向导 → mock provider
// 保存+连通测试 → 引导卡消失（hasApiKey 就绪）。


// 向导为全站统一实现：全链路在 desktop 验证；mobile 视口共享组件由既有基线覆盖。
test.skip(({ viewport }) => (viewport?.width || 0) < 768, '向导全链路在 desktop 验证');

test('首次配置向导：选供应商、写密钥、连通测试全链路', async ({ page }) => {
  test.setTimeout(120_000);
  // mock provider：响应 OpenAI chat/completions 格式，probe 即通过。
  const probeHits = [];
  const provider = http.createServer((request, response) => {
    let body = '';
    request.on('data', chunk => { body += chunk; });
    request.on('end', () => {
      probeHits.push({ url: request.url, body });
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({
        choices: [{
          message: {
            role: 'assistant',
            content: null,
            tool_calls: [{ id: 'call_e2e', type: 'function', function: { name: 'connection_check', arguments: '{}'} }],
          },
        }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      }));
    });
  });
  await new Promise(resolve => provider.listen(0, '127.0.0.1', resolve));
  const providerBase = `http://127.0.0.1:${provider.address().port}`;
  try {
  const name = undefined;
  await page.goto('/');
  // 全新 fixture 无供应商：引导卡可见。
  const card = page.getByTestId('onboarding-model-guide');
  await expect(card).toBeVisible();

  await card.getByRole('button', { name: '打开配置向导' }).click({ force: true });
  await expect(page.getByRole('heading', { name: '配置模型供应商' })).toBeVisible();

  // 选 DeepSeek 预设，但把 Base URL 指向本地 mock（探测可离线通过）。
  await page.getByTestId('setup-wizard').getByLabel('供应商').selectOption('deepseek');
  await page.getByTestId('setup-wizard').getByLabel('API Key', { exact: true }).fill('e2e-api-key');
  await page.getByTestId('setup-wizard').getByLabel(/自定义 Base URL/).fill(providerBase);
  await page.getByTestId('setup-wizard').getByLabel(/凭据库口令/).fill('e2e-passphrase');
  await page.getByTestId('setup-wizard').getByRole('button', { name: /保存并测试连通/ }).click();

  await expect(page.locator('body')).toContainText('配置完成，连通性测试通过', { timeout: 30_000 });
  await expect.poll(() => probeHits.length, { timeout: 10_000 }).toBeGreaterThanOrEqual(1);
  expect(probeHits[0].url).toContain('/chat/completions');
  expect(JSON.parse(probeHits[0].body).model).toBe('deepseek-chat');

  await page.getByRole('button', { name: '开始使用' }).click();

  // 刷新后：凭据已就绪，引导卡不再显示。
  await page.waitForTimeout(500);
  await page.reload();
  await expect(page.getByTestId('onboarding-model-guide')).toHaveCount(0);
  } finally {
    await new Promise(resolve => provider.close(resolve));
  }
});

import { randomUUID } from 'node:crypto';
import { expect, test } from '@playwright/test';
import { Store } from '../../server/store.mjs';

function seedComposer() {
  const store = new Store(process.env.GGB_E2E_DATA_DIR, process.cwd(), {
    seedProjectManager: true,
  });
  try {
    const providerId = `composer-${randomUUID()}`;
    const model = `long-model-${'extended-context-'.repeat(12)}`;
    store.records.save(
      'providers',
      {
        id: providerId,
        name: '长名称模型供应商 · 企业开发与推理服务 '.repeat(5),
        protocol: 'openai-completions',
        baseUrl: 'http://127.0.0.1:1',
        enabled: true,
        health: {
          ok: false,
          model,
          error: `HTTP 503 ${'upstream_unavailable_'.repeat(40)}`,
          checkedAt: new Date().toISOString(),
        },
        models: [
          {
            id: model,
            name: '超长上下文开发推理模型 '.repeat(10),
            tools: false,
          },
          { id: 'compact', name: '简短模型', tools: false },
        ],
      },
      providerId,
    );
    const team = store.saveTeamSpace({
      name: '输入区布局验证需求',
      goal: '在长名称、探测失败和窄屏下保留可靠发送入口',
      pmRoleId: 'project_manager',
      memberRoleIds: ['project_manager'],
      workspace: `${process.cwd()}/${'long-project-name-'.repeat(8)}`,
      providerId,
      model,
      memberSettings: {
        project_manager: { providerIds: [providerId], modelHint: model },
      },
      recruitment: { phase: 'discovery' },
    });
    return { team, providerId, model };
  } finally {
    store.close();
  }
}

async function expectUsableControl(locator) {
  await expect(locator).toBeVisible();
  const geometry = await locator.evaluate((element) => {
    const box = element.getBoundingClientRect();
    const parent = element.closest('.composer').getBoundingClientRect();
    const points = [
      [box.left + 2, box.top + box.height / 2],
      [box.right - 2, box.top + box.height / 2],
      [box.left + box.width / 2, box.top + 2],
      [box.left + box.width / 2, box.bottom - 2],
      [box.left + box.width / 2, box.top + box.height / 2],
    ];
    return {
      contained:
        box.left >= Math.max(0, parent.left) &&
        box.right <= Math.min(innerWidth, parent.right) &&
        box.top >= Math.max(0, parent.top) &&
        box.bottom <= Math.min(innerHeight, parent.bottom),
      reachable: points.every(([x, y]) =>
        element.contains(document.elementFromPoint(x, y)),
      ),
      width: box.width,
      height: box.height,
    };
  });
  expect(geometry).toMatchObject({ contained: true, reachable: true });
  expect(geometry.width).toBeGreaterThanOrEqual(44);
  expect(geometry.height).toBeGreaterThanOrEqual(44);
}

for (const width of [320, 390, 1024, 1280, 1440]) {
  test(`${width}px 长模型名称与失败提示不遮挡模型切换和发送`, async ({
    page,
  }) => {
    const fixture = seedComposer();
    const { team, providerId, model } = fixture;
    await page.setViewportSize({ width, height: 900 });
    await page.addInitScript((id) => {
      localStorage.setItem(
        'ggb.workspace-route.v1',
        JSON.stringify({
          spaceId: id,
          role: 'project_manager',
          view: 'recruitment',
        }),
      );
    }, team.id);
    await page.goto('/');
    await expect(page.locator('.workspace-path')).toContainText(
      'long-project-name-'.repeat(8),
    );
    const input = page.locator('textarea[aria-label^="发送给"]');
    const selector = page.getByRole('combobox', {
      name: '选择模型',
      exact: true,
    });
    const send = page.getByRole('button', { name: '发送任务', exact: true });
    await input.fill('验证模型切换后的实际发送参数');
    await expect(selector).toHaveValue(`${providerId}::${model}`);
    await expectUsableControl(send);
    await expectUsableControl(selector);
    await page
      .getByText('最近一次连通性检查失败 · 查看详情', { exact: true })
      .click();
    await expect(page.locator('.composer-model-status p')).toContainText(
      'HTTP 503',
    );
    await expectUsableControl(send);
    await expectUsableControl(selector);
    await selector.selectOption(`${providerId}::compact`);
    await expect(selector).toHaveValue(`${providerId}::compact`);
    await selector.selectOption(`${providerId}::${model}`);
    await page.reload();
    await expect(selector).toHaveValue(`${providerId}::${model}`);
    await expect(input).toHaveValue('验证模型切换后的实际发送参数');
    await expectUsableControl(send);
    await expectUsableControl(selector);
    await page.screenshot({ path: test.info().outputPath('composer.png') });
    // Check a real pointer click and the outgoing model selection without
    // invoking a paid provider or creating background work.
    let payload;
    await page.route(`**/api/spaces/${team.id}/messages`, async (route) => {
      if (route.request().method() !== 'POST') return route.continue();
      payload = route.request().postDataJSON();
      await route.fulfill({
        status: 503,
        json: { error: '布局测试：保留草稿' },
      });
    });
    await send.click();
    await expect
      .poll(() => payload)
      .toMatchObject({
        providerId,
        model,
        content: '验证模型切换后的实际发送参数',
      });
    await expect(input).toHaveValue('验证模型切换后的实际发送参数');
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
  });
}

import { expect, test } from '@playwright/test';
import { Store } from '../../server/store.mjs';
import { clickNavigation, dataDir } from './team-recruitment-fixtures.mjs';
const notice = (page) =>
  page.getByRole('region', { name: '模型启动检查', exact: true });
const composer = (page) => page.locator('textarea[aria-label^="发送给"]');
const withStore = (fn) => {
  const store = new Store(dataDir, process.cwd(), { seedProjectManager: true });
  try {
    return fn(store);
  } finally {
    store.close();
  }
};
function seed(extra = {}) {
  return withStore((store) =>
    store.saveTeamSpace({
      name: `首次需求 ${crypto.randomUUID().slice(0, 8)}`,
      goal: '验证首次配置到团队招募的流程',
      pmRoleId: 'project_manager',
      memberRoleIds: ['project_manager'],
      workspace: process.cwd(),
      recruitment: { phase: 'discovery' },
      ...extra,
    }),
  );
}
async function open(page, team) {
  await page.addInitScript((id) => {
    if (sessionStorage.getItem(`setup-opened:${id}`)) return;
    sessionStorage.setItem(`setup-opened:${id}`, '1');
    localStorage.setItem(
      'ggb.workspace-route.v1',
      JSON.stringify({
        spaceId: id,
        role: 'project_manager',
        view: 'workspace',
      }),
    );
  }, team.id);
  await page.goto('/');
  await expect(composer(page)).toBeVisible();
}
async function project(page, team, setup) {
  await page.route('**/api/state', async (route) => {
    const response = await route.fetch({
      headers: { ...route.request().headers(), 'if-none-match': '' },
    });
    const state = await response.json();
    state.spaces = state.spaces.filter((space) => space.id === team.id);
    state.providers = [];
    Object.assign(state.config, {
      hasApiKey: false,
      modelSetup: {
        state: setup.state,
        configuredProviders: 0,
        readyProviders: 0,
        readyModels: 0,
      },
      ...setup.config,
    });
    const { etag: _etag, ...headers } = response.headers();
    await route.fulfill({ response, headers, json: state });
  });
}

test('首次模型检查区分缺失、仅决策后端和停用，去配置再返回保留招募草稿', async ({
  page,
}) => {
  const team = seed();
  const setup = { state: 'missing' };
  await project(page, team, setup);
  await open(page, team);
  await expect(notice(page)).toContainText('先接入一个聊天模型');
  await composer(page).fill('需要一个维护订单服务的运维团队');
  await notice(page)
    .getByRole('button', { name: '配置聊天模型', exact: true })
    .click();
  await expect(
    page.getByRole('heading', { name: '模型管理', exact: true }),
  ).toBeVisible();
  await clickNavigation(page, '团队招募');
  await expect(composer(page)).toHaveValue('需要一个维护订单服务的运维团队');
  setup.state = 'decision-only';
  await page.reload();
  await expect(notice(page)).toContainText('还需要一个聊天模型');
  setup.state = 'disabled';
  await page.reload();
  await expect(notice(page)).toContainText('聊天模型已全部停用');
  await expect(composer(page)).toHaveValue('需要一个维护订单服务的运维团队');
  if (test.info().project.name === 'mobile')
    await page.setViewportSize({ width: 320, height: 851 });
  const button = notice(page).getByRole('button', {
    name: '配置聊天模型',
    exact: true,
  });
  await button.scrollIntoViewIfNeeded();
  const box = await button.boundingBox();
  expect(box.height).toBeGreaterThanOrEqual(44);
  expect(box.x).toBeGreaterThanOrEqual(0);
  expect(box.x + box.width).toBeLessThanOrEqual(page.viewportSize().width);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await page.screenshot({
    path: test.info().outputPath('setup-mobile-safe.png'),
  });
});

test('当前模型凭据锁定不被其他可用模型掩盖，真实解锁后继续草稿并识别凭据删除', async ({
  page,
  request,
}) => {
  const status = await (await request.get('/api/manage')).json();
  const passphrase = 'setup-test-passphrase';
  const action = status.vault?.initialized ? 'unlock' : 'initialize';
  expect(
    (await request.post(`/api/vault/${action}`, { data: { passphrase } })).ok(),
  ).toBe(true);
  const credential = await (
    await request.post('/api/credentials', {
      data: { name: 'Setup fixture', value: 'non-production-fixture-key' },
    })
  ).json();
  const suffix = crypto.randomUUID();
  const secureId = `setup-secure-${suffix}`;
  const openId = `setup-open-${suffix}`;
  withStore((store) => {
    for (const [id, credentialId] of [
      [secureId, credential.id],
      [openId, ''],
    ])
      store.records.save(
        'providers',
        {
          name: id === secureId ? '当前受保护模型' : '无需凭据的本机模型',
          enabled: true,
          priority: 9999,
          protocol: 'openai-completions',
          baseUrl: 'http://127.0.0.1:1/v1',
          credentialId,
          models: [
            {
              id: 'setup-model',
              name: 'Setup model',
              tools: true,
              vision: false,
              contextWindow: 8192,
            },
          ],
        },
        id,
      );
  });
  const team = seed({ providerId: secureId, model: 'setup-model' });
  try {
    expect((await request.post('/api/vault/lock', { data: {} })).ok()).toBe(
      true,
    );
    await open(page, team);
    await expect(notice(page)).toContainText('当前受保护模型：凭据库已锁定');
    await composer(page).fill('解锁之后继续讨论我的发布目标');
    await notice(page).getByRole('button', { name: '解锁模型凭据' }).click();
    await page.getByRole('button', { name: '解锁', exact: true }).click();
    const dialog = page.getByRole('dialog', {
      name: '解锁凭据库',
      exact: true,
    });
    await dialog.getByLabel('主密码', { exact: true }).fill(passphrase);
    await dialog.getByRole('button', { name: '解锁', exact: true }).click();
    await expect(dialog).toHaveCount(0);
    await clickNavigation(page, '团队招募');
    await expect(composer(page)).toHaveValue('解锁之后继续讨论我的发布目标');
    await expect(notice(page)).toContainText('模型配置已具备');
    expect(
      (
        await request.delete(`/api/credentials/${credential.id}`, { data: {} })
      ).ok(),
    ).toBe(true);
    await expect(notice(page)).toContainText('凭据已不存在');
    await expect(composer(page)).toHaveValue('解锁之后继续讨论我的发布目标');
    await page
      .getByRole('combobox', { name: '选择模型', exact: true })
      .selectOption(`${openId}::setup-model`);
    await expect(notice(page)).toContainText('模型配置已具备');
    await expect(notice(page)).not.toContainText('凭据已不存在');
  } finally {
    withStore((store) => {
      for (const id of [secureId, openId]) {
        const row = store.records.get('providers', id);
        store.records.save('providers', { ...row, enabled: false }, id);
      }
    });
    await request.post('/api/vault/lock', { data: {} });
  }
});

test('旧版默认模型显示真实配置，引导说明不要求 TypeSafe 或插件也不自动探测', async ({
  page,
}) => {
  const team = seed();
  await project(page, team, {
    state: 'legacy',
    config: { hasApiKey: true, model: 'legacy-test-model' },
  });
  let probes = 0;
  page.on('request', (request) => {
    if (new URL(request.url()).pathname.includes('/probe')) probes++;
  });
  await open(page, team);
  await expect(page.locator('.model-label')).toHaveText(
    '默认模型 · legacy-test-model',
  );
  await notice(page).getByRole('button').first().click();
  await expect(notice(page)).toContainText('TypeSafe 也是可选能力');
  await expect(notice(page)).toContainText('不会自动调用付费模型');
  await composer(page).fill('先描述需求，不必安装所有插件');
  expect(probes).toBe(0);
  await notice(page).getByRole('button', { name: '打开模型管理' }).click();
  await clickNavigation(page, '团队招募');
  await expect(composer(page)).toHaveValue('先描述需求，不必安装所有插件');
});

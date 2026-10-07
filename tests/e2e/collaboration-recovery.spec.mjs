import { expect, test } from '@playwright/test';
import { Store } from '../../server/store.mjs';
import {
  clickNavigation,
  dataDir,
  openMobileSidebar,
  sidebarLocator,
} from './team-recruitment-fixtures.mjs';

const form = (page) =>
  page.getByRole('region', { name: '团队协作控制台', exact: true });
const targetSelect = (page) =>
  form(page).getByRole('combobox', { name: '选择协作目标团队', exact: true });
const goal = (page) =>
  form(page).getByRole('textbox', { name: '协作目标', exact: true });
const criteria = (page) =>
  form(page).getByRole('textbox', { name: '协作验收标准', exact: true });
const preview = (page) =>
  form(page).getByRole('button', { name: '预览并发起协作', exact: true });
function withStore(callback) {
  const store = new Store(dataDir, process.cwd(), { seedProjectManager: true });
  try {
    return callback(store);
  } finally {
    store.close();
  }
}

function seedTeams() {
  return withStore((store) => {
    const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    const create = (label) =>
      store.saveTeamSpace({
        name: `${label} ${suffix}`,
        goal: 'Verify recoverable collaboration in isolation.',
        workspace: process.cwd(),
        pmRoleId: 'project_manager',
        memberRoleIds: ['project_manager'],
        recruitment: {
          phase: 'confirmed',
          confirmedAt: new Date().toISOString(),
        },
        collaboration: {
          enabled: true,
          allowedTeamIds: [],
          autoHandoff: true,
          sharedBoard: true,
        },
      });
    const source = create('Recovery source');
    const target = create('Recovery target');
    for (const [team, peer] of [
      [source, target],
      [target, source],
    ]) {
      store.saveTeamSpace(
        {
          ...team,
          collaboration: { ...team.collaboration, allowedTeamIds: [peer.id] },
        },
        team.id,
      );
    }
    return { source, target };
  });
}

test.afterEach(() => {
  // Real handoffs are queued on a node that will never connect. Retain their
  // history but settle fixture work so later suites do not inherit activity.
  withStore((store) => {
    for (const job of store.records.list('jobs')) {
      if (!job.nodeId?.startsWith('handoff-offline-')) continue;
      if (store.task(job.taskId)?.status === 'queued')
        store.updateTask(job.taskId, { status: 'cancelled' });
      store.records.save('jobs', { ...job, status: 'cancelled' }, job.id);
    }
  });
});
async function open(page, source) {
  await page.addInitScript((id) => {
    if (sessionStorage.getItem('collaboration-initialized')) return;
    sessionStorage.setItem('collaboration-initialized', '1');
    localStorage.setItem(
      'ggb.workspace-route.v1',
      JSON.stringify({
        spaceId: id,
        role: 'project_manager',
        view: 'workspace',
      }),
    );
  }, source.id);
  await page.goto('/');
  await expect(page.getByRole('heading', { name: source.name })).toBeVisible();
  await clickNavigation(page, '团队动态');
  await expect(targetSelect(page)).toBeEnabled();
}
async function selectTeam(page, team) {
  await openMobileSidebar(page);
  await sidebarLocator(page)
    .locator('button')
    .filter({ hasText: team.name })
    .first()
    .click({ force: true });
  await expect(page.getByRole('heading', { name: team.name })).toBeVisible();
  await clickNavigation(page, '团队动态');
}

test('协作草稿按来源团队隔离，离开与刷新保留目标和标准，修改预览必须重新审阅', async ({
  page,
}) => {
  const teams = seedTeams();
  await open(page, teams.source);
  await expect(targetSelect(page)).toHaveValue('');
  await targetSelect(page).selectOption(teams.target.id);
  await goal(page).fill('第一版协作目标');
  await criteria(page).fill('提供回滚与验证记录');
  await preview(page).click();
  await expect(
    form(page).getByRole('region', { name: '协作发送前审阅' }),
  ).toBeVisible();
  await goal(page).fill('修改后的协作目标');
  await expect(
    form(page).getByRole('region', { name: '协作发送前审阅' }),
  ).toHaveCount(0);
  await expect(preview(page)).toBeVisible();
  await clickNavigation(page, '知识库');
  await clickNavigation(page, '团队动态');
  await expect(goal(page)).toHaveValue('修改后的协作目标');
  await page.reload();
  await expect(goal(page)).toHaveValue('修改后的协作目标');
  await expect(criteria(page)).toHaveValue('提供回滚与验证记录');
  await expect(targetSelect(page)).toHaveValue(teams.target.id);
  await selectTeam(page, teams.target);
  await expect(goal(page)).toHaveValue('');
  await goal(page).fill('另一团队的协作草稿');
  await selectTeam(page, teams.source);
  await expect(goal(page)).toHaveValue('修改后的协作目标');
  await expect(criteria(page)).toHaveValue('提供回滚与验证记录');
  await expect(preview(page)).toBeVisible();
});

test('真实任务已创建但回执丢失，刷新后重试原请求只创建一次任务', async ({
  page,
}) => {
  const teams = seedTeams();
  // Queue on an offline fixture node: exercise real persistence without
  // launching a paid model or a local executor.
  const nodeId = `handoff-offline-${Date.now()}`;
  withStore((store) => {
    store.records.save(
      'providers',
      {
        name: 'Offline handoff fixture',
        protocol: 'openai-compatible',
        enabled: false,
        priority: 999,
        baseUrl: 'http://127.0.0.1:1',
        models: [],
      },
      'offline-handoff-provider',
    );
    store.records.save(
      'nodes',
      { name: '离线测试节点', status: 'offline' },
      nodeId,
    );
    const role = store.role('project_manager');
    const roleId = store.saveRole({
      ...role,
      id: undefined,
      name: '协作恢复项目经理',
      nodeId,
    }).id;
    const target = store.teamSpace(teams.target.id);
    store.saveTeamSpace(
      { ...target, pmRoleId: roleId, memberRoleIds: [roleId] },
      target.id,
    );
  });
  const sent = [];
  let receipt;
  let loseResponse = true;
  await page.route(
    `**/api/teams/${teams.source.id}/collaborate`,
    async (route) => {
      sent.push(route.request().postDataJSON());
      const response = await route.fetch();
      receipt = await response.json();
      if (loseResponse) {
        loseResponse = false;
        expect(response.status(), JSON.stringify(receipt)).toBe(201);
        await route.abort('failed');
      } else {
        expect(response.status()).toBe(200);
        await route.fulfill({ response });
      }
    },
  );
  await open(page, teams.source);
  await targetSelect(page).selectOption(teams.target.id);
  await goal(page).fill('确认回执丢失后的唯一任务');
  await criteria(page).fill('只有一个任务和两边各一条协作记录');
  await preview(page).click();
  await form(page)
    .getByRole('button', { name: '确认并发起协作', exact: true })
    .click();
  await expect(form(page).getByText(/尚未确认请求是否送达/)).toBeVisible();
  await expect(goal(page)).toBeDisabled();
  await page.reload();
  await expect(goal(page)).toHaveValue('确认回执丢失后的唯一任务');
  await expect(goal(page)).toBeDisabled();
  await form(page)
    .getByRole('button', { name: '重试确认送达', exact: true })
    .click();
  await expect(form(page).getByText(/协作请求已发送给/)).toBeVisible();
  expect(sent).toHaveLength(2);
  expect(sent[1]).toEqual(sent[0]);
  const result = withStore((store) => ({
    messages: store.records
      .list('space-messages')
      .filter((item) => item.clientMessageId === sent[0].clientMessageId),
    jobs: store.records
      .list('jobs')
      .filter((item) => item.sourceMessageId === receipt.id),
  }));
  expect(result.messages).toHaveLength(2);
  expect(
    result.messages.every((message) => message.taskId === receipt.taskId),
  ).toBe(true);
  expect(result.jobs).toHaveLength(1);
  expect(result.jobs[0].nodeId).toBe(nodeId);
  await expect(goal(page)).toHaveValue('');
  await page.reload();
  await expect(goal(page)).toHaveValue('');
  await expect(
    form(page).getByRole('button', { name: '重试确认送达', exact: true }),
  ).toHaveCount(0);
});

test('目标团队读取失败可原地重试，校验失败保留草稿并允许修正', async ({
  page,
}) => {
  const teams = seedTeams();
  let fail = true;
  await page.route(`**/api/teams/${teams.source.id}/collaborators`, (route) =>
    fail
      ? route.fulfill({ status: 503, json: { error: '目标列表暂时不可用' } })
      : route.continue(),
  );
  await page.addInitScript(
    (id) =>
      localStorage.setItem(
        `ggb.collaboration-draft.v1:${id}`,
        JSON.stringify({
          targetTeamId: '',
          content: '草稿不会丢失',
          acceptance: '检查项',
        }),
      ),
    teams.source.id,
  );
  // The target selector is disabled while unavailable, so navigate without
  // the success-only helper assertion.
  await page.goto('/');
  await selectTeam(page, teams.source);
  await expect(form(page).getByRole('alert')).toContainText(
    '目标列表暂时不可用',
  );
  await expect(goal(page)).toHaveValue('草稿不会丢失');
  fail = false;
  await form(page)
    .getByRole('button', { name: '重新读取目标团队', exact: true })
    .click();
  await expect(targetSelect(page)).toBeEnabled();
  await targetSelect(page).selectOption(teams.target.id);
  await page.route(`**/api/teams/${teams.source.id}/collaborate`, (route) =>
    route.fulfill({ status: 409, json: { error: '目标团队正在暂停' } }),
  );
  await preview(page).click();
  await form(page)
    .getByRole('button', { name: '确认并发起协作', exact: true })
    .click();
  await expect(form(page).getByRole('alert')).toContainText('目标团队正在暂停');
  await expect(goal(page)).toBeEnabled();
  await expect(goal(page)).toHaveValue('草稿不会丢失');
  await expect(preview(page)).toBeVisible();
  await form(page).scrollIntoViewIfNeeded();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await page.screenshot({
    path: test.info().outputPath('collaboration-recovery.png'),
  });
});

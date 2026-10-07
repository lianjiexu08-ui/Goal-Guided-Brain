import { expect, test } from '@playwright/test';
import { Store } from '../../server/store.mjs';
import { clickNavigation, dataDir } from './team-recruitment-fixtures.mjs';

const panel = (page) =>
  page.getByRole('region', { name: '团队协作控制台', exact: true });
const goal = (page) =>
  panel(page).getByRole('textbox', { name: '协作目标', exact: true });
const withStore = (callback) => {
  const store = new Store(dataDir, process.cwd(), { seedProjectManager: true });
  try {
    return callback(store);
  } finally {
    store.close();
  }
};
function seed() {
  return withStore((store) => {
    const suffix = crypto.randomUUID();
    const nodeId = `followup-offline-${suffix}`;
    store.records.save(
      'nodes',
      { name: 'Followup fixture', status: 'offline' },
      nodeId,
    );
    store.records.save(
      'providers',
      {
        name: 'Followup fixture',
        protocol: 'openai-compatible',
        enabled: false,
        priority: 999,
        baseUrl: 'http://127.0.0.1:1',
        models: [],
      },
      `followup-provider-${suffix}`,
    );
    const role = store.saveRole({
      ...store.role('project_manager'),
      id: undefined,
      name: 'Followup manager',
      nodeId,
    });
    const create = (name) =>
      store.saveTeamSpace({
        name: `${name} ${suffix}`,
        goal: 'Verify collaboration follow-up with isolated tasks.',
        workspace: process.cwd(),
        pmRoleId: role.id,
        memberRoleIds: [role.id],
        recruitment: {
          phase: 'confirmed',
          confirmedAt: new Date().toISOString(),
        },
        collaboration: { enabled: true, autoHandoff: true, allowedTeamIds: [] },
      });
    const source = create('Followup source');
    const target = create('Followup target');
    store.saveTeamSpace(
      {
        ...source,
        collaboration: { ...source.collaboration, allowedTeamIds: [target.id] },
      },
      source.id,
    );
    const rows = [];
    for (let index = 0; index < 5; index++) {
      const id = `followup-fixture:${suffix}:${index}`;
      const task = store.createTask({
        role: role.id,
        teamId: target.id,
        prompt: `Original goal ${index}`,
        workspace: process.cwd(),
      });
      store.updateTask(task.id, {
        status: 'completed',
        result: `Returned findings ${index}`,
      });
      store.records.save(
        'task-meta',
        { teamId: target.id, spaceId: target.id, sourceMessageId: id },
        task.id,
      );
      const input = {
        spaceId: target.id,
        kind: 'handoff',
        fromTeamId: source.id,
        toTeamId: target.id,
        clientMessageId: id,
        taskId: task.id,
        content: `原协作目标 ${index}：检查数据库迁移`,
        status: 'answered',
      };
      store.saveTeamMessage(input, id);
      store.saveTeamMessage(
        { ...input, spaceId: source.id, relatedMessageId: id },
        `${id}:source`,
      );
      const at = new Date(Date.UTC(2026, 0, 1, 0, index * 2)).toISOString();
      store.records.save(
        'space-messages',
        {
          ...store.records.get('space-messages', `${id}:source`),
          createdAt: at,
        },
        `${id}:source`,
      );
      const reply = store.saveTeamMessage(
        {
          spaceId: source.id,
          kind: 'reply',
          fromTeamId: target.id,
          toTeamId: source.id,
          relatedMessageId: `${id}:source`,
          taskId: task.id,
          content: `回传结果 ${index}\n需要补齐迁移回滚清单。\n结尾证据：migration-check-${index}`,
          status: 'answered',
        },
        `handoff-reply:${task.id}`,
      );
      store.records.save(
        'space-messages',
        { ...reply, createdAt: new Date(Date.parse(at) + 1000).toISOString() },
        reply.id,
      );
      rows.push({ taskId: task.id, sourceMessageId: `${id}:source` });
    }
    return { source, target, rows };
  });
}
async function open(page, source) {
  await page.addInitScript((id) => {
    if (sessionStorage.getItem('followup-initialized')) return;
    sessionStorage.setItem('followup-initialized', '1');
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
  await expect(
    panel(page).getByRole('combobox', { name: '选择协作目标团队' }),
  ).toBeEnabled();
}
test.afterEach(() =>
  withStore((store) => {
    for (const job of store.records.list('jobs')) {
      if (!job.nodeId?.startsWith('followup-offline-')) continue;
      if (store.task(job.taskId)?.status === 'queued')
        store.updateTask(job.taskId, { status: 'cancelled' });
      store.records.save('jobs', { ...job, status: 'cancelled' }, job.id);
    }
  }),
);

test('完整阅读回传并加载更早协作，手机布局和操作保持可用', async ({
  page,
}, info) => {
  const teams = seed();
  await open(page, teams.source);
  const history = panel(page).locator('.team-collaboration-history');
  await expect(history.locator('article')).toHaveCount(8);
  const reply = history.locator('article').filter({ hasText: '回传结果 4' });
  await expect(
    reply.getByText('结尾证据：migration-check-4', { exact: false }),
  ).not.toBeVisible();
  await reply.locator('summary').click();
  await expect(reply.locator('details > div')).toContainText(
    '结尾证据：migration-check-4',
  );
  await expect(reply.locator('details > div')).toBeVisible();
  const button = reply.getByRole('button', { name: '继续协作' });
  expect((await button.boundingBox()).height).toBeGreaterThanOrEqual(44);
  await page.screenshot({
    path: info.outputPath('expanded-result.png'),
    fullPage: true,
  });
  await panel(page).getByRole('button', { name: '加载更早协作' }).click();
  await expect(history.locator('article')).toHaveCount(10);
  await expect(
    history.locator('article').filter({ hasText: '原协作目标 0' }),
  ).toBeVisible();
  await expect(
    panel(page).getByRole('button', { name: '加载更早协作' }),
  ).toHaveCount(0);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
});

test('继续协作保护已有草稿，刷新保留引用，审阅后创建带原始上下文的独立任务', async ({
  page,
}, info) => {
  const teams = seed();
  await open(page, teams.source);
  await goal(page).fill('已有草稿，不能直接覆盖');
  const reply = panel(page)
    .locator('article')
    .filter({ hasText: '回传结果 4' });
  await reply.getByRole('button', { name: '继续协作' }).click();
  const choice = panel(page).getByRole('region', {
    name: '保留或替换协作草稿',
  });
  await choice.getByRole('button', { name: '保留当前草稿' }).click();
  await expect(goal(page)).toHaveValue('已有草稿，不能直接覆盖');
  await reply.getByRole('button', { name: '继续协作' }).click();
  await choice.getByRole('button', { name: '替换草稿并继续' }).click();
  await expect(goal(page)).toHaveValue('');
  await expect(
    panel(page).getByRole('combobox', { name: '选择协作目标团队' }),
  ).toBeDisabled();
  await goal(page).fill('请补齐迁移回滚清单和实际验证');
  await page.reload();
  await expect(goal(page)).toHaveValue('请补齐迁移回滚清单和实际验证');
  await expect(
    panel(page).getByRole('region', { name: '引用的原协作' }),
  ).toContainText('回传结果 4');
  await panel(page).getByRole('button', { name: '预览并发起协作' }).click();
  await expect(
    panel(page).getByRole('region', { name: '协作发送前审阅' }),
  ).toContainText('自动附上原请求及回传');
  await page.screenshot({
    path: info.outputPath('followup-review.png'),
    fullPage: true,
  });
  const responsePromise = page.waitForResponse(
    (response) =>
      response.url().includes(`/teams/${teams.source.id}/collaborate`) &&
      response.request().method() === 'POST',
  );
  await panel(page).getByRole('button', { name: '确认并发起协作' }).click();
  const response = await responsePromise;
  const receipt = await response.json();
  expect(response.status(), JSON.stringify(receipt)).toBe(201);
  await expect(
    panel(page).getByRole('region', { name: '引用的原协作' }),
  ).toHaveCount(0);
  const data = withStore((store) => ({
    task: store.task(receipt.taskId),
    original: store.task(teams.rows[4].taskId),
    trace: store.records.get('space-messages', receipt.sourceMessageId),
  }));
  expect(data.task.prompt).toContain('原协作目标 4');
  expect(data.task.prompt).toContain('结尾证据：migration-check-4');
  expect(data.task.prompt).toContain('请补齐迁移回滚清单和实际验证');
  expect(data.task.sessionId).not.toBe(data.original.sessionId);
  expect(data.trace.followupMessageId).toBe(teams.rows[4].sourceMessageId);
});

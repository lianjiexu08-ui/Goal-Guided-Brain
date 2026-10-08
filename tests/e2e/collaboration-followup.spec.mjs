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

test('结束跟进保存说明，丢失回执后刷新重试不重复记录，重新打开后恢复追问', async ({
  page,
}, info) => {
  const teams = seed();
  await open(page, teams.source);
  const row = () =>
    panel(page).locator('article').filter({ hasText: '原协作目标 4' });
  await row().getByRole('button', { name: '处理协作', exact: true }).click();
  const review = () => row().getByRole('region', { name: '协作收尾处理' });
  await review()
    .getByRole('combobox', { name: '协作处理方式' })
    .selectOption('end');
  await expect(
    review().getByRole('button', { name: '结束跟进', exact: true }),
  ).toBeDisabled();
  await review()
    .getByRole('textbox', { name: '协作处理说明' })
    .fill('需求已取消，保留交付状态');
  await clickNavigation(page, '知识库');
  await clickNavigation(page, '团队动态');
  await row().getByRole('button', { name: '处理协作', exact: true }).click();
  await expect(
    review().getByRole('textbox', { name: '协作处理说明' }),
  ).toHaveValue('需求已取消，保留交付状态');
  let first = true;
  const requests = [];
  let holdCleanup = false;
  let cleanupStarted = false;
  let releaseCleanup;
  const cleanupGate = new Promise((resolve) => {
    releaseCleanup = resolve;
  });
  await page.route(
    (url) =>
      url.pathname.endsWith('/collaboration-draft') &&
      url.searchParams.get('messageId') === teams.rows[4].sourceMessageId,
    async (route) => {
      if (holdCleanup && route.request().method() === 'GET') {
        holdCleanup = false;
        cleanupStarted = true;
        await cleanupGate;
      }
      await route.continue();
    },
  );
  await page.route('**/collaboration-review/**', async (route) => {
    if (route.request().method() !== 'POST') return route.continue();
    requests.push(route.request().postDataJSON());
    const response = await route.fetch();
    expect(response.status()).toBe(200);
    if (first) {
      first = false;
      await route.abort('failed');
    } else {
      holdCleanup = true;
      await route.fulfill({ response });
    }
  });
  await review().getByRole('button', { name: '结束跟进', exact: true }).click();
  await expect(
    review().getByRole('button', { name: '重试确认处理结果' }),
  ).toBeVisible();
  await page.reload();
  await row()
    .getByRole('button', { name: '查看收尾记录', exact: true })
    .click();
  await review().getByRole('button', { name: '重试确认处理结果' }).click();
  try {
    await expect.poll(() => cleanupStarted).toBe(true);
    await expect(
      row().getByRole('button', { name: '查看收尾记录', exact: true }),
    ).toBeDisabled();
    await expect(
      review().getByRole('textbox', { name: '协作处理说明' }),
    ).toBeDisabled();
  } finally {
    releaseCleanup();
  }
  await expect(review()).toHaveCount(0);
  expect(requests).toHaveLength(2);
  expect(requests[0].requestId).toBe(requests[1].requestId);
  await expect(
    row().getByText('已结束跟进（不代表验收通过）', { exact: true }),
  ).toBeVisible();
  await expect(
    row().getByRole('button', { name: '继续协作', exact: true }),
  ).toHaveCount(0);
  const events = withStore((store) =>
    store.records
      .list('handoff-review-events')
      .filter((event) => event.messageId === teams.rows[4].sourceMessageId),
  );
  expect(events).toHaveLength(1);
  await row()
    .getByRole('button', { name: '查看收尾记录', exact: true })
    .click();
  await review()
    .getByRole('textbox', { name: '协作处理说明' })
    .fill('需求恢复，继续处理');
  await page.screenshot({
    path: info.outputPath('review-reopen.png'),
    fullPage: true,
  });
  await review().getByRole('button', { name: '重新打开', exact: true }).click();
  await expect(
    row().getByRole('button', { name: '继续协作', exact: true }),
  ).toBeVisible();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
});

test('协作完成复用交付验收，证据变化提示重新复核，旧页面决定拒绝覆盖新状态', async ({
  page,
  request,
}) => {
  const teams = seed();
  await open(page, teams.source);
  const row = () =>
    panel(page).locator('article').filter({ hasText: '原协作目标 4' });
  const review = () => row().getByRole('region', { name: '协作收尾处理' });
  await row().getByRole('button', { name: '处理协作', exact: true }).click();
  await expect(
    review().getByRole('button', { name: '确认完成', exact: true }),
  ).toBeDisabled();
  await expect(
    review().getByRole('button', { name: '查看任务并复核交付' }),
  ).toBeVisible();
  const taskId = teams.rows[4].taskId;
  const evidence = withStore((store) =>
    store.records.save('artifacts', {
      taskId,
      kind: 'verification',
      status: 'verified',
      verified: true,
      requirementVersion: 1,
    }),
  );
  expect(
    (
      await request.post(`/api/tasks/${taskId}/accept`, {
        data: { note: '实际复核通过' },
      })
    ).status(),
  ).toBe(200);
  await review().getByRole('button', { name: '刷新处理状态' }).click();
  await expect(
    review().getByRole('button', { name: '确认完成', exact: true }),
  ).toBeEnabled();
  await review().getByRole('button', { name: '确认完成', exact: true }).click();
  await expect(row().getByText('已确认完成', { exact: true })).toBeVisible();
  withStore((store) =>
    store.records.save(
      'artifacts',
      { ...evidence, status: 'failed', verified: false },
      evidence.id,
    ),
  );
  await expect(
    row().getByRole('button', { name: '重新复核协作', exact: true }),
  ).toBeVisible();
  await row()
    .getByRole('button', { name: '重新复核协作', exact: true })
    .click();
  await expect(review()).toContainText('原收尾结论需要重新复核');
  await review()
    .getByRole('textbox', { name: '协作处理说明' })
    .fill('旧页面的处理原因');
  const endpoint = `/api/teams/${teams.source.id}/collaboration-review/${encodeURIComponent(teams.rows[4].sourceMessageId)}`;
  const fresh = await (await request.get(endpoint)).json();
  expect(
    (
      await request.post(endpoint, {
        data: {
          action: 'reopen',
          note: '另一页面已重新打开',
          fingerprint: fresh.fingerprint,
          revision: fresh.revision,
          requestId: crypto.randomUUID(),
        },
      })
    ).status(),
  ).toBe(200);
  await review().getByRole('button', { name: '重新打开', exact: true }).click();
  await expect(review().getByRole('alert')).toContainText('状态已更新');
  await expect(
    review().getByRole('textbox', { name: '协作处理说明' }),
  ).toHaveValue('旧页面的处理原因');
  await review().getByRole('button', { name: '重新读取状态' }).click();
  await expect(
    review().getByRole('combobox', { name: '协作处理方式' }),
  ).toHaveValue('complete');
  const persisted = await (await request.get(endpoint)).json();
  expect(persisted.note).toBe('另一页面已重新打开');
  expect(persisted.history).toHaveLength(2);
});

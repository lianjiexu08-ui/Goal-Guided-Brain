import { expect, test } from '@playwright/test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { Store } from '../../server/store.mjs';
import { ControlPlane } from '../../server/control.mjs';
import { clickNavigation, dataDir } from './team-recruitment-fixtures.mjs';

function withStore(fn) {
  const store = new Store(dataDir, process.cwd(), { seedProjectManager: true });
  try {
    return fn(store);
  } finally {
    store.close();
  }
}
function seed() {
  return withStore((store) => {
    const suffix = crypto.randomUUID().slice(0, 8);
    const nodeId = `onward-browser-${suffix}`;
    store.records.save(
      'nodes',
      { name: 'Onward browser fixture', status: 'offline' },
      nodeId,
    );
    store.records.save(
      'providers',
      {
        name: 'Onward fixture',
        protocol: 'openai-compatible',
        enabled: false,
        priority: 999,
        baseUrl: 'http://127.0.0.1:1',
        models: [],
      },
      `onward-provider-${suffix}`,
    );
    const role = store.saveRole({
      ...store.role('project_manager'),
      id: undefined,
      name: `转派经理 ${suffix}`,
      nodeId,
    });
    const teams = ['产品团队', '开发团队', '运维团队'].map((name) =>
      store.saveTeamSpace({
        name: `${name} ${suffix} · 多团队协作与产品发布验证`,
        goal: '验证可追溯的多团队协作',
        workspace: process.cwd(),
        pmRoleId: role.id,
        memberRoleIds: [role.id],
        recruitment: {
          phase: 'confirmed',
          confirmedAt: new Date().toISOString(),
        },
        collaboration: { enabled: true, autoHandoff: true, allowedTeamIds: [] },
      }),
    );
    return { teams, nodeId };
  });
}
async function handoff(request, source, target, title) {
  const response = await request.post(
    `http://127.0.0.1:3289/api/teams/${source.id}/collaborate`,
    {
      data: {
        targetTeamId: target.id,
        content: title,
        clientMessageId: crypto.randomUUID(),
      },
    },
  );
  const body = await response.json();
  expect(response.status(), JSON.stringify(body)).toBe(201);
  return body;
}
async function caller(taskId, clients) {
  const lease = withStore((store) => {
    const task = store.task(taskId);
    const meta = store.records.get('task-meta', taskId);
    return new ControlPlane({ store }).claimLocal(task, meta.nodeId);
  });
  expect(lease).toBeTruthy();
  const client = new Client({ name: 'onward-browser', version: '1' });
  clients.push(client);
  await client.connect(
    new StreamableHTTPClientTransport(
      new URL('http://127.0.0.1:3289/api/mcp'),
      { requestInit: { headers: { Authorization: `Bearer ${lease.token}` } } },
    ),
  );
  return {
    lease,
    delegate: async (target, extra = {}) => {
      const response = await client.callTool({
        name: 'delegate_to_team',
        arguments: {
          teamId: target.id,
          prompt: `请 ${target.name} 完成验证并回传`,
          idempotencyKey: crypto.randomUUID(),
          ...extra,
        },
      });
      expect(response.isError, response.content[0].text).not.toBe(true);
      return JSON.parse(response.content[0].text);
    },
  };
}
const panel = (page) =>
  page.getByRole('region', { name: '团队协作控制台', exact: true });
const chain = (page) =>
  page.getByRole('region', { name: '协作链路', exact: true });
async function open(page, source, title) {
  await page.addInitScript(
    (id) =>
      localStorage.setItem(
        'ggb.workspace-route.v1',
        JSON.stringify({
          spaceId: id,
          role: 'project_manager',
          view: 'workspace',
        }),
      ),
    source.id,
  );
  await page.goto('/');
  await expect(page.getByRole('heading', { name: source.name })).toBeVisible();
  await clickNavigation(page, '团队动态');
  await panel(page)
    .locator('article.team-collaboration-item')
    .filter({ has: page.locator('summary > span', { hasText: title }) })
    .first()
    .getByRole('button', { name: '查看协作链路' })
    .click();
}

test.afterEach(() =>
  withStore((store) => {
    const control = new ControlPlane({ store });
    for (const meta of store.records.list('task-meta')) {
      if (!meta.nodeId?.startsWith('onward-browser-')) continue;
      const task = store.task(meta.id);
      if (!task || !['queued', 'running', 'waiting'].includes(task.status))
        continue;
      control.revokeExecution(task.id, 'test cleanup');
      store.updateTask(task.id, { status: 'cancelled' });
      const job = store.records.get('jobs', meta.jobId);
      if (job)
        store.records.save('jobs', { ...job, status: 'cancelled' }, job.id);
    }
  }),
);

test('真实 MCP 转派连接产品、开发和运维团队，并可回到发起任务', async ({
  page,
  request,
}) => {
  const {
    teams: [a, b, c],
  } = seed();
  const clients = [];
  try {
    const root = await handoff(request, a, b, '产品发布协作');
    const developer = await caller(root.taskId, clients);
    const onward = await developer.delegate(c);
    const operator = await caller(onward.taskId, clients);
    await operator.delegate(a);
    withStore((store) =>
      store.updateTask(onward.taskId, { result: '运维未共享的内部草稿' }),
    );
    await open(page, a, '产品发布协作');
    await expect(chain(page).locator('li')).toHaveCount(3);
    await expect(chain(page)).toContainText('涉及 3 个团队');
    await expect(chain(page)).toContainText('#2 转派自 #1');
    await expect(chain(page)).toContainText('#3 转派自 #2');
    await expect(chain(page)).toContainText(`${b.name} → ${c.name}`);
    await expect(chain(page)).toContainText(`${c.name} → ${a.name}`);
    await expect(chain(page)).not.toContainText('运维未共享的内部草稿');
    expect(
      await chain(page).evaluate(
        (element) => element.scrollWidth > element.clientWidth + 1,
      ),
    ).toBe(false);
    const sourceLink = chain(page).getByRole('button', {
      name: '查看第 2 次请求的发起任务',
    });
    expect((await sourceLink.boundingBox()).height).toBeGreaterThanOrEqual(44);
    await chain(page)
      .getByRole('heading', { name: '协作链路', exact: true })
      .scrollIntoViewIfNeeded();
    const layout = await page.locator('.team-page').evaluate((element) => ({
      width: element.clientWidth,
      contentWidth: element.scrollWidth,
      scrollLeft: element.scrollLeft,
    }));
    expect(layout.contentWidth).toBeLessThanOrEqual(layout.width + 1);
    expect(layout.scrollLeft).toBe(0);
    const bounds = await chain(page).boundingBox();
    expect(bounds.x).toBeGreaterThanOrEqual(0);
    expect(bounds.x + bounds.width).toBeLessThanOrEqual(
      page.viewportSize().width + 1,
    );
    await page.screenshot({ path: test.info().outputPath('onward-chain.png') });
    await sourceLink.click();
    await expect(page.getByRole('heading', { name: b.name })).toBeVisible();
    await expect(page.locator(`[data-turn-id="${root.taskId}"]`)).toBeVisible();
  } finally {
    await Promise.allSettled(clients.map((client) => client.close()));
  }
});

test('跨目标引用保留两个起始请求，共享后续不重复，损坏记录刷新后提示未纳入', async ({
  page,
  request,
}) => {
  const {
    teams: [a, b, c],
    nodeId,
  } = seed();
  const clients = [];
  try {
    const root = await handoff(request, a, b, '首项发布需求');
    const other = await handoff(request, a, b, '第二项发布需求');
    const first = await caller(root.taskId, clients);
    const original = await first.delegate(c);
    const receiver = await caller(original.taskId, clients);
    withStore((store) =>
      new ControlPlane({ store }).finishLocal(
        original.taskId,
        receiver.lease.execution.epoch,
        { status: 'completed', result: '运维检查已完成' },
        nodeId,
      ),
    );
    const second = await caller(other.taskId, clients);
    await second.delegate(c, { followupMessageId: original.sourceMessageId });
    await open(page, a, '首项发布需求');
    await expect(chain(page).locator('li')).toHaveCount(4);
    await expect(chain(page)).toContainText('2 个起始请求');
    const successor = chain(page).locator('li').last();
    await expect(successor).toContainText('接续 #3');
    await expect(successor).toContainText('转派自 #2');
    expect(
      await chain(page)
        .locator('li')
        .evaluateAll(
          (items) => new Set(items.map((item) => item.dataset.messageId)).size,
        ),
    ).toBe(4);
    withStore((store) =>
      store.records.remove('space-messages', original.sourceMessageId),
    );
    await chain(page).getByRole('button', { name: '刷新链路' }).click();
    await expect(chain(page).locator('li')).toHaveCount(1);
    await expect(chain(page)).toContainText('另有 1 条转派关联未能纳入');
    await expect(chain(page)).toContainText('部分来源或引用无法确认');
  } finally {
    await Promise.allSettled(clients.map((client) => client.close()));
  }
});

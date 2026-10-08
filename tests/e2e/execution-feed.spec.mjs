import { expect, test } from '@playwright/test';
import {
  emit,
  fakeStreams,
  open,
  seed,
  waitLive,
  write,
} from './execution-feed-fixtures.mjs';

const endpoint = (fixture) => `**/api/tasks/${fixture.taskId}`;

test('执行详情首次失败和损坏响应可重试，刷新失败保留已有执行证据', async ({
  page,
}, testInfo) => {
  const fixture = seed();
  let mode = 'fail';
  await fakeStreams(page);
  await page.route(endpoint(fixture), (route) =>
    mode === 'fail'
      ? route.fulfill({ status: 503, json: { error: '详情暂不可用' } })
      : mode === 'invalid'
        ? route.fulfill({ json: { id: fixture.taskId, events: null } })
        : route.continue(),
  );
  const panel = await open(page, fixture);
  await expect(panel).toContainText('详情暂不可用');
  await expect(panel.locator('.delivery-summary')).toHaveCount(0);
  mode = 'invalid';
  await panel.getByRole('button', { name: '重试读取' }).click();
  await expect(panel).toContainText('执行详情返回了无效数据');
  mode = 'ok';
  await panel.getByRole('button', { name: '重试读取' }).click();
  await waitLive(panel);
  mode = 'fail';
  await panel.getByRole('button', { name: '刷新进展' }).click();
  await expect(panel).toContainText('更新失败，显示上次结果');
  await expect(panel.locator('.delivery-summary')).toContainText(
    '原有执行结果',
  );
  mode = 'ok';
  await panel.getByRole('button', { name: '重试读取' }).click();
  await waitLive(panel);
  await expect(panel).not.toContainText('详情暂不可用');
  const box = await panel
    .getByRole('button', { name: '刷新进展' })
    .boundingBox();
  expect(box.height).toBeGreaterThanOrEqual(44);
  expect(box.x).toBeGreaterThanOrEqual(0);
  expect(box.x + box.width).toBeLessThanOrEqual(page.viewportSize().width);
  await page.screenshot({ path: testInfo.outputPath('execution-feed.png') });
});

test('事件流临时错误允许原连接恢复，晚到详情不覆盖新读取和新事件', async ({
  page,
}) => {
  const fixture = seed();
  await fakeStreams(page);
  const panel = await open(page, fixture);
  await waitLive(panel);
  await emit(page, 'error');
  await expect(panel).toContainText('正在重连，暂用定时更新');
  expect(
    await page.evaluate(() => window.__taskStreams.at(-1).readyState),
  ).toBe(0);
  await emit(page, 'ready');
  await expect(panel.locator('.execution-feed-status')).toContainText(
    '实时更新',
  );
  let release;
  let delivered;
  const delivery = new Promise((resolve) => {
    delivered = resolve;
  });
  let captured;
  const capturedPromise = new Promise((resolve) => {
    captured = resolve;
  });
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  let delay = true;
  await page.route(endpoint(fixture), async (route) => {
    if (!delay) return route.continue();
    delay = false;
    const response = await route.fetch();
    captured();
    await gate;
    await route.fulfill({ response });
    delivered?.();
  });
  try {
    await panel.getByRole('button', { name: '刷新进展' }).click();
    await capturedPromise;
    write((store) =>
      store.updateTask(fixture.taskId, { error: '恢复后最新执行结果' }),
    );
    await page.evaluate(() => window.dispatchEvent(new Event('online')));
    await expect(panel.locator('.delivery-summary')).toContainText(
      '恢复后最新执行结果',
    );
    release();
    await delivery;
    await expect(panel.locator('.delivery-summary')).not.toContainText(
      '原有执行结果',
    );
    const event = write((store) =>
      store.records.save('task-events', {
        taskId: fixture.taskId,
        type: 'routing/fallback',
        data: { reason: '重连后的实时证据', from: {}, to: {} },
      }),
    );
    await emit(page, 'task_event', event);
    await expect(panel).toContainText('重连后的实时证据');
  } finally {
    release();
  }
});

test('真实离线恢复会重连并读取新状态，关闭详情释放事件连接', async ({
  page,
  context,
}) => {
  const fixture = seed();
  const panel = await open(page, fixture);
  await waitLive(panel);
  const streams = [];
  page.on('request', (request) => {
    if (request.url().includes(`/tasks/${fixture.taskId}/events/stream`))
      streams.push(request);
  });
  await context.setOffline(true);
  await expect(panel).toContainText(/当前离线|更新失败/);
  await expect(panel.locator('.delivery-summary')).toContainText(
    '原有执行结果',
  );
  write((store) =>
    store.updateTask(fixture.taskId, { error: '联网后读取到的新状态' }),
  );
  await context.setOffline(false);
  await expect(panel.locator('.delivery-summary')).toContainText(
    '联网后读取到的新状态',
  );
  await expect(panel.locator('.execution-feed-status')).toContainText(
    '实时更新',
  );
  expect(streams.length).toBeGreaterThan(0);
  await page
    .getByRole('dialog', { name: fixture.label })
    .getByRole('button', { name: 'Close', exact: true })
    .click();
  await expect(panel).toHaveCount(0);
});

test('详情读取期间的新事件不丢失，关闭的流从游标重新连接且关闭面板释放连接', async ({
  page,
}) => {
  const fixture = seed();
  await fakeStreams(page);
  const panel = await open(page, fixture);
  await waitLive(panel);
  let release;
  let delivered;
  const delivery = new Promise((resolve) => {
    delivered = resolve;
  });
  let entered;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const start = new Promise((resolve) => {
    entered = resolve;
  });
  await page.route(
    endpoint(fixture),
    async (route) => {
      const response = await route.fetch();
      entered();
      await gate;
      await route.fulfill({ response });
      delivered?.();
    },
    { times: 1 },
  );
  try {
    await panel.getByRole('button', { name: '刷新进展' }).click();
    await start;
    const event = write((store) =>
      store.records.save('task-events', {
        taskId: fixture.taskId,
        type: 'routing/fallback',
        data: { reason: '读取期间的最新事件', from: {}, to: {} },
      }),
    );
    await emit(page, 'task_event', event);
    await expect(panel).toContainText('读取期间的最新事件');
    release();
    await delivery;
    await expect(panel.getByRole('button', { name: '刷新进展' })).toBeEnabled();
    await expect(
      panel.getByText('原因：读取期间的最新事件', { exact: true }),
    ).toHaveCount(1);
    await page.evaluate(() => {
      const source = window.__taskStreams.at(-1);
      source.readyState = 2;
      source.dispatchEvent(new Event('error'));
    });
    await expect
      .poll(() => page.evaluate(() => window.__taskStreams.length))
      .toBe(2);
    expect(
      await page.evaluate(() => window.__taskStreams.at(-1).url),
    ).toContain(encodeURIComponent(event.id));
    await expect(panel.locator('.execution-feed-status')).toContainText(
      '实时更新',
    );
    await page
      .getByRole('dialog', { name: fixture.label })
      .getByRole('button', { name: 'Close', exact: true })
      .click();
    expect(
      await page.evaluate(() =>
        window.__taskStreams.every((source) => source.readyState === 2),
      ),
    ).toBe(true);
  } finally {
    release();
  }
});

test('验收备注在离线和刷新失败后保留，恢复读取不会自动提交决定', async ({
  page,
}) => {
  const fixture = seed();
  write((store) =>
    store.updateTask(fixture.taskId, { status: 'completed', error: '' }),
  );
  await fakeStreams(page);
  const panel = await open(page, fixture);
  const input = panel.getByRole('textbox', { name: '验收备注' });
  await input.fill('请补充集成测试证据');
  let failing = true;
  await page.route(endpoint(fixture), (route) =>
    failing
      ? route.fulfill({ status: 503, json: { error: '测试网络暂断' } })
      : route.continue(),
  );
  await panel.getByRole('button', { name: '刷新进展' }).click();
  await expect(panel).toContainText('更新失败，显示上次结果');
  await expect(input).toHaveValue('请补充集成测试证据');
  failing = false;
  await panel.getByRole('button', { name: '重试读取' }).click();
  await expect(panel).not.toContainText('测试网络暂断');
  await expect(input).toHaveValue('请补充集成测试证据');
  const saved = write((store) =>
    store.taskDelivery(store.task(fixture.taskId)),
  );
  expect(saved.acceptanceDecision).not.toBe('rejected');
});

test('读取超时后仍可手动重试，迟到的超时响应不会覆盖恢复结果', async ({
  page,
}) => {
  const fixture = seed();
  await fakeStreams(page);
  const panel = await open(page, fixture);
  await waitLive(panel);
  await page.clock.install();
  let hanging = true;
  let release;
  let delivered;
  const delivery = new Promise((resolve) => {
    delivered = resolve;
  });
  let entered;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const start = new Promise((resolve) => {
    entered = resolve;
  });
  await page.route(endpoint(fixture), async (route) => {
    if (!hanging) return route.continue();
    const response = await route.fetch();
    entered();
    await gate;
    await route.fulfill({ response });
    delivered?.();
  });
  try {
    await panel.getByRole('button', { name: '刷新进展' }).click();
    await start;
    await page.clock.fastForward(10_001);
    await expect(panel).toContainText('执行详情读取超时');
    await expect(panel.getByRole('button', { name: '重试读取' })).toBeEnabled();
    await expect(panel.locator('.delivery-summary')).toContainText(
      '原有执行结果',
    );
    hanging = false;
    write((store) =>
      store.updateTask(fixture.taskId, { error: '超时后恢复的结果' }),
    );
    await panel.getByRole('button', { name: '重试读取' }).click();
    await expect(panel.locator('.delivery-summary')).toContainText(
      '超时后恢复的结果',
    );
    release();
    await delivery;
    await expect(panel).not.toContainText('执行详情读取超时');
  } finally {
    release();
  }
});

test('切换执行详情隔离读取、错误和连接，旧任务响应不能覆盖新任务', async ({
  page,
}) => {
  const first = seed();
  const second = seed();
  write((store) =>
    store.updateTask(second.taskId, { error: '第二个任务的独立结果' }),
  );
  await fakeStreams(page);
  const oldPanel = await open(page, first);
  await waitLive(oldPanel);
  let release;
  let delivered;
  const delivery = new Promise((resolve) => {
    delivered = resolve;
  });
  let entered;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const start = new Promise((resolve) => {
    entered = resolve;
  });
  await page.route(endpoint(first), async (route) => {
    const response = await route.fetch();
    entered();
    await gate;
    await route.fulfill({ response });
    delivered?.();
  });
  try {
    await oldPanel.getByRole('button', { name: '刷新进展' }).click();
    await start;
    await page
      .getByRole('dialog', { name: first.label })
      .getByRole('button', { name: 'Close', exact: true })
      .click();
    await page.getByRole('button', { name: second.label, exact: true }).click();
    const dialog = page.getByRole('dialog', { name: second.label });
    await dialog
      .getByRole('button', { name: second.label, exact: true })
      .click();
    const nextPanel = dialog
      .locator('.manage-detail')
      .filter({
        has: page.getByRole('heading', { name: '执行目录与验收', exact: true }),
      })
      .last();
    await expect(nextPanel.locator('.delivery-summary')).toContainText(
      '第二个任务的独立结果',
    );
    release();
    await delivery;
    await expect(nextPanel.locator('.delivery-summary')).not.toContainText(
      '原有执行结果',
    );
    expect(await page.evaluate(() => window.__taskStreams[0].readyState)).toBe(
      2,
    );
    expect(
      await page.evaluate(() => window.__taskStreams.at(-1).url),
    ).toContain(second.taskId);
  } finally {
    release();
  }
});

test('没有事件流能力时仍通过游标恢复进展，保留最新状态且不重复事件', async ({
  page,
}) => {
  const fixture = seed();
  await page.addInitScript(() => {
    delete window.EventSource;
  });
  const cursors = [];
  page.on('request', (request) => {
    const url = new URL(request.url());
    if (url.pathname === `/api/tasks/${fixture.taskId}/events`)
      cursors.push(url.searchParams.get('after'));
  });
  const panel = await open(page, fixture);
  await expect(panel.locator('.delivery-summary')).toContainText(
    '原有执行结果',
  );
  await expect(panel.locator('.execution-feed-status')).toContainText(
    '定时更新',
  );
  const event = write((store) => {
    store.updateTask(fixture.taskId, { error: '定时恢复的新结果' });
    return store.records.save('task-events', {
      taskId: fixture.taskId,
      type: 'routing/fallback',
      data: { reason: '定时读取补回的证据', from: {}, to: {} },
    });
  });
  await expect(panel.locator('.delivery-summary')).toContainText(
    '定时恢复的新结果',
  );
  await expect(
    panel.getByText('原因：定时读取补回的证据', { exact: true }),
  ).toHaveCount(1);
  await expect
    .poll(() => cursors.some((value) => value?.endsWith(`|${event.id}`)))
    .toBe(true);
  await page.clock.install();
  write((store) =>
    store.updateTask(fixture.taskId, { error: '没有新事件时的最新状态' }),
  );
  await page.clock.fastForward(16_000);
  await expect(panel.locator('.delivery-summary')).toContainText(
    '没有新事件时的最新状态',
  );
});

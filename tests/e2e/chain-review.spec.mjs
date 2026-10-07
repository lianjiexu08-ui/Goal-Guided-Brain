import { expect, test } from '@playwright/test';
import {
  seed,
  withStore,
  open,
  article,
  chain,
} from './collaboration-chain-fixture.mjs';
const panel = (page) =>
  page.getByRole('region', { name: '整条链路收尾预览', exact: true });
const note = (page) =>
  panel(page).getByRole('textbox', { name: '链路处理说明', exact: true });
const consent = (page) =>
  panel(page).getByRole('checkbox', { name: '我已核对以上全部范围及处理方式' });
const confirm = (page) =>
  panel(page).getByRole('button', { name: '结束整条链路跟进', exact: true });
async function preview(page, data) {
  await open(page, data);
  await article(page, '链路请求 0：')
    .getByRole('button', { name: '查看协作链路' })
    .click();
  await chain(page)
    .getByRole('button', { name: '整条链路收尾', exact: true })
    .click();
  await expect(panel(page).getByRole('heading')).toBeFocused();
  await expect(
    panel(page).getByRole('region', { name: '链路处理草稿同步' }),
  ).toContainText('草稿已同步');
}
function reviews(data) {
  return withStore((store) =>
    data.rows
      .slice(0, 23)
      .map((row) => store.records.get('handoff-reviews', row.sourceMessageId)),
  );
}

test('整条链路预览含未展开历史，手机可核对全部范围并结束和重新打开', async ({
  page,
}) => {
  const data = seed();
  await preview(page, data);
  await expect(
    chain(page).locator('.collaboration-chain-list > li'),
  ).toHaveCount(20);
  await expect(
    panel(page).getByLabel('全部处理范围').locator('li'),
  ).toHaveCount(23);
  await expect(panel(page)).toContainText('当前交付尚未验收');
  await expect(
    panel(page).getByRole('button', { name: '确认整条链路完成', exact: true }),
  ).toBeDisabled();
  await panel(page)
    .getByRole('combobox', { name: '链路处理方式' })
    .selectOption('end');
  await note(page).fill('已核对全部分支，结束本轮跟进');
  await expect(confirm(page)).toBeDisabled();
  await consent(page).check();
  const box = await confirm(page).boundingBox();
  expect(box.height).toBeGreaterThanOrEqual(44);
  await confirm(page).click();
  await expect(panel(page)).toHaveCount(0);
  await expect(chain(page)).toContainText('处理 23 次请求');
  expect(
    reviews(data).every(
      (row) => row.status === 'closed' && row.action === 'end',
    ),
  ).toBe(true);
  expect(
    withStore((store) =>
      store.records.get('handoff-reviews', data.rows[23].sourceMessageId),
    ),
  ).toBeNull();
  await expect(chain(page).getByLabel('整条链路状态')).toContainText(
    '23 已收尾',
  );
  await chain(page)
    .getByRole('button', { name: '整条链路收尾', exact: true })
    .click();
  await panel(page).getByRole('combobox').selectOption('reopen');
  await note(page).fill('继续跟进下一版');
  await consent(page).check();
  await panel(page)
    .getByRole('button', { name: '重新打开整条链路', exact: true })
    .click();
  await expect(panel(page)).toHaveCount(0);
  expect(reviews(data).every((row) => row.status === 'open')).toBe(true);
  expect(
    withStore((store) =>
      data.rows.every((row) =>
        ['completed', 'failed'].includes(store.task(row.task.id).status),
      ),
    ),
  ).toBe(true);
});

test('预览后变化阻止整批写入，处理说明保留，重新核对后可提交', async ({
  page,
}) => {
  const data = seed();
  await preview(page, data);
  await panel(page).getByRole('combobox').selectOption('end');
  await note(page).fill('保留这段处理说明');
  await consent(page).check();
  withStore((store) =>
    store.updateTask(data.rows[22].task.id, { result: '预览之后的新结果' }),
  );
  await confirm(page).click();
  await expect(panel(page).getByRole('alert')).toContainText('重新预览');
  expect(reviews(data).every((row) => row === null)).toBe(true);
  await expect(note(page)).toHaveValue('保留这段处理说明');
  await panel(page).getByRole('button', { name: '重新预览链路' }).click();
  await expect(consent(page)).not.toBeChecked();
  await consent(page).check();
  await confirm(page).click();
  await expect(panel(page)).toHaveCount(0);
  expect(reviews(data).every((row) => row?.status === 'closed')).toBe(true);
});

test('链路回执丢失后刷新能确认同一请求且不重复审计记录', async ({ page }) => {
  const data = seed();
  await preview(page, data);
  await panel(page).getByRole('combobox').selectOption('end');
  await note(page).fill('回执恢复测试');
  await consent(page).check();
  let count = 0;
  await page.route('**/collaboration-chain-review/*', async (route) => {
    if (route.request().method() !== 'POST') return route.continue();
    count++;
    await route.fetch();
    await route.abort('failed');
  });
  await confirm(page).click();
  await expect(
    panel(page).getByRole('button', { name: '重试确认链路结果' }),
  ).toBeEnabled();
  expect(reviews(data).every((row) => row?.status === 'closed')).toBe(true);
  await page.unroute('**/collaboration-chain-review/*');
  await page.reload();
  await preview(page, data);
  await panel(page).getByRole('button', { name: '重试确认链路结果' }).click();
  await expect(panel(page)).toHaveCount(0);
  expect(count).toBe(1);
  const ids = new Set(data.rows.map((row) => row.sourceMessageId));
  expect(
    withStore(
      (store) =>
        store.records
          .list('handoff-review-events')
          .filter((row) => ids.has(row.messageId)).length,
    ),
  ).toBe(23);
});

test('另一设备同步修改处理说明后必须重新核对范围，刷新保留草稿', async ({
  page,
}) => {
  const data = seed();
  await preview(page, data);
  await panel(page).getByRole('combobox').selectOption('end');
  await note(page).fill('第一版说明');
  await expect(
    panel(page).getByRole('region', { name: '链路处理草稿同步' }),
  ).toContainText('草稿已同步');
  await consent(page).check();
  const endpoint = `/api/teams/${data.source.id}/collaboration-chain-review/${encodeURIComponent(data.rows[0].sourceMessageId)}/draft`;
  const current = await (await page.request.get(endpoint)).json();
  const response = await page.request.put(endpoint, {
    data: {
      revision: current.revision,
      value: { action: 'end', note: '另一设备修改后的说明' },
    },
  });
  expect(response.ok()).toBe(true);
  await expect(note(page)).toHaveValue('另一设备修改后的说明', {
    timeout: 15000,
  });
  await expect(consent(page)).not.toBeChecked();
  await expect(confirm(page)).toBeDisabled();
  await page.reload();
  await preview(page, data);
  await expect(note(page)).toHaveValue('另一设备修改后的说明');
  await expect(consent(page)).not.toBeChecked();
  expect(reviews(data).every((row) => row === null)).toBe(true);
});

test('损坏的范围预览显示可恢复错误，不丢输入或允许未经核对的提交', async ({
  page,
}) => {
  const data = seed();
  await page.route('**/collaboration-chain-review/*', async (route) => {
    if (route.request().method() !== 'GET') return route.continue();
    const response = await route.fetch();
    const result = await response.json();
    result.items[0].decisions = {};
    await route.fulfill({ response, json: result });
  });
  await open(page, data);
  await article(page, '链路请求 0：')
    .getByRole('button', { name: '查看协作链路' })
    .click();
  await chain(page)
    .getByRole('button', { name: '整条链路收尾', exact: true })
    .click();
  await expect(panel(page).getByRole('alert')).toContainText('预览不完整');
  await note(page).fill('错误期间仍保留的说明');
  await expect(consent(page)).toBeDisabled();
  await page.unroute('**/collaboration-chain-review/*');
  await panel(page).getByRole('button', { name: '重新预览链路' }).click();
  await expect(
    panel(page).getByLabel('全部处理范围').locator('li'),
  ).toHaveCount(23);
  await expect(note(page)).toHaveValue('错误期间仍保留的说明');
  expect(reviews(data).every((row) => row === null)).toBe(true);
});

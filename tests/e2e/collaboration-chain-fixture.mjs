import { expect } from '@playwright/test';
import { Store } from '../../server/store.mjs';
import { commitTeamHandoff } from '../../server/team-handoff-store.mjs';
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
    const suffix = crypto.randomUUID();
    const nodeId = `chain-offline-${suffix}`;
    store.records.save(
      'nodes',
      { name: 'Chain browser fixture', status: 'offline' },
      nodeId,
    );
    const role = store.saveRole({
      ...store.role('project_manager'),
      id: undefined,
      name: `Chain PM ${suffix.slice(0, 8)}`,
      nodeId,
    });
    const makeTeam = (name) =>
      store.saveTeamSpace({
        name: `${name} ${suffix}`,
        goal: 'Chain inspection',
        workspace: process.cwd(),
        pmRoleId: role.id,
        memberRoleIds: [role.id],
        recruitment: {
          phase: 'confirmed',
          confirmedAt: new Date().toISOString(),
        },
        collaboration: { enabled: true, autoHandoff: true, allowedTeamIds: [] },
      });
    const source = makeTeam('链路来源');
    const target = makeTeam('链路目标');
    const rows = [];
    for (let index = 0; index < 24; index++) {
      const content =
        index === 23 ? '另一条独立协作' : `链路请求 ${index}：发布前检查`;
      const handoff = commitTeamHandoff({
        store,
        source,
        target,
        clientMessageId: `chain-${suffix}-${index}`,
        content,
        followupMessageId:
          index === 0 || index === 23
            ? null
            : rows[index === 2 ? 1 : 0].sourceMessageId,
        createTask: (message) => {
          const task = store.createTask({
            role: role.id,
            teamId: target.id,
            prompt: content,
            workspace: process.cwd(),
          });
          store.records.save(
            'task-meta',
            {
              teamId: target.id,
              spaceId: target.id,
              sourceMessageId: message.id,
              nodeId,
            },
            task.id,
          );
          return store.updateTask(task.id, {
            status: index === 21 ? 'failed' : 'completed',
            result: '未共享的内部任务输出',
          });
        },
      });
      const row = store.records.get('space-messages', handoff.sourceMessageId);
      store.db
        .prepare('UPDATE records SET createdAt=? WHERE collection=? AND id=?')
        .run(
          new Date(
            Date.UTC(2026, 0, index === 0 ? 30 : index + 1),
          ).toISOString(),
          'space-messages',
          row.id,
        );
      rows.push(handoff);
    }
    const root = rows[0];
    store.saveTeamMessage(
      {
        spaceId: source.id,
        kind: 'reply',
        fromTeamId: target.id,
        toTeamId: source.id,
        relatedMessageId: root.sourceMessageId,
        taskId: root.task.id,
        content: '共享回传：检查完成，附件证据待确认。',
        status: 'answered',
      },
      `handoff-reply:${root.task.id}`,
    );
    return { source, target, rows };
  });
}
const consolePanel = (page) =>
  page.getByRole('region', { name: '团队协作控制台', exact: true });
const chain = (page) =>
  page.getByRole('region', { name: '协作链路', exact: true });
const article = (page, content) =>
  consolePanel(page)
    .locator('article.team-collaboration-item')
    .filter({ has: page.locator('summary > span', { hasText: content }) })
    .first();
async function open(page, data) {
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
    data.source.id,
  );
  await page.goto('/');
  await expect(
    page.getByRole('heading', { name: data.source.name }),
  ).toBeVisible();
  await clickNavigation(page, '团队动态');
  await expect(article(page, '链路请求 0：')).toBeVisible();
}

export { seed, withStore, open, article, chain, consolePanel };

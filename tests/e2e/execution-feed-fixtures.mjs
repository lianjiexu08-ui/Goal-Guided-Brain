import { randomUUID } from 'node:crypto';
import { expect } from '@playwright/test';
import { Store } from '../../server/store.mjs';
import { clickNavigation } from './team-recruitment-fixtures.mjs';

export function write(callback) {
  const store = new Store(process.env.GGB_E2E_DATA_DIR, process.cwd(), {
    seedProjectManager: true,
  });
  try {
    return callback(store);
  } finally {
    store.close();
  }
}
export function seed() {
  return write((store) => {
    const label = `进展恢复 ${randomUUID().slice(0, 8)}`;
    const task = store.createTask({
      role: 'developer',
      prompt: label,
      workspace: process.cwd(),
    });
    const job = store.records.save('jobs', {
      title: label,
      goal: label,
      role: 'developer',
      groupId: randomUUID(),
      batchId: randomUUID(),
      status: 'failed',
      taskId: task.id,
      nodeId: 'local',
      workspace: process.cwd(),
      workspaceKey: 'default',
      requirementVersion: 1,
      depth: 0,
      permissions: [],
    });
    store.records.save(
      'task-meta',
      {
        jobId: job.id,
        groupId: job.groupId,
        attachmentIds: [],
        permissions: [],
        requirementVersion: 1,
      },
      task.id,
    );
    store.records.save(
      'runtime-snapshots',
      {
        route: {
          providerName: '测试供应商',
          model: 'fixture-model',
          protocol: 'openai-completions',
        },
      },
      task.id,
    );
    store.updateTask(task.id, {
      status: 'failed',
      error: '原有执行结果',
      result: '保留的执行证据',
    });
    return { taskId: task.id, label };
  });
}
export async function open(page, fixture) {
  await page.goto('/');
  await clickNavigation(page, '协作任务');
  await page.getByRole('button', { name: fixture.label, exact: true }).click();
  const dialog = page.getByRole('dialog', { name: fixture.label });
  await dialog
    .getByRole('button', { name: fixture.label, exact: true })
    .click();
  return dialog
    .locator('.manage-detail')
    .filter({
      has: page.getByRole('heading', { name: '执行目录与验收', exact: true }),
    })
    .last();
}
export async function fakeStreams(page) {
  await page.addInitScript(() => {
    const Native = window.EventSource;
    window.__taskStreams = [];
    window.EventSource = class extends EventTarget {
      static CLOSED = 2;
      static CONNECTING = 0;
      static OPEN = 1;
      readyState = 0;
      constructor(url) {
        super();
        if (!String(url).includes('/api/tasks/')) return new Native(url);
        this.url = String(url);
        window.__taskStreams.push(this);
        setTimeout(() => {
          if (this.readyState !== 2) this.emit('ready');
        }, 0);
      }
      close() {
        this.readyState = 2;
      }
      emit(type, data) {
        if (type === 'ready') this.readyState = 1;
        if (type === 'error') this.readyState = 0;
        this.dispatchEvent(
          new MessageEvent(type, {
            data: JSON.stringify(data),
            lastEventId: data ? `${data.createdAt}|${data.id}` : '',
          }),
        );
      }
    };
  });
}
export async function emit(page, type, data) {
  await page.evaluate(
    ({ type, data }) => window.__taskStreams.at(-1).emit(type, data),
    { type, data },
  );
}
export async function waitLive(panel) {
  await expect(panel.locator('.execution-feed-status')).toContainText(
    '实时更新',
  );
  await expect(panel.locator('.delivery-summary')).toContainText(
    '原有执行结果',
  );
}

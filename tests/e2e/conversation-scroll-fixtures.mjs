import os from 'node:os';
import path from 'node:path';
import { Store } from '../../server/store.mjs';

export const dataDir =
  process.env.GGB_E2E_DATA_DIR ||
  path.join(os.tmpdir(), 'ggb-browser-e2e-fixture');

export function seedConversationScrollTeam() {
  const store = new Store(dataDir, process.cwd(), { seedProjectManager: true });
  try {
    const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const goal = '验证对话阅读位置和回到最新消息。';
    const team = store.saveTeamSpace({
      name: `滚动阅读团队 ${suffix}`,
      goal,
      purpose: goal,
      workspace: process.cwd(),
      pmRoleId: 'project_manager',
      memberRoleIds: ['project_manager'],
      recruitment: {
        phase: 'confirmed',
        sessionId: null,
        turns: 1,
        brief: goal,
        proposal: null,
        confirmedAt: new Date().toISOString(),
      },
    });
    let latestTaskId = '';
    for (let index = 0; index < 18; index += 1) {
      const task = store.createTask({
        role: 'project_manager',
        prompt: `历史对话任务 ${index}：保留旧消息阅读位置。`,
        workspace: process.cwd(),
      });
      store.records.save(
        'task-meta',
        {
          spaceId: team.id,
          teamId: team.id,
          workspaceMode: 'isolated',
          attachmentIds: [],
        },
        task.id,
      );
      store.updateTask(task.id, {
        status: 'completed',
        result: `历史任务 ${index} 已完成，新的内容不能打断阅读。`,
      });
      latestTaskId = task.id;
    }
    return { id: team.id, name: team.name, latestTaskId };
  } finally {
    store.close();
  }
}

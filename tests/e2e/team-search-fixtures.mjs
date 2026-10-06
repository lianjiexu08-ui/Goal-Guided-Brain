import { Store } from '../../server/store.mjs';
import { dataDir, seedConfirmedTeams } from './team-recruitment-fixtures.mjs';

export function seedManyConfirmedTeams() {
  const existing = seedConfirmedTeams();
  const store = new Store(dataDir, process.cwd(), { seedProjectManager: true });
  try {
    const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const inputs = [
      {
        name: `平台工程团队 ${suffix}`,
        goal: '负责共享平台、基础组件和工程效率。',
      },
      {
        name: `数据分析团队 ${suffix}`,
        goal: '负责数据管道、指标和经营分析。',
      },
      {
        name: `客户支持团队 ${suffix}`,
        goal: '负责客户问题响应和服务流程优化。',
      },
    ];
    const extra = inputs.map((input) => {
      const saved = store.saveTeamSpace({
        name: input.name,
        goal: input.goal,
        purpose: input.goal,
        workspace: process.cwd(),
        pmRoleId: 'project_manager',
        memberRoleIds: ['project_manager'],
        recruitment: {
          phase: 'confirmed',
          sessionId: null,
          turns: 1,
          brief: input.goal,
          proposal: null,
          confirmedAt: new Date().toISOString(),
        },
      });
      return { ...input, id: saved.id };
    });
    return { ...existing, extra };
  } finally {
    store.close();
  }
}

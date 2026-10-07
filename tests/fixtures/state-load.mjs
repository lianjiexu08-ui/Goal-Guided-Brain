export function seedStateLoad(store, { teams = 10, tasksPerTeam = 20 } = {}) {
  const spaces = [];
  const tasks = [];
  store.db.exec('SAVEPOINT state_load_fixture');
  try {
    for (let i = 0; i < teams; i++) {
      const space = store.saveTeamSpace({
        name: `性能验证团队 ${i}`,
        goal: '检验长期多团队工作台的完整状态读取',
        pmRoleId: 'project_manager',
        memberRoleIds: ['project_manager'],
        recruitment: { phase: 'confirmed' },
      });
      spaces.push(space);
      for (let j = 0; j < tasksPerTeam; j++) {
        const task = store.createTask({
          role: 'project_manager',
          prompt: `团队 ${i} 的交付任务 ${j}`,
        });
        tasks.push(task);
        store.records.save(
          'jobs',
          {
            taskId: task.id,
            teamId: space.id,
            spaceId: space.id,
            status: 'completed',
            requirementVersion: 1,
          },
          task.id,
        );
        store.records.save(
          'task-meta',
          { jobId: task.id, spaceId: space.id, teamId: space.id },
          task.id,
        );
        store.updateTask(task.id, {
          status: 'completed',
          result: '已完成实现并提供验证记录。'.repeat(30),
        });
        for (let k = 0; k < 3; k++) {
          store.records.save(
            'artifacts',
            {
              taskId: task.id,
              kind: k === 0 ? 'verification' : 'file',
              name: `产物 ${k}`,
              status: 'verified',
              verified: true,
              requirementVersion: 1,
            },
            `${task.id}-${k}`,
          );
        }
        store.records.save('task-events', {
          taskId: task.id,
          type: 'completed',
        });
        store.records.save('usage', { jobId: task.id, totalTokens: 100 });
        store.saveTeamMessage({
          spaceId: space.id,
          taskId: task.id,
          content: `交付任务 ${j} 已准备好验收。`,
        });
      }
    }
    store.db.exec('RELEASE state_load_fixture');
    return { spaces, tasks };
  } catch (error) {
    store.db.exec('ROLLBACK TO state_load_fixture; RELEASE state_load_fixture');
    throw error;
  }
}

import os from 'node:os';
import path from 'node:path';
import { Store } from '../../server/store.mjs';

const dataDir =
  process.env.GGB_E2E_DATA_DIR ||
  path.join(os.tmpdir(), 'ggb-browser-e2e-fixture');

function seedProposedRecruitment() {
  const store = new Store(dataDir, process.cwd(), { seedProjectManager: true });
  try {
    const teamName = '待确认开发团队';
    // Reuse the fixture team when the desktop project has already exercised
    // this flow. Playwright projects share one isolated database per run.
    const team =
      store
        .teamSpaces()
        .find((space) => space.recruitment?.proposal?.teamName === teamName) ||
      store
        .teamSpaces()
        .find((space) => space.recruitment?.phase === 'confirmed') ||
      store.teamSpaces().find((space) => space.status !== 'archived');
    if (!team) throw new Error('E2E fixture requires a seeded team.');
    const proposal = {
      version: 1,
      teamName,
      goal: '交付一条可测试的产品开发流程。',
      purpose: '负责需求拆解、代码实现和验收准备。',
      size: 2,
      members: [
        {
          memberId: 'manager',
          roleId: 'project_manager',
          name: '项目经理',
          responsibility: '澄清目标、安排任务并汇总交付。',
          deliverables: ['团队计划', '交付总结'],
          skills: [],
          skillIds: [],
          capabilityIds: [],
          providerIds: [],
          tools: [],
          toolAccess: null,
          modelHint: '',
          dependencies: [],
        },
        {
          memberId: 'developer',
          roleId: 'developer',
          name: '开发交付助手',
          responsibility: '实现功能并运行自动化测试。',
          deliverables: ['可运行代码', '测试结果'],
          skills: [],
          skillIds: [],
          capabilityIds: [],
          providerIds: [],
          tools: [],
          toolAccess: null,
          modelHint: '',
          dependencies: ['manager'],
        },
      ],
      openQuestions: [],
      ready: true,
      createdAt: new Date().toISOString(),
    };
    store.saveTeamSpace(
      {
        ...team,
        name: '待确认需求',
        goal: proposal.goal,
        purpose: proposal.purpose,
        memberRoleIds: ['project_manager'],
        recruitment: {
          ...team.recruitment,
          phase: 'proposed',
          sessionId: null,
          turns: 1,
          brief: proposal.goal,
          proposal,
          confirmedAt: null,
        },
      },
      team.id,
    );
    return { teamId: team.id, teamName };
  } finally {
    store.close();
  }
}

function seedModelTeams() {
  const store = new Store(dataDir, process.cwd(), { seedProjectManager: true });
  try {
    const providers = [
      {
        id: 'e2e-provider-alpha',
        name: 'E2E Alpha Provider',
        protocol: 'openai-completions',
        baseUrl: 'http://127.0.0.1:1',
        credentialId: '',
        enabled: true,
        priority: 1,
        health: {
          ok: true,
          model: 'e2e-alpha-model',
          status: 200,
          checkedAt: new Date().toISOString(),
          latencyMs: 318,
          toolTest: false,
        },
        models: [
          {
            id: 'e2e-alpha-model',
            name: 'Alpha Model',
            tools: false,
            vision: false,
            contextWindow: 128000,
            inputPrice: null,
            outputPrice: null,
          },
        ],
      },
      {
        id: 'e2e-provider-beta',
        name: 'E2E Beta Provider',
        protocol: 'openai-completions',
        baseUrl: 'http://127.0.0.1:1',
        credentialId: '',
        enabled: true,
        priority: 2,
        health: {
          ok: false,
          model: 'e2e-beta-model',
          status: 503,
          checkedAt: new Date().toISOString(),
          latencyMs: 742,
          toolTest: false,
          error: '接口返回 HTTP 503',
        },
        models: [
          {
            id: 'e2e-beta-model',
            name: 'Beta Model',
            tools: false,
            vision: false,
            contextWindow: 128000,
            inputPrice: null,
            outputPrice: null,
          },
        ],
      },
    ];
    for (const provider of providers)
      store.records.save('providers', provider, provider.id);
    const seeded = store
      .teamSpaces()
      .find((space) => space.recruitment?.phase === 'confirmed');
    if (!seeded) throw new Error('E2E fixture requires a seeded team.');
    const teams = [
      {
        slug: 'alpha',
        name: 'Alpha 模型团队',
        goal: '验证 Alpha 团队的模型路由隔离。',
        providerId: 'e2e-provider-alpha',
        model: 'e2e-alpha-model',
      },
      {
        slug: 'beta',
        name: 'Beta 模型团队',
        goal: '验证 Beta 团队的模型路由隔离。',
        providerId: 'e2e-provider-beta',
        model: 'e2e-beta-model',
      },
    ];
    const result = {};
    for (const input of teams) {
      const existing =
        store.teamSpaces().find((space) => space.name === input.name) ||
        (input.slug === 'alpha' ? seeded : undefined);
      const saved = store.saveTeamSpace(
        {
          ...existing,
          name: input.name,
          goal: input.goal,
          purpose: input.goal,
          model: input.model,
          providerId: input.providerId,
          workspace: process.cwd(),
          pmRoleId: 'project_manager',
          memberRoleIds: ['project_manager'],
          responsibilities: { project_manager: '验证团队模型路由。' },
          memberSettings: {
            project_manager: {
              label: '项目经理',
              responsibility: '验证团队模型路由。',
              modelHint: input.model,
              providerIds: [input.providerId],
            },
          },
          recruitment: {
            ...existing?.recruitment,
            phase: 'confirmed',
            sessionId: null,
            turns: 1,
            brief: input.goal,
            proposal: null,
            confirmedAt: new Date().toISOString(),
          },
        },
        existing?.id,
      );
      result[input.slug] = {
        id: saved.id,
        name: saved.name,
        providerId: input.providerId,
        model: input.model,
      };
    }
    return result;
  } finally {
    store.close();
  }
}

function seedModelMetrics() {
  const teams = seedModelTeams();
  const store = new Store(dataDir, process.cwd(), { seedProjectManager: true });
  try {
    const attempts = [
      {
        id: 'metrics-alpha-attempt',
        teamId: teams.alpha.id,
        providerId: 'e2e-provider-alpha',
        model: 'e2e-alpha-model',
        status: 'completed',
        tokens: { inputTokens: 120, outputTokens: 40, totalTokens: 160 },
        cost: 0.003,
      },
      {
        id: 'metrics-beta-attempt',
        teamId: teams.beta.id,
        providerId: 'e2e-provider-beta',
        model: 'e2e-beta-model',
        status: 'failed',
        tokens: { inputTokens: 90, outputTokens: 20, totalTokens: 110 },
        cost: null,
      },
    ];
    for (const input of attempts) {
      const task = store.createTask({
        role: 'project_manager',
        prompt: `E2E 模型指标 ${input.id}`,
        workspace: process.cwd(),
      });
      const jobId = `job-${input.id}`;
      const groupId = `group-${input.id}`;
      store.records.save(
        'jobs',
        {
          title: task.title,
          goal: task.prompt,
          role: task.role,
          groupId,
          batchId: groupId,
          status: input.status,
          taskId: task.id,
          nodeId: 'local',
          workspace: process.cwd(),
          workspaceKey: 'default',
          requirementVersion: 1,
          budgetTokens: 200000,
          maxDurationMinutes: 30,
          permissions: [],
          spaceId: input.teamId,
          teamId: input.teamId,
        },
        jobId,
      );
      store.records.save(
        'task-meta',
        {
          jobId,
          groupId,
          batchId: groupId,
          nodeId: 'local',
          workspaceKey: 'default',
          workspaceMode: 'isolated',
          providerIds: [input.providerId],
          allowedProviderIds: [input.providerId],
          requirementVersion: 1,
          spaceId: input.teamId,
          teamId: input.teamId,
        },
        task.id,
      );
      store.records.save(
        'runtime-snapshots',
        {
          route: {
            providerId: input.providerId,
            model: input.model,
            routingCandidates: [
              {
                providerId: input.providerId,
                model: input.model,
                status: 'selected',
              },
            ],
          },
        },
        task.id,
      );
      store.records.save(
        'executions',
        {
          taskId: task.id,
          groupId,
          status: input.status,
          startedAt: 1000,
          finishedAt: input.status === 'completed' ? 2500 : 2200,
        },
        task.id,
      );
      store.records.save(
        'usage',
        {
          taskId: task.id,
          groupId,
          jobId,
          turn: 1,
          ...input.tokens,
          cost: input.cost,
          providerId: input.providerId,
          model: input.model,
        },
        `${task.id}:1`,
      );
      store.updateTask(task.id, {
        status: input.status,
        error: input.status === 'failed' ? 'fixture failure' : '',
      });
    }
    return teams;
  } finally {
    store.close();
  }
}

function seedCapabilityBinding() {
  const store = new Store(dataDir, process.cwd(), { seedProjectManager: true });
  try {
    const capabilityId = 'e2e-bound-capability';
    store.records.save(
      'capabilities',
      {
        id: capabilityId,
        name: 'E2E 证据整理能力',
        kind: 'skill',
        version: '1.0.0',
        source: 'e2e',
        enabled: true,
        compatibility: 'partial',
        diagnostics: ['需要先检查执行节点。'],
        description: '验证能力绑定范围展示。',
        tools: [],
      },
      capabilityId,
    );
    const role = store.role('product');
    store.saveRole({ ...role, capabilityIds: [capabilityId] }, role.id);
    return { capabilityId, roleId: role.id };
  } finally {
    store.close();
  }
}

function seedHighRiskCapability() {
  const store = new Store(dataDir, process.cwd(), { seedProjectManager: true });
  try {
    const capabilityId = `e2e-high-risk-${Date.now()}`;
    const name = `E2E 高风险能力 ${Date.now()}`;
    store.records.save(
      'capabilities',
      {
        id: capabilityId,
        name,
        kind: 'mcp',
        transport: 'stdio',
        command: process.execPath,
        args: ['-e', 'process.exit(0)'],
        enabled: false,
        source: 'e2e',
        diagnostics: [],
        tools: [],
      },
      capabilityId,
    );
    return { capabilityId, name };
  } finally {
    store.close();
  }
}

function seedHighRiskRecruitment() {
  const store = new Store(dataDir, process.cwd(), { seedProjectManager: true });
  try {
    const capabilityId = `e2e-recruit-high-risk-${Date.now()}`;
    const capabilityName = `E2E 招募高风险能力 ${Date.now()}`;
    store.records.save(
      'capabilities',
      {
        id: capabilityId,
        name: capabilityName,
        kind: 'mcp',
        transport: 'stdio',
        command: process.execPath,
        args: ['-e', 'process.exit(0)'],
        enabled: true,
        source: 'e2e',
        diagnostics: [],
        tools: [],
      },
      capabilityId,
    );
    const team = store
      .teamSpaces()
      .find((space) => space.recruitment?.phase === 'confirmed');
    if (!team) throw new Error('E2E fixture requires a seeded team.');
    const teamName = `待确认高风险团队 ${Date.now()}`;
    const proposal = {
      version: 1,
      teamName,
      goal: '验证团队招募会在绑定高风险能力前要求逐项确认。',
      purpose: '用真实 Team Charter 流程验证能力风险确认和绑定审计。',
      size: 2,
      members: [
        {
          memberId: 'manager',
          roleId: 'project_manager',
          name: '项目经理',
          responsibility: '澄清目标、安排任务并汇总交付。',
          deliverables: ['团队计划', '交付总结'],
          skills: [],
          skillIds: [],
          capabilityIds: [],
          providerIds: [],
          tools: [],
          toolAccess: null,
          modelHint: '',
          dependencies: [],
        },
        {
          memberId: 'developer',
          roleId: 'developer',
          name: '高风险能力开发助手',
          responsibility: '使用已确认的执行能力实现功能并运行测试。',
          deliverables: ['可运行代码', '测试结果'],
          skills: [],
          skillIds: [],
          capabilityIds: [capabilityId],
          providerIds: [],
          tools: [],
          toolAccess: null,
          modelHint: '',
          dependencies: ['manager'],
        },
      ],
      openQuestions: [],
      ready: true,
      createdAt: new Date().toISOString(),
    };
    store.saveTeamSpace(
      {
        ...team,
        name: `待确认高风险需求 ${Date.now()}`,
        goal: proposal.goal,
        purpose: proposal.purpose,
        memberRoleIds: ['project_manager'],
        recruitment: {
          ...team.recruitment,
          phase: 'proposed',
          sessionId: null,
          turns: 1,
          brief: proposal.goal,
          proposal,
          confirmedAt: null,
        },
      },
      team.id,
    );
    return { teamId: team.id, teamName, capabilityId, capabilityName };
  } finally {
    store.close();
  }
}

function seedConfirmedTeams() {
  const store = new Store(dataDir, process.cwd(), { seedProjectManager: true });
  try {
    const teams = [
      {
        slug: 'operations',
        name: '线上运维团队',
        goal: '负责线上服务稳定性、监控和故障处理。',
        message: '线上运维团队的项目经理动态',
      },
      {
        slug: 'development',
        name: '研发交付团队',
        goal: '负责产品功能开发、测试和版本交付。',
        message: '研发交付团队的项目经理动态',
      },
    ];
    const result = {};
    for (const input of teams) {
      const existing = store
        .teamSpaces()
        .find((space) => space.name === input.name);
      const saved = store.saveTeamSpace(
        {
          ...existing,
          name: input.name,
          goal: input.goal,
          purpose: input.goal,
          collaboration: { enabled: true, allowedTeamIds: [], autoHandoff: true, sharedBoard: true },
          workspace: process.cwd(),
          pmRoleId: 'project_manager',
          memberRoleIds: ['project_manager'],
          recruitment: {
            ...existing?.recruitment,
            phase: 'confirmed',
            sessionId: null,
            turns: 1,
            brief: input.goal,
            proposal: null,
            confirmedAt: new Date().toISOString(),
          },
        },
        existing?.id,
      );
      store.saveTeamMessage(
        {
          spaceId: saved.id,
          teamId: saved.id,
          clientMessageId: `e2e-${input.slug}-message`,
          kind: 'reply',
          senderType: 'agent',
          senderId: 'project_manager',
          content: input.message,
          status: 'sent',
        },
        `e2e-${input.slug}-message`,
      );
      result[input.slug] = { ...input, id: saved.id };
    }
    // Keep the historic keys used by the existing tests while returning the
    // durable ids needed by route-cache assertions.
    return { development: result.operations, operations: result.development };
  } finally {
    store.close();
  }
}

function seedTeamKnowledge() {
  const store = new Store(dataDir, process.cwd(), { seedProjectManager: true });
  try {
    const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const create = (name, goal) =>
      store.saveTeamSpace({
        name: `${name} ${suffix}`,
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
    const development = create('知识研发团队', '验证研发团队知识隔离。');
    const operations = create('知识运维团队', '验证运维团队知识隔离。');
    store.saveKnowledge({
      title: '研发团队专属约定',
      content: '研发变更必须包含自动化测试。',
      scope: 'team',
      teamId: development.id,
      state: 'confirmed',
      source: '研发团队 fixture',
    });
    store.saveKnowledge({
      title: '运维团队专属约定',
      content: '生产发布必须先执行回滚演练。',
      scope: 'team',
      teamId: operations.id,
      state: 'confirmed',
      source: '运维团队 fixture',
    });
    return { development, operations };
  } finally {
    store.close();
  }
}

function seedCollaborationTeams() {
  const teams = seedConfirmedTeams();
  const store = new Store(dataDir, process.cwd(), { seedProjectManager: true });
  try {
    const source = store.teamSpace(teams.development.id);
    const target = store.teamSpace(teams.operations.id);
    if (!source || !target)
      throw new Error('E2E fixture requires two confirmed teams.');
    store.saveTeamSpace(
      {
        ...source,
        collaboration: {
          enabled: true,
          autoHandoff: true,
          sharedBoard: true,
          allowedTeamIds: [target.id],
        },
      },
      source.id,
    );
    store.saveTeamSpace(
      {
        ...target,
        collaboration: {
          enabled: true,
          autoHandoff: true,
          sharedBoard: true,
          allowedTeamIds: [source.id],
        },
      },
      target.id,
    );
    return {
      source: { ...teams.development, id: source.id },
      target: { ...teams.operations, id: target.id },
    };
  } finally {
    store.close();
  }
}

function seedLongTimelineTeam() {
  const store = new Store(dataDir, process.cwd(), { seedProjectManager: true });
  try {
    const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const saved = store.saveTeamSpace({
      name: `长期交付团队 ${suffix}`,
      goal: '验证团队可以持续追溯更早的动态。',
      purpose: '验证时间线分页和游标去重。',
      workspace: process.cwd(),
      pmRoleId: 'project_manager',
      memberRoleIds: ['project_manager'],
      recruitment: {
        phase: 'confirmed',
        sessionId: null,
        turns: 1,
        brief: '验证时间线分页。',
        proposal: null,
        confirmedAt: new Date().toISOString(),
      },
    });
    for (let index = 0; index < 125; index += 1) {
      store.saveTeamMessage(
        {
          spaceId: saved.id,
          teamId: saved.id,
          clientMessageId: `timeline-page-${suffix}-${index}`,
          kind: 'reply',
          senderType: 'agent',
          senderId: 'project_manager',
          content: `分页回归消息 ${index}`,
          status: 'sent',
        },
        `timeline-page-${suffix}-${index}`,
      );
    }
    return { id: saved.id, name: saved.name };
  } finally {
    store.close();
  }
}

function seedRiskTeams() {
  const store = new Store(dataDir, process.cwd(), { seedProjectManager: true });
  try {
    const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const teams = [
      {
        name: `风险研发团队 ${suffix}`,
        status: 'failed',
        error: '研发执行需要重试。',
      },
      {
        name: `风险运维团队 ${suffix}`,
        status: 'blocked',
        error: '运维任务等待人工处理。',
      },
    ].map((input) => {
      const team = store.saveTeamSpace({
        name: input.name,
        goal: '验证跨团队风险收件箱。',
        purpose: '验证风险按团队和类型筛选。',
        workspace: process.cwd(),
        pmRoleId: 'project_manager',
        memberRoleIds: ['project_manager'],
        recruitment: {
          phase: 'confirmed',
          sessionId: null,
          turns: 1,
          brief: '验证跨团队风险收件箱。',
          proposal: null,
          confirmedAt: new Date().toISOString(),
        },
      });
      const task = store.createTask({
        role: 'project_manager',
        prompt: `${input.name}风险任务`,
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
      store.updateTask(task.id, { status: input.status, error: input.error });
      return { ...input, id: team.id, taskId: task.id };
    });
    store.records.save(
      'attention',
      {
        teamId: teams[1].id,
        status: 'open',
        kind: 'manual-review',
        title: '运维团队需要确认',
        detail: '请确认运维任务的恢复边界。',
      },
      `e2e-risk-attention-${suffix}`,
    );
    return { source: teams[0], target: teams[1] };
  } finally {
    store.close();
  }
}

function seedDraftRecoveryTeams() {
  const store = new Store(dataDir, process.cwd(), { seedProjectManager: true });
  try {
    const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const inputs = [
      {
        slug: 'alpha',
        name: `服务端草稿团队 A ${suffix}`,
        goal: '验证草稿跨刷新恢复，并保持团队隔离。',
      },
      {
        slug: 'beta',
        name: `服务端草稿团队 B ${suffix}`,
        goal: '验证不同团队拥有独立的服务端草稿。',
      },
    ];
    const result = {};
    for (const input of inputs) {
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
      result[input.slug] = { ...input, id: saved.id };
    }
    return result;
  } finally {
    store.close();
  }
}

// Two independent server drafts let the browser test exercise both sides of
// the optimistic-concurrency contract. The first changes different lines on
// each device (which should merge automatically); the second changes the same
// text (which must remain an explicit user decision).
function seedDraftMergeTeams() {
  const store = new Store(dataDir, process.cwd(), { seedProjectManager: true });
  try {
    const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const create = (slug, base) => {
      const goal = `验证多设备草稿 ${slug} ${suffix}。`;
      const saved = store.saveTeamSpace({
        name: `多设备草稿团队 ${slug} ${suffix}`,
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
      const draft = store.saveTeamDraft({
        spaceId: saved.id,
        roleId: 'project_manager',
        content: base,
        attachmentIds: [],
      });
      return {
        slug,
        name: saved.name,
        id: saved.id,
        base,
        revision: draft.revision,
      };
    };
    return {
      merge: create('自动合并', '初始标题\n初始正文'),
      conflict: create('冲突决策', '共同草稿'),
    };
  } finally {
    store.close();
  }
}

function seedTeamTemplateSource() {
  const store = new Store(dataDir, process.cwd(), { seedProjectManager: true });
  try {
    const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const goal = '负责平台功能开发、自动化测试和版本交付。';
    const source = store.saveTeamSpace({
      name: `模板来源研发团队 ${suffix}`,
      goal,
      purpose: '把需求稳定地交付到线上。',
      teamType: 'development',
      workspace: process.cwd(),
      workspaceMode: 'isolated',
      pmRoleId: 'project_manager',
      memberRoleIds: ['project_manager', 'developer'],
      responsibilities: { developer: '实现功能并运行自动化测试。' },
      memberSettings: {
        developer: {
          label: '主开发',
          modelHint: 'template-model',
          capabilityIds: ['development-workflow'],
        },
      },
      model: 'template-model',
      providerId: 'template-provider',
      recruitment: {
        phase: 'confirmed',
        sessionId: null,
        turns: 1,
        brief: goal,
        proposal: null,
        confirmedAt: new Date().toISOString(),
      },
    });
    store.saveTeamMessage(
      {
        spaceId: source.id,
        teamId: source.id,
        clientMessageId: `template-source-${suffix}`,
        kind: 'reply',
        senderType: 'agent',
        senderId: 'project_manager',
        content: '来源团队历史消息，复制时不能带走。',
        status: 'sent',
      },
      `template-source-message-${suffix}`,
    );
    const sourceTask = store.createTask({
      role: 'project_manager',
      prompt: '来源团队历史任务，复制时不能带走。',
      workspace: process.cwd(),
      teamId: source.id,
      spaceId: source.id,
    });
    store.records.save(
      'task-meta',
      { teamId: source.id, spaceId: source.id },
      sourceTask.id,
    );
    return { source };
  } finally {
    store.close();
  }
}

function seedNodeLifecycleFixtures() {
  const store = new Store(dataDir, process.cwd(), { seedProjectManager: true });
  try {
    const now = Date.now();
    const base = {
      workspaces: ['default'],
      platform: 'linux',
      tokenHash: 'fixture-token-hash',
    };
    store.records.save(
      'nodes',
      {
        ...base,
        name: 'E2E 离线节点',
        lastSeenAt: now - 5 * 60_000,
        status: 'online',
      },
      'e2e-offline-node',
    );
    store.records.save(
      'nodes',
      {
        ...base,
        name: 'E2E 已撤销节点',
        tokenHash: null,
        lastSeenAt: now,
        status: 'revoked',
        revokedAt: new Date(now - 60_000).toISOString(),
      },
      'e2e-revoked-node',
    );
  } finally {
    store.close();
  }
}

function markNodeOnline(id) {
  const store = new Store(dataDir, process.cwd(), { seedProjectManager: true });
  try {
    const node = store.records.get('nodes', id);
    if (node)
      store.records.save(
        'nodes',
        { ...node, lastSeenAt: Date.now(), status: 'online' },
        id,
      );
  } finally {
    store.close();
  }
}

export {
  dataDir,
  seedProposedRecruitment,
  seedModelTeams,
  seedModelMetrics,
  seedCapabilityBinding,
  seedHighRiskCapability,
  seedHighRiskRecruitment,
  seedConfirmedTeams,
  seedTeamKnowledge,
  seedCollaborationTeams,
  seedLongTimelineTeam,
  seedRiskTeams,
  seedDraftRecoveryTeams,
  seedDraftMergeTeams,
  seedTeamTemplateSource,
  seedNodeLifecycleFixtures,
  markNodeOnline,
};

export {
  sidebarLocator,
  openMobileSidebar,
  clickNavigation,
  recruitmentPage,
} from './team-recruitment-helpers.mjs';

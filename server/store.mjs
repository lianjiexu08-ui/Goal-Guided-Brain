import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { validateRole } from './roles.mjs';
import { migrate } from './migrations.mjs';
import { Records } from './records.mjs';
import { DEFAULT_PROFILE, validateProfile } from './profile.mjs';
import { ROLES } from './store/roles.mjs';
import { knowledgeMethods } from './store/knowledge.mjs';
import { teamLifecycleMethods } from './store/team-lifecycle.mjs';
export { ROLES } from './store/roles.mjs';
import {
  buildRecruitmentPage,
  deriveTaskDelivery,
  draftKey as makeDraftKey,
  normalizeTaskRow,
  normalizeTeamSpace as normalizeTeamSpaceData,
  normalizeTeamTemplate as normalizeTeamTemplateData,
} from './store/helpers.mjs';

export function atomicWrite(filename, text) {
  fs.mkdirSync(path.dirname(filename), { recursive: true, mode: 0o700 });
  const temp = `${filename}.${randomUUID()}.tmp`;
  fs.writeFileSync(temp, text, { mode: 0o600 });
  fs.renameSync(temp, filename);
}
export class Store {
  constructor(dir, workspace, { seedProjectManager = false } = {}) {
    this.dir = dir;
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(path.join(dir, 'workspace.sqlite'));
    migrate(this.db, dir);
    this.records = new Records(this.db);
    this.onTaskUpdate = null;
    this.db
      .exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS settings (id INTEGER PRIMARY KEY CHECK(id=1), data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS roles (id TEXT PRIMARY KEY, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS sessions (id TEXT PRIMARY KEY, role TEXT NOT NULL, workspace TEXT NOT NULL, title TEXT NOT NULL, createdAt TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS tasks (id TEXT PRIMARY KEY, sessionId TEXT NOT NULL REFERENCES sessions(id), role TEXT NOT NULL, workspace TEXT NOT NULL, title TEXT NOT NULL, prompt TEXT NOT NULL, status TEXT NOT NULL, result TEXT NOT NULL DEFAULT '', error TEXT NOT NULL DEFAULT '', log TEXT NOT NULL DEFAULT '', sourceTaskId TEXT, knowledgeIds TEXT NOT NULL DEFAULT '[]', knowledgeRefs TEXT NOT NULL DEFAULT '[]', context TEXT NOT NULL DEFAULT '', createdAt TEXT NOT NULL, updatedAt TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS idx_tasks_status_created ON tasks(status,createdAt);
      CREATE INDEX IF NOT EXISTS idx_tasks_session_created ON tasks(sessionId,createdAt);
      CREATE TABLE IF NOT EXISTS knowledge (id TEXT PRIMARY KEY,title TEXT NOT NULL,content TEXT NOT NULL,scope TEXT NOT NULL,state TEXT NOT NULL,source TEXT NOT NULL,projectPath TEXT NOT NULL,teamId TEXT NOT NULL DEFAULT '',updatedAt TEXT NOT NULL,version INTEGER NOT NULL DEFAULT 1,createdAt TEXT,expiresAt TEXT);
      CREATE INDEX IF NOT EXISTS idx_knowledge_scope_project ON knowledge(scope,projectPath);`);
    const knowledgeColumns = new Set(
      this.db.prepare('PRAGMA table_info(knowledge)').all().map((column) => column.name),
    );
    const taskColumns = new Set(
      this.db.prepare('PRAGMA table_info(tasks)').all().map((column) => column.name),
    );
    if (!taskColumns.has('knowledgeRefs'))
      this.db.exec("ALTER TABLE tasks ADD COLUMN knowledgeRefs TEXT NOT NULL DEFAULT '[]'");
    // Databases created before team-scoped knowledge used an eight-column
    // table. Keep those records readable and add the nullable-by-convention
    // empty team ID without rewriting user content.
    if (!knowledgeColumns.has('teamId')) this.db.exec("ALTER TABLE knowledge ADD COLUMN teamId TEXT NOT NULL DEFAULT ''");
    if (!knowledgeColumns.has('version'))
      this.db.exec('ALTER TABLE knowledge ADD COLUMN version INTEGER NOT NULL DEFAULT 1');
    if (!knowledgeColumns.has('createdAt')) {
      this.db.exec('ALTER TABLE knowledge ADD COLUMN createdAt TEXT');
      this.db.exec('UPDATE knowledge SET createdAt=updatedAt WHERE createdAt IS NULL');
    }
    if (!knowledgeColumns.has('expiresAt'))
      this.db.exec('ALTER TABLE knowledge ADD COLUMN expiresAt TEXT');
    this.db.exec('CREATE INDEX IF NOT EXISTS idx_knowledge_team ON knowledge(teamId)');
    fs.chmodSync(path.join(dir, 'workspace.sqlite'), 0o600);
    const config = {
      workspace,
      model: 'deepseek-v4-flash',
      maxConcurrent: 3,
      profile: DEFAULT_PROFILE,
      roleInstructions: Object.fromEntries(
        Object.entries(ROLES).map(([k, v]) => [k, v.instructions]),
      ),
    };
    this.db
      .prepare('INSERT OR IGNORE INTO settings VALUES(1, ?)')
      .run(JSON.stringify(config));
    // Add the profile to databases created before personal preferences existed.
    const storedConfig = JSON.parse(
      this.db.prepare('SELECT data FROM settings WHERE id=1').get().data,
    );
    if (!Object.hasOwn(storedConfig, 'profile')) {
      this.db
        .prepare('UPDATE settings SET data=? WHERE id=1')
        .run(JSON.stringify({ ...storedConfig, profile: DEFAULT_PROFILE }));
    }
    // Seed once and carry forward user-edited instructions from the original schema.
    const stored = this.config;
    const seed = this.db.prepare(
      'INSERT OR IGNORE INTO roles(id,data) VALUES(?,?)',
    );
    for (const [id, role] of Object.entries(ROLES)) {
      if (id === 'project_manager' && !seedProjectManager) continue;
      seed.run(
        id,
        JSON.stringify(
          validateRole({
            ...role,
            instructions: stored.roleInstructions?.[id] ?? role.instructions,
          }),
        ),
      );
    }
    // Existing workspaces were created before team recruitment became the
    // primary project-manager flow. Keep user-authored instructions intact,
    // while making the new skill available to the already seeded role.
    const existingProjectManager = this.role('project_manager');
    if (existingProjectManager && !existingProjectManager.archived) {
      const skillIds = [...new Set([...(existingProjectManager.skillIds || []), 'team-recruitment'])];
      const recruitmentRule = '团队招募阶段先多轮澄清需求，使用 propose_team 保存待确认的 Team Charter；保存后等待用户在团队招募界面确认创建，确认前不要配置成员或分派任务。';
      const currentInstructions = String(existingProjectManager.instructions || '');
      const instructions = currentInstructions.includes('propose_team')
        ? currentInstructions.replace(/只有用户明确确认后，才使用 confirm_team_recruitment 完成成员配置，再使用团队编排工具 delegate_task 分派工作。/, '保存后明确等待用户在团队招募界面点击确认创建；确认前不要把成员说成已创建，也不要使用 delegate_task。')
        : `${currentInstructions}\n${recruitmentRule}`.trim();
      if (JSON.stringify(skillIds) !== JSON.stringify(existingProjectManager.skillIds || []) || instructions !== existingProjectManager.instructions) {
        this.saveRole({ ...existingProjectManager, skillIds, instructions }, 'project_manager');
      }
    }
    if (seedProjectManager && !this.records.list('spaces').length && this.role('project_manager')) {
      this.records.save('spaces', {
        name: '我的项目组',
        goal: '和项目经理沟通需求，由团队助手协作推进并汇总交付。',
        purpose: '负责产品规划、开发交付与团队协调。',
        teamType: 'project',
        workspace: this.config.workspace,
        pmRoleId: 'project_manager',
        memberRoleIds: ['project_manager', 'product', 'developer', 'assistant'],
        status: 'active',
        autonomy: {
          mode: 'auto',
          maxDepth: 4,
          maxJobs: 32,
          budgetTokens: 200000,
          requireApprovalKinds: ['external-write', 'publish', 'deploy'],
        },
        responsibilities: {
          project_manager: '理解目标、拆解任务、协调团队并汇总结果。',
          product: '调研需求、整理方案和验收标准。',
          developer: '实现代码、运行测试并交付可验证结果。',
          assistant: '整理资料、补充信息和行动计划。',
        },
        memberSettings: {},
        collaboration: { enabled: true, autoHandoff: true, sharedBoard: true, allowedTeamIds: [] },
        recruitment: {
          phase: 'confirmed',
          sessionId: null,
          turns: 0,
          brief: '',
          proposal: null,
          confirmedAt: new Date().toISOString(),
        },
      });
    }
    this.db
      .prepare(
        "UPDATE tasks SET status='interrupted',error='本地服务在执行期间停止，请检查已有修改后重试。',updatedAt=? WHERE status='running' AND NOT EXISTS (SELECT 1 FROM records WHERE collection='executions' AND id=tasks.id)",
      )
      .run(new Date().toISOString());
  }
  get config() {
    const value = JSON.parse(
      this.db.prepare('SELECT data FROM settings WHERE id=1').get().data,
    );
    return {
      ...value,
      profile: validateProfile(value.profile ?? DEFAULT_PROFILE),
    };
  }
  configure(values) {
    const result = { ...this.config, ...values };
    if (values.profile !== undefined)
      result.profile = validateProfile(values.profile, this.config.profile);
    this.db
      .prepare('UPDATE settings SET data=? WHERE id=1')
      .run(JSON.stringify(result));
    return result;
  }
  profile() {
    return this.config.profile;
  }
  saveProfile(input) {
    return this.configure({
      profile: validateProfile(input, this.config.profile),
    }).profile;
  }
  roles() {
    return this.db
      .prepare('SELECT * FROM roles ORDER BY rowid')
      .all()
      .map((row) => ({ ...JSON.parse(row.data), id: row.id }));
  }
  role(id) {
    const row = this.db.prepare('SELECT data FROM roles WHERE id=?').get(id);
    return row ? { ...JSON.parse(row.data), id } : null;
  }
  saveRole(input, id) {
    const existing = id ? this.role(id) : undefined;
    if (id && !existing) throw new Error('助手不存在。');
    const data = validateRole(input, existing);
    id ??= randomUUID();
    this.db
      .prepare(
        'INSERT INTO roles VALUES(?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data',
      )
      .run(id, JSON.stringify(data));
    return this.role(id);
  }
  archiveRole(id, archived) {
    const role = this.role(id);
    if (!role) throw new Error('助手不存在。');
    if (archived && this.teamSpaces().some((team) =>
      team.status !== 'archived' &&
      (team.pmRoleId === id || (Array.isArray(team.memberRoleIds) && team.memberRoleIds.includes(id)))
    ))
      throw new Error('该助手仍属于启用中的团队，请先调整团队成员或归档团队。');
    if (
      archived &&
      this.tasks().some(
        (t) => t.role === id && ['queued', 'running'].includes(t.status),
      )
    )
      throw new Error('该助手还有运行或排队中的任务，请完成或停止后归档。');
    this.db
      .prepare('UPDATE roles SET data=? WHERE id=?')
      .run(JSON.stringify({ ...role, archived }), id);
    return this.role(id);
  }
  task(id) {
    return normalizeTaskRow(this.db.prepare('SELECT * FROM tasks WHERE id=?').get(id));
  }
  tasks() {
    return this.db
      .prepare('SELECT * FROM tasks ORDER BY createdAt DESC')
      .all()
      .map(normalizeTaskRow);
  }
  sessions() {
    return this.db
      .prepare('SELECT * FROM sessions ORDER BY createdAt DESC')
      .all();
  }
  teamSpaces() {
    return this.records.list('spaces').map((space) => this.normalizeTeamSpace(space));
  }
  teamSpace(id) {
    const space = this.records.get('spaces', id);
    return space ? this.normalizeTeamSpace(space) : null;
  }
  teamTemplates() {
    return this.records.list('team-templates').map((template) => this.normalizeTeamTemplate(template));
  }
  teamTemplate(id) {
    const template = this.records.get('team-templates', id);
    return template ? this.normalizeTeamTemplate(template) : null;
  }
  normalizeTeamTemplate(template) {
    return normalizeTeamTemplateData(template);
  }
  saveTeamTemplate(input, id) {
    const existing = id ? this.teamTemplate(id) : undefined;
    if (id && !existing) throw new Error('团队模板不存在。');
    const sourceTeamId = typeof input.sourceTeamId === 'string' && input.sourceTeamId.trim()
      ? input.sourceTeamId.trim()
      : (existing?.sourceTeamId || null);
    const source = sourceTeamId ? this.teamSpace(sourceTeamId) : null;
    if (sourceTeamId && !source) throw new Error('模板来源团队不存在。');
    if (source && source.status === 'archived') throw new Error('归档团队不能保存为模板。');
    if (source && source.recruitment?.phase !== 'confirmed') throw new Error('只有已确认的团队才能保存为模板。');
    const name = String(input.name ?? existing?.name ?? source?.name ?? '').trim();
    if (!name || name.length > 80) throw new Error('团队模板名称无效。');
    const description = String(input.description ?? existing?.description ?? source?.purpose ?? source?.goal ?? '').trim();
    if (description.length > 2000) throw new Error('团队模板说明不能超过 2000 字符。');
    const config = source || existing;
    if (!config) throw new Error('请提供模板来源团队。');
    const memberRoleIds = [...new Set(
      (Array.isArray(config.memberRoleIds) ? config.memberRoleIds : [config.pmRoleId || 'project_manager'])
        .filter((value) => typeof value === 'string' && this.role(value) && !this.role(value).archived),
    )];
    const pmRoleId = String(config.pmRoleId || memberRoleIds[0] || 'project_manager').trim();
    if (!memberRoleIds.includes(pmRoleId)) memberRoleIds.unshift(pmRoleId);
    return this.records.save('team-templates', {
      ...existing,
      name,
      description,
      sourceTeamId: source?.id || sourceTeamId || existing?.sourceTeamId || null,
      sourceTeamName: source?.name || existing?.sourceTeamName || null,
      teamType: config.teamType || 'custom',
      goal: String(config.goal || '').trim().slice(0, 2000),
      purpose: String(config.purpose || config.goal || '').trim().slice(0, 2000),
      model: config.model || null,
      providerId: config.providerId || null,
      workspaceMode: config.workspaceMode || 'isolated',
      pmRoleId,
      memberRoleIds,
      responsibilities: config.responsibilities && typeof config.responsibilities === 'object' && !Array.isArray(config.responsibilities)
        ? config.responsibilities
        : {},
      memberSettings: config.memberSettings && typeof config.memberSettings === 'object' && !Array.isArray(config.memberSettings)
        ? config.memberSettings
        : {},
      autonomy: config.autonomy || { mode: 'auto', maxDepth: 4, maxJobs: 32, budgetTokens: 200000, requireApprovalKinds: [] },
      collaboration: {
        enabled: config.collaboration?.enabled !== false,
        autoHandoff: config.collaboration?.autoHandoff !== false,
        sharedBoard: config.collaboration?.sharedBoard !== false,
        // A template must not preserve a team's private allow-list. Targets
        // are selected after the new team is created.
        allowedTeamIds: [],
      },
    }, id);
  }
  removeTeamTemplate(id) {
    if (!this.teamTemplate(id)) throw new Error('团队模板不存在。');
    return this.records.remove('team-templates', id);
  }
  createTeamFromTemplate(templateId, input = {}) {
    const template = this.teamTemplate(templateId);
    if (!template) throw new Error('团队模板不存在。');
    const name = String(input.name ?? '').trim();
    const goal = String(input.goal ?? template.goal ?? '').trim();
    if (!name || name.length > 80) throw new Error('新团队名称无效。');
    if (!goal || goal.length > 2000) throw new Error('新团队目标无效。');
    const workspace = String(input.workspace ?? this.config.workspace).trim();
    const model = Object.hasOwn(input, 'model') ? input.model : template.model;
    const providerId = Object.hasOwn(input, 'providerId') ? input.providerId : template.providerId;
    // A copy starts a fresh recruitment identity. Never carry the source
    // team's session, turns, proposal or confirmation timestamp across.
    const requestedPhase = input.recruitment && typeof input.recruitment === 'object' && !Array.isArray(input.recruitment)
      && input.recruitment.phase === 'discovery'
      ? 'discovery'
      : 'confirmed';
    const recruitment = {
      phase: requestedPhase,
      sessionId: null,
      turns: 0,
      brief: goal,
      proposal: null,
      confirmedAt: requestedPhase === 'confirmed' ? new Date().toISOString() : null,
    };
    return this.saveTeamSpace({
      name,
      goal,
      purpose: String(input.purpose ?? goal).trim(),
      teamType: input.teamType ?? template.teamType,
      model,
      providerId,
      workspace,
      workspaceMode: input.workspaceMode ?? template.workspaceMode,
      pmRoleId: template.pmRoleId,
      memberRoleIds: template.memberRoleIds,
      responsibilities: template.responsibilities,
      memberSettings: template.memberSettings,
      autonomy: template.autonomy,
      collaboration: {
        ...template.collaboration,
        ...(input.collaboration && typeof input.collaboration === 'object' ? input.collaboration : {}),
        allowedTeamIds: Array.isArray(input.collaboration?.allowedTeamIds)
          ? [...new Set(input.collaboration.allowedTeamIds
            .filter((value) => typeof value === 'string')
            .filter((value) => {
              const target = this.teamSpace(value);
              return target && target.status === 'active' && target.recruitment?.phase === 'confirmed';
            }))]
          : [],
      },
      recruitment,
    });
  }
  normalizeTeamSpace(space) {
    return normalizeTeamSpaceData(space);
  }
  saveTeamSpace(input, id) {
    const existing = id ? this.teamSpace(id) : undefined;
    if (id && !existing) throw new Error('团队空间不存在。');
    // A team space is also the durable identity of a Chat. Keep the old
    // `spaces` collection for compatibility, but expose explicit identifiers
    // so clients can maintain several independent teams.
    const spaceId = id || input.id || randomUUID();
    const chatId = String(input.chatId ?? existing?.chatId ?? spaceId).trim();
    if (!chatId || chatId.length > 150) throw new Error('Chat ID 无效。');
    const name = String(input.name ?? existing?.name ?? '').trim();
    const goal = String(input.goal ?? existing?.goal ?? input.purpose ?? existing?.purpose ?? '').trim();
    const pmRoleId = String(
      input.pmRoleId ?? existing?.pmRoleId ?? 'project_manager',
    ).trim();
    if (!name || name.length > 80) throw new Error('团队空间名称无效。');
    if (!goal || goal.length > 2000) throw new Error('团队空间目标无效。');
    if (!this.role(pmRoleId) || this.role(pmRoleId).archived)
      throw new Error('项目经理助手不存在或已归档。');
    const memberRoleIds = [
      ...new Set(
        (Array.isArray(input.memberRoleIds)
          ? input.memberRoleIds
          : existing?.memberRoleIds || [pmRoleId])
          .filter((value) => typeof value === 'string' && this.role(value)),
      ),
    ];
    if (!memberRoleIds.includes(pmRoleId)) memberRoleIds.unshift(pmRoleId);
    const teamTypeInput = input.teamType ?? existing?.teamType ?? 'custom';
    const teamTypeAliases = { dev: 'development', engineering: 'development', ops: 'operations' };
    const teamType = teamTypeAliases[teamTypeInput] || teamTypeInput;
    if (!['custom', 'development', 'operations', 'product', 'project'].includes(teamType))
      throw new Error('团队类型无效。');
    const purpose = String(input.purpose ?? existing?.purpose ?? goal).trim();
    if (!purpose || purpose.length > 2000) throw new Error('团队职责无效。');
    const modelValue = input.model ?? existing?.model ?? null;
    const model =
      modelValue === null || modelValue === ''
        ? null
        : String(modelValue).trim().slice(0, 120);
    if (model && !modelValue) throw new Error('团队模型无效。');
    const providerValue = input.providerId ?? existing?.providerId ?? null;
    const providerId =
      providerValue === null || providerValue === ''
        ? null
        : String(providerValue).trim().slice(0, 160);
    if (providerId && !providerValue) throw new Error('团队供应商无效。');
    const workspaceMode = input.workspaceMode ?? existing?.workspaceMode ?? 'isolated';
    if (!['isolated', 'worktree', 'snapshot', 'shared'].includes(workspaceMode))
      throw new Error('团队执行目录模式无效。');
    const responsibilities = {};
    const suppliedResponsibilities = input.responsibilities ?? existing?.responsibilities ?? {};
    if (suppliedResponsibilities && typeof suppliedResponsibilities === 'object' && !Array.isArray(suppliedResponsibilities)) {
      for (const [roleId, value] of Object.entries(suppliedResponsibilities)) {
        if (memberRoleIds.includes(roleId) && typeof value === 'string' && value.trim())
          responsibilities[roleId] = value.trim().slice(0, 1000);
      }
    }
    const memberSettings = {};
    const suppliedSettings = input.memberSettings ?? existing?.memberSettings ?? {};
    if (suppliedSettings && typeof suppliedSettings === 'object' && !Array.isArray(suppliedSettings)) {
      for (const roleId of memberRoleIds) {
        const value = suppliedSettings[roleId];
        if (!value || typeof value !== 'object' || Array.isArray(value)) continue;
        memberSettings[roleId] = {
          ...(typeof value.label === 'string' ? { label: value.label.trim().slice(0, 120) } : {}),
          ...(typeof value.responsibility === 'string' ? { responsibility: value.responsibility.trim().slice(0, 1000) } : {}),
          ...(Array.isArray(value.providerIds) ? { providerIds: [...new Set(value.providerIds.filter((v) => typeof v === 'string').slice(0, 20))] } : {}),
          ...(typeof value.memberId === 'string' ? { memberId: value.memberId.trim().slice(0, 64) } : {}),
          ...(typeof value.templateRoleId === 'string' ? { templateRoleId: value.templateRoleId.trim().slice(0, 150) } : {}),
          ...(typeof value.modelHint === 'string' ? { modelHint: value.modelHint.trim().slice(0, 160) } : {}),
          ...(Array.isArray(value.skills) ? { skills: [...new Set(value.skills.filter((v) => typeof v === 'string' && v.trim()).map((v) => v.trim().slice(0, 160)).slice(0, 12))] } : {}),
          ...(Array.isArray(value.skillIds) ? { skillIds: [...new Set(value.skillIds.filter((v) => typeof v === 'string' && v.trim()).map((v) => v.trim().slice(0, 80)).slice(0, 3))] } : {}),
          ...(Array.isArray(value.capabilityIds) ? { capabilityIds: [...new Set(value.capabilityIds.filter((v) => typeof v === 'string' && v.trim()).map((v) => v.trim().slice(0, 160)).slice(0, 100))] } : {}),
          ...(Array.isArray(value.providerIds) ? { providerIds: [...new Set(value.providerIds.filter((v) => typeof v === 'string' && v.trim()).map((v) => v.trim().slice(0, 160)).slice(0, 32))] } : {}),
          ...(Array.isArray(value.tools) ? { tools: [...new Set(value.tools.filter((v) => typeof v === 'string' && v.trim()).map((v) => v.trim().slice(0, 160)).slice(0, 12))] } : {}),
          ...(value.toolAccess && typeof value.toolAccess === 'object' && !Array.isArray(value.toolAccess) ? {
            toolAccess: Object.fromEntries(['files', 'web', 'terminal']
              .filter((key) => value.toolAccess[key] !== undefined && typeof value.toolAccess[key] === 'boolean')
              .map((key) => [key, value.toolAccess[key]])),
          } : {}),
          ...(Array.isArray(value.dependencies) ? { dependencies: [...new Set(value.dependencies.filter((v) => typeof v === 'string' && v.trim()).map((v) => v.trim().slice(0, 64)).slice(0, 12))] } : {}),
        };
      }
    }
    const status = input.status ?? existing?.status ?? 'active';
    if (!['active', 'paused', 'archived'].includes(status))
      throw new Error('团队空间状态无效。');
    const autonomy = {
      mode: input.autonomy?.mode ?? existing?.autonomy?.mode ?? 'auto',
      maxDepth: input.autonomy?.maxDepth ?? existing?.autonomy?.maxDepth ?? 4,
      maxJobs: input.autonomy?.maxJobs ?? existing?.autonomy?.maxJobs ?? 32,
      budgetTokens:
        input.autonomy?.budgetTokens ?? existing?.autonomy?.budgetTokens ?? 200000,
      requireApprovalKinds:
        input.autonomy?.requireApprovalKinds ??
        existing?.autonomy?.requireApprovalKinds ??
        [],
    };
    if (!['assist', 'auto'].includes(autonomy.mode))
      throw new Error('团队空间自治模式无效。');
    if (!Number.isSafeInteger(autonomy.maxDepth) || autonomy.maxDepth < 1 || autonomy.maxDepth > 4)
      throw new Error('团队空间最大层级需要在 1 至 4 之间。');
    if (!Number.isSafeInteger(autonomy.maxJobs) || autonomy.maxJobs < 1 || autonomy.maxJobs > 32)
      throw new Error('团队空间最大任务数需要在 1 至 32 之间。');
    if (!Number.isSafeInteger(autonomy.budgetTokens) || autonomy.budgetTokens < 1000 || autonomy.budgetTokens > 100000000)
      throw new Error('团队空间预算需要在 1000 至 100000000 之间。');
    const collaborationInput = input.collaboration ?? existing?.collaboration ?? {};
    const collaboration = {
      enabled: collaborationInput.enabled !== false,
      autoHandoff: collaborationInput.autoHandoff !== false,
      sharedBoard: collaborationInput.sharedBoard !== false,
      allowedTeamIds: Array.isArray(collaborationInput.allowedTeamIds)
        ? [...new Set(collaborationInput.allowedTeamIds.filter((value) => typeof value === 'string' && value !== spaceId).slice(0, 50))]
        : (existing?.collaboration?.allowedTeamIds || []),
    };
    const recruitmentInput = input.recruitment ?? existing?.recruitment ?? {};
    const recruitmentPhase = ['discovery', 'proposed', 'confirmed'].includes(recruitmentInput.phase)
      ? recruitmentInput.phase
      : (!existing && input.recruitment === undefined ? 'confirmed' : 'discovery');
    const recruitment = {
      phase: recruitmentPhase,
      sessionId: typeof recruitmentInput.sessionId === 'string' && recruitmentInput.sessionId.trim()
        ? recruitmentInput.sessionId.trim().slice(0, 160)
        : null,
      turns: Number.isSafeInteger(recruitmentInput.turns) && recruitmentInput.turns >= 0
        ? Math.min(recruitmentInput.turns, 1000)
        : 0,
      brief: typeof recruitmentInput.brief === 'string' ? recruitmentInput.brief.trim().slice(0, 20000) : '',
      proposal: recruitmentInput.proposal && typeof recruitmentInput.proposal === 'object' && !Array.isArray(recruitmentInput.proposal)
        ? recruitmentInput.proposal
        : null,
      confirmedAt: typeof recruitmentInput.confirmedAt === 'string' ? recruitmentInput.confirmedAt : null,
    };
    return this.records.save('spaces', {
      ...existing,
      id: spaceId,
      chatId,
      name,
      goal,
      purpose,
      model,
      providerId,
      workspaceMode,
      teamType,
      workspace: input.workspace || existing?.workspace || this.config.workspace,
      pmRoleId,
      memberRoleIds,
      responsibilities,
      memberSettings,
      recruitment,
      status,
      autonomy,
      collaboration,
      archivedAt: status === 'archived'
        ? input.archivedAt ?? existing?.archivedAt ?? new Date().toISOString()
        : null,
      archivedFromStatus: status === 'archived'
        ? input.archivedFromStatus ?? existing?.archivedFromStatus ?? null
        : null,
    }, spaceId);
  }
  teamMessages(spaceId) {
    return this.records
      .list('space-messages')
      .filter((message) => message.spaceId === spaceId);
  }
  recruitmentPage(spaceId, { after = null, limit = 100 } = {}) {
    const space = this.teamSpace(spaceId);
    return buildRecruitmentPage({
      space,
      tasks: space ? this.tasks() : [],
      messages: space ? this.teamMessages(spaceId) : [],
      after,
      limit,
    });
  }
  taskDelivery(task) {
    const meta = this.records.get('task-meta', task.id) || {};
    const job = meta.jobId ? this.records.get('jobs', meta.jobId) : null;
    const artifacts = this.records.list('artifacts').filter((artifact) => artifact.taskId === task.id);
    const savedAcceptance = this.records.get('task-acceptance', task.id);
    return deriveTaskDelivery({ task, meta, job, artifacts, savedAcceptance });
  }
  teamTimeline(spaceId, limit = 120, before = null) {
    if (!this.teamSpace(spaceId)) return [];
    const tasks = this.tasks().filter((task) => {
      const meta = this.records.get('task-meta', task.id) || {};
      const job = meta.jobId ? this.records.get('jobs', meta.jobId) : null;
      return (meta.spaceId || job?.spaceId || null) === spaceId;
    });
    const taskIds = new Set(tasks.map((task) => task.id));
    const taskById = new Map(tasks.map((task) => [task.id, task]));
    const items = [];
    for (const message of this.teamMessages(spaceId)) {
      items.push({
        id: `message:${message.id}`,
        type: 'message',
        at: message.createdAt,
        messageId: message.id,
        clientMessageId: message.clientMessageId || null,
        senderType: message.senderType,
        senderId: message.senderId,
        fromTeamId: message.fromTeamId || null,
        toTeamId: message.toTeamId || null,
        relatedMessageId: message.relatedMessageId || null,
        kind: message.kind,
        taskId: message.taskId || null,
        content: message.content,
        status: message.status,
        error: message.error || null,
        attachmentIds: Array.isArray(message.attachmentIds) ? message.attachmentIds : [],
      });
    }
    for (const task of tasks) {
      const meta = this.records.get('task-meta', task.id) || {};
      const artifacts = this.records.list('artifacts').filter((artifact) => artifact.taskId === task.id);
      const delivery = this.taskDelivery(task);
      items.push({
        id: `task:${task.id}`,
        type: 'task',
        at: task.updatedAt || task.createdAt,
        taskId: task.id,
        role: task.role,
        title: task.title,
        status: task.status,
        result: String(task.result || '').slice(0, 360),
        error: String(task.error || '').slice(0, 360),
        workspaceMode: meta.workspaceMode || null,
        artifactCount: artifacts.length,
        verificationStatus: delivery.hasVerificationEvidence ? delivery.acceptanceStatus : null,
        deliveryStatus: delivery.deliveryStatus,
        acceptanceDecision: delivery.acceptanceDecision,
      });
    }
    for (const event of this.records.list('task-events')) {
      if (!taskIds.has(event.taskId)) continue;
      items.push({
        id: `event:${event.id}`,
        type: 'task-event',
        at: event.at || event.updatedAt || event.createdAt || taskById.get(event.taskId)?.updatedAt || taskById.get(event.taskId)?.createdAt,
        taskId: event.taskId,
        eventType: event.type || 'event',
        data: event.data || null,
      });
    }
    for (const artifact of this.records.list('artifacts')) {
      if (!taskIds.has(artifact.taskId)) continue;
      items.push({
        id: `artifact:${artifact.id}`,
        type: artifact.kind === 'verification' ? 'verification' : 'artifact',
        at: artifact.finishedAt || artifact.updatedAt || artifact.createdAt || taskById.get(artifact.taskId)?.updatedAt || taskById.get(artifact.taskId)?.createdAt,
        taskId: artifact.taskId,
        kind: artifact.kind || 'artifact',
        name: artifact.name || '未命名产物',
        status: artifact.status || null,
        verified: artifact.verified === true,
      });
    }
    for (const acceptance of this.records.list('task-acceptance')) {
      if (!taskIds.has(acceptance.taskId)) continue;
      items.push({
        id: `acceptance:${acceptance.id}`,
        type: 'acceptance',
        at: acceptance.decidedAt || acceptance.updatedAt || acceptance.createdAt || taskById.get(acceptance.taskId)?.updatedAt || taskById.get(acceptance.taskId)?.createdAt,
        taskId: acceptance.taskId,
        status: acceptance.status || 'active',
        acceptanceDecision: acceptance.decision || null,
        acceptanceNote: String(acceptance.note || '').slice(0, 360),
        currentRequirementVersion: Number(acceptance.requirementVersion || 1),
      });
    }
    const cursor = typeof before === 'string' && before.trim()
      ? before.split('|')
      : [];
    const beforeAt = cursor[0] || null;
    const beforeId = cursor.slice(1).join('|') || null;
    return items
      .filter((item) => typeof item.at === 'string' && item.at)
      .sort((a, b) => a.at.localeCompare(b.at) || a.id.localeCompare(b.id))
      .filter((item) => !beforeAt || item.at < beforeAt || (item.at === beforeAt && Boolean(beforeId && item.id < beforeId)))
      .slice(-Math.max(1, Math.min(200, Number(limit) || 120)));
  }
  draftKey(spaceId, roleId) {
    return makeDraftKey(spaceId, roleId);
  }
  teamDraft(spaceId, roleId) {
    const key = this.draftKey(spaceId, roleId);
    return this.records.get('space-drafts', key);
  }
  teamDrafts() {
    return this.records.list('space-drafts');
  }
  saveTeamDraft(input, expectedRevision) {
    const spaceId = typeof input.spaceId === 'string' && input.spaceId.trim()
      ? input.spaceId.trim()
      : null;
    const roleId = String(input.roleId || '').trim();
    if (!roleId || !this.role(roleId) || this.role(roleId).archived)
      throw new Error('草稿所属助手不存在或已归档。');
    if (spaceId) {
      const space = this.teamSpace(spaceId);
      if (!space) throw new Error('草稿所属团队不存在。');
      if (space.status !== 'active') throw new Error('草稿所属团队当前不可编辑。');
      if (!space.memberRoleIds.includes(roleId))
        throw new Error('该助手不属于当前团队。');
    }
    const content = String(input.content ?? '').trim();
    const attachmentIds = Array.isArray(input.attachmentIds)
      ? [...new Set(input.attachmentIds.filter((value) => typeof value === 'string' && value.trim()).map((value) => value.trim()))]
      : [];
    const key = this.draftKey(spaceId, roleId);
    const existing = this.records.get('space-drafts', key);
    const revisionConflict = () => Object.assign(
      new Error('草稿已在其他窗口更新，请刷新后重试。'),
      { status: 409 },
    );
    // A missing revision is safe for the first write only. Once a draft
    // exists, requiring the caller to send the revision prevents an offline
    // tab from overwriting newer work after it reconnects.
    if (existing && (expectedRevision === undefined || existing.revision !== expectedRevision))
      throw revisionConflict();
    if (!content && !attachmentIds.length) {
      if (existing) this.records.remove('space-drafts', key);
      return null;
    }
    if (content.length > 32000) throw new Error('草稿不能超过 32000 字符。');
    return this.records.save('space-drafts', {
      spaceId,
      roleId,
      content,
      attachmentIds: attachmentIds.slice(0, 20),
    }, key, expectedRevision);
  }
  removeTeamDraft(spaceId, roleId, expectedRevision) {
    const key = this.draftKey(spaceId, roleId);
    const existing = this.records.get('space-drafts', key);
    if (!existing) return false;
    if (expectedRevision === undefined || existing.revision !== expectedRevision)
      throw Object.assign(new Error('草稿已在其他窗口更新，请刷新后重试。'), { status: 409 });
    return this.records.remove('space-drafts', key);
  }
  saveTeamMessage(input, id) {
    const spaceId = input.spaceId || input.teamId;
    if (!this.teamSpace(spaceId)) throw new Error('团队空间不存在。');
    const content = String(input.content ?? '').trim();
    if (!content || content.length > 32000) throw new Error('团队消息不能为空，且不能超过 32000 字符。');
    return this.records.save('space-messages', {
      spaceId,
      teamId: input.teamId || spaceId,
      clientMessageId: input.clientMessageId || null,
      kind: input.kind || 'request',
      senderType: input.senderType || 'owner',
      senderId: input.senderId || 'owner',
      fromTeamId: input.fromTeamId || null,
      toTeamId: input.toTeamId || spaceId,
      relatedMessageId: input.relatedMessageId || null,
      taskId: input.taskId || null,
      attachmentIds: Array.isArray(input.attachmentIds) ? [...new Set(input.attachmentIds.filter((value) => typeof value === 'string').slice(0, 20))] : [],
      content,
      status: input.status || 'sent',
    }, id);
  }
  updateTask(id, changes) {
    const allowed = [
      'status',
      'result',
      'error',
      'log',
      'knowledgeIds',
      'knowledgeRefs',
      'context',
    ];
    const entries = Object.entries(changes).filter(([key]) =>
      allowed.includes(key),
    );
    if (!entries.length) return this.task(id);
    const previous = this.task(id);
    this.db
      .prepare(
        `UPDATE tasks SET ${entries.map(([key]) => `${key}=?`).join(',')},updatedAt=? WHERE id=?`,
      )
      .run(
        ...entries.map(([key, v]) =>
          ['knowledgeIds', 'knowledgeRefs'].includes(key) ? JSON.stringify(v) : v,
        ),
        this.records.nextTimestamp(),
        id,
      );
    const saved = this.task(id);
    try { this.onTaskUpdate?.({ task: saved, previous }); } catch {}
    return saved;
  }
  createTask({
    role,
    prompt,
    sessionId,
    sourceTaskId,
    teamId,
    spaceId,
    workspace = this.config.workspace,
  }) {
    const assistant = this.role(role);
    if (!assistant || assistant.archived)
      throw new Error('助手不存在或已归档，请先恢复助手。');
    const scopeId = teamId || spaceId || null;
    const now = new Date().toISOString(),
      id = randomUUID();
    this.db.exec('SAVEPOINT create_task');
    try {
      if (sessionId) {
        const session = this.db
          .prepare('SELECT * FROM sessions WHERE id=?')
          .get(sessionId);
        if (
          !session ||
          session.role !== role ||
          session.workspace !== workspace
        )
          throw new Error('这个会话不属于当前助手或工作目录，请新建会话。');
        const previousTasks = this.db
          .prepare('SELECT id FROM tasks WHERE sessionId=?')
          .all(sessionId);
        if (scopeId) {
          const crossesTeamBoundary = previousTasks.some(({ id: previousTaskId }) => {
            const meta = this.records.get('task-meta', previousTaskId);
            const previousScopeId = meta?.teamId || meta?.spaceId || null;
            return previousScopeId !== scopeId;
          });
          if (crossesTeamBoundary)
            throw Object.assign(
              new Error('这个会话属于另一个团队，请为当前团队新建会话。'),
              { status: 409 },
            );
        } else if (previousTasks.some(({ id: previousTaskId }) => {
          const meta = this.records.get('task-meta', previousTaskId);
          return Boolean(meta?.teamId || meta?.spaceId);
        })) {
          throw Object.assign(
            new Error('这个会话属于团队空间，请使用团队自己的会话。'),
            { status: 409 },
          );
        }
      } else {
        sessionId = randomUUID();
        this.db
          .prepare('INSERT INTO sessions VALUES(?,?,?,?,?)')
          .run(sessionId, role, workspace, prompt.slice(0, 40), now);
      }
      this.db
        .prepare(
          'INSERT INTO tasks (id,sessionId,role,workspace,title,prompt,status,sourceTaskId,createdAt,updatedAt) VALUES(?,?,?,?,?,?,?,?,?,?)',
        )
        .run(
          id,
          sessionId,
          role,
          workspace,
          prompt.slice(0, 65),
          prompt,
          'queued',
          sourceTaskId || null,
          now,
          now,
        );
      this.db.exec('RELEASE SAVEPOINT create_task');
      return this.task(id);
    } catch (error) {
      this.db.exec(
        'ROLLBACK TO SAVEPOINT create_task; RELEASE SAVEPOINT create_task',
      );
      throw error;
    }
  }
  close() {
    this.db.close();
  }
}

Object.assign(Store.prototype, knowledgeMethods);
Object.assign(Store.prototype, teamLifecycleMethods);

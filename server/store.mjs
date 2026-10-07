import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { validateRole } from './roles.mjs';
import { migrate } from './migrations.mjs';
import { saveTeamSpace as persistTeamSpace } from './store/team-space.mjs';
import { StoreReadIndex } from './store/read-index.mjs';
import { buildTeamTimeline } from './store/team-timeline.mjs';
import { Records } from './records.mjs';
import { DEFAULT_PROFILE, validateProfile } from './profile.mjs';
import { ROLES } from './store/roles.mjs';
import { knowledgeMethods } from './store/knowledge.mjs';
import { teamLifecycleMethods } from './store/team-lifecycle.mjs';
import { normalizePlanTaskIds } from './store/plan-tasks.mjs';
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
      this.db
        .prepare('PRAGMA table_info(knowledge)')
        .all()
        .map((column) => column.name),
    );
    const taskColumns = new Set(
      this.db
        .prepare('PRAGMA table_info(tasks)')
        .all()
        .map((column) => column.name),
    );
    if (!taskColumns.has('knowledgeRefs'))
      this.db.exec(
        "ALTER TABLE tasks ADD COLUMN knowledgeRefs TEXT NOT NULL DEFAULT '[]'",
      );
    // Databases created before team-scoped knowledge used an eight-column
    // table. Keep those records readable and add the nullable-by-convention
    // empty team ID without rewriting user content.
    if (!knowledgeColumns.has('teamId'))
      this.db.exec(
        "ALTER TABLE knowledge ADD COLUMN teamId TEXT NOT NULL DEFAULT ''",
      );
    if (!knowledgeColumns.has('version'))
      this.db.exec(
        'ALTER TABLE knowledge ADD COLUMN version INTEGER NOT NULL DEFAULT 1',
      );
    if (!knowledgeColumns.has('createdAt')) {
      this.db.exec('ALTER TABLE knowledge ADD COLUMN createdAt TEXT');
      this.db.exec(
        'UPDATE knowledge SET createdAt=updatedAt WHERE createdAt IS NULL',
      );
    }
    if (!knowledgeColumns.has('expiresAt'))
      this.db.exec('ALTER TABLE knowledge ADD COLUMN expiresAt TEXT');
    this.db.exec(
      'CREATE INDEX IF NOT EXISTS idx_knowledge_team ON knowledge(teamId)',
    );
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
      const skillIds = [
        ...new Set([
          ...(existingProjectManager.skillIds || []),
          'team-recruitment',
        ]),
      ];
      const recruitmentRule =
        '团队招募阶段先多轮澄清需求，使用 propose_team 保存待确认的 Team Charter；保存后等待用户在团队招募界面确认创建，确认前不要配置成员或分派任务。';
      const currentInstructions = String(
        existingProjectManager.instructions || '',
      );
      const instructions = currentInstructions.includes('propose_team')
        ? currentInstructions.replace(
            /只有用户明确确认后，才使用 confirm_team_recruitment 完成成员配置，再使用团队编排工具 delegate_task 分派工作。/,
            '保存后明确等待用户在团队招募界面点击确认创建；确认前不要把成员说成已创建，也不要使用 delegate_task。',
          )
        : `${currentInstructions}\n${recruitmentRule}`.trim();
      if (
        JSON.stringify(skillIds) !==
          JSON.stringify(existingProjectManager.skillIds || []) ||
        instructions !== existingProjectManager.instructions
      ) {
        this.saveRole(
          { ...existingProjectManager, skillIds, instructions },
          'project_manager',
        );
      }
    }
    if (
      seedProjectManager &&
      !this.records.list('spaces').length &&
      this.role('project_manager')
    ) {
      this.records.save('spaces', {
        name: '新需求',
        goal: '先澄清需求、交付物和约束，再确认团队方案。',
        purpose: '通过多轮交流明确团队职责。',
        teamType: 'project',
        workspace: this.config.workspace,
        pmRoleId: 'project_manager',
        memberRoleIds: ['project_manager'],
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
        },
        memberSettings: {},
        collaboration: {
          enabled: true,
          autoHandoff: true,
          sharedBoard: true,
          allowedTeamIds: [],
        },
        recruitment: {
          phase: 'discovery',
          sessionId: null,
          turns: 0,
          brief: '',
          proposal: null,
          confirmedAt: null,
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
    if (
      archived &&
      this.teamSpaces().some(
        (team) =>
          team.status !== 'archived' &&
          (team.pmRoleId === id ||
            (Array.isArray(team.memberRoleIds) &&
              team.memberRoleIds.includes(id))),
      )
    )
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
    return normalizeTaskRow(
      this.db.prepare('SELECT * FROM tasks WHERE id=?').get(id),
    );
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
    return this.records
      .list('spaces')
      .map((space) => this.normalizeTeamSpace(space));
  }
  teamSpace(id) {
    const space = this.records.get('spaces', id);
    return space ? this.normalizeTeamSpace(space) : null;
  }
  defaultTeamPlan(spaceId) {
    const space = this.teamSpace(spaceId);
    if (!space) return null;
    return {
      id: space.id,
      teamId: space.id,
      version: 1,
      status: 'active',
      summary: space.goal,
      dueAt: null,
      riskPreference: 'balanced',
      budgetTokens: null,
      milestones: [],
      revision: 0,
      createdAt: null,
      updatedAt: null,
    };
  }
  teamPlan(spaceId) {
    if (!this.teamSpace(spaceId)) return null;
    const saved = this.records.get('team-plans', spaceId);
    if (!saved) return this.defaultTeamPlan(spaceId);
    return {
      ...this.defaultTeamPlan(spaceId),
      ...saved,
      dueAt: saved.dueAt ?? null,
      riskPreference: saved.riskPreference ?? 'balanced',
      budgetTokens: saved.budgetTokens ?? null,
    };
  }
  saveTeamPlan(spaceId, input = {}, { agentUpdate } = {}) {
    const space = this.teamSpace(spaceId);
    if (!space) throw new Error('团队空间不存在。');
    if (space.status === 'archived') throw new Error('归档团队不能编辑计划。');
    const existing = this.records.get('team-plans', spaceId) || {};
    const status = input.status ?? existing.status ?? 'active';
    if (!['active', 'paused', 'completed'].includes(status))
      throw new Error('团队计划状态无效。');
    const summary = String(
      input.summary ?? existing.summary ?? space.goal,
    ).trim();
    if (!summary || summary.length > 2000)
      throw new Error('团队计划说明无效。');
    const dueAtValue = Object.hasOwn(input, 'dueAt')
      ? input.dueAt
      : (existing.dueAt ?? null);
    let dueAt = null;
    if (
      dueAtValue !== null &&
      dueAtValue !== undefined &&
      String(dueAtValue).trim()
    ) {
      dueAt = String(dueAtValue).trim();
      const parsedDueAt = Date.parse(`${dueAt}T00:00:00Z`);
      const date = new Date(parsedDueAt);
      const validRoundTrip =
        !Number.isNaN(parsedDueAt) && date.toISOString().slice(0, 10) === dueAt;
      if (!/^\d{4}-\d{2}-\d{2}$/.test(dueAt) || !validRoundTrip)
        throw new Error('计划截止日期必须是有效的 YYYY-MM-DD 日期。');
    }
    const riskPreference =
      input.riskPreference ?? existing.riskPreference ?? 'balanced';
    if (!['conservative', 'balanced', 'aggressive'].includes(riskPreference))
      throw new Error('计划风险偏好无效。');
    const budgetValue = Object.hasOwn(input, 'budgetTokens')
      ? input.budgetTokens
      : (existing.budgetTokens ?? null);
    const budgetTokens =
      budgetValue === null || budgetValue === undefined || budgetValue === ''
        ? null
        : Number(budgetValue);
    const autonomyBudget = Number(space.autonomy?.budgetTokens) || 200000;
    if (
      budgetTokens !== null &&
      (!Number.isSafeInteger(budgetTokens) ||
        budgetTokens < 1000 ||
        budgetTokens > autonomyBudget)
    )
      throw new Error(
        `计划预算需要在 1000 至团队自治预算 ${autonomyBudget} tokens 之间。`,
      );
    const source = Array.isArray(input.milestones)
      ? input.milestones
      : Array.isArray(existing.milestones)
        ? existing.milestones
        : [];
    if (source.length > 40) throw new Error('团队里程碑最多 40 项。');
    const milestones = source.map((item, index) => {
      if (!item || typeof item !== 'object' || Array.isArray(item))
        throw new Error('团队里程碑格式无效。');
      const title = String(item.title ?? '').trim();
      if (!title || title.length > 160) throw new Error('里程碑标题无效。');
      const description = String(item.description ?? '').trim();
      if (description.length > 1000)
        throw new Error('里程碑说明不能超过 1000 个字符。');
      const milestoneStatus = item.status ?? 'planned';
      if (
        !['planned', 'active', 'blocked', 'completed'].includes(milestoneStatus)
      )
        throw new Error('里程碑状态无效。');
      const dueAt = item.dueAt ? String(item.dueAt).trim().slice(0, 40) : null;
      const ownerRoleId = item.ownerRoleId
        ? String(item.ownerRoleId).trim().slice(0, 160)
        : null;
      return {
        id: String(item.id || randomUUID()).slice(0, 80),
        title,
        description,
        status: milestoneStatus,
        dueAt,
        ownerRoleId,
        taskIds: normalizePlanTaskIds(this, spaceId, item.taskIds),
        order: Number.isSafeInteger(item.order) ? item.order : index,
        completedAt:
          milestoneStatus === 'completed'
            ? item.completedAt || new Date().toISOString()
            : null,
      };
    });
    milestones.sort((a, b) => a.order - b.order);
    const expectedRevision =
      existing.revision && input.revision !== undefined
        ? input.revision
        : undefined;
    const saved = this.records.save(
      'team-plans',
      {
        ...existing,
        ...(agentUpdate ? { lastAgentUpdate: agentUpdate } : {}),
        id: spaceId,
        teamId: spaceId,
        version: 1,
        status,
        summary,
        dueAt,
        riskPreference,
        budgetTokens,
        milestones,
      },
      spaceId,
      expectedRevision,
    );
    if (summary !== space.goal) {
      this.saveTeamSpace(
        {
          ...space,
          goal: summary,
          purpose: space.purpose === space.goal ? summary : space.purpose,
        },
        space.id,
      );
    }
    return saved;
  }
  teamTemplates() {
    return this.records
      .list('team-templates')
      .map((template) => this.normalizeTeamTemplate(template));
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
    const sourceTeamId =
      typeof input.sourceTeamId === 'string' && input.sourceTeamId.trim()
        ? input.sourceTeamId.trim()
        : existing?.sourceTeamId || null;
    const source = sourceTeamId ? this.teamSpace(sourceTeamId) : null;
    if (sourceTeamId && !source) throw new Error('模板来源团队不存在。');
    if (source && source.status === 'archived')
      throw new Error('归档团队不能保存为模板。');
    if (source && source.recruitment?.phase !== 'confirmed')
      throw new Error('只有已确认的团队才能保存为模板。');
    const name = String(
      input.name ?? existing?.name ?? source?.name ?? '',
    ).trim();
    if (!name || name.length > 80) throw new Error('团队模板名称无效。');
    const description = String(
      input.description ??
        existing?.description ??
        source?.purpose ??
        source?.goal ??
        '',
    ).trim();
    if (description.length > 2000)
      throw new Error('团队模板说明不能超过 2000 字符。');
    const config = source || existing;
    if (!config) throw new Error('请提供模板来源团队。');
    const memberRoleIds = [
      ...new Set(
        (Array.isArray(config.memberRoleIds)
          ? config.memberRoleIds
          : [config.pmRoleId || 'project_manager']
        ).filter(
          (value) =>
            typeof value === 'string' &&
            this.role(value) &&
            !this.role(value).archived,
        ),
      ),
    ];
    const pmRoleId = String(
      config.pmRoleId || memberRoleIds[0] || 'project_manager',
    ).trim();
    if (!memberRoleIds.includes(pmRoleId)) memberRoleIds.unshift(pmRoleId);
    return this.records.save(
      'team-templates',
      {
        ...existing,
        name,
        description,
        sourceTeamId:
          source?.id || sourceTeamId || existing?.sourceTeamId || null,
        sourceTeamName: source?.name || existing?.sourceTeamName || null,
        teamType: config.teamType || 'custom',
        goal: String(config.goal || '')
          .trim()
          .slice(0, 2000),
        purpose: String(config.purpose || config.goal || '')
          .trim()
          .slice(0, 2000),
        model: config.model || null,
        providerId: config.providerId || null,
        workspaceMode: config.workspaceMode || 'isolated',
        pmRoleId,
        memberRoleIds,
        responsibilities:
          config.responsibilities &&
          typeof config.responsibilities === 'object' &&
          !Array.isArray(config.responsibilities)
            ? config.responsibilities
            : {},
        memberSettings:
          config.memberSettings &&
          typeof config.memberSettings === 'object' &&
          !Array.isArray(config.memberSettings)
            ? config.memberSettings
            : {},
        autonomy: config.autonomy || {
          mode: 'auto',
          maxDepth: 4,
          maxJobs: 32,
          budgetTokens: 200000,
          requireApprovalKinds: [],
        },
        collaboration: {
          enabled: config.collaboration?.enabled !== false,
          autoHandoff: config.collaboration?.autoHandoff !== false,
          sharedBoard: config.collaboration?.sharedBoard !== false,
          // A template must not preserve a team's private allow-list. Targets
          // are selected after the new team is created.
          allowedTeamIds: [],
        },
      },
      id,
    );
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
    const providerId = Object.hasOwn(input, 'providerId')
      ? input.providerId
      : template.providerId;
    // A copy starts a fresh recruitment identity. Never carry the source
    // team's session, turns, proposal or confirmation timestamp across.
    const requestedPhase =
      input.recruitment &&
      typeof input.recruitment === 'object' &&
      !Array.isArray(input.recruitment) &&
      input.recruitment.phase === 'discovery'
        ? 'discovery'
        : 'confirmed';
    const recruitment = {
      phase: requestedPhase,
      sessionId: null,
      turns: 0,
      brief: goal,
      proposal: null,
      confirmedAt:
        requestedPhase === 'confirmed' ? new Date().toISOString() : null,
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
        ...(input.collaboration && typeof input.collaboration === 'object'
          ? input.collaboration
          : {}),
        allowedTeamIds: Array.isArray(input.collaboration?.allowedTeamIds)
          ? [
              ...new Set(
                input.collaboration.allowedTeamIds
                  .filter((value) => typeof value === 'string')
                  .filter((value) => {
                    const target = this.teamSpace(value);
                    return (
                      target &&
                      target.status === 'active' &&
                      target.recruitment?.phase === 'confirmed'
                    );
                  }),
              ),
            ]
          : [],
      },
      recruitment,
    });
  }
  normalizeTeamSpace(space) {
    return normalizeTeamSpaceData(space);
  }
  saveTeamSpace(input, id) {
    return persistTeamSpace(this, input, id);
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
    const artifacts = this.records
      .list('artifacts')
      .filter((artifact) => artifact.taskId === task.id);
    const savedAcceptance = this.records.get('task-acceptance', task.id);
    return deriveTaskDelivery({ task, meta, job, artifacts, savedAcceptance });
  }
  teamTimeline(
    spaceId,
    limit = 120,
    before = null,
    read = new StoreReadIndex(this),
    kind = 'all',
  ) {
    return buildTeamTimeline(read, spaceId, limit, before, kind);
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
    const spaceId =
      typeof input.spaceId === 'string' && input.spaceId.trim()
        ? input.spaceId.trim()
        : null;
    const roleId = String(input.roleId || '').trim();
    if (!roleId || !this.role(roleId) || this.role(roleId).archived)
      throw new Error('草稿所属助手不存在或已归档。');
    if (spaceId) {
      const space = this.teamSpace(spaceId);
      if (!space) throw new Error('草稿所属团队不存在。');
      if (space.status !== 'active')
        throw new Error('草稿所属团队当前不可编辑。');
      if (!space.memberRoleIds.includes(roleId))
        throw new Error('该助手不属于当前团队。');
    }
    const content = String(input.content ?? '').trim();
    const attachmentIds = Array.isArray(input.attachmentIds)
      ? [
          ...new Set(
            input.attachmentIds
              .filter((value) => typeof value === 'string' && value.trim())
              .map((value) => value.trim()),
          ),
        ]
      : [];
    const key = this.draftKey(spaceId, roleId);
    const existing = this.records.get('space-drafts', key);
    const revisionConflict = () =>
      Object.assign(new Error('草稿已在其他窗口更新，请刷新后重试。'), {
        status: 409,
      });
    // A missing revision is safe for the first write only. Once a draft
    // exists, requiring the caller to send the revision prevents an offline
    // tab from overwriting newer work after it reconnects.
    if (
      existing &&
      (expectedRevision === undefined || existing.revision !== expectedRevision)
    )
      throw revisionConflict();
    if (!content && !attachmentIds.length) {
      if (existing) this.records.remove('space-drafts', key);
      return null;
    }
    if (content.length > 32000) throw new Error('草稿不能超过 32000 字符。');
    return this.records.save(
      'space-drafts',
      {
        spaceId,
        roleId,
        content,
        attachmentIds: attachmentIds.slice(0, 20),
      },
      key,
      expectedRevision,
    );
  }
  removeTeamDraft(spaceId, roleId, expectedRevision) {
    const key = this.draftKey(spaceId, roleId);
    const existing = this.records.get('space-drafts', key);
    if (!existing) return false;
    if (
      expectedRevision === undefined ||
      existing.revision !== expectedRevision
    )
      throw Object.assign(new Error('草稿已在其他窗口更新，请刷新后重试。'), {
        status: 409,
      });
    return this.records.remove('space-drafts', key);
  }
  saveTeamMessage(input, id) {
    const spaceId = input.spaceId || input.teamId;
    if (!this.teamSpace(spaceId)) throw new Error('团队空间不存在。');
    const content = String(input.content ?? '').trim();
    if (!content || content.length > 32000)
      throw new Error('团队消息不能为空，且不能超过 32000 字符。');
    return this.records.save(
      'space-messages',
      {
        spaceId,
        teamId: input.teamId || spaceId,
        clientMessageId: input.clientMessageId || null,
        kind: input.kind || 'request',
        senderType: input.senderType || 'owner',
        senderId: input.senderId || 'owner',
        fromTeamId: input.fromTeamId || null,
        toTeamId: input.toTeamId || spaceId,
        relatedMessageId: input.relatedMessageId || null,
        followupMessageId: input.followupMessageId || null,
        taskId: input.taskId || null,
        attachmentIds: Array.isArray(input.attachmentIds)
          ? [
              ...new Set(
                input.attachmentIds
                  .filter((value) => typeof value === 'string')
                  .slice(0, 20),
              ),
            ]
          : [],
        content,
        status: input.status || 'sent',
      },
      id,
    );
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
          ['knowledgeIds', 'knowledgeRefs'].includes(key)
            ? JSON.stringify(v)
            : v,
        ),
        this.records.nextTimestamp(),
        id,
      );
    const saved = this.task(id);
    try {
      this.onTaskUpdate?.({ task: saved, previous });
    } catch {}
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
          const crossesTeamBoundary = previousTasks.some(
            ({ id: previousTaskId }) => {
              const meta = this.records.get('task-meta', previousTaskId);
              const previousScopeId = meta?.teamId || meta?.spaceId || null;
              return previousScopeId !== scopeId;
            },
          );
          if (crossesTeamBoundary)
            throw Object.assign(
              new Error('这个会话属于另一个团队，请为当前团队新建会话。'),
              { status: 409 },
            );
        } else if (
          previousTasks.some(({ id: previousTaskId }) => {
            const meta = this.records.get('task-meta', previousTaskId);
            return Boolean(meta?.teamId || meta?.spaceId);
          })
        ) {
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

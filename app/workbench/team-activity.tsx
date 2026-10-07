'use client';

import type { Dispatch, ReactNode, SetStateAction } from 'react';
import {
  ArrowRight,
  Archive,
  Copy,
  ListChecks,
  MessageSquare,
  Pause,
  Pencil,
  Play,
  Plus,
  Users,
  UserRound,
} from 'lucide-react';
import { CrossTeamTimeline } from './team-overview';
import { TeamCollaborationConsole } from './team-collaboration-console';
import { TeamTimelinePanel } from './team-timeline-panel';
import { TeamPlan } from './team-plan';
import { Choice } from './choice';
import { assistantIcons } from '../assistant-editor';
import type { Task, TeamSpace, TeamTimelineItem } from './model';

type TeamMember = {
  id: string;
  name: string;
  icon: string;
  color: string;
  model?: string | null;
};

export type TeamActivityProps = {
  teamSpace?: TeamSpace;
  confirmedSpaces: TeamSpace[];
  busy: boolean;
  activeRoles: Array<{ id: string }>;
  selectTeam: (id: string) => void;
  openCreateTeam: () => void;
  startRecruitment: (forceNew?: boolean) => Promise<void>;
  openSaveTeamTemplate: () => void;
  openTeamRename: () => void;
  openTeamSettings: () => void;
  toggleTeamAutonomy: () => Promise<void>;
  archiveTeam: () => Promise<void>;
  rosterReady: boolean;
  teamMembers: TeamMember[];
  recruitment?: { phase: string };
  openRiskTeam: (id: string) => void;
  openRiskTask: (id: string) => void;
  openPlanTask: (id: string) => void;
  tasks: Task[];
  refresh: () => Promise<void>;
  projectManager?: { name: string };
  teamTasks: Task[];
  isActive: (task: Task) => boolean;
  renderTeamTimelineItem: (item: TeamTimelineItem) => ReactNode;
  teamActivityRevision: number;
  openTeamConversation: () => void;
  setRole: Dispatch<SetStateAction<string>>;
  setView: (view: string) => void;
  teamOpenTasks: Task[];
  teamReviewTasks: Task[];
  teamRiskTasks: Task[];
  teamEvidenceCount: number;
  setTaskFilter: (filter: string) => void;
};

const isActive = (task: Task) => ['queued', 'running'].includes(task.status);

export function TeamActivity({
  teamSpace,
  confirmedSpaces,
  busy,
  activeRoles,
  selectTeam,
  openCreateTeam,
  startRecruitment,
  openSaveTeamTemplate,
  openTeamRename,
  openTeamSettings,
  toggleTeamAutonomy,
  archiveTeam,
  rosterReady,
  teamMembers,
  recruitment,
  openRiskTeam,
  openRiskTask,
  openPlanTask,
  tasks,
  refresh,
  projectManager,
  teamTasks,
  renderTeamTimelineItem,
  teamActivityRevision,
  openTeamConversation,
  setRole,
  setView,
  teamOpenTasks,
  teamReviewTasks,
  teamRiskTasks,
  teamEvidenceCount,
  setTaskFilter,
}: TeamActivityProps) {
  return (
    <main className="team-page" key={`team-page:${teamSpace?.id || 'none'}`}>
      <div className="team-heading">
        <div>
          <span className="section-kicker">TEAM ACTIVITY</span>
          <h1>{teamSpace?.name || '查看团队如何推进。'}</h1>
          <p>
            {teamSpace?.goal ||
              '项目经理会在后台选择成员、分派任务并汇总进展。新的需求请从团队招募发起。'}
          </p>
        </div>
        <div className="team-heading-actions">
          {teamSpace?.recruitment?.phase === 'confirmed' &&
          confirmedSpaces.length > 0 ? (
            <Choice
              label="选择团队"
              value={teamSpace.id}
              onChange={selectTeam}
              options={confirmedSpaces.map((space) => ({
                value: space.id,
                label: space.name,
              }))}
            />
          ) : null}
          <button
            className="secondary-button"
            type="button"
            disabled={busy || !activeRoles.length}
            onClick={() => openCreateTeam()}
          >
            <Copy size={14} /> 新建团队
          </button>
          <button
            className="secondary-button"
            type="button"
            disabled={busy || !activeRoles.length}
            onClick={() => void startRecruitment(true)}
          >
            <Plus size={15} /> 发布新需求
          </button>
          <button
            className="text-button"
            type="button"
            disabled={
              busy || !teamSpace || teamSpace.recruitment?.phase !== 'confirmed'
            }
            onClick={openSaveTeamTemplate}
          >
            <Copy size={13} /> 保存为模板
          </button>
          <button
            className="text-button"
            type="button"
            disabled={busy || !teamSpace}
            onClick={openTeamRename}
          >
            <Pencil size={13} /> 重命名
          </button>
          <button
            className="text-button"
            type="button"
            onClick={openTeamSettings}
          >
            团队设置
          </button>
          {teamSpace?.recruitment?.phase === 'confirmed' && (
            <button
              className={`secondary-button team-autonomy-toggle${teamSpace.status === 'paused' ? ' is-paused' : ''}`}
              type="button"
              disabled={busy}
              aria-label={
                teamSpace.status === 'paused' ? '恢复团队自治' : '暂停团队自治'
              }
              onClick={() => void toggleTeamAutonomy()}
            >
              {teamSpace.status === 'paused' ? (
                <Play size={14} />
              ) : (
                <Pause size={14} />
              )}
              {teamSpace.status === 'paused' ? '恢复自治' : '暂停自治'}
            </button>
          )}
          {teamSpace?.recruitment?.phase === 'confirmed' && (
            <button
              className="text-button team-archive-action"
              type="button"
              disabled={busy}
              onClick={() => void archiveTeam()}
            >
              <Archive size={13} /> 归档团队
            </button>
          )}
          <div
            className={`team-health${teamSpace?.status === 'paused' ? ' is-paused' : ''}`}
          >
            <span className="live-dot" />
            {teamSpace?.status === 'paused'
              ? '自治已暂停 · 新任务不会派发'
              : rosterReady
                ? `${teamMembers.length} 位成员已配置`
                : recruitment?.phase === 'proposed'
                  ? '方案待确认'
                  : '正在招募'}
          </div>
        </div>
      </div>
      {teamSpace?.recruitment?.phase === 'confirmed' && (
        <>
          <div className="team-autonomy-summary" aria-label="团队自治限额">
            <span>
              自治模式 ·{' '}
              {teamSpace.autonomy?.mode === 'assist'
                ? '关键步骤确认'
                : '自动推进'}
            </span>
            <span>活跃任务上限 · {teamSpace.autonomy?.maxJobs || 32}</span>
            <span>最大拆解 · {teamSpace.autonomy?.maxDepth || 4} 层</span>
            <span>
              Token 预算 ·{' '}
              {(teamSpace.autonomy?.budgetTokens || 200000).toLocaleString()}
            </span>
          </div>
          {teamSpace.autonomyUsage && (
            <div
              className={`team-autonomy-usage${teamSpace.autonomyUsage.exceeded ? ' is-exceeded' : teamSpace.autonomyUsage.warning ? ' is-warning' : ''}`}
              aria-label="团队自治用量"
            >
              <div className="team-autonomy-usage-heading">
                <span>累计用量</span>
                <strong>
                  {teamSpace.autonomyUsage.usedTokens.toLocaleString()} /{' '}
                  {teamSpace.autonomyUsage.budgetTokens.toLocaleString()} tokens
                </strong>
                <b>{teamSpace.autonomyUsage.percent}%</b>
              </div>
              <div className="team-autonomy-usage-track" aria-hidden="true">
                <span
                  style={{ width: `${teamSpace.autonomyUsage.percent}%` }}
                />
              </div>
              <small>
                {teamSpace.autonomyUsage.exceeded
                  ? '预算已用尽，自治已暂停。请调整预算后恢复。'
                  : teamSpace.autonomyUsage.warning
                    ? '预算即将用尽，建议先处理或暂停低优先级任务。'
                    : `剩余 ${teamSpace.autonomyUsage.remainingTokens.toLocaleString()} tokens`}
              </small>
            </div>
          )}
        </>
      )}
      {confirmedSpaces.length > 0 && (
        <CrossTeamTimeline
          teams={confirmedSpaces}
          onOpenTeam={openRiskTeam}
          onOpenTask={openRiskTask}
        />
      )}
      {teamSpace?.recruitment?.phase === 'confirmed' && teamSpace && (
        <TeamCollaborationConsole
          key={teamSpace.id}
          team={teamSpace}
          revision={teamActivityRevision}
          teams={confirmedSpaces}
          tasks={tasks}
          onOpenTeam={openRiskTeam}
          onOpenTask={openRiskTask}
          onChanged={refresh}
        />
      )}
      <TeamPlan
        key={`team-plan:${teamSpace?.id || 'none'}`}
        tasks={tasks}
        onOpenTask={openPlanTask}
        teamSpace={teamSpace}
        onChanged={refresh}
      />
      <div className="team-grid">
        <section className="team-chat-panel">
          <div className="team-chat-head">
            <div className="pm-avatar">
              <Users size={20} />
            </div>
            <div>
              <strong>{projectManager?.name || '项目经理'}</strong>
              <span>协调需求、安排任务、跟踪结果</span>
            </div>
            <span className="pm-status">
              <span className="live-dot" />{' '}
              {teamTasks.some(
                (task) => task.role === teamSpace?.pmRoleId && isActive(task),
              )
                ? '正在工作'
                : '随时响应'}
            </span>
          </div>
          <div className="team-chat-stream">
            <div className="team-intro-message">
              <span className="message-label">
                <span className="mini-role pm">PM</span> 项目经理
              </span>
              <p>
                {recruitment?.phase === 'confirmed'
                  ? '在这里跟进团队进展、执行风险和交付证据。需要补充要求或调整方向时，回到团队对话与项目经理沟通。'
                  : '把目标、问题或一段模糊需求直接丢进来。我会先和你澄清，再给出团队规模、职责和推进方式。'}
              </p>
              <div className="pm-flow">
                <span>
                  {recruitment?.phase === 'confirmed' ? '推进任务' : '多轮澄清'}
                </span>
                <ArrowRight size={13} />
                <span>
                  {recruitment?.phase === 'confirmed'
                    ? '跟踪进展'
                    : 'Team Charter'}
                </span>
                <ArrowRight size={13} />
                <span>
                  {recruitment?.phase === 'confirmed' ? '验收交付' : '确认创建'}
                </span>
              </div>
            </div>
            {teamSpace && (
              <TeamTimelinePanel
                key={teamSpace.id}
                teamId={teamSpace.id}
                revision={teamActivityRevision}
                renderItem={renderTeamTimelineItem}
              />
            )}
          </div>
          <div className="team-readonly-note">
            <div className="team-readonly-icon">
              <MessageSquare size={16} />
            </div>
            <div>
              <strong>
                {recruitment?.phase === 'confirmed'
                  ? '继续与当前团队协作'
                  : '新的需求从团队招募发起'}
              </strong>
              <p>这里专门查看项目经理的拆解、成员状态和任务结果。</p>
            </div>
            <button className="text-button" onClick={openTeamConversation}>
              {recruitment?.phase === 'confirmed'
                ? '回到团队对话'
                : '回到团队招募'}{' '}
              <ArrowRight size={13} />
            </button>
          </div>
        </section>
        <aside className="team-roster-panel">
          <div className="team-roster-head">
            <div>
              <span className="section-kicker">ROSTER</span>
              <h2>协作成员</h2>
            </div>
            <span className="count-pill">{teamMembers.length}</span>
          </div>
          <div className="team-member-list">
            {teamMembers.map((member) => {
              const MemberIcon =
                assistantIcons[member.icon as keyof typeof assistantIcons] ||
                UserRound;
              const memberTasks = teamTasks.filter(
                (task) => task.role === member.id,
              );
              const active = memberTasks.filter(isActive).length;
              const settings = teamSpace?.memberSettings?.[member.id];
              const memberModel =
                settings?.modelHint || member.model || teamSpace?.model;
              return (
                <button
                  className="team-member-card"
                  key={member.id}
                  onClick={() => {
                    setRole(member.id);
                    setView('workspace');
                  }}
                >
                  <span
                    className="team-member-icon"
                    style={{
                      color: member.color,
                      background: `${member.color}18`,
                    }}
                  >
                    <MemberIcon size={18} />
                  </span>
                  <span className="team-member-copy">
                    <strong>{settings?.label || member.name}</strong>
                    {settings?.responsibility && (
                      <span className="team-member-responsibility">
                        {settings.responsibility}
                      </span>
                    )}
                    <small>{memberModel || '跟随工作空间模型'}</small>
                  </span>
                  <span
                    className={`team-member-state ${active ? 'working' : ''}`}
                  >
                    <span className="live-dot" />
                    {active ? `${active} 项进行中` : '待命'}
                  </span>
                </button>
              );
            })}
          </div>
          {!rosterReady && (
            <div className="team-roster-pending">
              Team Charter 确认后，候选成员才会创建并出现在这里。
            </div>
          )}
          <div className="team-summary">
            <div className="team-summary-title">
              <ListChecks size={16} />
              任务总览
            </div>
            <div className="team-metrics">
              <span>
                <strong>{teamOpenTasks.length}</strong>
                <small>进行中</small>
              </span>
              <span>
                <strong>{teamReviewTasks.length}</strong>
                <small>待处理</small>
              </span>
              <span>
                <strong>{teamRiskTasks.length}</strong>
                <small>风险/阻塞</small>
              </span>
              <span>
                <strong>
                  {
                    teamTasks.filter((task) => task.status === 'completed')
                      .length
                  }
                </strong>
                <small>已完成</small>
              </span>
            </div>
            <div className="team-summary-evidence">
              最近交付证据 {teamEvidenceCount} 项
            </div>
            <div className="team-summary-actions">
              <button
                className="text-button"
                onClick={() => {
                  setTaskFilter('all');
                  setView('tasks');
                }}
              >
                查看全部任务 <ArrowRight size={13} />
              </button>
              {teamReviewTasks.length > 0 && (
                <button
                  className="text-button"
                  onClick={() => {
                    setTaskFilter('review');
                    setView('tasks');
                  }}
                >
                  打开待处理 <ArrowRight size={13} />
                </button>
              )}
            </div>
          </div>
        </aside>
      </div>
    </main>
  );
}

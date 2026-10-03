'use client';

import { useEffect, useMemo, useState } from 'react';
import {
  Check,
  CircleAlert,
  Flag,
  LoaderCircle,
  Pencil,
  Plus,
  Save,
} from 'lucide-react';
import { api } from '../workbench-api';
import type { TeamSpace } from './model';

type PlanStatus = 'active' | 'paused' | 'completed';
type MilestoneStatus = 'planned' | 'active' | 'blocked' | 'completed';
type Milestone = {
  id: string;
  title: string;
  description: string;
  status: MilestoneStatus;
  dueAt?: string | null;
  ownerRoleId?: string | null;
  order: number;
  completedAt?: string | null;
};
type TeamPlanData = {
  id: string;
  teamId: string;
  summary: string;
  status: PlanStatus;
  dueAt?: string | null;
  riskPreference: 'conservative' | 'balanced' | 'aggressive';
  budgetTokens?: number | null;
  milestones: Milestone[];
  revision: number;
};

const statusLabels: Record<MilestoneStatus, string> = {
  planned: '未开始',
  active: '进行中',
  blocked: '受阻',
  completed: '已完成',
};
const riskLabels: Record<TeamPlanData['riskPreference'], string> = {
  conservative: '稳健：优先控制风险',
  balanced: '平衡：兼顾速度与风险',
  aggressive: '进取：优先推进速度',
};

export function TeamPlan({
  teamSpace,
  onChanged,
}: {
  teamSpace?: TeamSpace;
  onChanged?: () => Promise<void>;
}) {
  const [plan, setPlan] = useState<TeamPlanData | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [draftTitle, setDraftTitle] = useState('');
  const [draftDescription, setDraftDescription] = useState('');
  const [adding, setAdding] = useState(false);
  const [editingSummary, setEditingSummary] = useState(false);
  const [draftSummary, setDraftSummary] = useState('');
  const [editingControls, setEditingControls] = useState(false);
  const [draftDueAt, setDraftDueAt] = useState('');
  const [draftRiskPreference, setDraftRiskPreference] =
    useState<TeamPlanData['riskPreference']>('balanced');
  const [draftBudgetTokens, setDraftBudgetTokens] = useState('');
  const [now] = useState(() => Date.now());

  useEffect(() => {
    let current = true;
    if (!teamSpace?.id) {
      return () => {
        current = false;
      };
    }
    void api<TeamPlanData>(`spaces/${encodeURIComponent(teamSpace.id)}/plan`)
      .then((next) => {
        if (current) setPlan(next);
      })
      .catch((reason) => {
        if (current)
          setError(reason instanceof Error ? reason.message : '计划加载失败。');
      })
      .finally(() => {
        if (current) setLoading(false);
      });
    return () => {
      current = false;
    };
  }, [teamSpace?.id]);

  const completedCount = useMemo(
    () =>
      plan?.milestones.filter((item) => item.status === 'completed').length ||
      0,
    [plan],
  );
  const progress = plan?.milestones.length
    ? Math.round((completedCount / plan.milestones.length) * 100)
    : 0;

  async function save(next: TeamPlanData) {
    setSaving(true);
    setError('');
    try {
      const saved = await api<TeamPlanData>(
        `spaces/${encodeURIComponent(next.teamId)}/plan`,
        'PUT',
        next,
      );
      setPlan(saved);
      await onChanged?.();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '计划保存失败。');
    } finally {
      setSaving(false);
    }
  }

  function updateMilestone(id: string, status: MilestoneStatus) {
    if (!plan) return;
    const milestones = plan.milestones.map((item) =>
      item.id === id
        ? {
            ...item,
            status,
            completedAt:
              status === 'completed' ? new Date().toISOString() : null,
          }
        : item,
    );
    void save({
      ...plan,
      status:
        milestones.length > 0 &&
        milestones.every((item) => item.status === 'completed')
          ? 'completed'
          : 'active',
      milestones,
    });
  }

  function addMilestone() {
    if (!plan || !draftTitle.trim()) return;
    const milestone: Milestone = {
      id: `local-${Date.now()}`,
      title: draftTitle.trim(),
      description: draftDescription.trim(),
      status: 'planned',
      dueAt: null,
      ownerRoleId: null,
      order: plan.milestones.length,
      completedAt: null,
    };
    setAdding(false);
    setDraftTitle('');
    setDraftDescription('');
    void save({
      ...plan,
      status: 'active',
      milestones: [...plan.milestones, milestone],
    });
  }

  function beginSummaryEdit() {
    if (!plan) return;
    setDraftSummary(plan.summary);
    setEditingSummary(true);
  }

  function saveSummary() {
    if (!plan || !draftSummary.trim()) return;
    setEditingSummary(false);
    void save({ ...plan, summary: draftSummary.trim() });
  }

  function beginControlsEdit() {
    if (!plan) return;
    setDraftDueAt(plan.dueAt || '');
    setDraftRiskPreference(plan.riskPreference || 'balanced');
    setDraftBudgetTokens(
      plan.budgetTokens === null || plan.budgetTokens === undefined
        ? ''
        : String(plan.budgetTokens),
    );
    setEditingControls(true);
  }

  function saveControls() {
    if (!plan) return;
    setEditingControls(false);
    void save({
      ...plan,
      dueAt: draftDueAt || null,
      riskPreference: draftRiskPreference,
      budgetTokens: draftBudgetTokens ? Number(draftBudgetTokens) : null,
    });
  }

  const dueState = useMemo(() => {
    if (!plan?.dueAt || plan.status === 'completed') return null;
    const due = new Date(`${plan.dueAt}T23:59:59`);
    if (Number.isNaN(due.getTime())) return null;
    return due.getTime() < now ? 'overdue' : 'upcoming';
  }, [now, plan]);

  if (!teamSpace || teamSpace.recruitment?.phase !== 'confirmed') return null;
  return (
    <section className="team-plan" aria-label="团队目标与里程碑">
      <div className="team-plan-head">
        <div>
          <span className="section-kicker">GOAL PLAN</span>
          <h2>目标与里程碑</h2>
          {editingSummary ? (
            <div className="team-plan-summary-form">
              <textarea
                aria-label="团队目标"
                value={draftSummary}
                onChange={(event) => setDraftSummary(event.target.value)}
                maxLength={2000}
                rows={2}
              />
              <button
                className="primary-button"
                type="button"
                disabled={!draftSummary.trim() || saving}
                onClick={saveSummary}
              >
                <Save size={13} /> 保存目标
              </button>
            </div>
          ) : (
            <p>
              {plan?.summary || teamSpace.goal}{' '}
              <button
                className="team-plan-edit"
                type="button"
                aria-label="编辑团队目标"
                disabled={saving || !plan}
                onClick={beginSummaryEdit}
              >
                <Pencil size={12} /> 编辑
              </button>
            </p>
          )}
        </div>
        <div className="team-plan-progress">
          <strong>{progress}%</strong>
          <span>
            {completedCount}/{plan?.milestones.length || 0} 项完成
          </span>
        </div>
      </div>
      <div className="team-plan-guardrails">
        {editingControls ? (
          <div className="team-plan-controls-form">
            <label>
              截止日期
              <input
                aria-label="计划截止日期"
                type="date"
                value={draftDueAt}
                onChange={(event) => setDraftDueAt(event.target.value)}
              />
            </label>
            <label>
              风险偏好
              <select
                aria-label="计划风险偏好"
                value={draftRiskPreference}
                onChange={(event) =>
                  setDraftRiskPreference(
                    event.target.value as TeamPlanData['riskPreference'],
                  )
                }
              >
                {Object.entries(riskLabels).map(([value, label]) => (
                  <option key={value} value={value}>
                    {label}
                  </option>
                ))}
              </select>
            </label>
            <label>
              计划预算（tokens）
              <input
                aria-label="计划预算"
                type="number"
                min={1000}
                max={teamSpace.autonomy?.budgetTokens || 200000}
                step={1000}
                placeholder="跟随团队自治预算"
                value={draftBudgetTokens}
                onChange={(event) => setDraftBudgetTokens(event.target.value)}
              />
            </label>
            <div className="team-plan-controls-actions">
              <button
                className="primary-button"
                type="button"
                disabled={saving}
                onClick={saveControls}
              >
                <Save size={13} /> 保存边界
              </button>
              <button
                className="text-button"
                type="button"
                onClick={() => setEditingControls(false)}
              >
                取消
              </button>
            </div>
          </div>
        ) : (
          <div className="team-plan-guardrail-row">
            <span className={dueState === 'overdue' ? 'is-overdue' : ''}>
              <strong>截止</strong>{' '}
              {plan?.dueAt
                ? `${plan.dueAt}${dueState === 'overdue' ? ' · 已逾期' : ''}`
                : '未设置'}
            </span>
            <span>
              <strong>风险</strong>{' '}
              {riskLabels[plan?.riskPreference || 'balanced']}
            </span>
            <span>
              <strong>预算</strong>{' '}
              {plan?.budgetTokens
                ? `计划上限 ${plan.budgetTokens.toLocaleString()} · 自治上限 ${(teamSpace.autonomy?.budgetTokens || 200000).toLocaleString()} tokens`
                : `跟随自治上限 ${(teamSpace.autonomy?.budgetTokens || 200000).toLocaleString()} tokens`}
            </span>
            <button
              className="team-plan-edit"
              type="button"
              aria-label="编辑计划边界"
              disabled={saving || !plan}
              onClick={beginControlsEdit}
            >
              <Pencil size={12} /> 编辑边界
            </button>
          </div>
        )}
      </div>
      <div className="team-plan-track" aria-label={`计划完成度 ${progress}%`}>
        <span style={{ width: `${progress}%` }} />
      </div>
      {loading ? (
        <div className="team-plan-empty">
          <LoaderCircle size={15} className="spin" /> 正在加载计划…
        </div>
      ) : error ? (
        <div className="team-plan-error">
          <CircleAlert size={15} /> {error}
        </div>
      ) : plan?.milestones.length ? (
        <div className="team-plan-list">
          {plan.milestones.map((item) => (
            <div className={`team-plan-item is-${item.status}`} key={item.id}>
              <button
                className="team-plan-status"
                type="button"
                aria-label={`${item.title}：${statusLabels[item.status]}`}
                disabled={saving}
                onClick={() =>
                  updateMilestone(
                    item.id,
                    item.status === 'completed' ? 'active' : 'completed',
                  )
                }
              >
                {item.status === 'completed' ? (
                  <Check size={14} />
                ) : (
                  <Flag size={14} />
                )}
              </button>
              <div className="team-plan-copy">
                <strong>{item.title}</strong>
                {item.description && <p>{item.description}</p>}
              </div>
              <span className="team-plan-badge">
                {statusLabels[item.status]}
              </span>
            </div>
          ))}
        </div>
      ) : (
        <div className="team-plan-empty">
          还没有里程碑，把团队目标拆成可验收的阶段吧。
        </div>
      )}
      {adding ? (
        <div className="team-plan-form">
          <input
            value={draftTitle}
            onChange={(event) => setDraftTitle(event.target.value)}
            placeholder="里程碑标题"
          />
          <input
            value={draftDescription}
            onChange={(event) => setDraftDescription(event.target.value)}
            placeholder="验收说明（可选）"
          />
          <div>
            <button
              className="primary-button"
              type="button"
              disabled={!draftTitle.trim() || saving}
              onClick={addMilestone}
            >
              <Save size={14} /> 保存
            </button>
            <button
              className="text-button"
              type="button"
              onClick={() => setAdding(false)}
            >
              取消
            </button>
          </div>
        </div>
      ) : (
        <button
          className="text-button team-plan-add"
          type="button"
          disabled={saving}
          onClick={() => setAdding(true)}
        >
          <Plus size={14} /> 添加里程碑
        </button>
      )}
    </section>
  );
}

'use client';

import { useCallback, useEffect, useState } from 'react';
import { LoaderCircle } from 'lucide-react';
import { api } from '../workbench-api';

const labels: Record<string, string> = {
  selected: '已选用',
  considered: '候选',
  unavailable: '不可用',
  ineligible: '能力不满足',
  compatible: '可直接使用',
  partial: '部分兼容',
  unsupported: '不支持',
  needs_configuration: '需要配置',
  needs_config: '需要配置',
  failed: '失败',
  completed: '已完成',
  fallback: '回退',
};

const time = (value: unknown) =>
  typeof value === 'string' && value
    ? new Date(value).toLocaleString('zh-CN')
    : '-';

function Empty({
  text = '暂无记录',
  busy = false,
}: {
  text?: string;
  busy?: boolean;
}) {
  return (
    <div className="manage-empty">
      {busy ? (
        <LoaderCircle size={26} className="spin" />
      ) : (
        <span aria-hidden="true">○</span>
      )}
      <strong>{busy ? '正在载入' : text}</strong>
    </div>
  );
}

function ErrorMessage({ error }: { error: string }) {
  return error ? (
    <div className="manage-error" role="alert">
      <span>{error}</span>
    </div>
  ) : null;
}

type ModelMetricOption = { id: string; name?: string };
type ModelMetricItem = {
  providerId: string | null;
  providerName: string;
  model: string | null;
  teamName: string;
  roleName: string;
  attempts: number;
  logicalTasks: number;
  completed: number;
  failed: number;
  fallbacks: number;
  fallbackTargets: number;
  avgLatencyMs: number | null;
  p50LatencyMs: number | null;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  cost: number | null;
  costKnown: boolean;
  verificationPassed: number;
  accepted: number;
  rejected: number;
  pending: number;
  candidateDecisions?: {
    providerId: string | null;
    providerName: string | null;
    model: string | null;
    status: string;
    reason: string | null;
    count: number;
  }[];
};
type TaskTypeComparison = {
  taskType: string;
  taskTypeName: string;
  attempts: number;
  logicalTasks: number;
  completed: number;
  failed: number;
  failedAttempts: number;
  fallbacks: number;
  avgLatencyMs: number | null;
  p50LatencyMs: number | null;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  cost: number | null;
  costKnown: boolean;
  verificationPassed: number;
  accepted: number;
  rejected: number;
  pending: number;
  coverageRate: number | null;
  currentVerified: number;
  missingCurrentEvidence: number;
};
type ModelMetricsResponse = {
  generatedAt: string;
  window?: {
    since: string | null;
    until: string | null;
  };
  options?: {
    teams?: ModelMetricOption[];
    roles?: ModelMetricOption[];
    providers?: ModelMetricOption[];
    models?: ModelMetricOption[];
    taskTypes?: ModelMetricOption[];
  };
  totals: {
    attempts: number;
    logicalTasks: number;
    completed: number;
    failed: number;
    accepted: number;
    rejected: number;
    pending: number;
    verificationPassed: number;
    fallbacks: number;
    totalTokens: number;
    cost: number | null;
    costKnown: boolean;
    avgLatencyMs: number | null;
    p50LatencyMs: number | null;
  };
  evidenceQuality?: EvidenceQuality;
  taskTypeComparisons?: TaskTypeComparison[];
  items: ModelMetricItem[];
};

type EvidenceQuality = {
  completedTasks: number;
  withVerification: number;
  currentVerified: number;
  missingCurrentEvidence: number;
  staleEvidence: number;
  failedEvidence: number;
  pendingVerification: number;
  accepted: number;
  rejected: number;
  awaitingOwner: number;
  coverageRate: number | null;
  verificationPassRate: number | null;
  ownerDecisionRate: number | null;
  acceptanceRate: number | null;
  byTeam: Array<{
    teamId: string | null;
    teamName: string;
    completedTasks: number;
    currentVerified: number;
    coverageRate: number | null;
  }>;
  byTaskType: Array<{
    taskType: string;
    taskTypeName: string;
    completedTasks: number;
    currentVerified: number;
    coverageRate: number | null;
  }>;
  trend: Array<{
    date: string;
    completedTasks: number;
    currentVerified: number;
    missingCurrentEvidence: number;
    coverageRate: number | null;
  }>;
};

const metricNumber = (value: number | null | undefined) =>
  typeof value === 'number' && Number.isFinite(value)
    ? value.toLocaleString('zh-CN')
    : '-';
const metricRate = (value: number | null | undefined) =>
  typeof value === 'number' && Number.isFinite(value) ? `${value}%` : '-';
const metricRouteExplanation = (
  item: ModelMetricItem,
  statusLabels: Record<string, string>,
) =>
  (item.candidateDecisions || [])
    .slice(0, 3)
    .map((candidate) => {
      const label = statusLabels[candidate.status] || candidate.status;
      const reason = candidate.reason ? `：${candidate.reason}` : '';
      return `${label}${reason}`;
    })
    .join(' · ');

type MetricsTimeWindow = 'all' | '7d' | '30d';

const timeWindowOptions: Array<{ value: MetricsTimeWindow; label: string }> = [
  { value: 'all', label: '全部时间' },
  { value: '7d', label: '最近 7 天' },
  { value: '30d', label: '最近 30 天' },
];

const timeWindowLabel = (value: MetricsTimeWindow) =>
  timeWindowOptions.find((option) => option.value === value)?.label ||
  '全部时间';

const timeWindowSince = (value: MetricsTimeWindow) => {
  if (value === 'all') return null;
  const days = value === '7d' ? 7 : 30;
  return new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
};

export function ModelMetricsPanel({
  labels: statusLabels = labels,
}: {
  labels?: Record<string, string>;
} = {}) {
  const [metrics, setMetrics] = useState<ModelMetricsResponse | null>(null);
  const [filters, setFilters] = useState({
    teamId: '',
    roleId: '',
    providerId: '',
    model: '',
    taskType: '',
  });
  const [timeWindow, setTimeWindow] = useState<MetricsTimeWindow>('all');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams();
      for (const [key, value] of Object.entries(filters))
        if (value) params.set(key, value);
      const since = timeWindowSince(timeWindow);
      if (since) params.set('since', since);
      const suffix = params.toString();
      setMetrics(
        await api<ModelMetricsResponse>(
          `metrics/models${suffix ? `?${suffix}` : ''}`,
        ),
      );
      setError('');
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }, [filters, timeWindow]);
  useEffect(() => {
    const initial = setTimeout(() => void refresh(), 0);
    const timer = setInterval(() => void refresh(), 8000);
    return () => {
      clearTimeout(initial);
      clearInterval(timer);
    };
  }, [refresh]);
  const options = metrics?.options || {};
  const updateFilter = (key: keyof typeof filters, value: string) =>
    setFilters((current) => ({ ...current, [key]: value }));
  const totals = metrics?.totals;
  const quality = metrics?.evidenceQuality;
  const taskTypeComparisons = metrics?.taskTypeComparisons || [];
  return (
    <section
      className="model-metrics"
      aria-label="模型运行指标"
      data-testid="model-metrics-panel"
    >
      <div className="model-metrics-heading">
        <div>
          <span className="section-kicker">MODEL PERFORMANCE</span>
          <h2>模型运行指标</h2>
          <p>按真实执行记录比较模型稳定性、回退、耗时、用量和交付质量。</p>
        </div>
        <span className="model-metrics-updated">
          {metrics?.generatedAt
            ? `更新于 ${time(metrics.generatedAt)}`
            : '正在读取运行记录'}
        </span>
      </div>
      <ErrorMessage error={error} />
      <div className="model-metrics-filters" aria-label="模型指标筛选">
        <label>
          时间范围
          <select
            aria-label="指标时间范围"
            value={timeWindow}
            onChange={(event) =>
              setTimeWindow(event.target.value as MetricsTimeWindow)
            }
          >
            {timeWindowOptions.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </label>
        <label>
          团队
          <select
            aria-label="指标团队"
            value={filters.teamId}
            onChange={(event) => updateFilter('teamId', event.target.value)}
          >
            <option value="">全部团队</option>
            {(options.teams || []).map((item) => (
              <option key={item.id} value={item.id}>
                {item.name || item.id}
              </option>
            ))}
          </select>
        </label>
        <label>
          助手
          <select
            aria-label="指标助手"
            value={filters.roleId}
            onChange={(event) => updateFilter('roleId', event.target.value)}
          >
            <option value="">全部助手</option>
            {(options.roles || []).map((item) => (
              <option key={item.id} value={item.id}>
                {item.name || item.id}
              </option>
            ))}
          </select>
        </label>
        <label>
          供应商
          <select
            aria-label="指标供应商"
            value={filters.providerId}
            onChange={(event) => updateFilter('providerId', event.target.value)}
          >
            <option value="">全部供应商</option>
            {(options.providers || []).map((item) => (
              <option key={item.id} value={item.id}>
                {item.name || item.id}
              </option>
            ))}
          </select>
        </label>
        <label>
          模型
          <select
            aria-label="指标模型"
            value={filters.model}
            onChange={(event) => updateFilter('model', event.target.value)}
          >
            <option value="">全部模型</option>
            {(options.models || []).map((item) => (
              <option key={item.id} value={item.id}>
                {item.name || item.id}
              </option>
            ))}
          </select>
        </label>
        <label>
          任务类型
          <select
            aria-label="指标任务类型"
            value={filters.taskType}
            onChange={(event) => updateFilter('taskType', event.target.value)}
          >
            <option value="">全部类型</option>
            {(options.taskTypes || []).map((item) => (
              <option key={item.id} value={item.id}>
                {item.name || item.id}
              </option>
            ))}
          </select>
        </label>
      </div>
      {totals && (
        <div className="model-metrics-summary">
          <div>
            <strong>{metricNumber(totals.logicalTasks)}</strong>
            <span>逻辑任务</span>
          </div>
          <div>
            <strong>{metricNumber(totals.attempts)}</strong>
            <span>执行尝试</span>
          </div>
          <div>
            <strong>{metricNumber(totals.completed)}</strong>
            <span>已完成</span>
          </div>
          <div>
            <strong>{metricNumber(totals.accepted)}</strong>
            <span>已验收</span>
          </div>
          <div>
            <strong>{metricNumber(totals.fallbacks)}</strong>
            <span>触发回退</span>
          </div>
          <div>
            <strong>
              {totals.costKnown && totals.cost !== null
                ? `$${totals.cost.toFixed(4)}`
                : '未知'}
            </strong>
            <span>费用</span>
          </div>
        </div>
      )}
      {quality && (
        <section
          className="model-evidence-quality"
          aria-label="验收证据质量"
          data-testid="model-evidence-quality"
        >
          <div className="model-evidence-quality-heading">
            <div>
              <strong>验收证据质量</strong>
              <span>
                {timeWindowLabel(timeWindow)} · 仅统计当前筛选范围内已完成的逻辑任务
              </span>
            </div>
            <span>{metricNumber(quality.completedTasks)} 个已完成任务</span>
          </div>
          <div className="model-evidence-quality-grid">
            <div>
              <strong>{metricRate(quality.coverageRate)}</strong>
              <span>当前证据覆盖率</span>
              <small>
                {metricNumber(quality.currentVerified)} /{' '}
                {metricNumber(quality.completedTasks)} 有效验证
              </small>
            </div>
            <div>
              <strong>{metricRate(quality.verificationPassRate)}</strong>
              <span>验证通过率</span>
              <small>
                {metricNumber(quality.currentVerified)} /{' '}
                {metricNumber(quality.withVerification)} 有验证记录
              </small>
            </div>
            <div>
              <strong>{metricRate(quality.ownerDecisionRate)}</strong>
              <span>所有者决策率</span>
              <small>
                {metricNumber(quality.accepted + quality.rejected)} /{' '}
                {metricNumber(quality.currentVerified)} 已决定
              </small>
            </div>
            <div>
              <strong>{metricRate(quality.acceptanceRate)}</strong>
              <span>验收通过率</span>
              <small>
                {metricNumber(quality.accepted)} 通过 ·{' '}
                {metricNumber(quality.rejected)} 退回
              </small>
            </div>
          </div>
          <div className="model-evidence-quality-breakdown">
            <span>待补证据 {metricNumber(quality.missingCurrentEvidence)}</span>
            <span>过期 {metricNumber(quality.staleEvidence)}</span>
            <span>验证失败 {metricNumber(quality.failedEvidence)}</span>
            <span>待验证 {metricNumber(quality.pendingVerification)}</span>
            <span>待所有者 {metricNumber(quality.awaitingOwner)}</span>
          </div>
          {quality.byTeam.length > 1 && (
            <div className="model-evidence-quality-teams" aria-label="按团队查看证据质量">
              <span>团队覆盖率</span>
              {quality.byTeam.map((team) => (
                <span key={team.teamId || team.teamName}>
                  {team.teamName} {metricRate(team.coverageRate)}
                </span>
              ))}
            </div>
          )}
          {quality.byTaskType.length > 1 && (
            <div
              className="model-evidence-quality-teams"
              aria-label="按任务类型查看证据质量"
            >
              <span>任务类型覆盖率</span>
              {quality.byTaskType.map((item) => (
                <span key={item.taskType}>
                  {item.taskTypeName} {metricRate(item.coverageRate)}
                </span>
              ))}
            </div>
          )}
          {quality.trend.length > 0 && (
            <div
              className="model-evidence-quality-trend"
              aria-label="按日查看证据质量趋势"
              data-testid="model-evidence-trend"
            >
              <div className="model-evidence-quality-trend-heading">
                <span>按日趋势</span>
                <small>完成任务 · 当前证据覆盖率</small>
              </div>
              <div className="model-evidence-quality-trend-list">
                {quality.trend.slice(-14).map((day) => {
                  const maxCompleted = Math.max(
                    ...quality.trend.map((item) => item.completedTasks),
                    1,
                  );
                  const width = Math.max(
                    (day.completedTasks / maxCompleted) * 100,
                    3,
                  );
                  return (
                    <div
                      className="model-evidence-quality-trend-row"
                      key={day.date}
                      data-testid="model-evidence-trend-row"
                    >
                      <time dateTime={day.date}>{day.date.slice(5)}</time>
                      <span
                        className="model-evidence-quality-trend-track"
                        aria-hidden="true"
                      >
                        <span style={{ width: `${width}%` }} />
                      </span>
                      <strong>{metricRate(day.coverageRate)}</strong>
                      <small>
                        {metricNumber(day.currentVerified)} /{' '}
                        {metricNumber(day.completedTasks)}
                      </small>
                    </div>
                  );
                })}
              </div>
            </div>
          )}
        </section>
      )}
      {taskTypeComparisons.length > 0 && (
        <section
          className="model-task-type-comparison"
          aria-label="任务类型运行对比"
          data-testid="model-task-type-comparison"
        >
          <div className="model-task-type-comparison-heading">
            <div>
              <strong>任务类型运行对比</strong>
              <span>
                {timeWindowLabel(timeWindow)} ·
                执行任务口径，完成/失败按逻辑任务最终状态计算
              </span>
            </div>
            <span>{taskTypeComparisons.length} 种类型</span>
          </div>
          <div className="model-task-type-comparison-grid">
            {taskTypeComparisons.map((item) => (
              <article key={item.taskType} data-testid="model-task-type-card">
                <div className="model-task-type-comparison-card-heading">
                  <strong>{item.taskTypeName}</strong>
                  <span>{item.taskType}</span>
                </div>
                <div className="model-task-type-comparison-stats">
                  <div>
                    <strong>
                      {metricNumber(item.completed)} /{' '}
                      {metricNumber(item.failed)}
                    </strong>
                    <span>最终完成 / 最终失败</span>
                  </div>
                  <div>
                    <strong>{metricNumber(item.attempts)}</strong>
                    <span>执行尝试</span>
                  </div>
                  <div>
                    <strong>
                      {item.avgLatencyMs === null
                        ? '-'
                        : `${metricNumber(item.avgLatencyMs)} ms`}
                    </strong>
                    <span>平均耗时</span>
                  </div>
                  <div>
                    <strong>{metricNumber(item.totalTokens)}</strong>
                    <span>Token</span>
                  </div>
                  <div>
                    <strong>
                      {item.costKnown && item.cost !== null
                        ? `$${item.cost.toFixed(4)}`
                        : '未知'}
                    </strong>
                    <span>费用</span>
                  </div>
                  <div>
                    <strong>{metricRate(item.coverageRate)}</strong>
                    <span>完成任务证据覆盖</span>
                  </div>
                </div>
                <div className="model-task-type-comparison-meta">
                  <span>逻辑任务 {metricNumber(item.logicalTasks)}</span>
                  <span>失败尝试 {metricNumber(item.failedAttempts)}</span>
                  <span>回退 {metricNumber(item.fallbacks)}</span>
                  <span>验收 {metricNumber(item.accepted)}</span>
                  <span>待处理 {metricNumber(item.pending)}</span>
                </div>
              </article>
            ))}
          </div>
        </section>
      )}
      {loading && !metrics ? (
        <Empty busy text="正在载入模型指标" />
      ) : metrics && metrics.items.length ? (
        <div className="model-metrics-table-wrap">
          <table className="model-metrics-table">
            <thead>
              <tr>
                <th>供应商 / 模型</th>
                <th>范围</th>
                <th>尝试</th>
                <th>完成 / 失败</th>
                <th>回退</th>
                <th>平均耗时</th>
                <th>Token</th>
                <th>费用</th>
                <th>路由解释</th>
                <th>交付</th>
              </tr>
            </thead>
            <tbody>
              {metrics.items.map((item) => (
                <tr
                  key={`${item.providerId || 'unknown'}:${item.model || 'unknown'}`}
                  data-testid="model-metrics-row"
                >
                  <td data-label="供应商 / 模型">
                    <strong>{item.providerName}</strong>
                    <small>{item.model || '未识别模型'}</small>
                  </td>
                  <td data-label="范围">
                    <small>{item.teamName}</small>
                    <small>{item.roleName}</small>
                  </td>
                  <td data-label="尝试">
                    {metricNumber(item.attempts)}
                    <small>{metricNumber(item.logicalTasks)} 个逻辑任务</small>
                  </td>
                  <td data-label="完成 / 失败">
                    {metricNumber(item.completed)} / {metricNumber(item.failed)}
                    <small>验收 {metricNumber(item.accepted)}</small>
                  </td>
                  <td data-label="回退">
                    {metricNumber(item.fallbacks)}
                    <small>接收 {metricNumber(item.fallbackTargets)}</small>
                  </td>
                  <td data-label="平均耗时">
                    {item.avgLatencyMs === null
                      ? '-'
                      : `${metricNumber(item.avgLatencyMs)} ms`}
                    <small>
                      p50{' '}
                      {item.p50LatencyMs === null
                        ? '-'
                        : `${metricNumber(item.p50LatencyMs)} ms`}
                    </small>
                  </td>
                  <td data-label="Token">
                    {metricNumber(item.totalTokens)}
                    <small>
                      输入 {metricNumber(item.inputTokens)} · 输出{' '}
                      {metricNumber(item.outputTokens)}
                    </small>
                  </td>
                  <td data-label="费用">
                    {item.costKnown && item.cost !== null
                      ? `$${item.cost.toFixed(4)}`
                      : '未知'}
                  </td>
                  <td data-label="路由解释">
                    <small>
                      {metricRouteExplanation(item, statusLabels) ||
                        '未记录候选决策'}
                    </small>
                  </td>
                  <td data-label="交付">
                    <small>验证 {metricNumber(item.verificationPassed)}</small>
                    <small>待处理 {metricNumber(item.pending)}</small>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <Empty text="当前筛选没有模型运行记录" busy={loading} />
      )}
    </section>
  );
}

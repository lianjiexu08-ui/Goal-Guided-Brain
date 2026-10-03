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
type ModelMetricsResponse = {
  generatedAt: string;
  options?: {
    teams?: ModelMetricOption[];
    roles?: ModelMetricOption[];
    providers?: ModelMetricOption[];
    models?: ModelMetricOption[];
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
  items: ModelMetricItem[];
};

const metricNumber = (value: number | null | undefined) =>
  typeof value === 'number' && Number.isFinite(value)
    ? value.toLocaleString('zh-CN')
    : '-';
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
  });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams();
      for (const [key, value] of Object.entries(filters))
        if (value) params.set(key, value);
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
  }, [filters]);
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

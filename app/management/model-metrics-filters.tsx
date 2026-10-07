'use client';

export type MetricOption = { id: string; name?: string };
export type MetricsTimeWindow = 'all' | '7d' | '30d';
export type MetricsFilters = {
  teamId: string;
  roleId: string;
  providerId: string;
  model: string;
  taskType: string;
};
export type MetricsOptions = {
  teams?: MetricOption[];
  roles?: MetricOption[];
  providers?: MetricOption[];
  models?: MetricOption[];
  taskTypes?: MetricOption[];
};

const fields: Array<{
  key: keyof MetricsFilters;
  options: keyof MetricsOptions;
  label: string;
  empty: string;
  advanced?: boolean;
}> = [
  { key: 'teamId', options: 'teams', label: '团队', empty: '全部团队' },
  {
    key: 'taskType',
    options: 'taskTypes',
    label: '任务类型',
    empty: '全部类型',
  },
  {
    key: 'roleId',
    options: 'roles',
    label: '助手',
    empty: '全部助手',
    advanced: true,
  },
  {
    key: 'providerId',
    options: 'providers',
    label: '供应商',
    empty: '全部供应商',
    advanced: true,
  },
  {
    key: 'model',
    options: 'models',
    label: '模型',
    empty: '全部模型',
    advanced: true,
  },
];

export const timeWindowOptions: Array<{
  value: MetricsTimeWindow;
  label: string;
}> = [
  { value: 'all', label: '全部时间' },
  { value: '7d', label: '最近 7 天' },
  { value: '30d', label: '最近 30 天' },
];

export function ModelMetricsFilters({
  filters,
  options,
  timeWindow,
  onChange,
  onTimeWindowChange,
  onReset,
}: {
  filters: MetricsFilters;
  options: MetricsOptions;
  timeWindow: MetricsTimeWindow;
  onChange: (key: keyof MetricsFilters, value: string) => void;
  onTimeWindowChange: (value: MetricsTimeWindow) => void;
  onReset: () => void;
}) {
  const active = fields.filter((field) => filters[field.key]);
  const advancedCount = active.filter((field) => field.advanced).length;
  const renderField = (field: (typeof fields)[number]) => (
    <label key={field.key}>
      {field.label}
      <select
        aria-label={`指标${field.label}`}
        value={filters[field.key]}
        onChange={(event) => onChange(field.key, event.target.value)}
      >
        <option value="">{field.empty}</option>
        {(options[field.options] || []).map((item) => (
          <option key={item.id} value={item.id}>
            {item.name || item.id}
          </option>
        ))}
      </select>
    </label>
  );
  return (
    <div className="model-metrics-filter-controls" aria-label="模型指标筛选">
      <div className="model-metrics-filters">
        <label>
          时间范围
          <select
            aria-label="指标时间范围"
            value={timeWindow}
            onChange={(event) =>
              onTimeWindowChange(event.target.value as MetricsTimeWindow)
            }
          >
            {timeWindowOptions.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </label>
        {fields.filter((field) => !field.advanced).map(renderField)}
      </div>
      <details className="model-metrics-advanced">
        <summary>
          更多筛选
          <span>
            {advancedCount
              ? `已选 ${advancedCount} 项`
              : '助手 · 供应商 · 模型'}
          </span>
        </summary>
        <div className="model-metrics-filters">
          {fields.filter((field) => field.advanced).map(renderField)}
        </div>
      </details>
      {(active.length > 0 || timeWindow !== 'all') && (
        <div className="model-metrics-active-filters" aria-label="已选指标筛选">
          {timeWindow !== 'all' && (
            <button
              type="button"
              aria-label="清除时间筛选"
              onClick={() => onTimeWindowChange('all')}
            >
              <span>
                {
                  timeWindowOptions.find((item) => item.value === timeWindow)
                    ?.label
                }
              </span>
              <span aria-hidden="true">×</span>
            </button>
          )}
          {active.map((field) => {
            const value = options[field.options]?.find(
              (item) => item.id === filters[field.key],
            );
            const label = `${field.label}：${value?.name || filters[field.key]}`;
            return (
              <button
                key={field.key}
                type="button"
                aria-label={`清除${field.label}筛选：${value?.name || filters[field.key]}`}
                title={label}
                onClick={() => onChange(field.key, '')}
              >
                <span>{label}</span>
                <span aria-hidden="true">×</span>
              </button>
            );
          })}
          <button
            type="button"
            className="model-metrics-reset"
            onClick={onReset}
          >
            重置全部筛选
          </button>
        </div>
      )}
    </div>
  );
}

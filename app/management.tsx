'use client';

import { useCallback, useEffect, useState, type ReactNode } from 'react';
import {
  Activity,
  Archive,
  Bell,
  Check,
  ChevronLeft,
  ChevronRight,
  Clock3,
  Copy,
  Cpu,
  Download,
  ExternalLink,
  FolderGit2,
  GitBranch,
  GitMerge,
  Inbox,
  KeyRound,
  Layers3,
  LoaderCircle,
  LockKeyhole,
  Mail,
  Network,
  Pause,
  Pencil,
  Play,
  Plug,
  Plus,
  Power,
  RefreshCw,
  Save,
  Search,
  Send,
  Server,
  Terminal,
  Square,
  Trash2,
  Undo2,
  UnlockKeyhole,
  X,
  type LucideIcon,
} from 'lucide-react';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  api,
  entityList,
  entityText as txt,
  type Entity,
  type ManagementState,
} from './workbench-api';
import './management.css';

export const managementNavigation = [
  { id: 'jobs', label: '协作任务', icon: GitBranch },
  { id: 'models', label: '模型管理', icon: Cpu },
  { id: 'resources', label: '资源与凭据', icon: Server },
  { id: 'nodes', label: '执行节点', icon: Network },
  { id: 'capabilities', label: '能力中心', icon: Plug },
  { id: 'schedules', label: '定时与监控', icon: Clock3 },
  { id: 'attention', label: '需要你处理', icon: Inbox },
  { id: 'backups', label: '备份与恢复', icon: Archive },
];

const labels: Record<string, string> = {
  providers: '供应商',
  resources: '资源',
  credentials: '凭据',
  nodes: '执行节点',
  jobs: '协作任务',
  messages: '消息',
  capabilities: '能力',
  schedules: '定时任务',
  monitors: '监控规则',
  notifications: '通知',
  attention: '待处理事项',
  backups: '备份',
  workflows: '工作流',
};
const statuses: Record<string, string> = {
  queued: '排队中',
  running: '进行中',
  completed: '已完成',
  failed: '失败',
  cancelled: '已取消',
  paused: '已暂停',
  blocked: '等待处理',
  interrupted: '已中断',
  online: '在线',
  offline: '离线',
  revoked: '已撤销',
  unknown: '状态未知',
  pending: '待处理',
  resolved: '已处理',
  dismissed: '已拒绝',
  budget_exceeded: '预算超限',
  'budget-exceeded': '预算超限',
  read: '已读',
  unread: '未读',
  sent: '已发送',
  delivered: '已送达',
  received: '已接收',
  processed: '已处理',
  active: '已启用',
  enabled: '已启用',
  disabled: '已停用',
  installed: '已安装',
  healthy: '正常',
  unhealthy: '异常',
  ok: '正常',
  error: '异常',
  compatible: '可直接使用',
  partial: '部分兼容',
  unsupported: '不支持',
  needs_configuration: '需要配置',
  needs_config: '需要配置',
  stopped: '已停止',
  open: '待处理',
  state_unknown: '状态未知',
  waiting_children: '等待子任务',
  'pending-review': '待验证',
  'needs-review': '需要复核',
  verified: '验证通过',
  skipped: '已跳过',
};
const time = (value: unknown) =>
  typeof value === 'string' && value
    ? new Date(value).toLocaleString('zh-CN')
    : '-';
const title = (item: Entity) =>
  txt(item, 'name') ||
  txt(item, 'title') ||
  txt(item, 'filename') ||
  txt(item, 'content').slice(0, 80) ||
  item.id;
const status = (item: Entity) =>
  txt(item, 'status') ||
  txt(item, 'state') ||
  (item.enabled === false
    ? 'disabled'
    : item.lastResult &&
        typeof item.lastResult === 'object' &&
        'ok' in item.lastResult
      ? item.lastResult.ok
        ? 'healthy'
        : 'unhealthy'
      : item.enabled === true
        ? 'enabled'
        : typeof item.read === 'boolean'
          ? item.read
            ? 'read'
            : 'unread'
          : '');

function IconButton({
  icon: Icon,
  label,
  onClick,
  disabled = false,
}: {
  icon: LucideIcon;
  label: string;
  onClick: () => void;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      className="icon-button"
      title={label}
      aria-label={label}
      disabled={disabled}
      onClick={onClick}
    >
      <Icon size={17} />
    </button>
  );
}
function Badge({ value }: { value: string }) {
  if (!value) return null;
  const tone = ['failed', 'error', 'unhealthy', 'revoked'].includes(value)
    ? 'error'
    : [
          'blocked',
          'unknown',
          'partial',
          'needs_configuration',
          'needs_config',
          'pending-review',
          'needs-review',
          'state_unknown',
          'budget_exceeded',
          'budget-exceeded',
        ].includes(value)
      ? 'warning'
      : ['disabled', 'offline', 'cancelled', 'paused', 'dismissed'].includes(
            value,
          )
        ? 'muted'
        : 'normal';
  return (
    <span className="manage-badge" data-tone={tone}>
      {statuses[value] || value}
    </span>
  );
}
function Empty({
  text = '暂无记录',
  busy = false,
}: {
  text?: string;
  busy?: boolean;
}) {
  return (
    <div className="manage-empty">
      {busy ? <LoaderCircle size={26} className="spin" /> : <Inbox size={27} />}
      <strong>{busy ? '正在载入' : text}</strong>
    </div>
  );
}
function ErrorMessage({
  error,
  dismiss,
}: {
  error: string;
  dismiss?: () => void;
}) {
  return error ? (
    <div className="manage-error" role="alert">
      <span>{error}</span>
      {dismiss && <IconButton icon={X} label="关闭错误" onClick={dismiss} />}
    </div>
  ) : null;
}

export function AuthenticationGate({ children }: { children: ReactNode }) {
  const [auth, setAuth] = useState<{
    required: boolean;
    authenticated: boolean;
    configured: boolean;
  } | null>(null);
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const check = useCallback(async () => {
    try {
      setAuth(await api('auth/status'));
      setError('');
    } catch (err) {
      setError((err as Error).message);
    }
  }, []);
  useEffect(() => {
    const timer = setTimeout(() => void check(), 0);
    const onExpired = () => void check();
    window.addEventListener('workbench-auth-required', onExpired);
    return () => {
      clearTimeout(timer);
      window.removeEventListener('workbench-auth-required', onExpired);
    };
  }, [check]);
  if (auth && (!auth.required || auth.authenticated)) return children;
  return (
    <main className="manage-login">
      <section>
        <Layers3 size={32} color="#1b7565" />
        <h1>Goal-Guided Brain</h1>
        <ErrorMessage error={error} />
        {!auth ? (
          <>
            <Empty busy={!error} text="连接失败" />
            {error && (
              <button className="secondary-button" onClick={() => void check()}>
                <RefreshCw size={16} />
                重新连接
              </button>
            )}
          </>
        ) : (
          <form
            className="manage-form"
            onSubmit={async (event) => {
              event.preventDefault();
              setBusy(true);
              setError('');
              try {
                await api('auth/login', 'POST', { password });
                setPassword('');
                await check();
              } catch (err) {
                setError((err as Error).message);
              } finally {
                setBusy(false);
              }
            }}
          >
            <label>
              工作台密码
              <input
                required
                type="password"
                autoComplete="current-password"
                value={password}
                onChange={(event) => setPassword(event.target.value)}
              />
            </label>
            <button className="primary-button" disabled={busy || !password}>
              {busy ? (
                <LoaderCircle className="spin" size={16} />
              ) : (
                <LockKeyhole size={16} />
              )}
              登录
            </button>
          </form>
        )}
      </section>
    </main>
  );
}

type FormValues = Record<string, unknown>;
type FormProps = {
  collection: string;
  initial?: Entity;
  data: ManagementState;
  credentials: Entity[];
  onSave: (body: FormValues) => Promise<void>;
  onClose: () => void;
};

function initialForm(
  collection: string,
  initial: Entity | undefined,
  data: ManagementState,
): FormValues {
  const role = data.roles.find((item) => !item.archived)?.id || '';
  const defaults: Record<string, FormValues> = {
    providers: {
      name: '',
      protocol: 'openai-completions',
      baseUrl: '',
      credentialId: '',
      enabled: true,
      priority: 10,
      models: [
        { id: '', name: '', tools: true, vision: false, contextWindow: 64000 },
      ],
    },
    resources: {
      name: '',
      kind: 'server',
      host: '',
      port: 22,
      username: '',
      credentialId: '',
      path: '',
      notes: '',
    },
    credentials: { name: '', kind: 'api_key', value: '' },
    jobs: {
      name: '',
      role,
      prompt: '',
      workspace: '',
      nodeId: '',
      workspaceMode: 'isolated',
      budgetTokens: 200000,
      steps: [],
    },
    messages: {
      toAgentId: role,
      toTaskId: '',
      jobId: '',
      content: '',
      kind: 'question',
    },
    capabilities: {
      name: '',
      kind: 'mcp',
      transport: 'stdio',
      command: '',
      args: '',
      url: '',
      credentialId: '',
      enabled: true,
    },
    schedules: {
      name: '',
      mode: 'cron',
      cron: '0 9 * * *',
      intervalSeconds: 3600,
      timezone: 'Asia/Shanghai',
      role,
      prompt: '',
      workflowId: '',
      nodeId: '',
      enabled: true,
      misfire: 'skip',
    },
    monitors: {
      name: '',
      kind: 'http',
      url: '',
      intervalSeconds: 300,
      enabled: true,
      webhookUrl: '',
      nodeId: '',
    },
    workflows: { name: '', steps: [{ role, prompt: '' }] },
  };
  return {
    ...(defaults[collection] || { name: '' }),
    ...(initial ? structuredClone(initial) : {}),
  };
}

function EntityEditor({
  collection,
  initial,
  data,
  credentials,
  onSave,
  onClose,
}: FormProps) {
  const [form, setForm] = useState<FormValues>(() =>
    initialForm(collection, initial, data),
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [preview, setPreview] = useState<string[]>([]);
  const [envBindings, setEnvBindings] = useState<
    { name: string; credentialId: string }[]
  >(() =>
    initial?.envRefs && typeof initial.envRefs === 'object'
      ? Object.entries(initial.envRefs).map(([name, credentialId]) => ({
          name,
          credentialId: String(credentialId),
        }))
      : [],
  );
  const availableTools =
    form.health && typeof form.health === 'object'
      ? entityList((form.health as Record<string, unknown>).tools)
      : [];
  const selectedTools: string[] =
    Array.isArray(form.tools) && form.tools.length
      ? form.tools.map(String)
      : availableTools.map((tool) => txt(tool, 'name'));
  const field = (key: string, value: unknown) => {
    if (['mode', 'cron', 'timezone', 'intervalSeconds'].includes(key))
      setPreview([]);
    setForm((previous) => ({ ...previous, [key]: value }));
  };
  const input = (
    key: string,
    label: string,
    options: {
      required?: boolean;
      type?: string;
      placeholder?: string;
      min?: number;
      max?: number;
    } = {},
  ) => (
    <label>
      {label}
      <input
        value={txt(form, key)}
        {...options}
        onChange={(event) =>
          field(
            key,
            options.type === 'number'
              ? Number(event.target.value)
              : event.target.value,
          )
        }
      />
    </label>
  );
  const area = (key: string, label: string, required = false, rows = 4) => (
    <label>
      {label}
      <textarea
        rows={rows}
        required={required}
        value={txt(form, key)}
        onChange={(event) => field(key, event.target.value)}
      />
    </label>
  );
  const choice = (
    key: string,
    label: string,
    options: { value: string; label: string }[],
    required = false,
  ) => (
    <label>
      {label}
      <select
        aria-label={label}
        required={required}
        value={txt(form, key)}
        onChange={(event) => field(key, event.target.value)}
      >
        {options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
    </label>
  );
  const toggle = (key: string, label: string) => (
    <label>
      <input
        type="checkbox"
        checked={Boolean(form[key])}
        onChange={(event) => field(key, event.target.checked)}
      />
      {label}
    </label>
  );
  const credentialChoice = () =>
    choice('credentialId', '凭据', [
      { value: '', label: '无凭据' },
      ...(txt(form, 'credentialId') &&
      !credentials.some((item) => item.id === form.credentialId)
        ? [
            {
              value: txt(form, 'credentialId'),
              label: '已绑定凭据（当前不可读取）',
            },
          ]
        : []),
      ...credentials.map((item) => ({ value: item.id, label: title(item) })),
    ]);
  const roleChoice = () =>
    choice(
      'role',
      '负责助手',
      [
        { value: '', label: '选择助手' },
        ...data.roles
          .filter((item) => !item.archived)
          .map((item) => ({ value: item.id, label: title(item) })),
      ],
      true,
    );
  const nodeChoice = () =>
    choice('nodeId', '执行节点', [
      { value: '', label: '控制端本地执行' },
      ...data.nodes
        .filter((item) => status(item) !== 'revoked')
        .map((item) => ({ value: item.id, label: title(item) })),
    ]);
  const steps = entityList(form.steps);
  const stepEditor = () => (
    <fieldset>
      <div className="manage-field-heading">
        子任务
        <button
          type="button"
          className="text-button"
          onClick={() =>
            field('steps', [...steps, { role: txt(form, 'role'), prompt: '' }])
          }
        >
          <Plus size={15} />
          添加
        </button>
      </div>
      {steps.map((step, index) => (
        <div className="manage-model-row" key={index}>
          <div className="manage-inline-fields">
            <select
              aria-label={`子任务 ${index + 1} 助手`}
              required
              value={txt(step, 'role')}
              onChange={(event) =>
                field(
                  'steps',
                  steps.map((item, at) =>
                    at === index ? { ...item, role: event.target.value } : item,
                  ),
                )
              }
            >
              <option value="">选择助手</option>
              {data.roles
                .filter((item) => !item.archived)
                .map((item) => (
                  <option key={item.id} value={item.id}>
                    {title(item)}
                  </option>
                ))}
            </select>
            <IconButton
              icon={X}
              label={`移除子任务 ${index + 1}`}
              onClick={() =>
                field(
                  'steps',
                  steps.filter((_, at) => at !== index),
                )
              }
            />
          </div>
          <textarea
            aria-label={`子任务 ${index + 1} 目标`}
            required
            rows={2}
            value={txt(step, 'prompt')}
            onChange={(event) =>
              field(
                'steps',
                steps.map((item, at) =>
                  at === index ? { ...item, prompt: event.target.value } : item,
                ),
              )
            }
          />
        </div>
      ))}
    </fieldset>
  );
  return (
    <Dialog open onOpenChange={(open) => !open && !busy && onClose()}>
      <DialogContent className="manage-dialog" showCloseButton={!busy}>
        <DialogTitle>
          {initial?.id ? '编辑' : collection === 'messages' ? '发送' : '新建'}
          {labels[collection]}
        </DialogTitle>
        <DialogDescription className="sr-only">
          {labels[collection]}配置
        </DialogDescription>
        <form
          className="manage-form"
          onSubmit={async (event) => {
            event.preventDefault();
            setBusy(true);
            setError('');
            try {
              const body = { ...form };
              if (['jobs', 'schedules', 'monitors'].includes(collection))
                body.nodeId = body.nodeId || 'local';
              if (collection === 'jobs') body.title = body.name;
              if (collection === 'messages' && body.jobId && !body.toTaskId) {
                const job = data.jobs.find((item) => item.id === body.jobId);
                if (!job?.taskId || job.role !== body.toAgentId)
                  throw new Error(
                    '关联任务的负责助手与收件人不一致，请指定正确执行实例',
                  );
                body.toTaskId = job.taskId;
              }
              if (collection === 'workflows' && !steps.length)
                throw new Error('工作流至少需要一个步骤');
              if (collection === 'capabilities' && body.transport === 'stdio')
                body.args = Array.isArray(body.args)
                  ? body.args
                  : txt(body, 'args')
                      .split('\n')
                      .map((value) => value.trim())
                      .filter(Boolean);
              if (collection === 'capabilities' && body.kind === 'mcp') {
                if (
                  envBindings.some(
                    (item) =>
                      !/^[A-Z_][A-Z0-9_]*$/.test(item.name) ||
                      !item.credentialId,
                  ) ||
                  new Set(envBindings.map((item) => item.name)).size !==
                    envBindings.length
                )
                  throw new Error('请填写不重复的环境变量名称，并选择凭据');
                body.envRefs = Object.fromEntries(
                  envBindings.map((item) => [item.name, item.credentialId]),
                );
              }
              if (collection === 'providers') {
                const models = entityList(body.models);
                if (!models.length || models.some((model) => !model.id.trim()))
                  throw new Error('请填写至少一个模型 ID');
                if (
                  new Set(models.map((model) => model.id)).size !==
                  models.length
                )
                  throw new Error('模型 ID 不能重复');
                body.models = models.map((model) => ({
                  ...model,
                  name: txt(model, 'name').trim() || model.id,
                }));
              }
              await onSave(body);
            } catch (err) {
              setError((err as Error).message);
            } finally {
              setBusy(false);
            }
          }}
        >
          <fieldset disabled={busy}>
            {!['messages'].includes(collection) &&
              input('name', '名称', {
                required: collection !== 'jobs',
                max: 120,
              })}
            {collection === 'providers' && (
              <>
                <div className="manage-columns">
                  {choice('protocol', '接口协议', [
                    { value: 'deepseek', label: 'DeepSeek' },
                    {
                      value: 'openai-completions',
                      label: 'OpenAI Chat Completions',
                    },
                    { value: 'openai-responses', label: 'OpenAI Responses' },
                    {
                      value: 'anthropic-messages',
                      label: 'Anthropic Messages',
                    },
                    {
                      value: 'typesafe-system-one',
                      label: 'TypeSafe System One（结构化决策）',
                    },
                  ])}
                  {input('priority', '路由优先级', {
                    type: 'number',
                    min: 0,
                    max: 10000,
                  })}
                </div>
                {input('baseUrl', '接口基础地址', {
                  required: true,
                  type: 'url',
                  placeholder: 'https://api.example.com/v1',
                })}
                {form.protocol === 'typesafe-system-one' && (
                  <p className="manage-help">
                    TypeSafe 用于结构化判断和路由，不生成聊天回复或代码。建议地址为
                    https://api.typesafe.ai/v1，模型问题需使用 choice、score 或 noul 类型。
                  </p>
                )}
                {credentialChoice()}
                <fieldset>
                  <div className="manage-field-heading">
                    模型
                    <button
                      type="button"
                      className="text-button"
                      onClick={() =>
                        field('models', [
                          ...entityList(form.models),
                          {
                            id: '',
                            name: '',
                            tools: true,
                            vision: false,
                            contextWindow: 64000,
                          },
                        ])
                      }
                    >
                      <Plus size={15} />
                      添加模型
                    </button>
                  </div>
                  {entityList(form.models).map((model, index) => {
                    const updateModel = (key: string, value: unknown) =>
                      field(
                        'models',
                        entityList(form.models).map((item, at) =>
                          at === index ? { ...item, [key]: value } : item,
                        ),
                      );
                    return (
                      <div className="manage-model-row" key={index}>
                        <div className="manage-inline-fields">
                          <input
                            aria-label={`模型 ${index + 1} ID`}
                            placeholder="模型 ID"
                            required
                            value={model.id}
                            onChange={(event) =>
                              updateModel('id', event.target.value)
                            }
                          />
                          <IconButton
                            icon={X}
                            label={`移除模型 ${index + 1}`}
                            onClick={() =>
                              field(
                                'models',
                                entityList(form.models).filter(
                                  (_, at) => at !== index,
                                ),
                              )
                            }
                          />
                        </div>
                        <div className="manage-columns">
                          <label>
                            显示名称
                            <input
                              value={txt(model, 'name')}
                              onChange={(event) =>
                                updateModel('name', event.target.value)
                              }
                            />
                          </label>
                          <label>
                            上下文上限
                            <input
                              type="number"
                              min={1024}
                              value={txt(model, 'contextWindow')}
                              onChange={(event) =>
                                updateModel(
                                  'contextWindow',
                                  Number(event.target.value),
                                )
                              }
                            />
                          </label>
                        </div>
                        <div className="manage-columns">
                          {[
                            ['inputPrice', '输入价格'],
                            ['outputPrice', '输出价格'],
                          ].map(([key, label]) => (
                            <label key={key}>
                              {label}（USD / 百万 Token）
                              <input
                                type="number"
                                min={0}
                                step="any"
                                placeholder="未知"
                                value={txt(model, key)}
                                onChange={(event) =>
                                  updateModel(
                                    key,
                                    event.target.value === ''
                                      ? null
                                      : Number(event.target.value),
                                  )
                                }
                              />
                            </label>
                          ))}
                        </div>
                        <div className="manage-model-flags">
                          <label>
                            <input
                              type="checkbox"
                              checked={Boolean(model.tools)}
                              onChange={(event) =>
                                updateModel('tools', event.target.checked)
                              }
                            />
                            工具调用
                          </label>
                          <label>
                            <input
                              type="checkbox"
                              checked={Boolean(model.vision)}
                              onChange={(event) =>
                                updateModel('vision', event.target.checked)
                              }
                            />
                            图片理解
                          </label>
                        </div>
                      </div>
                    );
                  })}
                </fieldset>
                {toggle('enabled', '启用供应商')}
              </>
            )}
            {collection === 'resources' && (
              <>
                {choice('kind', '资源类型', [
                  { value: 'server', label: '云服务器' },
                  { value: 'project', label: '项目目录' },
                ])}
                {form.kind === 'server' && (
                  <>
                    <div className="manage-columns">
                      {input('host', '服务器地址', {
                        required: true,
                        placeholder: '主机名或 IP',
                      })}
                      {input('port', 'SSH 端口', {
                        type: 'number',
                        min: 1,
                        max: 65535,
                        required: true,
                      })}
                    </div>
                    {input('username', '登录用户', { required: true })}
                    {credentialChoice()}
                  </>
                )}
                {input(
                  'path',
                  form.kind === 'project' ? '项目绝对路径' : '默认工作目录',
                  { required: form.kind === 'project' },
                )}
                {area('notes', '备注')}
              </>
            )}
            {collection === 'credentials' && (
              <>
                {choice('kind', '凭据类型', [
                  { value: 'api_key', label: 'API Key' },
                  { value: 'password', label: '密码' },
                  { value: 'ssh_key', label: 'SSH 私钥' },
                  { value: 'token', label: '访问令牌' },
                ])}
                {form.kind === 'ssh_key'
                  ? area('value', 'SSH 私钥', true, 7)
                  : input('value', '凭据内容', {
                      required: true,
                      type: 'password',
                    })}
              </>
            )}
            {['jobs', 'workflows'].includes(collection) && (
              <>
                {collection === 'jobs' && (
                  <>
                    {roleChoice()}
                    {area('prompt', '目标与完成条件', true, 5)}
                    {input('budgetTokens', '任务组 Token 预算', {
                      type: 'number',
                      min: 1000,
                      max: 100000000,
                      required: true,
                    })}
                  </>
                )}
                {collection === 'jobs' && (
                  <>
                    <div className="manage-columns">
                      {nodeChoice()}
                      {choice('workspaceMode', '工作目录模式', [
                        { value: 'isolated', label: '独立 worktree / 快照' },
                        { value: 'shared', label: '使用指定目录' },
                      ])}
                    </div>
                    {input('workspace', '工作目录')}
                  </>
                )}
                {stepEditor()}
              </>
            )}
            {collection === 'messages' && (
              <>
                {choice(
                  'toAgentId',
                  '接收助手',
                  [
                    { value: '', label: '选择助手' },
                    ...data.roles.map((item) => ({
                      value: item.id,
                      label: `${title(item)} · ${item.id}`,
                    })),
                  ],
                  true,
                )}
                {choice('jobId', '关联任务', [
                  { value: '', label: '无关联任务' },
                  ...data.jobs.map((item) => ({
                    value: item.id,
                    label: title(item),
                  })),
                ])}
                {input('toTaskId', '接收执行实例 ID')}
                {choice('kind', '消息类型', [
                  { value: 'question', label: '提问' },
                  { value: 'task', label: '任务分派' },
                  { value: 'reply', label: '答复' },
                  { value: 'progress', label: '进度' },
                  { value: 'blocked', label: '阻塞' },
                  { value: 'handoff', label: '成果交接' },
                  { value: 'notice', label: '通知' },
                ])}
                {area('content', '消息内容', true, 6)}
              </>
            )}
            {collection === 'capabilities' && (
              <>
                {choice('kind', '能力类型', [
                  { value: 'mcp', label: 'MCP 连接' },
                  { value: 'skill', label: 'Skill' },
                  ...(initial?.kind === 'plugin'
                    ? [{ value: 'plugin', label: 'Plugin' }]
                    : []),
                ])}
                {form.kind === 'mcp' ? (
                  <>
                    {choice('transport', '连接方式', [
                      { value: 'stdio', label: '控制端 stdio' },
                      {
                        value: 'streamable-http',
                        label: '远程 Streamable HTTP',
                      },
                    ])}
                    {form.transport === 'stdio' ? (
                      <>
                        {input('command', '可执行程序', { required: true })}
                        <label>
                          启动参数（每行一项）
                          <textarea
                            rows={4}
                            value={
                              Array.isArray(form.args)
                                ? form.args.join('\n')
                                : txt(form, 'args')
                            }
                            onChange={(event) =>
                              field('args', event.target.value)
                            }
                          />
                        </label>
                      </>
                    ) : (
                      input('url', 'MCP 地址', { type: 'url', required: true })
                    )}
                    {credentialChoice()}
                    {form.transport === 'stdio' && (
                      <fieldset>
                        <div className="manage-field-heading">
                          环境变量凭据
                          <button
                            type="button"
                            className="text-button"
                            onClick={() =>
                              setEnvBindings((items) => [
                                ...items,
                                { name: '', credentialId: '' },
                              ])
                            }
                          >
                            <Plus size={15} />
                            添加
                          </button>
                        </div>
                        {envBindings.map((binding, index) => (
                          <div className="manage-inline-fields" key={index}>
                            <input
                              required
                              aria-label={`环境变量 ${index + 1}`}
                              placeholder="API_TOKEN"
                              value={binding.name}
                              onChange={(event) =>
                                setEnvBindings((items) =>
                                  items.map((item, at) =>
                                    at === index
                                      ? { ...item, name: event.target.value }
                                      : item,
                                  ),
                                )
                              }
                            />
                            <select
                              required
                              aria-label={`环境变量 ${index + 1} 凭据`}
                              value={binding.credentialId}
                              onChange={(event) =>
                                setEnvBindings((items) =>
                                  items.map((item, at) =>
                                    at === index
                                      ? {
                                          ...item,
                                          credentialId: event.target.value,
                                        }
                                      : item,
                                  ),
                                )
                              }
                            >
                              <option value="">选择凭据</option>
                              {binding.credentialId &&
                                !credentials.some(
                                  (item) => item.id === binding.credentialId,
                                ) && (
                                  <option value={binding.credentialId}>
                                    已绑定凭据
                                  </option>
                                )}
                              {credentials.map((item) => (
                                <option key={item.id} value={item.id}>
                                  {title(item)}
                                </option>
                              ))}
                            </select>
                            <IconButton
                              icon={X}
                              label={`移除环境变量 ${index + 1}`}
                              onClick={() =>
                                setEnvBindings((items) =>
                                  items.filter((_, at) => at !== index),
                                )
                              }
                            />
                          </div>
                        ))}
                      </fieldset>
                    )}
                    {!!availableTools.length && (
                      <fieldset>
                        <legend>允许调用的工具</legend>
                        <div className="manage-option-list">
                          {availableTools.map((tool) => {
                            const name = txt(tool, 'name');
                            return (
                              <label
                                key={name}
                                title={txt(tool, 'description')}
                              >
                                <input
                                  type="checkbox"
                                  checked={selectedTools.includes(name)}
                                  onChange={(event) => {
                                    const next = event.target.checked
                                      ? [...selectedTools, name]
                                      : selectedTools.filter(
                                          (value) => value !== name,
                                        );
                                    if (!next.length) {
                                      setError(
                                        '至少保留一个工具；关闭全部工具请停用此连接',
                                      );
                                      return;
                                    }
                                    field('tools', next);
                                  }}
                                />
                                {name}
                              </label>
                            );
                          })}
                        </div>
                      </fieldset>
                    )}
                  </>
                ) : form.kind === 'plugin' ? (
                  toggle('allowHooks', '允许已适配的命令 Hooks')
                ) : !initial || initial.source === 'custom' ? (
                  area('content', 'Skill 内容', true, 10)
                ) : (
                  <p className="manage-muted">
                    {txt(form, 'source')} · {txt(form, 'version')} ·{' '}
                    {txt(form, 'digest').slice(0, 16)}
                  </p>
                )}
                {toggle('enabled', '启用能力')}
              </>
            )}
            {collection === 'schedules' && (
              <>
                {choice('mode', '调度模式', [
                  { value: 'cron', label: 'Cron 表达式' },
                  { value: 'interval', label: '固定间隔' },
                ])}
                <div className="manage-columns">
                  {form.mode === 'interval'
                    ? input('intervalSeconds', '执行间隔（秒）', {
                        type: 'number',
                        required: true,
                        min: 60,
                        max: 31536000,
                      })
                    : input('cron', 'Cron 表达式', { required: true })}
                  {input('timezone', '时区', { required: true })}
                </div>
                <button
                  type="button"
                  className="text-button"
                  onClick={async () => {
                    try {
                      const result = await api<{
                        times?: string[];
                        nextRuns?: string[];
                      }>('schedules/preview', 'POST', {
                        mode: form.mode,
                        cron: form.cron,
                        timezone: form.timezone,
                        intervalSeconds: form.intervalSeconds,
                      });
                      setPreview(result.times || result.nextRuns || []);
                      setError('');
                    } catch (err) {
                      setError((err as Error).message);
                    }
                  }}
                >
                  <Clock3 size={15} />
                  预览执行时间
                </button>
                {!!preview.length && (
                  <div className="manage-preview">
                    {preview.map((value) => (
                      <time key={value}>{time(value)}</time>
                    ))}
                  </div>
                )}
                {choice('workflowId', '工作流', [
                  { value: '', label: '直接分派给助手' },
                  ...data.workflows.map((item) => ({
                    value: item.id,
                    label: title(item),
                  })),
                ])}
                {!form.workflowId && (
                  <>
                    {roleChoice()}
                    {area('prompt', '执行内容', true)}
                  </>
                )}
                {nodeChoice()}
                {choice('misfire', '错过执行时间', [
                  { value: 'skip', label: '跳过' },
                  { value: 'once', label: '恢复后补跑一次' },
                ])}
                {toggle('enabled', '启用定时任务')}
              </>
            )}
            {collection === 'monitors' && (
              <>
                <div className="manage-columns">
                  {choice('kind', '监控类型', [
                    { value: 'http', label: 'HTTP 服务' },
                    { value: 'tcp', label: 'TCP 端口' },
                    { value: 'model', label: '模型接口' },
                    { value: 'mcp', label: 'MCP 连接' },
                  ])}
                  {input('intervalSeconds', '检查间隔（秒）', {
                    type: 'number',
                    min: 30,
                    max: 86400,
                    required: true,
                  })}
                </div>
                {form.kind === 'model'
                  ? choice(
                      'providerId',
                      '供应商',
                      [
                        { value: '', label: '选择供应商' },
                        ...data.providers.map((item) => ({
                          value: item.id,
                          label: title(item),
                        })),
                      ],
                      true,
                    )
                  : form.kind === 'mcp'
                    ? choice(
                        'capabilityId',
                        'MCP 连接',
                        [
                          { value: '', label: '选择连接' },
                          ...data.capabilities
                            .filter((item) => item.kind === 'mcp')
                            .map((item) => ({
                              value: item.id,
                              label: title(item),
                            })),
                        ],
                        true,
                      )
                    : input(
                        'url',
                        form.kind === 'tcp' ? '主机与端口' : '检查地址',
                        {
                          required: true,
                          placeholder:
                            form.kind === 'tcp'
                              ? 'example.com:22'
                              : 'https://example.com/health',
                        },
                      )}
                {nodeChoice()}
                {input('webhookUrl', 'Webhook 通知地址', { type: 'url' })}
                {toggle('enabled', '启用监控')}
              </>
            )}
          </fieldset>
          <ErrorMessage error={error} />
          <div className="manage-form-footer">
            <button
              type="button"
              className="secondary-button"
              disabled={busy}
              onClick={onClose}
            >
              取消
            </button>
            <button type="submit" className="primary-button" disabled={busy}>
              {busy ? (
                <LoaderCircle className="spin" size={16} />
              ) : collection === 'messages' ? (
                <Send size={16} />
              ) : (
                <Save size={16} />
              )}
              {collection === 'messages'
                ? '发送消息'
                : collection === 'jobs'
                  ? '创建任务'
                  : '保存'}
            </button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}

const icons: Record<string, LucideIcon> = {
  providers: Cpu,
  resources: Server,
  credentials: KeyRound,
  nodes: Network,
  jobs: GitBranch,
  messages: Mail,
  workflows: GitBranch,
  capabilities: Plug,
  schedules: Clock3,
  monitors: Activity,
  attention: Inbox,
  notifications: Bell,
  backups: Archive,
};
const canEdit = new Set([
  'providers',
  'resources',
  'schedules',
  'monitors',
  'workflows',
  'capabilities',
]);

function description(collection: string, item: Entity, data: ManagementState) {
  const roleName = (id: string) =>
    data.roles.find((role) => role.id === id)?.name || id;
  switch (collection) {
    case 'providers':
      return [
        txt(item, 'protocol'),
        txt(item, 'baseUrl'),
        entityList(item.models)
          .map((model) => model.id)
          .join(', '),
      ]
        .filter(Boolean)
        .join(' · ');
    case 'resources':
      return item.kind === 'project'
        ? txt(item, 'path')
        : `${txt(item, 'username') ? `${txt(item, 'username')}@` : ''}${txt(item, 'host')}:${txt(item, 'port', '22')}`;
    case 'credentials':
      return [txt(item, 'kind'), time(item.updatedAt || item.createdAt)].join(
        ' · ',
      );
    case 'nodes':
      return [
        txt(item, 'platform'),
        txt(item, 'hostname'),
        item.lastSeenAt ? `最近心跳 ${time(item.lastSeenAt)}` : '',
      ]
        .filter(Boolean)
        .join(' · ');
    case 'jobs':
      return [
        roleName(txt(item, 'role')),
        time(item.createdAt),
        txt(item, 'workspace'),
      ]
        .filter(Boolean)
        .join(' · ');
    case 'messages':
      return [
        roleName(txt(item, 'fromAgentId', '用户')),
        '→',
        roleName(txt(item, 'toAgentId')),
        time(item.createdAt),
      ].join(' ');
    case 'capabilities':
      return [
        txt(item, 'kind'),
        txt(item, 'source'),
        txt(item, 'version'),
        txt(item, 'transport'),
      ]
        .filter(Boolean)
        .join(' · ');
    case 'schedules':
      return [
        item.mode === 'interval'
          ? `每 ${txt(item, 'intervalSeconds', '3600')} 秒`
          : txt(item, 'cron'),
        txt(item, 'timezone'),
        item.nextRunAt ? `下次 ${time(item.nextRunAt)}` : '',
      ]
        .filter(Boolean)
        .join(' · ');
    case 'monitors':
      return [
        txt(item, 'kind').toUpperCase(),
        txt(item, 'url') ||
          txt(item, 'providerId') ||
          txt(item, 'capabilityId'),
        `每 ${txt(item, 'intervalSeconds', '300')} 秒`,
      ]
        .filter(Boolean)
        .join(' · ');
    case 'backups':
      return [
        item.size || item.bytes
          ? `${Math.round(Number(item.size || item.bytes) / 1024)} KB`
          : '',
        time(item.createdAt),
      ]
        .filter(Boolean)
        .join(' · ');
    default:
      return (
        txt(item, 'description') ||
        txt(item, 'detail') ||
        txt(item, 'message') ||
        txt(item, 'goal') ||
        txt(item, 'reason') ||
        txt(item, 'prompt') ||
        time(item.createdAt)
      );
  }
}

export function ExecutionInspector({ taskId }: { taskId: string }) {
  const [execution, setExecution] = useState<Entity | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [mode, setMode] = useState<'diff' | 'commit' | 'verify' | null>(null);
  const [result, setResult] = useState<Entity | null>(null);
  const [message, setMessage] = useState('');
  const [command, setCommand] = useState('npm');
  const [args, setArgs] = useState('test');
  useEffect(() => {
    let cancelled = false;
    void api<Entity>(`tasks/${taskId}`)
      .then((item) => {
        if (!cancelled) setExecution(item);
      })
      .catch((err) => {
        if (!cancelled) setError((err as Error).message);
      });
    return () => {
      cancelled = true;
    };
  }, [taskId]);
  const workspace =
    execution?.executionWorkspace &&
    typeof execution.executionWorkspace === 'object'
      ? (execution.executionWorkspace as Entity)
      : null;
  const latestVerification =
    execution?.latestVerification || execution?.verification;
  const verification =
    latestVerification && typeof latestVerification === 'object'
      ? (latestVerification as Entity)
      : entityList(execution?.artifacts).find(
          (item) => item.kind === 'verification',
        );
  const mutating =
    execution &&
    ['running', 'queued', 'state_unknown'].includes(status(execution));
  const perform = async (action: 'diff' | 'commit' | 'verify') => {
    setBusy(true);
    setError('');
    setResult(null);
    setMode(action);
    try {
      const output = await api<Entity>(
        `workspaces/${taskId}${action === 'diff' ? '' : `/${action}`}`,
        action === 'diff' ? 'GET' : 'POST',
        action === 'commit'
          ? { message }
          : action === 'verify'
            ? {
                command,
                args: args
                  .split('\n')
                  .map((item) => item.trim())
                  .filter(Boolean),
              }
            : undefined,
      );
      setResult(output);
      setExecution(await api<Entity>(`tasks/${taskId}`));
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="manage-detail">
      <h3>
        <FolderGit2 size={16} /> 执行目录与验收
      </h3>
      <ErrorMessage error={error} />
      {!execution ? (
        <Empty busy={!error} />
      ) : !workspace ? (
        <p>尚未分配执行目录</p>
      ) : (
        <>
          <dl>
            <dt>目录类型</dt>
            <dd>
              {(
                {
                  shared: '共享目录',
                  worktree: 'Git worktree',
                  snapshot: '文件快照',
                } as Record<string, string>
              )[txt(workspace, 'kind')] || txt(workspace, 'kind')}
            </dd>
            <dt>目录</dt>
            <dd>{txt(workspace, 'path')}</dd>
            {Boolean(workspace.branch) && (
              <>
                <dt>分支</dt>
                <dd>{txt(workspace, 'branch')}</dd>
              </>
            )}
            <dt>目录状态</dt>
            <dd>{txt(workspace, 'state')}</dd>
            <dt>最近验证</dt>
            <dd>
              <Badge
                value={
                  (verification ? status(verification) : '') ||
                  txt(workspace, 'verificationStatus') ||
                  (workspace.verified === true ? 'verified' : 'pending-review')
                }
              />
            </dd>
          </dl>
          <div className="manage-toolbar">
            <button
              className="secondary-button"
              disabled={busy}
              onClick={() => void perform('diff')}
            >
              <GitBranch size={15} />
              查看变更
            </button>
            <button
              className="secondary-button"
              disabled={
                busy ||
                Boolean(mutating) ||
                workspace.kind !== 'worktree' ||
                workspace.state === 'quarantined'
              }
              onClick={() => {
                setMode('commit');
                setResult(null);
              }}
            >
              <Save size={15} />
              保存内部提交
            </button>
            <button
              className="secondary-button"
              disabled={
                busy || Boolean(mutating) || workspace.state === 'quarantined'
              }
              onClick={() => {
                setMode('verify');
                setResult(null);
              }}
            >
              <Terminal size={15} />
              运行验证
            </button>
          </div>
          {mode === 'commit' && (
            <form
              className="manage-form"
              onSubmit={(event) => {
                event.preventDefault();
                void perform('commit');
              }}
            >
              <label>
                提交说明
                <input
                  required
                  value={message}
                  onChange={(event) => setMessage(event.target.value)}
                />
              </label>
              <button
                className="primary-button"
                disabled={busy || Boolean(mutating)}
              >
                <Save size={15} />
                保存提交
              </button>
            </form>
          )}
          {mode === 'verify' && (
            <form
              className="manage-form"
              onSubmit={(event) => {
                event.preventDefault();
                void perform('verify');
              }}
            >
              <label>
                验证程序
                <input
                  required
                  value={command}
                  onChange={(event) => setCommand(event.target.value)}
                />
              </label>
              <label>
                参数（每行一项）
                <textarea
                  rows={3}
                  value={args}
                  onChange={(event) => setArgs(event.target.value)}
                />
              </label>
              <button
                className="primary-button"
                disabled={busy || Boolean(mutating)}
              >
                {busy ? (
                  <LoaderCircle size={15} className="spin" />
                ) : (
                  <Play size={15} />
                )}
                执行验证
              </button>
            </form>
          )}
          {result && (
            <div className="manage-detail">
              {mode === 'diff' ? (
                <pre>
                  {[
                    txt(result, 'status'),
                    txt(result, 'diff'),
                    txt(result, 'message'),
                  ]
                    .filter(Boolean)
                    .join('\n') || '没有未提交变更'}
                </pre>
              ) : mode === 'commit' ? (
                <>
                  <Badge value="pending-review" />
                  <pre>
                    {txt(result, 'commit')}\n{txt(result, 'branch')}
                  </pre>
                </>
              ) : (
                <>
                  <Badge
                    value={
                      result.ok === true ||
                      result.verified === true ||
                      result.exitCode === 0
                        ? 'verified'
                        : 'failed'
                    }
                  />
                  <pre>
                    {txt(result, 'output') ||
                      txt(result, 'stdout') ||
                      txt(result, 'error') ||
                      txt(result, 'stderr') ||
                      JSON.stringify(result, null, 2)}
                  </pre>
                </>
              )}
            </div>
          )}
          {!!entityList(execution.usage).length && (
            <>
              <h3>模型用量</h3>
              {entityList(execution.usage).map((usage, index) => (
                <div className="manage-row" key={usage.id || index}>
                  <div className="manage-main">
                    <strong>{txt(usage, 'model')}</strong>
                    <small>
                      输入 {txt(usage, 'inputTokens', '-')} · 输出{' '}
                      {txt(usage, 'outputTokens', '-')}
                    </small>
                  </div>
                  <span className="manage-muted">
                    {usage.cost === undefined || usage.cost === null
                      ? '费用未知'
                      : `${txt(usage, 'cost')} ${txt(usage, 'currency', 'USD')}`}
                  </span>
                </div>
              ))}
            </>
          )}
        </>
      )}
    </section>
  );
}

function JobDetail({
  detail,
  data,
  onAction,
  busy,
}: {
  detail: Entity;
  data: ManagementState;
  onAction: (path: string, body?: unknown, method?: string) => Promise<boolean>;
  busy: boolean;
}) {
  const job =
    typeof detail.job === 'object' && detail.job !== null
      ? (detail.job as Entity)
      : detail;
  const executions = entityList(detail.tasks || detail.executions || job.tasks);
  const messages = entityList(detail.messages);
  const artifacts = entityList(detail.artifacts);
  const checkpoints = entityList(detail.checkpoints);
  const board = entityList(detail.board || detail.boardItems);
  const [requirements, setRequirements] = useState(
    txt(job, 'goal') || txt(job, 'requirements') || txt(job, 'prompt'),
  );
  const [revising, setRevising] = useState(false);
  const [budgetTokens, setBudgetTokens] = useState(
    Number(job.budgetTokens) || 200000,
  );
  const [resumeProvider, setResumeProvider] = useState('');
  const resumable = [
    'paused',
    'blocked',
    'failed',
    'interrupted',
    'state_unknown',
    'budget-exceeded',
    'budget_exceeded',
  ].includes(status(job));
  const [selectedExecutions, setSelectedExecutions] = useState<string[]>([]);
  const [inspecting, setInspecting] = useState<string | null>(null);
  const [integration, setIntegration] = useState<Entity | null>(null);
  const [integrationError, setIntegrationError] = useState('');
  const [integrating, setIntegrating] = useState(false);
  return (
    <div className="manage-detail">
      <div className="manage-actions">
        <Badge value={status(job)} />
        {resumable && (
          <label style={{ maxWidth: 280 }}>
            恢复模型供应商
            <select
              aria-label="恢复模型供应商"
              value={resumeProvider}
              disabled={busy}
              onChange={(event) => setResumeProvider(event.target.value)}
            >
              <option value="">原候选顺序</option>
              {data.providers
                .filter((provider) => provider.enabled !== false)
                .map((provider) => (
                  <option key={provider.id} value={provider.id}>
                    {title(provider)}
                  </option>
                ))}
            </select>
          </label>
        )}
        {!['completed', 'cancelled'].includes(status(job)) && (
          <>
            <IconButton
              icon={resumable ? Play : Pause}
              label={resumable ? '继续任务' : '暂停任务'}
              disabled={busy}
              onClick={() =>
                void onAction(
                  `jobs/${job.id}/${resumable ? 'resume' : 'pause'}`,
                  resumable && resumeProvider
                    ? { providerIds: [resumeProvider] }
                    : undefined,
                )
              }
            />
            <IconButton
              icon={Square}
              label="取消任务"
              disabled={busy}
              onClick={() => void onAction(`jobs/${job.id}/cancel`)}
            />
            <IconButton
              icon={Pencil}
              label="修改需求"
              disabled={busy}
              onClick={() => setRevising(!revising)}
            />
          </>
        )}
      </div>
      <h3>目标与完成条件</h3>
      <p>
        {txt(job, 'goal') || txt(job, 'requirements') || txt(job, 'prompt')}
      </p>
      {revising && (
        <form
          className="manage-form"
          onSubmit={async (event) => {
            event.preventDefault();
            const saved = await onAction(
              `jobs/${job.id}`,
              {
                goal: requirements,
                budgetTokens,
                expectedRevision: job.revision,
              },
              'PUT',
            );
            if (saved) setRevising(false);
          }}
        >
          <label>
            新版需求
            <textarea
              required
              rows={5}
              value={requirements}
              onChange={(event) => setRequirements(event.target.value)}
            />
          </label>
          <label>
            任务组 Token 预算
            <input
              type="number"
              required
              min={1000}
              max={100000000}
              value={budgetTokens}
              onChange={(event) => setBudgetTokens(Number(event.target.value))}
            />
          </label>
          <button className="primary-button" disabled={busy}>
            <Save size={15} />
            更新需求
          </button>
        </form>
      )}
      <h3>任务信息</h3>
      <dl>
        {[
          ['任务 ID', job.id],
          ['Token 预算', txt(job, 'budgetTokens', '200000')],
          [
            '负责助手',
            data.roles.find((item) => item.id === job.role)?.name ||
              txt(job, 'role'),
          ],
          [
            '需求版本',
            txt(job, 'requirementVersion') ||
              txt(job, 'requirementsVersion', '1'),
          ],
          ['执行节点', txt(job, 'nodeId', '控制端本地')],
          ['工作目录', txt(job, 'workspace')],
          ['创建时间', time(job.createdAt)],
        ].map(([key, value]) => (
          <div style={{ display: 'contents' }} key={key}>
            <dt>{key}</dt>
            <dd>{value || '-'}</dd>
          </div>
        ))}
      </dl>
      <h3>执行实例 · {executions.length}</h3>
      {executions.length ? (
        executions.map((item) => (
          <div className="manage-row" key={item.id}>
            <input
              type="checkbox"
              aria-label={`选择执行 ${title(item)}`}
              disabled={['running', 'queued', 'state_unknown'].includes(
                status(item),
              )}
              checked={selectedExecutions.includes(item.id)}
              onChange={(event) =>
                setSelectedExecutions((items) =>
                  event.target.checked
                    ? [...items, item.id]
                    : items.filter((id) => id !== item.id),
                )
              }
            />
            <div className="manage-main">
              <button
                onClick={() =>
                  setInspecting(inspecting === item.id ? null : item.id)
                }
              >
                <strong>{title(item)}</strong>
              </button>
              <p>
                {data.roles.find((role) => role.id === item.role)?.name ||
                  txt(item, 'role')}{' '}
                · {item.id}
              </p>
              {Boolean(item.workspaceMode) && (
                <small>
                  {txt(item, 'workspaceMode')} · {txt(item, 'workspace')}
                </small>
              )}
              {Boolean(item.error) && <small>{txt(item, 'error')}</small>}
            </div>
            <Badge value={status(item)} />
          </div>
        ))
      ) : (
        <p>暂无执行实例</p>
      )}
      {inspecting && (
        <ExecutionInspector key={inspecting} taskId={inspecting} />
      )}
      {!!executions.length && (
        <div className="manage-toolbar">
          <button
            className="secondary-button"
            disabled={integrating || !selectedExecutions.length}
            onClick={async () => {
              setIntegrating(true);
              setIntegrationError('');
              try {
                setIntegration(
                  await api<Entity>('workspaces/integrate', 'POST', {
                    taskIds: selectedExecutions,
                  }),
                );
              } catch (err) {
                setIntegrationError((err as Error).message);
              } finally {
                setIntegrating(false);
              }
            }}
          >
            <GitMerge size={15} />
            集成已选成果 ({selectedExecutions.length})
          </button>
        </div>
      )}
      <ErrorMessage error={integrationError} />
      {integration && (
        <>
          <h3>集成结果</h3>
          <Badge
            value={
              integration.verified === true
                ? 'verified'
                : status(integration) === 'failed' || integration.error
                  ? 'failed'
                  : 'pending-review'
            }
          />
          <p>{txt(integration, 'path')}</p>
          <p>{txt(integration, 'branch')}</p>
          {Boolean(integration.error) && <pre>{txt(integration, 'error')}</pre>}
        </>
      )}
      <h3>共享任务板</h3>
      {board.length ? (
        board.map((item) => (
          <div className="manage-row" key={item.id}>
            <div className="manage-main">
              <strong>{title(item)}</strong>
              <p>{txt(item, 'content') || txt(item, 'value')}</p>
            </div>
          </div>
        ))
      ) : (
        <p>{typeof detail.board === 'string' ? detail.board : '暂无记录'}</p>
      )}
      <h3>产物 · {artifacts.length}</h3>
      {artifacts.length ? (
        artifacts.map((item) => (
          <div className="manage-row" key={item.id}>
            <div className="manage-main">
              <strong>{title(item)}</strong>
              <p>
                {txt(item, 'path') || txt(item, 'url') || txt(item, 'content')}
              </p>
              <small>
                {txt(item, 'commit')} · {time(item.createdAt)}
              </small>
            </div>
            <Badge value={txt(item, 'reviewStatus') || status(item)} />
          </div>
        ))
      ) : (
        <p>暂无产物</p>
      )}
      {!!checkpoints.length && (
        <>
          <h3>检查点</h3>
          {checkpoints.map((item) => (
            <details key={item.id}>
              <summary>{time(item.createdAt)}</summary>
              <pre>{txt(item, 'summary') || JSON.stringify(item, null, 2)}</pre>
            </details>
          ))}
        </>
      )}
      {!!messages.length && (
        <>
          <h3>任务消息</h3>
          {messages.map((item) => (
            <div className="manage-row" key={item.id}>
              <div className="manage-main">
                <strong>{txt(item, 'content')}</strong>
                <small>{description('messages', item, data)}</small>
              </div>
              <Badge value={status(item)} />
            </div>
          ))}
        </>
      )}
      {Boolean(job.result) && (
        <>
          <h3>交付结果</h3>
          <p>{txt(job, 'result')}</p>
        </>
      )}
    </div>
  );
}

function PluginComponents({
  capability,
  data,
  credentials,
  onChanged,
}: {
  capability: Entity;
  data: ManagementState;
  credentials: Entity[];
  onChanged: () => Promise<void>;
}) {
  const [components, setComponents] = useState<{
    commands: Entity[];
    agents: Entity[];
    mcp: Entity[];
  } | null>(null);
  const [selected, setSelected] = useState<{
    kind: 'command' | 'agent' | 'mcp';
    item: Entity;
  } | null>(null);
  const [form, setForm] = useState<Record<string, unknown>>({});
  const [result, setResult] = useState<{ kind: string; item: Entity } | null>(
    null,
  );
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [enabled, setEnabled] = useState(capability.enabled !== false);
  const load = useCallback(async () => {
    try {
      setComponents(await api(`capabilities/${capability.id}/components`));
      setError('');
    } catch (err) {
      setError((err as Error).message);
    }
  }, [capability.id]);
  useEffect(() => {
    const timer = setTimeout(() => void load(), 0);
    return () => clearTimeout(timer);
  }, [load]);
  const field = (key: string, value: unknown) =>
    setForm((previous) => ({ ...previous, [key]: value }));
  const strings = (value: unknown) =>
    Array.isArray(value)
      ? value.filter((item): item is string => typeof item === 'string')
      : [];
  const config = (item: Entity) =>
    typeof item.config === 'object' && item.config !== null
      ? (item.config as Record<string, unknown>)
      : {};
  const unsupportedHeaders = (item: Entity) =>
    strings(item.requiredHeaders).filter(
      (name) => name.toLowerCase() !== 'authorization',
    );
  const choose = (kind: 'command' | 'agent' | 'mcp', item: Entity) => {
    setSelected({ kind, item });
    setResult(null);
    setError('');
    if (kind === 'command')
      setForm({
        role: data.roles.find((role) => !role.archived)?.id || '',
        arguments: '',
      });
    else if (kind === 'agent')
      setForm({
        name: `${title(capability)} · ${title(item)}`.slice(0, 40),
        model: '',
        tools: { files: true, web: false, terminal: false },
      });
    else {
      const original = config(item);
      setForm({
        name: `${title(capability)} / ${title(item)}`.slice(0, 120),
        transport:
          original.type === 'stdio' || original.command
            ? 'stdio'
            : 'streamable-http',
        command: txt(original, 'command'),
        args: strings(original.args).join('\n'),
        url: original.type === 'sse' ? '' : txt(original, 'url'),
        credentialId: '',
        envRefs: Object.fromEntries(
          strings(item.requiredEnv).map((name) => [name, '']),
        ),
      });
    }
  };
  const sections = [
    {
      key: 'commands' as const,
      kind: 'command' as const,
      name: '命令',
      icon: Terminal,
      action: '运行命令',
    },
    {
      key: 'agents' as const,
      kind: 'agent' as const,
      name: '助手模板',
      icon: Cpu,
      action: '导入助手',
    },
    {
      key: 'mcp' as const,
      kind: 'mcp' as const,
      name: 'MCP 连接',
      icon: Plug,
      action: '导入连接',
    },
  ];
  const credentialOptions = (
    <>
      <option value="">稍后配置</option>
      {credentials.map((item) => (
        <option key={item.id} value={item.id}>
          {title(item)}
        </option>
      ))}
    </>
  );
  const toolChoices =
    form.tools && typeof form.tools === 'object'
      ? (form.tools as Record<string, boolean>)
      : {};
  const envRefs =
    form.envRefs && typeof form.envRefs === 'object'
      ? (form.envRefs as Record<string, string>)
      : {};
  return (
    <section className="manage-detail">
      <h3>插件组件</h3>
      <ErrorMessage error={error} dismiss={() => setError('')} />
      {!components ? (
        <>
          <Empty busy={!error} />
          {error && (
            <button className="text-button" onClick={() => void load()}>
              <RefreshCw size={15} />
              重试
            </button>
          )}
        </>
      ) : (
        <>
          {!enabled && !!components.commands.length && (
            <div className="manage-toolbar">
              <Badge value="disabled" />
              <button
                className="secondary-button"
                disabled={busy}
                onClick={async () => {
                  setBusy(true);
                  try {
                    await api(`capabilities/${capability.id}/enable`, 'POST');
                    setEnabled(true);
                    await onChanged();
                  } catch (err) {
                    setError((err as Error).message);
                  } finally {
                    setBusy(false);
                  }
                }}
              >
                <Power size={15} />
                启用插件
              </button>
            </div>
          )}
          {sections.map((section) =>
            components[section.key].length ? (
              <div key={section.key}>
                <h3>
                  {section.name} · {components[section.key].length}
                </h3>
                {components[section.key].map((item) => {
                  const unavailable =
                    section.kind === 'command'
                      ? item.runnable === false || item.userInvocable === false
                      : section.kind === 'mcp'
                        ? unsupportedHeaders(item).length > 0
                        : false;
                  const reasons = strings(item.diagnostics);
                  const headers = unsupportedHeaders(item);
                  return (
                    <div key={item.id}>
                      <div className="manage-row">
                        <span className="manage-row-icon">
                          <section.icon size={17} />
                        </span>
                        <div className="manage-main">
                          <strong>{title(item)}</strong>
                          <p>
                            {txt(item, 'description') ||
                              (section.kind === 'mcp'
                                ? txt(config(item), 'url') ||
                                  txt(config(item), 'command')
                                : '')}
                          </p>
                          {Boolean(item.modelHint) && (
                            <small>原模型：{txt(item, 'modelHint')}</small>
                          )}
                          {Boolean(item.argumentHint) && (
                            <small>参数：{txt(item, 'argumentHint')}</small>
                          )}
                          {reasons.map((reason, index) => (
                            <small key={index}>{reason}</small>
                          ))}
                          {!!headers.length && (
                            <small>不支持的认证头：{headers.join(', ')}</small>
                          )}
                        </div>
                        {unavailable && <Badge value="unsupported" />}
                        <button
                          className="secondary-button"
                          disabled={
                            busy ||
                            unavailable ||
                            (section.kind === 'command' && !enabled)
                          }
                          onClick={() => choose(section.kind, item)}
                        >
                          {section.kind === 'command' ? (
                            <Play size={15} />
                          ) : (
                            <Download size={15} />
                          )}
                          {section.action}
                        </button>
                      </div>
                      {selected?.kind === section.kind &&
                        selected.item.id === item.id && (
                          <form
                            className="manage-form"
                            onSubmit={async (event) => {
                              event.preventDefault();
                              setBusy(true);
                              setError('');
                              try {
                                const operation =
                                  section.kind === 'command'
                                    ? 'run-command'
                                    : section.kind === 'agent'
                                      ? 'import-agent'
                                      : 'import-mcp';
                                const body: Record<string, unknown> = {
                                  ...form,
                                  [section.kind === 'command'
                                    ? 'commandId'
                                    : section.kind === 'agent'
                                      ? 'agentId'
                                      : 'entryId']: item.id,
                                };
                                if (section.kind === 'mcp') {
                                  body.args = txt(form, 'args')
                                    .split('\n')
                                    .map((value) => value.trim())
                                    .filter(Boolean);
                                  body.envRefs = Object.fromEntries(
                                    Object.entries(envRefs).filter(
                                      ([, value]) => value,
                                    ),
                                  );
                                }
                                const created = await api<Entity>(
                                  `capabilities/${capability.id}/${operation}`,
                                  'POST',
                                  body,
                                );
                                setResult({
                                  kind: section.kind,
                                  item: created,
                                });
                                setSelected(null);
                                await onChanged();
                              } catch (err) {
                                setError((err as Error).message);
                              } finally {
                                setBusy(false);
                              }
                            }}
                          >
                            <fieldset disabled={busy}>
                              {section.kind === 'command' && (
                                <>
                                  <label>
                                    执行助手
                                    <select
                                      required
                                      value={txt(form, 'role')}
                                      onChange={(event) =>
                                        field('role', event.target.value)
                                      }
                                    >
                                      <option value="">选择助手</option>
                                      {data.roles
                                        .filter((role) => !role.archived)
                                        .map((role) => (
                                          <option key={role.id} value={role.id}>
                                            {title(role)}
                                          </option>
                                        ))}
                                    </select>
                                  </label>
                                  <label>
                                    命令参数
                                    <textarea
                                      rows={3}
                                      placeholder={txt(item, 'argumentHint')}
                                      value={txt(form, 'arguments')}
                                      onChange={(event) =>
                                        field('arguments', event.target.value)
                                      }
                                    />
                                  </label>
                                </>
                              )}
                              {section.kind === 'agent' && (
                                <>
                                  <div className="manage-columns">
                                    <label>
                                      助手名称
                                      <input
                                        required
                                        maxLength={40}
                                        value={txt(form, 'name')}
                                        onChange={(event) =>
                                          field('name', event.target.value)
                                        }
                                      />
                                    </label>
                                    <label>
                                      助手模型
                                      <input
                                        aria-label="助手模型"
                                        list={`plugin-models-${item.id}`}
                                        placeholder="跟随工作台模型"
                                        value={txt(form, 'model')}
                                        onChange={(event) =>
                                          field('model', event.target.value)
                                        }
                                      />
                                      <datalist id={`plugin-models-${item.id}`}>
                                        {[
                                          ...new Set(
                                            data.providers.flatMap((provider) =>
                                              entityList(provider.models).map(
                                                (model) => model.id,
                                              ),
                                            ),
                                          ),
                                        ].map((id) => (
                                          <option key={id} value={id}>
                                            {id}
                                          </option>
                                        ))}
                                      </datalist>
                                    </label>
                                  </div>
                                  <fieldset>
                                    <legend>工具权限</legend>
                                    {[
                                      ['files', '文件读写'],
                                      ['web', '网页检索'],
                                      ['terminal', '终端命令'],
                                    ].map(([key, label]) => (
                                      <label key={key}>
                                        <input
                                          type="checkbox"
                                          checked={Boolean(toolChoices[key])}
                                          onChange={(event) =>
                                            field('tools', {
                                              ...toolChoices,
                                              [key]: event.target.checked,
                                            })
                                          }
                                        />
                                        {label}
                                      </label>
                                    ))}
                                  </fieldset>
                                  {strings(item.requestedTools).length > 0 && (
                                    <p className="manage-muted">
                                      原工具声明：
                                      {strings(item.requestedTools).join(', ')}
                                    </p>
                                  )}
                                </>
                              )}
                              {section.kind === 'mcp' && (
                                <>
                                  <label>
                                    连接名称
                                    <input
                                      required
                                      maxLength={120}
                                      value={txt(form, 'name')}
                                      onChange={(event) =>
                                        field('name', event.target.value)
                                      }
                                    />
                                  </label>
                                  <label>
                                    连接方式
                                    <select
                                      value={txt(form, 'transport')}
                                      onChange={(event) =>
                                        field('transport', event.target.value)
                                      }
                                    >
                                      <option value="stdio">
                                        控制端 stdio
                                      </option>
                                      <option value="streamable-http">
                                        远程 Streamable HTTP
                                      </option>
                                    </select>
                                  </label>
                                  {form.transport === 'stdio' ? (
                                    <>
                                      <label>
                                        可执行程序
                                        <input
                                          required
                                          value={txt(form, 'command')}
                                          onChange={(event) =>
                                            field('command', event.target.value)
                                          }
                                        />
                                      </label>
                                      <label>
                                        启动参数（每行一项）
                                        <textarea
                                          rows={3}
                                          value={txt(form, 'args')}
                                          onChange={(event) =>
                                            field('args', event.target.value)
                                          }
                                        />
                                      </label>
                                    </>
                                  ) : (
                                    <label>
                                      Streamable HTTP 地址
                                      <input
                                        required
                                        type="url"
                                        value={txt(form, 'url')}
                                        onChange={(event) =>
                                          field('url', event.target.value)
                                        }
                                      />
                                    </label>
                                  )}
                                  <label>
                                    Bearer 认证凭据
                                    <select
                                      value={txt(form, 'credentialId')}
                                      onChange={(event) =>
                                        field(
                                          'credentialId',
                                          event.target.value,
                                        )
                                      }
                                    >
                                      {credentialOptions}
                                    </select>
                                  </label>
                                  {strings(item.requiredEnv).map((name) => (
                                    <label key={name}>
                                      {name} 凭据
                                      <select
                                        value={envRefs[name] || ''}
                                        onChange={(event) =>
                                          field('envRefs', {
                                            ...envRefs,
                                            [name]: event.target.value,
                                          })
                                        }
                                      >
                                        {credentialOptions}
                                      </select>
                                    </label>
                                  ))}
                                </>
                              )}
                              {Boolean(item.body) && (
                                <details>
                                  <summary>
                                    {section.kind === 'agent'
                                      ? '助手规范'
                                      : '命令内容'}
                                  </summary>
                                  <pre>{txt(item, 'body')}</pre>
                                </details>
                              )}
                            </fieldset>
                            <div className="manage-form-footer">
                              <button
                                type="button"
                                className="secondary-button"
                                disabled={busy}
                                onClick={() => setSelected(null)}
                              >
                                取消
                              </button>
                              <button
                                className="primary-button"
                                disabled={busy}
                              >
                                {busy ? (
                                  <LoaderCircle className="spin" size={15} />
                                ) : section.kind === 'command' ? (
                                  <Play size={15} />
                                ) : (
                                  <Download size={15} />
                                )}
                                {section.action}
                              </button>
                            </div>
                          </form>
                        )}
                    </div>
                  );
                })}
              </div>
            ) : null,
          )}
          {!sections.some((section) => components[section.key].length) && (
            <p>暂无可导入组件</p>
          )}
          {result && (
            <output className="manage-row">
              <span className="manage-row-icon">
                <Check size={17} />
              </span>
              <span className="manage-main">
                <strong>
                  {result.kind === 'command'
                    ? '命令任务已创建'
                    : result.kind === 'agent'
                      ? '助手已导入'
                      : 'MCP 连接已导入'}
                </strong>
                <small>{title(result.item)}</small>
                <small>{result.item.id}</small>
              </span>
              <Badge
                value={
                  result.kind === 'mcp'
                    ? result.item.configurationRequired
                      ? 'needs_config'
                      : 'disabled'
                    : status(result.item)
                }
              />
            </output>
          )}
        </>
      )}
    </section>
  );
}

export function Management({
  view,
  onChanged,
}: {
  view: string;
  onChanged: () => Promise<void>;
}) {
  const [data, setData] = useState<ManagementState | null>(null);
  const [loadError, setLoadError] = useState('');
  const [credentials, setCredentials] = useState<Entity[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [tab, setTab] = useState('');
  const [query, setQuery] = useState('');
  const [page, setPage] = useState(0);
  const [editing, setEditing] = useState<{
    collection: string;
    item?: Entity;
  } | null>(null);
  const [detail, setDetail] = useState<{
    collection: string;
    item: Entity;
  } | null>(null);
  const [removing, setRemoving] = useState<{
    collection: string;
    item: Entity;
  } | null>(null);
  const [vaultDialog, setVaultDialog] = useState(false);
  const [passphrase, setPassphrase] = useState('');
  const [passphraseConfirm, setPassphraseConfirm] = useState('');
  const [pairDialog, setPairDialog] = useState(false);
  const [pairName, setPairName] = useState('');
  const [pairResult, setPairResult] = useState<Entity | null>(null);
  const [importDialog, setImportDialog] = useState(false);
  const [sourceUrl, setSourceUrl] = useState('');
  const [importVersion, setImportVersion] = useState('');
  const [importSource, setImportSource] = useState('github');
  const [importItem, setImportItem] = useState<Entity | null>(null);
  const [marketSource, setMarketSource] = useState('skillsmp');
  const [marketResults, setMarketResults] = useState<Entity[]>([]);
  const [marketSearched, setMarketSearched] = useState(false);
  const [probeItem, setProbeItem] = useState<Entity | null>(null);
  const [probeModel, setProbeModel] = useState('');
  const [probeTools, setProbeTools] = useState(true);
  const [probeResult, setProbeResult] = useState<Record<
    string,
    unknown
  > | null>(null);
  const [restoring, setRestoring] = useState<Entity | null>(null);
  const [restoreResult, setRestoreResult] = useState<Entity | null>(null);
  const refresh = useCallback(async () => {
    try {
      const next = await api<ManagementState>('manage');
      setData(next);
      setLoadError('');
      const credentialData = await api<Entity[] | { items: Entity[] }>(
        'credentials',
      );
      setCredentials(
        Array.isArray(credentialData)
          ? credentialData
          : credentialData.items || [],
      );
    } catch (err) {
      setLoadError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }, []);
  useEffect(() => {
    const initial = setTimeout(() => void refresh(), 0);
    const timer = setInterval(() => void refresh(), 8000);
    return () => {
      clearTimeout(initial);
      clearInterval(timer);
    };
  }, [refresh]);
  useEffect(() => {
    if (!notice) return;
    const timer = setTimeout(() => setNotice(''), 5000);
    return () => clearTimeout(timer);
  }, [notice]);
  useEffect(() => {
    if (detail?.collection !== 'jobs') return;
    const id = detail.item.id;
    let cancelled = false;
    const timer = setInterval(async () => {
      try {
        const item = await api<Entity>(`jobs/${id}`);
        if (!cancelled)
          setDetail({ collection: 'jobs', item: { ...item, id } });
      } catch (err) {
        if (!cancelled) setError((err as Error).message);
      }
    }, 4000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [detail?.collection, detail?.item.id]);
  const act = async (path: string, body?: unknown, method = 'POST') => {
    setBusy(true);
    setError('');
    try {
      await api(path, method, body);
      await refresh();
      await onChanged();
      if (detail?.collection === 'jobs') {
        const item = await api<Entity>(`jobs/${detail.item.id}`);
        setDetail((current) =>
          current?.collection === 'jobs' && current.item.id === detail.item.id
            ? { collection: 'jobs', item: { ...item, id: detail.item.id } }
            : current,
        );
      }
      return true;
    } catch (err) {
      setError((err as Error).message);
      return false;
    } finally {
      setBusy(false);
    }
  };
  const tabs =
    view === 'resources'
      ? ['resources', 'credentials']
      : view === 'jobs'
        ? ['jobs', 'messages', 'workflows']
        : view === 'capabilities'
          ? ['capabilities', 'market']
          : view === 'schedules'
            ? ['schedules', 'monitors']
            : view === 'attention'
              ? ['attention', 'notifications']
              : [];
  const selectedTab = tabs.includes(tab) ? tab : tabs[0];
  const collection = selectedTab || (view === 'models' ? 'providers' : view);
  const items =
    collection === 'credentials'
      ? credentials
      : data
        ? entityList(data[collection as keyof ManagementState])
        : [];
  const filtered = items.filter((item) =>
    `${title(item)} ${description(collection, item, data!)}`
      .toLowerCase()
      .includes(query.toLowerCase()),
  );
  const pageCount = Math.max(1, Math.ceil(filtered.length / 12));
  const currentPage = Math.min(page, pageCount - 1);
  const name =
    managementNavigation.find((item) => item.id === view)?.label ||
    labels[collection];
  const RowIcon = icons[collection] || Plug;
  const openDetail = async (item: Entity) => {
    setDetail({ collection, item });
    if (
      ['jobs', 'schedules', 'monitors', 'capabilities'].includes(collection)
    ) {
      try {
        const full = await api<Entity>(`${collection}/${item.id}`);
        setDetail((current) =>
          current?.collection === collection && current.item.id === item.id
            ? { collection, item: { ...full, id: item.id } }
            : current,
        );
      } catch (err) {
        setError((err as Error).message);
      }
    }
  };
  const rowActions = (item: Entity) => (
    <div className="manage-actions">
      {collection === 'providers' && (
        <IconButton
          icon={Activity}
          label={`测试 ${title(item)}`}
          disabled={busy}
          onClick={() => {
            setProbeItem(item);
            setProbeModel(entityList(item.models)[0]?.id || '');
            setProbeTools(item.protocol !== 'typesafe-system-one');
            setProbeResult(null);
          }}
        />
      )}
      {canEdit.has(collection) && (
        <IconButton
          icon={Pencil}
          label={`编辑 ${title(item)}`}
          disabled={busy}
          onClick={() => setEditing({ collection, item })}
        />
      )}
      {['providers', 'schedules', 'monitors'].includes(collection) && (
        <IconButton
          icon={Power}
          label={item.enabled === false ? '启用' : '停用'}
          disabled={busy}
          onClick={() =>
            void act(
              `${collection}/${item.id}`,
              { ...item, enabled: item.enabled === false },
              'PUT',
            )
          }
        />
      )}
      {collection === 'schedules' && (
        <IconButton
          icon={Play}
          label="立即运行"
          disabled={busy}
          onClick={() => void act(`schedules/${item.id}/run`)}
        />
      )}
      {collection === 'workflows' && (
        <IconButton
          icon={Play}
          label="运行工作流"
          disabled={busy}
          onClick={() =>
            setEditing({
              collection: 'jobs',
              item: {
                ...item,
                id: '',
                workflowId: item.id,
                role: txt(entityList(item.steps)[0] || {}, 'role'),
                prompt: title(item),
              },
            })
          }
        />
      )}
      {collection === 'nodes' && status(item) !== 'revoked' && (
        <IconButton
          icon={LockKeyhole}
          label="撤销节点"
          disabled={busy}
          onClick={() => setRemoving({ collection, item })}
        />
      )}
      {collection === 'capabilities' && (
        <>
          {item.kind === 'mcp' && (
            <IconButton
              icon={Activity}
              label="检查 MCP 连接"
              disabled={busy}
              onClick={() => void act(`capabilities/${item.id}/probe`)}
            />
          )}
          <IconButton
            icon={Power}
            label={item.enabled === false ? '启用能力' : '停用能力'}
            disabled={busy}
            onClick={() =>
              void act(
                `capabilities/${item.id}/${item.enabled === false ? 'enable' : 'disable'}`,
              )
            }
          />
          <IconButton
            icon={Undo2}
            label="回退上一版本"
            disabled={busy}
            onClick={() => void act(`capabilities/${item.id}/rollback`)}
          />
        </>
      )}
      {collection === 'attention' &&
        item.kind !== 'tool-approval' &&
        !['resolved', 'dismissed', 'completed'].includes(status(item)) && (
          <IconButton
            icon={Check}
            label="标记已处理"
            disabled={busy}
            onClick={() => void act(`attention/${item.id}/resolve`)}
          />
        )}
      {collection === 'attention' &&
        item.kind === 'tool-approval' &&
        !['resolved', 'dismissed'].includes(status(item)) && (
          <IconButton
            icon={Search}
            label="查看待授权调用"
            onClick={() => void openDetail(item)}
          />
        )}
      {collection === 'notifications' &&
        !item.read &&
        !item.readAt &&
        status(item) !== 'read' && (
          <IconButton
            icon={Check}
            label="标记已读"
            disabled={busy}
            onClick={() => void act(`notifications/${item.id}/read`)}
          />
        )}
      {collection === 'backups' && (
        <>
          <a
            className="icon-button"
            title="下载备份"
            aria-label={`下载 ${title(item)}`}
            href={`/api/backups/${encodeURIComponent(item.id || txt(item, 'filename'))}/download`}
          >
            <Download size={17} />
          </a>
          <IconButton
            icon={Undo2}
            label="恢复备份"
            disabled={busy}
            onClick={() => {
              setRestoreResult(null);
              setRestoring(item);
            }}
          />
        </>
      )}
      {[
        'providers',
        'resources',
        'credentials',
        'capabilities',
        'schedules',
        'monitors',
        'workflows',
      ].includes(collection) && (
        <IconButton
          icon={Trash2}
          label={`删除 ${title(item)}`}
          disabled={busy}
          onClick={() => setRemoving({ collection, item })}
        />
      )}
    </div>
  );
  return (
    <main className="manage-page">
      <div className="manage-heading">
        <div>
          <h1>{name}</h1>
          <p>
            {collection === 'market'
              ? 'Skill · MCP · Plugin'
              : `${items.length} 条记录`}
          </p>
        </div>
        <div className="manage-actions">
          <IconButton
            icon={RefreshCw}
            label="刷新列表"
            disabled={busy || loading}
            onClick={() => void refresh()}
          />
          {[
            'providers',
            'resources',
            'credentials',
            'jobs',
            'messages',
            'workflows',
            'capabilities',
            'schedules',
            'monitors',
          ].includes(collection) && (
            <button
              className="primary-button"
              disabled={
                !data ||
                busy ||
                (collection === 'credentials' && !data.vault?.unlocked)
              }
              onClick={() => setEditing({ collection })}
            >
              {collection === 'messages' ? (
                <Send size={16} />
              ) : (
                <Plus size={16} />
              )}
              {collection === 'messages'
                ? '发送消息'
                : `新建${labels[collection]}`}
            </button>
          )}
          {view === 'nodes' && (
            <button
              className="primary-button"
              disabled={busy}
              onClick={() => {
                setPairDialog(true);
                setPairName('');
                setPairResult(null);
              }}
            >
              <Plus size={16} />
              配对节点
            </button>
          )}
          {view === 'capabilities' && (
            <button
              className="secondary-button"
              disabled={busy}
              onClick={() => {
                setImportItem(null);
                setImportSource('github');
                setSourceUrl('');
                setImportVersion('');
                setImportDialog(true);
              }}
            >
              <Download size={16} />
              导入
            </button>
          )}
          {view === 'backups' && (
            <button
              className="primary-button"
              disabled={busy}
              onClick={() => void act('backups', {})}
            >
              <Archive size={16} />
              创建备份
            </button>
          )}
        </div>
      </div>
      {!!tabs.length && (
        <div className="manage-tabs" role="tablist" aria-label={name}>
          {tabs.map((id) => (
            <button
              key={id}
              type="button"
              role="tab"
              aria-selected={selectedTab === id}
              onClick={() => {
                setTab(id);
                setQuery('');
                setPage(0);
              }}
            >
              {id === 'market' ? '发现能力' : labels[id]}
            </button>
          ))}
        </div>
      )}
      {view === 'resources' && (
        <div className="manage-security">
          <div>
            {data?.vault?.unlocked ? (
              <UnlockKeyhole size={19} />
            ) : (
              <LockKeyhole size={19} />
            )}
            <strong>凭据库</strong>
            <Badge
              value={
                data?.vault?.unlocked
                  ? '已解锁'
                  : data?.vault?.initialized || data?.vault?.configured
                    ? '已锁定'
                    : '未初始化'
              }
            />
          </div>
          <div className="manage-actions">
            {data?.vault?.unlocked && (
              <button
                className="secondary-button"
                disabled={busy}
                onClick={() => void act('vault/import-legacy', {})}
              >
                <Download size={15} />
                导入旧版模型凭据
              </button>
            )}
            <button
              className="secondary-button"
              disabled={!data || busy}
              onClick={() => {
                if (data?.vault?.unlocked) void act('vault/lock');
                else {
                  setPassphrase('');
                  setPassphraseConfirm('');
                  setVaultDialog(true);
                }
              }}
            >
              {data?.vault?.unlocked ? (
                <LockKeyhole size={15} />
              ) : (
                <KeyRound size={15} />
              )}
              {data?.vault?.unlocked
                ? '锁定'
                : data?.vault?.initialized || data?.vault?.configured
                  ? '解锁'
                  : '初始化'}
            </button>
          </div>
        </div>
      )}
      <ErrorMessage
        error={error || loadError}
        dismiss={() => {
          setError('');
          setLoadError('');
        }}
      />
      {collection === 'market' ? (
        <>
          <form
            className="manage-toolbar"
            onSubmit={async (event) => {
              event.preventDefault();
              if (!query.trim()) return;
              setBusy(true);
              setError('');
              try {
                const result = await api<
                  | Entity[]
                  | {
                      items?: Entity[];
                      skills?: Entity[];
                      servers?: Entity[];
                      results?: Entity[];
                    }
                >(
                  `capabilities/search?source=${encodeURIComponent(marketSource)}&q=${encodeURIComponent(query)}`,
                );
                setMarketResults(
                  Array.isArray(result)
                    ? result
                    : result.items ||
                        result.skills ||
                        result.servers ||
                        result.results ||
                        [],
                );
                setMarketSearched(true);
              } catch (err) {
                setError((err as Error).message);
              } finally {
                setBusy(false);
              }
            }}
          >
            <select
              aria-label="能力市场"
              value={marketSource}
              onChange={(event) => {
                setMarketSource(event.target.value);
                setMarketResults([]);
                setMarketSearched(false);
              }}
            >
              <option value="skillsmp">SkillsMP</option>
              <option value="clawhub">ClawHub</option>
              <option value="mcp">MCP Registry</option>
            </select>
            <div className="manage-search">
              <Search size={16} />
              <input
                required
                aria-label="搜索市场能力"
                placeholder="搜索能力"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
              />
            </div>
            <button className="primary-button" disabled={busy || !query.trim()}>
              {busy ? (
                <LoaderCircle size={16} className="spin" />
              ) : (
                <Search size={16} />
              )}
              搜索
            </button>
          </form>
          <div className="manage-list">
            {marketResults.map((item, index) => {
              const sourceLink =
                txt(item, 'sourceUrl') ||
                txt(item, 'githubUrl') ||
                txt(item, 'url') ||
                txt(item, 'skillUrl');
              return (
                <div
                  className="manage-row"
                  key={item.id || sourceLink || index}
                >
                  <span className="manage-row-icon">
                    <Plug size={18} />
                  </span>
                  <div className="manage-main">
                    <strong>{title(item)}</strong>
                    <p>{txt(item, 'description')}</p>
                    <small>
                      {txt(item, 'author')} {txt(item, 'version')}
                    </small>
                  </div>
                  <div className="manage-actions">
                    {sourceLink.startsWith('https://') && (
                      <a
                        className="icon-button"
                        href={sourceLink}
                        rel="noreferrer"
                        target="_blank"
                        title="查看来源"
                        aria-label="查看来源"
                      >
                        <ExternalLink size={17} />
                      </a>
                    )}
                    <button
                      className="secondary-button"
                      disabled={busy}
                      onClick={() => {
                        setImportSource(marketSource);
                        setImportItem(item);
                        setSourceUrl(
                          sourceLink || txt(item, 'slug') || item.id,
                        );
                        setImportVersion(txt(item, 'version'));
                        setImportDialog(true);
                      }}
                    >
                      <Download size={15} />
                      选择
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
          {!marketResults.length && (
            <Empty
              text={marketSearched ? '没有找到匹配的能力' : '选择来源并搜索'}
              busy={busy}
            />
          )}
        </>
      ) : (
        <>
          <div className="manage-toolbar">
            <div className="manage-search">
              <Search size={16} />
              <input
                aria-label={`搜索${labels[collection] || ''}`}
                placeholder="搜索名称或内容"
                value={query}
                onChange={(event) => {
                  setQuery(event.target.value);
                  setPage(0);
                }}
              />
            </div>
          </div>
          <div className="manage-list">
            {filtered
              .slice(currentPage * 12, (currentPage + 1) * 12)
              .map((item) => (
                <div
                  className="manage-row"
                  key={item.id || txt(item, 'filename')}
                >
                  <span className="manage-row-icon">
                    {collection === 'resources' && item.kind === 'project' ? (
                      <FolderGit2 size={18} />
                    ) : (
                      <RowIcon size={18} />
                    )}
                  </span>
                  <div className="manage-main">
                    <button onClick={() => void openDetail(item)}>
                      <strong>{title(item)}</strong>
                    </button>
                    <p>{description(collection, item, data!)}</p>
                    {Boolean(item.lastError) && (
                      <small>{txt(item, 'lastError')}</small>
                    )}
                    {collection === 'capabilities' &&
                      Boolean(item.compatibility) && (
                        <small>
                          {statuses[txt(item, 'compatibility')] ||
                            txt(item, 'compatibility')}
                        </small>
                      )}
                  </div>
                  <Badge value={status(item)} />
                  {rowActions(item)}
                </div>
              ))}
          </div>
          {!filtered.length && (
            <Empty
              text={
                query ? '没有匹配记录' : `暂无${labels[collection] || '记录'}`
              }
              busy={loading}
            />
          )}
          {pageCount > 1 && (
            <div className="manage-pager">
              <span>
                {currentPage + 1} / {pageCount}
              </span>
              <IconButton
                icon={ChevronLeft}
                label="上一页"
                disabled={currentPage === 0}
                onClick={() => setPage(currentPage - 1)}
              />
              <IconButton
                icon={ChevronRight}
                label="下一页"
                disabled={currentPage + 1 >= pageCount}
                onClick={() => setPage(currentPage + 1)}
              />
            </div>
          )}
        </>
      )}
      {editing && data && (
        <EntityEditor
          collection={editing.collection}
          initial={editing.item}
          data={data}
          credentials={credentials}
          onClose={() => setEditing(null)}
          onSave={async (body) => {
            const id = editing.item?.id;
            await api(
              `${editing.collection}${id ? `/${id}` : ''}`,
              id ? 'PUT' : 'POST',
              body,
            );
            setEditing(null);
            await refresh();
            await onChanged();
            setNotice(
              editing.collection === 'messages' ? '消息已发送' : '已保存',
            );
          }}
        />
      )}
      {detail && data && (
        <Dialog open onOpenChange={(open) => !open && setDetail(null)}>
          <DialogContent className="manage-dialog">
            <DialogTitle>
              {title(
                typeof detail.item.job === 'object' && detail.item.job !== null
                  ? (detail.item.job as Entity)
                  : detail.item,
              )}
            </DialogTitle>
            <DialogDescription className="sr-only">
              {labels[detail.collection]}详情
            </DialogDescription>
            <ErrorMessage error={error} />
            {detail.collection === 'jobs' ? (
              <JobDetail
                detail={detail.item}
                data={data}
                onAction={act}
                busy={busy}
              />
            ) : (
              <div className="manage-detail">
                <Badge value={status(detail.item)} />
                <dl>
                  {Object.entries(detail.item)
                    .filter(
                      ([key, value]) =>
                        ![
                          'name',
                          'title',
                          'content',
                          'description',
                          'prompt',
                          'status',
                        ].includes(key) &&
                        value !== null &&
                        typeof value !== 'object',
                    )
                    .map(([key, value]) => (
                      <div key={key} style={{ display: 'contents' }}>
                        <dt>
                          {(
                            {
                              id: 'ID',
                              kind: '类型',
                              createdAt: '创建时间',
                              updatedAt: '更新时间',
                              host: '地址',
                              port: '端口',
                              path: '路径',
                              username: '用户',
                              credentialId: '凭据引用',
                              source: '来源',
                              version: '版本',
                              compatibility: '兼容状态',
                              error: '错误',
                              lastError: '最近错误',
                              nodeId: '执行节点',
                              requirementsVersion: '需求版本',
                              toAgentId: '接收助手',
                              fromAgentId: '发送助手',
                              toTaskId: '执行实例',
                              jobId: '关联任务',
                            } as Record<string, string>
                          )[key] || key}
                        </dt>
                        <dd>
                          {typeof value === 'boolean'
                            ? value
                              ? '是'
                              : '否'
                            : String(value)}
                        </dd>
                      </div>
                    ))}
                </dl>
                {[
                  'content',
                  'description',
                  'prompt',
                  'notes',
                  'detail',
                  'message',
                ].map((key) =>
                  detail.item[key] ? (
                    <p key={key}>{txt(detail.item, key)}</p>
                  ) : null,
                )}
                {entityList(detail.item.components).map((component, index) => (
                  <div className="manage-row" key={component.id || index}>
                    <div className="manage-main">
                      <strong>{title(component)}</strong>
                      <p>{txt(component, 'reason')}</p>
                    </div>
                    <Badge
                      value={
                        txt(component, 'compatibility') || status(component)
                      }
                    />
                  </div>
                ))}
                {Array.isArray(detail.item.diagnostics) &&
                  detail.item.diagnostics.map((value, index) => (
                    <p key={index}>{String(value)}</p>
                  ))}
                {['schedules', 'monitors'].includes(detail.collection) && (
                  <>
                    <h3>运行历史</h3>
                    {entityList(detail.item.runs).length ? (
                      entityList(detail.item.runs).map((run, index) => (
                        <div className="manage-row" key={run.id || index}>
                          <div className="manage-main">
                            <strong>
                              {time(
                                run.scheduledAt ||
                                  run.checkedAt ||
                                  run.createdAt,
                              )}
                            </strong>
                            <p>{txt(run, 'reason') || txt(run, 'error')}</p>
                            <small>
                              {Array.isArray(run.taskIds)
                                ? run.taskIds.join(' · ')
                                : txt(run, 'taskId')}
                            </small>
                          </div>
                          <Badge
                            value={
                              status(run) ||
                              (run.ok === true
                                ? 'healthy'
                                : run.ok === false
                                  ? 'unhealthy'
                                  : '')
                            }
                          />
                        </div>
                      ))
                    ) : (
                      <p>暂无运行记录</p>
                    )}
                  </>
                )}
                {detail.collection === 'capabilities' &&
                  typeof detail.item.health === 'object' &&
                  detail.item.health !== null && (
                    <>
                      <h3>连接检查</h3>
                      <Badge
                        value={
                          (detail.item.health as Record<string, unknown>).ok ===
                          true
                            ? 'healthy'
                            : 'unhealthy'
                        }
                      />
                      {entityList(
                        (detail.item.health as Record<string, unknown>).tools,
                      ).map((tool, index) => (
                        <div
                          className="manage-row"
                          key={txt(tool, 'name') || index}
                        >
                          <div className="manage-main">
                            <strong>{txt(tool, 'name')}</strong>
                            <p>{txt(tool, 'description')}</p>
                          </div>
                        </div>
                      ))}
                    </>
                  )}
                {detail.collection === 'capabilities' &&
                  (detail.item.kind === 'plugin' ||
                    entityList(detail.item.commands).length > 0 ||
                    entityList(detail.item.agents).length > 0 ||
                    entityList(detail.item.mcp).length > 0) && (
                    <PluginComponents
                      key={`${detail.item.id}:${txt(detail.item, 'digest')}`}
                      capability={detail.item}
                      data={data}
                      credentials={credentials}
                      onChanged={async () => {
                        await refresh();
                        await onChanged();
                        const updated = await api<Entity>(
                          `capabilities/${detail.item.id}`,
                        );
                        setDetail((current) =>
                          current?.collection === 'capabilities' &&
                          current.item.id === detail.item.id
                            ? { collection: 'capabilities', item: updated }
                            : current,
                        );
                      }}
                    />
                  )}
                {detail.collection === 'attention' &&
                  detail.item.kind !== 'tool-approval' &&
                  !['resolved', 'dismissed'].includes(status(detail.item)) && (
                    <form
                      className="manage-form"
                      onSubmit={async (event) => {
                        event.preventDefault();
                        const formData = new FormData(event.currentTarget);
                        const saved = await act(
                          `attention/${detail.item.id}/resolve`,
                          { resolution: formData.get('resolution') },
                        );
                        if (saved) setDetail(null);
                      }}
                    >
                      <label>
                        处理结果
                        <textarea name="resolution" rows={3} required />
                      </label>
                      <button className="primary-button" disabled={busy}>
                        <Check size={15} />
                        提交处理结果
                      </button>
                    </form>
                  )}
                {detail.collection === 'attention' &&
                  detail.item.kind === 'tool-approval' && (
                    <>
                      <h3>工具调用</h3>
                      <p>
                        {txt(detail.item, 'toolName')} ·{' '}
                        {txt(detail.item, 'action')}
                      </p>
                      <pre>
                        {typeof detail.item.argumentsPreview === 'string'
                          ? detail.item.argumentsPreview
                          : JSON.stringify(
                              detail.item.argumentsPreview,
                              null,
                              2,
                            )}
                      </pre>
                      {!['resolved', 'dismissed'].includes(
                        status(detail.item),
                      ) && (
                        <div className="manage-form-footer">
                          <button
                            className="secondary-button"
                            disabled={busy}
                            onClick={async () => {
                              if (
                                await act(
                                  `attention/${detail.item.id}/resolve`,
                                  { approved: false },
                                )
                              )
                                setDetail(null);
                            }}
                          >
                            <X size={16} />
                            拒绝
                          </button>
                          <button
                            className="primary-button"
                            disabled={busy}
                            onClick={async () => {
                              if (
                                await act(
                                  `attention/${detail.item.id}/resolve`,
                                  { approved: true },
                                )
                              )
                                setDetail(null);
                            }}
                          >
                            <Check size={16} />
                            批准这次调用
                          </button>
                        </div>
                      )}
                    </>
                  )}
              </div>
            )}
          </DialogContent>
        </Dialog>
      )}
      {removing && (
        <Dialog
          open
          onOpenChange={(open) => !open && !busy && setRemoving(null)}
        >
          <DialogContent className="manage-dialog">
            <DialogTitle>
              {removing.collection === 'nodes' ? '撤销节点' : '删除记录'}
            </DialogTitle>
            <DialogDescription>{title(removing.item)}</DialogDescription>
            <ErrorMessage error={error} />
            <div className="manage-form-footer">
              <button
                className="secondary-button"
                disabled={busy}
                onClick={() => setRemoving(null)}
              >
                取消
              </button>
              <button
                className="primary-button"
                disabled={busy}
                onClick={async () => {
                  setBusy(true);
                  try {
                    await api(
                      `${removing.collection}/${removing.item.id}${removing.collection === 'nodes' ? '/revoke' : ''}`,
                      removing.collection === 'nodes' ? 'POST' : 'DELETE',
                    );
                    setRemoving(null);
                    await refresh();
                  } catch (err) {
                    setError((err as Error).message);
                  } finally {
                    setBusy(false);
                  }
                }}
              >
                <Trash2 size={16} />
                {removing.collection === 'nodes' ? '撤销' : '删除'}
              </button>
            </div>
          </DialogContent>
        </Dialog>
      )}
      {vaultDialog && data && (
        <Dialog
          open
          onOpenChange={(open) => {
            if (!open && !busy) {
              setVaultDialog(false);
              setPassphrase('');
              setPassphraseConfirm('');
            }
          }}
        >
          <DialogContent className="manage-dialog">
            <DialogTitle>
              {data.vault?.initialized || data.vault?.configured
                ? '解锁凭据库'
                : '初始化凭据库'}
            </DialogTitle>
            <DialogDescription className="sr-only">
              凭据库主密码
            </DialogDescription>
            <form
              className="manage-form"
              onSubmit={async (event) => {
                event.preventDefault();
                if (
                  !(data.vault?.initialized || data.vault?.configured) &&
                  passphrase !== passphraseConfirm
                ) {
                  setError('两次输入的主密码不一致');
                  return;
                }
                setBusy(true);
                try {
                  await api(
                    `vault/${data.vault?.initialized || data.vault?.configured ? 'unlock' : 'initialize'}`,
                    'POST',
                    { passphrase },
                  );
                  setPassphrase('');
                  setPassphraseConfirm('');
                  setVaultDialog(false);
                  await refresh();
                } catch (err) {
                  setError((err as Error).message);
                } finally {
                  setBusy(false);
                }
              }}
            >
              <label>
                主密码
                <input
                  type="password"
                  autoComplete={
                    data.vault?.initialized
                      ? 'current-password'
                      : 'new-password'
                  }
                  required
                  minLength={6}
                  value={passphrase}
                  onChange={(event) => setPassphrase(event.target.value)}
                />
              </label>
              {!(data.vault?.initialized || data.vault?.configured) && (
                <label>
                  确认主密码
                  <input
                    type="password"
                    autoComplete="new-password"
                    required
                  minLength={6}
                    value={passphraseConfirm}
                    onChange={(event) =>
                      setPassphraseConfirm(event.target.value)
                    }
                  />
                </label>
              )}
              <ErrorMessage error={error} />
              <button className="primary-button" disabled={busy}>
                <UnlockKeyhole size={16} />
                {data.vault?.initialized || data.vault?.configured
                  ? '解锁'
                  : '初始化'}
              </button>
            </form>
          </DialogContent>
        </Dialog>
      )}
      {pairDialog && (
        <Dialog
          open
          onOpenChange={(open) => !open && !busy && setPairDialog(false)}
        >
          <DialogContent className="manage-dialog">
            <DialogTitle>配对执行节点</DialogTitle>
            <DialogDescription className="sr-only">
              生成节点配对码
            </DialogDescription>
            {pairResult ? (
              <div className="manage-detail">
                <code className="manage-pairing">
                  {txt(pairResult, 'code') || txt(pairResult, 'token')}
                </code>
                {Boolean(pairResult.expiresAt) && (
                  <p>有效期至 {time(pairResult.expiresAt)}</p>
                )}
                <button
                  className="text-button"
                  onClick={async () => {
                    try {
                      await navigator.clipboard.writeText(
                        txt(pairResult, 'code') || txt(pairResult, 'token'),
                      );
                      setNotice('配对码已复制');
                    } catch {
                      setError('无法访问剪贴板');
                    }
                  }}
                >
                  <Copy size={16} />
                  复制配对码
                </button>
                {Boolean(pairResult.command) && (
                  <pre>{txt(pairResult, 'command')}</pre>
                )}
              </div>
            ) : (
              <form
                className="manage-form"
                onSubmit={async (event) => {
                  event.preventDefault();
                  setBusy(true);
                  try {
                    setPairResult(
                      await api<Entity>('nodes/pairing', 'POST', {
                        name: pairName,
                      }),
                    );
                  } catch (err) {
                    setError((err as Error).message);
                  } finally {
                    setBusy(false);
                  }
                }}
              >
                <label>
                  节点名称
                  <input
                    required
                    value={pairName}
                    onChange={(event) => setPairName(event.target.value)}
                  />
                </label>
                <ErrorMessage error={error} />
                <button className="primary-button" disabled={busy}>
                  <Network size={16} />
                  生成配对码
                </button>
              </form>
            )}
          </DialogContent>
        </Dialog>
      )}
      {importDialog && (
        <Dialog
          open
          onOpenChange={(open) => !open && !busy && setImportDialog(false)}
        >
          <DialogContent className="manage-dialog">
            <DialogTitle>导入能力</DialogTitle>
            <DialogDescription className="sr-only">
              安装指定来源和版本
            </DialogDescription>
            <form
              className="manage-form"
              onSubmit={async (event) => {
                event.preventDefault();
                setBusy(true);
                try {
                  await api('capabilities/install', 'POST', {
                    ...importItem,
                    ...(importSource === 'mcp'
                      ? {
                          url:
                            entityList(importItem?.remotes).find(
                              (remote) => remote.type === 'streamable-http',
                            )?.url || '',
                        }
                      : {}),
                    source: importSource,
                    sourceUrl,
                    slug:
                      importSource === 'clawhub'
                        ? txt(importItem || {}, 'slug') ||
                          sourceUrl.split('/').filter(Boolean).pop()
                        : undefined,
                    version: importVersion || undefined,
                  });
                  setImportDialog(false);
                  await refresh();
                  setNotice('能力已导入');
                } catch (err) {
                  setError((err as Error).message);
                } finally {
                  setBusy(false);
                }
              }}
            >
              <label>
                来源
                <select
                  value={importSource}
                  onChange={(event) => {
                    setImportSource(event.target.value);
                    setImportItem(null);
                  }}
                >
                  <option value="github">Git 仓库 / 本地目录</option>
                  <option value="skillsmp">SkillsMP</option>
                  <option value="clawhub">ClawHub</option>
                  <option value="mcp">MCP Registry</option>
                  <option value="claude">Claude Code Plugin</option>
                  <option value="codex">Codex Plugin</option>
                </select>
              </label>
              <label>
                来源地址或路径
                <input
                  required
                  value={sourceUrl}
                  onChange={(event) => setSourceUrl(event.target.value)}
                />
              </label>
              <label>
                固定版本 / Git 分支
                <input
                  value={importVersion}
                  onChange={(event) => setImportVersion(event.target.value)}
                />
              </label>
              <ErrorMessage error={error} />
              <button className="primary-button" disabled={busy}>
                {busy ? (
                  <LoaderCircle size={16} className="spin" />
                ) : (
                  <Download size={16} />
                )}
                导入
              </button>
            </form>
          </DialogContent>
        </Dialog>
      )}
      {probeItem && (
        <Dialog
          open
          onOpenChange={(open) => !open && !busy && setProbeItem(null)}
        >
          <DialogContent className="manage-dialog">
            <DialogTitle>测试 {title(probeItem)}</DialogTitle>
            <DialogDescription className="sr-only">
              模型能力检查
            </DialogDescription>
            <form
              className="manage-form"
              onSubmit={async (event) => {
                event.preventDefault();
                setBusy(true);
                setProbeResult(null);
                try {
                  setProbeResult(
                    await api(`providers/${probeItem.id}/probe`, 'POST', {
                      model: probeModel,
                      toolTest: probeTools,
                    }),
                  );
                  await refresh();
                } catch (err) {
                  setError((err as Error).message);
                } finally {
                  setBusy(false);
                }
              }}
            >
              <label>
                测试模型
                <select
                  required
                  value={probeModel}
                  onChange={(event) => setProbeModel(event.target.value)}
                >
                  {entityList(probeItem.models).map((model) => (
                    <option key={model.id} value={model.id}>
                      {model.name || model.id}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                <input
                  type="checkbox"
                  checked={probeTools}
                  disabled={probeItem.protocol === 'typesafe-system-one'}
                  onChange={(event) => setProbeTools(event.target.checked)}
                />
                {probeItem.protocol === 'typesafe-system-one'
                  ? 'TypeSafe 结构化连通性检查'
                  : '检查工具调用'}
              </label>
              <ErrorMessage error={error} />
              <button className="primary-button" disabled={busy}>
                {busy ? (
                  <LoaderCircle className="spin" size={16} />
                ) : (
                  <Activity size={16} />
                )}
                开始测试
              </button>
            </form>
            {probeResult && (
              <div className="manage-detail">
                <h3>测试结果</h3>
                <pre>{JSON.stringify(probeResult, null, 2)}</pre>
              </div>
            )}
          </DialogContent>
        </Dialog>
      )}
      {restoring && (
        <Dialog
          open
          onOpenChange={(open) => !open && !busy && setRestoring(null)}
        >
          <DialogContent className="manage-dialog">
            <DialogTitle>恢复备份</DialogTitle>
            <DialogDescription>
              {title(restoring)}。恢复需要停止控制端服务，完成后重新启动。
            </DialogDescription>
            <ErrorMessage error={error} />
            {restoreResult && (
              <div className="manage-detail">
                <Badge value="需要离线恢复" />
                <p>
                  {txt(restoreResult, 'message') ||
                    txt(restoreResult, 'instructions')}
                </p>
                <pre>{txt(restoreResult, 'command')}</pre>
                <button
                  className="text-button"
                  onClick={async () => {
                    try {
                      await navigator.clipboard.writeText(
                        txt(restoreResult, 'command'),
                      );
                      setNotice('恢复命令已复制');
                    } catch {
                      setError('无法访问剪贴板');
                    }
                  }}
                >
                  <Copy size={15} />
                  复制命令
                </button>
              </div>
            )}
            <div className="manage-form-footer">
              <button
                className="secondary-button"
                disabled={busy}
                onClick={() => setRestoring(null)}
              >
                关闭
              </button>
              <button
                className="primary-button"
                disabled={busy || Boolean(restoreResult)}
                onClick={async () => {
                  setBusy(true);
                  try {
                    setRestoreResult(
                      await api<Entity>(
                        `backups/${encodeURIComponent(restoring.id || txt(restoring, 'filename'))}/restore`,
                        'POST',
                        {},
                      ),
                    );
                  } catch (err) {
                    setError((err as Error).message);
                  } finally {
                    setBusy(false);
                  }
                }}
              >
                <Undo2 size={16} />
                准备恢复
              </button>
            </div>
          </DialogContent>
        </Dialog>
      )}
      {notice && (
        <output className="toast">
          {notice}
          <IconButton icon={X} label="关闭通知" onClick={() => setNotice('')} />
        </output>
      )}
    </main>
  );
}

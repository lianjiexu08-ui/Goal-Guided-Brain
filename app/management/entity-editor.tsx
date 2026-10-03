'use client';

import { useState } from 'react';
import {
  Activity,
  Clock3,
  LoaderCircle,
  Plus,
  Save,
  Send,
  X,
} from 'lucide-react';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from '@/components/ui/dialog';
import { api, entityList, entityText as txt } from '../workbench-api';
import { ErrorMessage, IconButton, status, time, title } from './shared';
import { labels } from './shared';
import { initialForm, type FormValues, type FormProps } from './entity-form';
import { StepEditor } from './step-editor';

export function EntityEditor({
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
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<Record<string, unknown> | null>(
    null,
  );
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
                    TypeSafe
                    用于结构化判断和路由，不生成聊天回复或代码。建议地址为
                    https://api.typesafe.ai/v1，模型问题需使用 choice、score 或
                    noul 类型。
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
                  <p className="manage-help">
                    保存供应商后，可以在列表中点击同步按钮，从接口读取真实可用的模型
                    ID；图片、音频和实时专用模型会自动排除。
                  </p>
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
                <StepEditor
                  steps={steps}
                  role={txt(form, 'role')}
                  roles={data.roles}
                  onChange={field}
                />
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
                        ...data.providers
                          .filter(
                            (item) => item.protocol !== 'typesafe-system-one',
                          )
                          .map((item) => ({
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
          {testResult && (
            <div
              style={{
                margin: '10px 0',
                padding: '10px 14px',
                borderRadius: '8px',
                fontSize: '13px',
                background: testResult.ok
                  ? 'rgba(34, 197, 94, 0.12)'
                  : 'rgba(239, 68, 68, 0.12)',
                color: testResult.ok ? '#4ade80' : '#f87171',
                border: `1px solid ${testResult.ok ? 'rgba(34, 197, 94, 0.3)' : 'rgba(239, 68, 68, 0.3)'}`,
                display: 'flex',
                justifyContent: 'space-between',
                alignItems: 'center',
              }}
            >
              <span>
                {typeof testResult.message === 'string'
                  ? testResult.message
                  : testResult.ok
                    ? '测试通过'
                    : '测试失败'}
              </span>
              {typeof testResult.latencyMs === 'number' && (
                <span style={{ fontSize: '11px', opacity: 0.8 }}>
                  {testResult.latencyMs}ms
                </span>
              )}
            </div>
          )}
          <ErrorMessage error={error} />
          <div className="manage-form-footer">
            {['credentials', 'resources'].includes(collection) && (
              <button
                type="button"
                className="secondary-button"
                disabled={
                  busy ||
                  testing ||
                  (collection === 'credentials'
                    ? !form.value
                    : form.kind === 'project'
                      ? !form.path
                      : !form.host)
                }
                onClick={async () => {
                  setTesting(true);
                  setTestResult(null);
                  setError('');
                  try {
                    const endpoint = initial?.id
                      ? `${collection}/${initial.id}/probe`
                      : `${collection}/probe`;
                    const res = await api<Record<string, unknown>>(
                      endpoint,
                      'POST',
                      form,
                    );
                    setTestResult(res);
                  } catch (err) {
                    setTestResult({
                      ok: false,
                      message: (err as Error).message,
                    });
                  } finally {
                    setTesting(false);
                  }
                }}
              >
                {testing ? (
                  <LoaderCircle className="spin" size={16} />
                ) : (
                  <Activity size={16} />
                )}
                测试连通性
              </button>
            )}
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

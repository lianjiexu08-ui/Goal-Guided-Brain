'use client';

import { useCallback, useEffect, useState } from 'react';
import {
  Check,
  Cpu,
  Download,
  Inbox,
  LoaderCircle,
  Play,
  Plug,
  Power,
  RefreshCw,
  Terminal,
  X,
} from 'lucide-react';
import {
  api,
  entityList,
  entityText as txt,
  type Entity,
  type ManagementState,
} from '../workbench-api';

const statuses: Record<string, string> = {
  disabled: '已停用',
  failed: '失败',
  error: '异常',
  unhealthy: '异常',
  revoked: '已撤销',
  unavailable: '不可用',
  rejected: '已退回复核',
  blocked: '等待处理',
  unknown: '状态未知',
  partial: '部分兼容',
  needs_configuration: '需要配置',
  needs_config: '需要配置',
  unsupported: '不支持',
  offline: '离线',
  cancelled: '已取消',
  paused: '已暂停',
  dismissed: '已拒绝',
};

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

function Badge({ value }: { value: string }) {
  if (!value) return null;
  const tone = [
    'failed',
    'error',
    'unhealthy',
    'revoked',
    'unavailable',
    'rejected',
  ].includes(value)
    ? 'error'
    : [
          'blocked',
          'unknown',
          'partial',
          'needs_configuration',
          'needs_config',
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
      {dismiss && (
        <button
          type="button"
          className="icon-button"
          title="关闭错误"
          aria-label="关闭错误"
          onClick={dismiss}
        >
          <X size={17} />
        </button>
      )}
    </div>
  ) : null;
}

export function PluginComponents({
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
                                            data.providers
                                              .filter(
                                                (provider) =>
                                                  provider.protocol !==
                                                  'typesafe-system-one',
                                              )
                                              .flatMap((provider) =>
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

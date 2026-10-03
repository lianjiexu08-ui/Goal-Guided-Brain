'use client';

import {
  api,
  entityList,
  entityText as txt,
  type Entity,
  type ManagementState,
} from '../workbench-api';
import { Dispatch, SetStateAction } from 'react';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from '@/components/ui/dialog';
import { EntityEditor } from './entity-editor';
import { JobDetail } from './job-detail';
import {
  Badge,
  ErrorMessage,
  labels,
  status,
  statuses,
  time,
  title,
} from './shared';
import { ExecutionInspector } from './execution-inspector';
import { PluginComponents } from './plugin-components';
import {
  Check,
  FolderGit2,
  GitBranch,
  Network,
  RefreshCw,
  X,
} from 'lucide-react';

type Editing = { collection: string; item?: Entity } | null;
type Detail = { collection: string; item: Entity } | null;
type Props = {
  editing: Editing;
  detail: Detail;
  data: ManagementState;
  credentials: Entity[];
  busy: boolean;
  error: string;
  setEditing: (value: Editing) => void;
  setDetail: Dispatch<SetStateAction<Detail>>;
  setNotice: (value: string) => void;
  refresh: () => Promise<void>;
  onChanged: () => Promise<void>;
  act: (path: string, body?: unknown, method?: string) => Promise<boolean>;
  openDetail: (item: Entity) => Promise<void>;
  openPairingDialog: (name?: string) => void;
  openRelatedJob: (item: Entity) => Promise<void>;
  attentionTaskId: string | null;
  setAttentionTaskId: (value: string | null) => void;
};

export function ManagementDetailDialogs({
  editing,
  detail,
  data,
  credentials,
  busy,
  error,
  setEditing,
  setDetail,
  setNotice,
  refresh,
  onChanged,
  act,
  openDetail,
  openPairingDialog,
  openRelatedJob,
  attentionTaskId,
  setAttentionTaskId,
}: Props) {
  return (
    <>
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
                {detail.collection === 'nodes' && (
                  <section
                    className="node-status-panel"
                    aria-label="节点运行状态"
                  >
                    <h3>节点运行状态</h3>
                    <div className="node-status-actions">
                      <button
                        type="button"
                        className="text-button"
                        disabled={busy}
                        onClick={() => void openDetail(detail.item)}
                      >
                        <RefreshCw size={14} /> 刷新状态
                      </button>
                      {status(detail.item) === 'revoked' && (
                        <button
                          type="button"
                          className="secondary-button"
                          disabled={busy}
                          onClick={() =>
                            openPairingDialog(`${title(detail.item)}-repaired`)
                          }
                        >
                          <Network size={14} /> 重新配对节点
                        </button>
                      )}
                    </div>
                    <div className="node-status-summary">
                      <span>
                        最近心跳：
                        {detail.item.lastSeenAt
                          ? time(detail.item.lastSeenAt)
                          : '尚未上报'}
                      </span>
                      <span>
                        平台：{txt(detail.item, 'platform') || '未知'}
                      </span>
                    </div>
                    <div className="node-workspace-list">
                      <strong>工作目录映射</strong>
                      {Array.isArray(detail.item.workspaces) &&
                      detail.item.workspaces.length ? (
                        detail.item.workspaces.map((workspace, index) => (
                          <code key={index}>{String(workspace)}</code>
                        ))
                      ) : (
                        <span>节点尚未声明工作目录映射。</span>
                      )}
                    </div>
                    <div className="node-active-list">
                      <strong>当前执行</strong>
                      {entityList(detail.item.activeExecutions).length ? (
                        entityList(detail.item.activeExecutions).map(
                          (execution, index) => (
                            <div
                              className="node-active-item"
                              key={txt(execution, 'taskId') || index}
                            >
                              <span>
                                {txt(execution, 'title') ||
                                  txt(execution, 'taskId')}
                              </span>
                              <Badge
                                value={txt(execution, 'status') || 'running'}
                              />
                            </div>
                          ),
                        )
                      ) : (
                        <span>当前没有执行中的任务。</span>
                      )}
                    </div>
                    {status(detail.item) === 'offline' && (
                      <p className="node-status-hint">
                        节点已超过租约时间未发送心跳。请在节点上重新运行启动命令；已有执行会保持未知状态，需要从新实例恢复。
                      </p>
                    )}
                    {status(detail.item) === 'revoked' && (
                      <p className="node-status-hint">
                        此节点凭据已撤销。请生成新的配对码，并使用独立的数据目录重新配对。
                      </p>
                    )}
                  </section>
                )}
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
                {detail.collection === 'capabilities' &&
                  (() => {
                    const rawRisk = detail.item.risk;
                    if (
                      !rawRisk ||
                      typeof rawRisk !== 'object' ||
                      Array.isArray(rawRisk)
                    )
                      return null;
                    const risk = rawRisk as Entity;
                    const signals =
                      risk.signals &&
                      typeof risk.signals === 'object' &&
                      !Array.isArray(risk.signals)
                        ? (risk.signals as Record<string, unknown>)
                        : {};
                    const signalLabels: [string, string][] = [
                      ['readOnly', '只读'],
                      ['hasCredential', '凭据'],
                      ['hasCommands', '命令/助手'],
                      ['hasHooks', 'Hook'],
                      ['hasNetwork', '网络'],
                    ];
                    return (
                      <section
                        className="capability-risk"
                        aria-label="能力风险评估"
                      >
                        <h3>风险评估</h3>
                        <Badge
                          value={`risk-${txt(risk, 'level') || 'unknown'}`}
                        />
                        <p>
                          {risk.requiresReview === true
                            ? '绑定前需要人工复核。'
                            : '当前元数据未发现需要额外复核的执行信号。'}
                        </p>
                        {Array.isArray(risk.reasons) &&
                          (risk.reasons as unknown[]).map((reason, index) => (
                            <p key={index}>{String(reason)}</p>
                          ))}
                        <div className="manage-muted">
                          信号：
                          {signalLabels
                            .filter(([key]) => signals[key] === true)
                            .map(([, label]) => label)
                            .join(' · ') || '无'}
                        </div>
                        {detail.item.enabled === false &&
                          risk.requiresReview === true && (
                            <button
                              type="button"
                              className="primary-button"
                              disabled={busy}
                              onClick={async () => {
                                const ok = await act(
                                  `capabilities/${detail.item.id}/enable`,
                                  { confirmed: true },
                                );
                                if (ok) setDetail(null);
                              }}
                            >
                              确认风险并启用能力
                            </button>
                          )}
                      </section>
                    );
                  })()}
                {detail.collection === 'capabilities' && (
                  <section
                    className="capability-audit"
                    aria-label="能力确认审计"
                  >
                    <h3>确认与审计</h3>
                    {entityList(detail.item.audits).length ? (
                      entityList(detail.item.audits).map((audit, index) => (
                        <div className="manage-row" key={audit.id || index}>
                          <div className="manage-main">
                            <strong>
                              {txt(audit, 'action') === 'bind'
                                ? '绑定能力'
                                : txt(audit, 'action') === 'enable'
                                  ? '启用能力'
                                  : txt(audit, 'action') === 'disable'
                                    ? '停用能力'
                                    : '回退版本'}
                            </strong>
                            <small>
                              {txt(audit, 'actor') || 'owner'} ·{' '}
                              {txt(audit, 'riskLevel') || 'unknown'} ·{' '}
                              {txt(audit, 'digest') || '无摘要'}
                            </small>
                            {Array.isArray(audit.reasons) && (
                              <small>
                                {(audit.reasons as unknown[]).join('；')}
                              </small>
                            )}
                          </div>
                          <Badge
                            value={
                              audit.confirmed === true
                                ? 'confirmed'
                                : 'recorded'
                            }
                          />
                        </div>
                      ))
                    ) : (
                      <p>
                        尚无确认记录。高风险能力在绑定或启用前会要求逐项确认。
                      </p>
                    )}
                  </section>
                )}
                {detail.collection === 'capabilities' &&
                  Boolean(detail.item.bindings) &&
                  typeof detail.item.bindings === 'object' && (
                    <section
                      className="capability-bindings"
                      aria-label="能力绑定范围"
                    >
                      <h3>绑定范围</h3>
                      {entityList(
                        (detail.item.bindings as Entity).assistants,
                      ).map((binding) => (
                        <div
                          className="manage-row"
                          key={`assistant:${binding.id}`}
                        >
                          <div className="manage-main">
                            <strong>助手 · {title(binding)}</strong>
                            <small>{txt(binding, 'id')}</small>
                          </div>
                          <Badge value="enabled" />
                        </div>
                      ))}
                      {entityList((detail.item.bindings as Entity).teams).map(
                        (binding) => (
                          <div
                            className="manage-row"
                            key={`team:${binding.id}`}
                          >
                            <div className="manage-main">
                              <strong>团队 · {txt(binding, 'teamName')}</strong>
                              <small>
                                {txt(binding, 'roleName')} ·{' '}
                                {txt(binding, 'roleId')}
                              </small>
                            </div>
                            <Badge value="enabled" />
                          </div>
                        ),
                      )}
                      {!entityList((detail.item.bindings as Entity).assistants)
                        .length &&
                        !entityList((detail.item.bindings as Entity).teams)
                          .length && <p>还没有助手或团队成员绑定此能力。</p>}
                    </section>
                  )}
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
                  Boolean(detail.item.taskId) && (
                    <section
                      className="attention-linked-task"
                      aria-label="关联执行"
                    >
                      <div className="attention-linked-task-heading">
                        <div>
                          <h3>关联执行</h3>
                          <p>
                            {txt(detail.item, 'taskTitle') ||
                              txt(detail.item, 'taskId')}
                          </p>
                        </div>
                        <Badge
                          value={
                            txt(detail.item, 'deliveryStatus') ||
                            txt(detail.item, 'taskStatus')
                          }
                        />
                      </div>
                      <div className="attention-linked-task-meta">
                        {txt(detail.item, 'jobTitle') && (
                          <span>任务组 · {txt(detail.item, 'jobTitle')}</span>
                        )}
                        {txt(detail.item, 'taskStatus') && (
                          <span>
                            执行 ·{' '}
                            {statuses[txt(detail.item, 'taskStatus')] ||
                              txt(detail.item, 'taskStatus')}
                          </span>
                        )}
                      </div>
                      <div className="manage-toolbar">
                        {Boolean(detail.item.jobId) && (
                          <button
                            className="secondary-button"
                            type="button"
                            disabled={busy}
                            onClick={() => void openRelatedJob(detail.item)}
                          >
                            <GitBranch size={15} /> 打开任务组
                          </button>
                        )}
                        <button
                          className="secondary-button"
                          type="button"
                          disabled={busy}
                          onClick={() =>
                            setAttentionTaskId(txt(detail.item, 'taskId'))
                          }
                        >
                          <FolderGit2 size={15} /> 查看执行与交付
                        </button>
                      </div>
                      {attentionTaskId === txt(detail.item, 'taskId') && (
                        <ExecutionInspector
                          taskId={txt(detail.item, 'taskId')}
                        />
                      )}
                    </section>
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
    </>
  );
}

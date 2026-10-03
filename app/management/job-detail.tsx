'use client';

import { useState } from 'react';
import {
  Pause,
  Pencil,
  Play,
  RefreshCw,
  Save,
  Square,
  GitMerge,
} from 'lucide-react';
import {
  api,
  entityList,
  entityText as txt,
  type Entity,
  type ManagementState,
} from '../workbench-api';
import {
  Badge,
  description,
  ErrorMessage,
  IconButton,
  status,
  statuses,
  time,
  title,
} from './shared';
import { ExecutionInspector } from './execution-inspector';

export function JobDetail({
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
  const executionError = txt(
    executions.find((item) => Boolean(item.error)) || {},
    'error',
  );
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
  const recoveryReason =
    status(job) === 'blocked' && txt(job, 'blockedReason') === 'child-failed'
      ? '子任务执行失败，先重试失败的执行实例；成功后系统会重新排队汇总。'
      : status(job) === 'budget-exceeded' || status(job) === 'budget_exceeded'
        ? '任务组已达到 Token 预算。请先修改预算，再创建新的执行实例。'
        : txt(job, 'error') ||
          executionError ||
          txt(job, 'blockedReason') ||
          '上一轮没有完成。恢复会创建新的隔离执行实例，并保留原实例的结果和证据。';
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
                .filter(
                  (provider) =>
                    provider.enabled !== false &&
                    provider.protocol !== 'typesafe-system-one',
                )
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
      {resumable && (
        <section
          className="delivery-summary"
          data-tone={
            status(job) === 'failed' || status(job) === 'state_unknown'
              ? 'error'
              : 'warning'
          }
        >
          <div className="delivery-summary-heading">
            <strong>恢复说明</strong>
            <Badge value={status(job)} />
          </div>
          <p>{recoveryReason}</p>
        </section>
      )}
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
              {Boolean(item.sourceTaskId) && (
                <small>恢复自执行实例 · {txt(item, 'sourceTaskId')}</small>
              )}
              {Boolean(item.error) && <small>{txt(item, 'error')}</small>}
            </div>
            <div className="execution-status-stack">
              <Badge value={status(item)} />
              {txt(item, 'deliveryStatus') &&
                txt(item, 'deliveryStatus') !== status(item) && (
                  <small>
                    交付 ·{' '}
                    {statuses[txt(item, 'deliveryStatus')] ||
                      txt(item, 'deliveryStatus')}
                  </small>
                )}
            </div>
            {['failed', 'interrupted', 'cancelled', 'state_unknown'].includes(
              status(item),
            ) && (
              <IconButton
                icon={RefreshCw}
                label="重试此执行实例"
                disabled={busy}
                onClick={() => void onAction(`tasks/${item.id}/retry`)}
              />
            )}
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

'use client';

import {
  Activity,
  Archive,
  Check,
  Download,
  FolderGit2,
  GitBranch,
  Pencil,
  Play,
  Power,
  RefreshCw,
  Search,
  Trash2,
  Undo2,
  LockKeyhole,
} from 'lucide-react';
import {
  api,
  entityList,
  entityText as txt,
  type Entity,
} from '../workbench-api';
import { IconButton, status, title } from './shared';

const canEdit = new Set([
  'providers',
  'resources',
  'schedules',
  'monitors',
  'workflows',
  'capabilities',
]);

type Props = {
  item: Entity;
  collection: string;
  busy: boolean;
  setBusy: (value: boolean) => void;
  setError: (value: string) => void;
  setNotice: (value: string) => void;
  setEditing: (value: { collection: string; item?: Entity } | null) => void;
  setRemoving: (value: { collection: string; item: Entity } | null) => void;
  setProbeItem: (value: Entity | null) => void;
  setProbeModel: (value: string) => void;
  setProbeTools: (value: boolean) => void;
  setProbeResult: (value: Record<string, unknown> | null) => void;
  setProbeCredentialItem: (value: Entity | null) => void;
  setProbeCredentialResult: (value: Record<string, unknown> | null) => void;
  setProbeTargetUrl: (value: string) => void;
  setRestoreResult: (value: Entity | null) => void;
  setRestoring: (value: Entity | null) => void;
  setAttentionTaskId: (value: string | null) => void;
  openPairingDialog: (name?: string) => void;
  openRelatedJob: (item: Entity) => Promise<void>;
  openDetail: (item: Entity) => Promise<void>;
  act: (path: string, body?: unknown, method?: string) => Promise<boolean>;
  refresh: () => Promise<void>;
  onChanged: () => Promise<void>;
};

export function ManagementRowActions({
  item,
  collection,
  busy,
  setBusy,
  setError,
  setNotice,
  setEditing,
  setRemoving,
  setProbeItem,
  setProbeModel,
  setProbeTools,
  setProbeResult,
  setProbeCredentialItem,
  setProbeCredentialResult,
  setProbeTargetUrl,
  setRestoreResult,
  setRestoring,
  setAttentionTaskId,
  openPairingDialog,
  openRelatedJob,
  openDetail,
  act,
  refresh,
  onChanged,
}: Props) {
  return (
    <div className="manage-actions">
      {collection === 'providers' && (
        <IconButton
          icon={RefreshCw}
          label={`同步 ${title(item)} 的模型列表`}
          disabled={busy || item.protocol === 'typesafe-system-one'}
          onClick={async () => {
            setBusy(true);
            setError('');
            try {
              const result = await api<{
                discovered?: number;
                previous?: number;
                removed?: string[];
              }>(`providers/${item.id}/sync-models`, 'POST');
              await refresh();
              await onChanged();
              setNotice(
                `已同步 ${result.discovered || 0} 个模型${result.removed?.length ? `，移除 ${result.removed.length} 个旧模型` : ''}`,
              );
            } catch (err) {
              setError((err as Error).message);
            } finally {
              setBusy(false);
            }
          }}
        />
      )}
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
      {collection === 'credentials' && (
        <IconButton
          icon={Activity}
          label={`测试 ${title(item)}`}
          disabled={busy}
          onClick={() => {
            setProbeCredentialItem(item);
            setProbeCredentialResult(null);
            setProbeTargetUrl('');
          }}
        />
      )}
      {collection === 'resources' && (
        <IconButton
          icon={Activity}
          label={`测试 ${title(item)}`}
          disabled={busy}
          onClick={async () => {
            setBusy(true);
            try {
              const res = await api<Record<string, unknown>>(
                `resources/${item.id}/probe`,
                'POST',
              );
              setNotice(
                typeof res.message === 'string'
                  ? res.message
                  : res.ok
                    ? '资源测试通过'
                    : '资源测试失败',
              );
            } catch (err) {
              setNotice(`测试失败: ${(err as Error).message}`);
            } finally {
              setBusy(false);
            }
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
      {collection === 'nodes' && status(item) === 'revoked' && (
        <IconButton
          icon={RefreshCw}
          label="重新配对节点"
          disabled={busy}
          onClick={() => openPairingDialog(`${title(item)}-repaired`)}
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
            onClick={() => {
              const risk =
                item.risk &&
                typeof item.risk === 'object' &&
                !Array.isArray(item.risk)
                  ? (item.risk as Entity)
                  : null;
              if (item.enabled === false && risk?.requiresReview === true) {
                void openDetail(item);
                return;
              }
              void act(
                `capabilities/${item.id}/${item.enabled === false ? 'enable' : 'disable'}`,
              );
            }}
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
        Boolean(item.jobId) &&
        !['resolved', 'dismissed'].includes(status(item)) && (
          <IconButton
            icon={GitBranch}
            label="打开关联任务组"
            disabled={busy}
            onClick={() => void openRelatedJob(item)}
          />
        )}
      {collection === 'attention' &&
        Boolean(item.taskId) &&
        !item.jobId &&
        !['resolved', 'dismissed'].includes(status(item)) && (
          <IconButton
            icon={FolderGit2}
            label="查看关联执行"
            disabled={busy}
            onClick={() => {
              setAttentionTaskId(txt(item, 'taskId'));
              void openDetail(item);
            }}
          />
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
      {collection === 'jobs' &&
        ['completed', 'failed', 'cancelled', 'interrupted'].includes(
          status(item),
        ) && (
          <IconButton
            icon={Archive}
            label={item.archived === true ? '恢复任务' : '归档任务'}
            disabled={busy}
            onClick={() =>
              void act(`jobs/${item.id}/archive`, {
                archived: item.archived !== true,
              })
            }
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
}

'use client';

import {
  api,
  entityList,
  entityText as txt,
  type Entity,
  type ManagementState,
} from '../workbench-api';
import {
  Copy,
  Download,
  Activity,
  LoaderCircle,
  Network,
  Trash2,
  Undo2,
  UnlockKeyhole,
  X,
} from 'lucide-react';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from '@/components/ui/dialog';
import { Badge, ErrorMessage, IconButton, time, title } from './shared';

type Removing = { collection: string; item: Entity } | null;
type Props = {
  data: ManagementState;
  busy: boolean;
  error: string;
  notice: string;
  removing: Removing;
  vaultDialog: boolean;
  passphrase: string;
  passphraseConfirm: string;
  pairDialog: boolean;
  pairName: string;
  pairResult: Entity | null;
  pairWorkspacePath: string;
  pairingCode: string;
  shellBootstrapCommand: string;
  powershellBootstrapCommand: string;
  importDialog: boolean;
  sourceUrl: string;
  importVersion: string;
  importSource: string;
  importItem: Entity | null;
  probeItem: Entity | null;
  probeModel: string;
  probeTools: boolean;
  probeResult: Record<string, unknown> | null;
  probeCredentialItem: Entity | null;
  probeCredentialResult: Record<string, unknown> | null;
  probeTargetUrl: string;
  restoring: Entity | null;
  restoreResult: Entity | null;
  setBusy: (value: boolean) => void;
  setError: (value: string) => void;
  setNotice: (value: string) => void;
  setRemoving: (value: Removing) => void;
  setVaultDialog: (value: boolean) => void;
  setPassphrase: (value: string) => void;
  setPassphraseConfirm: (value: string) => void;
  setPairDialog: (value: boolean) => void;
  setPairName: (value: string) => void;
  setPairResult: (value: Entity | null) => void;
  setPairWorkspacePath: (value: string) => void;
  setImportDialog: (value: boolean) => void;
  setSourceUrl: (value: string) => void;
  setImportVersion: (value: string) => void;
  setImportSource: (value: string) => void;
  setImportItem: (value: Entity | null) => void;
  setProbeItem: (value: Entity | null) => void;
  setProbeModel: (value: string) => void;
  setProbeTools: (value: boolean) => void;
  setProbeResult: (value: Record<string, unknown> | null) => void;
  setProbeCredentialItem: (value: Entity | null) => void;
  setProbeCredentialResult: (value: Record<string, unknown> | null) => void;
  setProbeTargetUrl: (value: string) => void;
  setRestoring: (value: Entity | null) => void;
  setRestoreResult: (value: Entity | null) => void;
  refresh: () => Promise<void>;
  copyText: (value: string, message: string) => Promise<void>;
};

export function ManagementSecondaryDialogs({
  data,
  busy,
  error,
  notice,
  removing,
  vaultDialog,
  passphrase,
  passphraseConfirm,
  pairDialog,
  pairName,
  pairResult,
  pairWorkspacePath,
  pairingCode,
  shellBootstrapCommand,
  powershellBootstrapCommand,
  importDialog,
  sourceUrl,
  importVersion,
  importSource,
  importItem,
  probeItem,
  probeModel,
  probeTools,
  probeResult,
  probeCredentialItem,
  probeCredentialResult,
  probeTargetUrl,
  restoring,
  restoreResult,
  setBusy,
  setError,
  setNotice,
  setRemoving,
  setVaultDialog,
  setPassphrase,
  setPassphraseConfirm,
  setPairDialog,
  setPairName,
  setPairResult,
  setPairWorkspacePath,
  setImportDialog,
  setSourceUrl,
  setImportVersion,
  setImportSource,
  setImportItem,
  setProbeItem,
  setProbeModel,
  setProbeTools,
  setProbeResult,
  setProbeCredentialItem,
  setProbeCredentialResult,
  setProbeTargetUrl,
  setRestoring,
  setRestoreResult,
  refresh,
  copyText,
}: Props) {
  return (
    <>
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
              <div className="manage-detail node-pairing-result">
                <div className="node-onboarding-step">
                  <strong>1. 保存配对码</strong>
                  <span>配对码只显示这一次，节点完成配对后立即失效。</span>
                </div>
                <code className="manage-pairing">{pairingCode}</code>
                {Boolean(pairResult.expiresAt) && (
                  <p>有效期至 {time(pairResult.expiresAt)}</p>
                )}
                <button
                  className="secondary-button"
                  type="button"
                  onClick={() => void copyText(pairingCode, '配对码已复制')}
                >
                  <Copy size={16} /> 复制配对码
                </button>
                <div className="node-onboarding-step">
                  <strong>2. 填写节点本机工作目录</strong>
                  <span>
                    这是执行节点上的绝对路径，控制端不会读取或验证它。
                  </span>
                </div>
                <label>
                  工作目录
                  <input
                    aria-label="节点本机工作目录"
                    value={pairWorkspacePath}
                    onChange={(event) =>
                      setPairWorkspacePath(event.target.value)
                    }
                    placeholder="例如 /srv/projects/my-app 或 C:\\Projects\\my-app"
                  />
                </label>
                <div className="node-onboarding-step">
                  <strong>3. 在节点终端运行启动命令</strong>
                  <span>先在节点安装当前版本依赖，再复制对应系统的命令。</span>
                </div>
                <div className="node-bootstrap-block">
                  <div className="node-bootstrap-heading">
                    <strong>macOS / Linux</strong>
                    <button
                      type="button"
                      className="text-button"
                      onClick={() =>
                        void copyText(
                          shellBootstrapCommand,
                          'macOS / Linux 启动命令已复制',
                        )
                      }
                    >
                      <Copy size={14} /> 复制命令
                    </button>
                  </div>
                  <pre aria-label="macOS Linux 节点启动命令">
                    {shellBootstrapCommand}
                  </pre>
                </div>
                <div className="node-bootstrap-block">
                  <div className="node-bootstrap-heading">
                    <strong>Windows PowerShell</strong>
                    <button
                      type="button"
                      className="text-button"
                      onClick={() =>
                        void copyText(
                          powershellBootstrapCommand,
                          'Windows 启动命令已复制',
                        )
                      }
                    >
                      <Copy size={14} /> 复制命令
                    </button>
                  </div>
                  <pre aria-label="Windows PowerShell 节点启动命令">
                    {powershellBootstrapCommand}
                  </pre>
                </div>
                <p className="field-help">
                  命令只包含控制端地址、临时配对码和工作目录，不包含节点长期
                  token。配对成功后可在下方列表确认在线状态。
                </p>
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
      {probeCredentialItem && (
        <Dialog
          open
          onOpenChange={(open) => {
            if (!open && !busy) {
              setProbeCredentialItem(null);
              setProbeCredentialResult(null);
            }
          }}
        >
          <DialogContent className="manage-dialog">
            <DialogTitle>测试凭据：{title(probeCredentialItem)}</DialogTitle>
            <DialogDescription className="sr-only">
              凭据可用性与连通测试
            </DialogDescription>
            <form
              className="manage-form"
              onSubmit={async (event) => {
                event.preventDefault();
                setBusy(true);
                setProbeCredentialResult(null);
                try {
                  const res = await api<Record<string, unknown>>(
                    `credentials/${probeCredentialItem.id}/probe`,
                    'POST',
                    { targetUrl: probeTargetUrl },
                  );
                  setProbeCredentialResult(res);
                } catch (err) {
                  setError((err as Error).message);
                } finally {
                  setBusy(false);
                }
              }}
            >
              <label>
                自定义探测地址（可选，留空则自动测试模型服务或格式校验）
                <input
                  type="url"
                  placeholder="https://api.openai.com/v1/models"
                  value={probeTargetUrl}
                  onChange={(e) => setProbeTargetUrl(e.target.value)}
                />
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
            {probeCredentialResult && (
              <div className="manage-detail">
                <h3>测试结果</h3>
                <pre>{JSON.stringify(probeCredentialResult, null, 2)}</pre>
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
    </>
  );
}

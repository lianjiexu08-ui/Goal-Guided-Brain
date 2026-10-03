'use client';

import { useCallback, useEffect, useState } from 'react';
import {
  Activity,
  Archive,
  Bell,
  ChevronLeft,
  ChevronRight,
  Clock3,
  Cpu,
  Download,
  ExternalLink,
  FolderGit2,
  GitBranch,
  Inbox,
  KeyRound,
  LoaderCircle,
  LockKeyhole,
  Mail,
  Network,
  Plug,
  Plus,
  RefreshCw,
  Search,
  Send,
  Server,
  UnlockKeyhole,
  type LucideIcon,
} from 'lucide-react';
import {
  api,
  entityList,
  entityText as txt,
  type Entity,
  type ManagementState,
} from '../workbench-api';
import { ModelMetricsPanel } from './model-metrics-panel';
import {
  Badge,
  Empty,
  ErrorMessage,
  IconButton,
  labels,
  status,
  statuses,
  title,
  description,
} from './shared';
import { ManagementDetailDialogs } from './management-detail-dialogs';
import { ManagementSecondaryDialogs } from './management-secondary-dialogs';
import { ManagementRowActions } from './management-row-actions';
import { RiskInbox } from '../workbench/team-overview';
import '../management.css';
import '../styles/model-metrics.css';

const managementNavigation = [
  { id: 'jobs', label: '协作任务' },
  { id: 'models', label: '模型管理' },
  { id: 'resources', label: '资源与凭据' },
  { id: 'nodes', label: '执行节点' },
  { id: 'capabilities', label: '能力中心' },
  { id: 'schedules', label: '定时与监控' },
  { id: 'attention', label: '需要你处理' },
  { id: 'backups', label: '备份与恢复' },
];

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

export function Management({
  view,
  onChanged,
  onOpenTeam,
  onOpenTask,
  onOpenKnowledge,
}: {
  view: string;
  onChanged: () => Promise<void>;
  onOpenTeam?: (teamId: string) => void;
  onOpenTask?: (taskId: string) => void;
  onOpenKnowledge?: (knowledgeId: string) => void;
}) {
  const [data, setData] = useState<ManagementState | null>(null);
  const [loadError, setLoadError] = useState('');
  const [credentials, setCredentials] = useState<Entity[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [showArchived, setShowArchived] = useState(false);
  const [jobTeamFilter, setJobTeamFilter] = useState('all');
  const [jobStatusFilter, setJobStatusFilter] = useState('all');
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
  const [attentionTaskId, setAttentionTaskId] = useState<string | null>(null);
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
  const [pairWorkspacePath, setPairWorkspacePath] = useState(
    '/absolute/path/to/project',
  );
  const [pairControlUrl, setPairControlUrl] = useState('');
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
  const [probeCredentialItem, setProbeCredentialItem] = useState<Entity | null>(
    null,
  );
  const [probeCredentialResult, setProbeCredentialResult] = useState<Record<
    string,
    unknown
  > | null>(null);
  const [probeTargetUrl, setProbeTargetUrl] = useState('');
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
  const copyText = async (value: string, message: string) => {
    try {
      await navigator.clipboard.writeText(value);
      setNotice(message);
    } catch {
      setError('无法访问剪贴板，请手动复制。');
    }
  };
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
  useEffect(() => {
    if (detail?.collection !== 'nodes') return;
    const id = detail.item.id;
    let cancelled = false;
    const poll = async () => {
      try {
        const item = await api<Entity>(`nodes/${id}`);
        if (!cancelled)
          setDetail({ collection: 'nodes', item: { ...item, id } });
      } catch (err) {
        if (!cancelled) setError((err as Error).message);
      }
    };
    const timer = setInterval(() => void poll(), 4000);
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
  const pairingCode = pairResult ? txt(pairResult, 'code') : '';
  const pairingControlUrl =
    pairControlUrl ||
    (typeof window !== 'undefined' ? window.location.origin : '');
  const pairingWorkspace =
    pairWorkspacePath.trim() || '/absolute/path/to/project';
  const shellQuote = (value: string) => `'${value.replaceAll("'", "'\"'\"'")}'`;
  const powershellQuote = (value: string) => `'${value.replaceAll("'", "''")}'`;
  const nodeName = pairName.trim() || 'my-node';
  const shellBootstrapCommand = pairingCode
    ? `ggb node --control-url ${shellQuote(pairingControlUrl)} --workspace ${shellQuote(`default=${pairingWorkspace}`)} --data-dir ~/.dsh-node --max-concurrent 3 --pair ${shellQuote(pairingCode)} --name ${shellQuote(nodeName)}`
    : '';
  const powershellBootstrapCommand = pairingCode
    ? `ggb node --control-url ${powershellQuote(pairingControlUrl)} --workspace ${powershellQuote(`default=${pairingWorkspace}`)} --data-dir "$HOME\\.dsh-node" --max-concurrent 3 --pair ${powershellQuote(pairingCode)} --name ${powershellQuote(nodeName)}`
    : '';
  const jobTeamOptions = data?.spaces || [];
  const jobStatusOptions = Array.from(
    new Set(items.map((item) => status(item)).filter(Boolean)),
  ).sort((a, b) => (statuses[a] || a).localeCompare(statuses[b] || b, 'zh-CN'));
  const visibleItems =
    collection === 'jobs'
      ? items
          .filter((item) => showArchived || item.archived !== true)
          .filter((item) => {
            if (jobTeamFilter === 'all') return true;
            const teamId = txt(item, 'teamId') || txt(item, 'spaceId');
            return jobTeamFilter === 'none'
              ? !teamId
              : teamId === jobTeamFilter;
          })
          .filter(
            (item) =>
              jobStatusFilter === 'all' || status(item) === jobStatusFilter,
          )
      : items;
  const filtered = visibleItems.filter((item) =>
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
      ['jobs', 'nodes', 'schedules', 'monitors', 'capabilities'].includes(
        collection,
      )
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
  const openPairingDialog = (name = '') => {
    setPairDialog(true);
    setPairName(name);
    setPairResult(null);
    setPairWorkspacePath('/absolute/path/to/project');
    setPairControlUrl(
      typeof window !== 'undefined' ? window.location.origin : '',
    );
  };
  const openRelatedJob = async (item: Entity) => {
    const jobId = txt(item, 'jobId');
    if (!jobId) return;
    setAttentionTaskId(null);
    setDetail({
      collection: 'jobs',
      item: {
        id: jobId,
        title: txt(item, 'jobTitle') || txt(item, 'taskTitle') || jobId,
      },
    });
    try {
      const full = await api<Entity>(`jobs/${jobId}`);
      setDetail({ collection: 'jobs', item: { ...full, id: jobId } });
    } catch (err) {
      setError((err as Error).message);
    }
  };
  return (
    <main className="manage-page">
      <div className="manage-heading">
        <div>
          <h1>{name}</h1>
          <p>
            {view === 'attention'
              ? '通知、待处理事项与团队风险'
              : collection === 'market'
                ? 'Skill · MCP · Plugin'
                : `${visibleItems.length} 条记录`}
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
              onClick={() => openPairingDialog()}
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
      {view === 'attention' && data && (
        <RiskInbox
          teams={(data.spaces || [])
            .filter(
              (space) =>
                space.status !== 'archived' &&
                space.recruitmentPhase === 'confirmed',
            )
            .map((space) => ({
              id: String(space.id),
              name: String(space.name || space.id),
            }))}
          onOpenTeam={onOpenTeam || (() => undefined)}
          onOpenTask={onOpenTask || (() => undefined)}
          onOpenKnowledge={onOpenKnowledge}
        />
      )}
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
      {view === 'models' && <ModelMetricsPanel labels={labels} />}
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
            {collection === 'jobs' && (
              <>
                <select
                  className="manage-job-filter"
                  aria-label="按团队筛选"
                  value={jobTeamFilter}
                  onChange={(event) => {
                    setJobTeamFilter(event.target.value);
                    setPage(0);
                  }}
                >
                  <option value="all">全部团队</option>
                  <option value="none">独立任务</option>
                  {jobTeamOptions.map((team) => (
                    <option key={team.id} value={team.id}>
                      {title(team)}
                    </option>
                  ))}
                </select>
                <select
                  className="manage-job-filter"
                  aria-label="按状态筛选"
                  value={jobStatusFilter}
                  onChange={(event) => {
                    setJobStatusFilter(event.target.value);
                    setPage(0);
                  }}
                >
                  <option value="all">全部状态</option>
                  {jobStatusOptions.map((value) => (
                    <option key={value} value={value}>
                      {statuses[value] || value}
                    </option>
                  ))}
                </select>
                <button
                  type="button"
                  className="secondary-button"
                  aria-pressed={showArchived}
                  onClick={() => {
                    setShowArchived((current) => !current);
                    setPage(0);
                  }}
                >
                  <Archive size={15} />
                  {showArchived ? '隐藏已归档' : '显示已归档'}
                </button>
              </>
            )}
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
                  <Badge
                    value={item.archived === true ? 'archived' : status(item)}
                  />
                  {
                    <ManagementRowActions
                      item={item}
                      collection={collection}
                      busy={busy}
                      setBusy={setBusy}
                      setError={setError}
                      setNotice={setNotice}
                      setEditing={setEditing}
                      setRemoving={setRemoving}
                      setProbeItem={setProbeItem}
                      setProbeModel={setProbeModel}
                      setProbeTools={setProbeTools}
                      setProbeResult={setProbeResult}
                      setProbeCredentialItem={setProbeCredentialItem}
                      setProbeCredentialResult={setProbeCredentialResult}
                      setProbeTargetUrl={setProbeTargetUrl}
                      setRestoreResult={setRestoreResult}
                      setRestoring={setRestoring}
                      setAttentionTaskId={setAttentionTaskId}
                      openPairingDialog={openPairingDialog}
                      openRelatedJob={openRelatedJob}
                      openDetail={openDetail}
                      act={act}
                      refresh={refresh}
                      onChanged={onChanged}
                    />
                  }
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
      <ManagementDetailDialogs
        editing={editing}
        detail={detail}
        data={data!}
        credentials={credentials}
        busy={busy}
        error={error}
        setEditing={setEditing}
        setDetail={setDetail}
        setNotice={setNotice}
        refresh={refresh}
        onChanged={onChanged}
        act={act}
        openDetail={openDetail}
        openPairingDialog={openPairingDialog}
        openRelatedJob={openRelatedJob}
        attentionTaskId={attentionTaskId}
        setAttentionTaskId={setAttentionTaskId}
      />
      <ManagementSecondaryDialogs
        data={data!}
        busy={busy}
        error={error}
        notice={notice}
        removing={removing}
        vaultDialog={vaultDialog}
        passphrase={passphrase}
        passphraseConfirm={passphraseConfirm}
        pairDialog={pairDialog}
        pairName={pairName}
        pairResult={pairResult}
        pairWorkspacePath={pairWorkspacePath}
        pairingCode={pairingCode}
        shellBootstrapCommand={shellBootstrapCommand}
        powershellBootstrapCommand={powershellBootstrapCommand}
        importDialog={importDialog}
        sourceUrl={sourceUrl}
        importVersion={importVersion}
        importSource={importSource}
        importItem={importItem}
        probeItem={probeItem}
        probeModel={probeModel}
        probeTools={probeTools}
        probeResult={probeResult}
        probeCredentialItem={probeCredentialItem}
        probeCredentialResult={probeCredentialResult}
        probeTargetUrl={probeTargetUrl}
        restoring={restoring}
        restoreResult={restoreResult}
        setBusy={setBusy}
        setError={setError}
        setNotice={setNotice}
        setRemoving={setRemoving}
        setVaultDialog={setVaultDialog}
        setPassphrase={setPassphrase}
        setPassphraseConfirm={setPassphraseConfirm}
        setPairDialog={setPairDialog}
        setPairName={setPairName}
        setPairResult={setPairResult}
        setPairWorkspacePath={setPairWorkspacePath}
        setImportDialog={setImportDialog}
        setSourceUrl={setSourceUrl}
        setImportVersion={setImportVersion}
        setImportSource={setImportSource}
        setImportItem={setImportItem}
        setProbeItem={setProbeItem}
        setProbeModel={setProbeModel}
        setProbeTools={setProbeTools}
        setProbeResult={setProbeResult}
        setProbeCredentialItem={setProbeCredentialItem}
        setProbeCredentialResult={setProbeCredentialResult}
        setProbeTargetUrl={setProbeTargetUrl}
        setRestoring={setRestoring}
        setRestoreResult={setRestoreResult}
        refresh={refresh}
        copyText={copyText}
      />
    </main>
  );
}

'use client';

import {
  BookOpen,
  FileText,
  CalendarClock,
  Pencil,
  Plus,
  Search,
  Trash2,
  X,
} from 'lucide-react';

export type KnowledgeRecord = {
  id: string;
  title: string;
  content: string;
  scope: string;
  state: string;
  source: string;
  updatedAt: string;
  version?: number;
  expiresAt?: string | null;
  expired?: boolean;
  expiresSoon?: boolean;
  projectPath: string;
  teamId?: string | null;
};

type KnowledgeRole = {
  id: string;
  name: string;
};

type KnowledgeTeam = {
  id: string;
  name: string;
};

type KnowledgeCollectionProps = {
  knowledge: KnowledgeRecord[];
  roles: KnowledgeRole[];
  workspace?: string;
  team?: KnowledgeTeam | null;
  search: string;
  filterScope: string;
  onSearchChange: (value: string) => void;
  onFilterScopeChange: (value: string) => void;
  onAdd: () => void;
  onOpen: (knowledge: KnowledgeRecord) => void;
  onRename: (knowledge: KnowledgeRecord) => void;
  onDelete: (knowledge: KnowledgeRecord) => void;
  formatTime: (value: string) => string;
};

export function KnowledgeCollection({
  knowledge,
  roles,
  workspace,
  team,
  search,
  filterScope,
  onSearchChange,
  onFilterScopeChange,
  onAdd,
  onOpen,
  onRename,
  onDelete,
  formatTime,
}: KnowledgeCollectionProps) {
  const scopedKnowledge = knowledge.filter(
    (item) =>
      item.scope === 'personal' ||
      (item.scope === 'team' && item.teamId === team?.id) ||
      (item.scope !== 'team' && item.projectPath === workspace),
  );
  const filteredKnowledge = scopedKnowledge
    .filter((item) => filterScope === 'all' || item.scope === filterScope)
    .filter((item) =>
      `${item.title} ${item.content}`
        .toLowerCase()
        .includes(search.toLowerCase()),
    );
  const expiryLabel = (item: KnowledgeRecord) => {
    if (item.expired) return '已过期 · 不会自动注入';
    if (item.expiresSoon && item.expiresAt)
      return `即将过期 · ${formatTime(item.expiresAt)}`;
    return item.expiresAt ? `复核至 ${formatTime(item.expiresAt)}` : '长期有效';
  };

  return (
    <main className="collection-page">
      <div className="page-heading">
        <div>
          <span className="section-kicker">SHARED KNOWLEDGE</span>
          <h1>每次工作，都有积累。</h1>
          <p>个人偏好、项目背景与角色经验，在本地长期保存。</p>
        </div>
        <button className="primary-button" onClick={onAdd}>
          <Plus size={16} />
          添加知识
        </button>
      </div>
      <div className="knowledge-toolbar">
        <div className="search-field">
          <Search size={18} />
          <input
            placeholder="搜索知识标题或内容…"
            aria-label="搜索知识"
            value={search}
            onChange={(event) => onSearchChange(event.target.value)}
          />
          {search && (
            <button
              type="button"
              className="clear-search-btn"
              onClick={() => onSearchChange('')}
              title="清空搜索"
            >
              <X size={14} />
            </button>
          )}
        </div>
        <div className="knowledge-filter-tags">
          {[
            { id: 'all', label: '全部' },
            { id: 'project', label: '项目共享' },
            { id: 'personal', label: '个人知识' },
            ...(team ? [{ id: 'team', label: `${team.name} · 团队知识` }] : []),
            ...roles.map((role) => ({ id: role.id, label: role.name })),
          ].map((tag) => (
            <button
              key={tag.id}
              type="button"
              className={`filter-pill ${filterScope === tag.id ? 'active' : ''}`}
              onClick={() => onFilterScopeChange(tag.id)}
            >
              {tag.label}
            </button>
          ))}
        </div>
      </div>
      {!scopedKnowledge.length ? (
        <div className="collection-empty">
          <BookOpen size={34} />
          <h2>给助手一份共同的背景</h2>
          <p>从项目介绍、开发约定，或你的工作偏好开始。</p>
          <button className="secondary-button" onClick={onAdd}>
            添加第一份知识
          </button>
        </div>
      ) : !filteredKnowledge.length ? (
        <div className="collection-empty compact">
          <Search size={28} />
          <h2>未找到匹配的知识</h2>
          <p>尝试更换搜索关键词或重置分类筛选。</p>
          <button
            className="secondary-button"
            onClick={() => {
              onSearchChange('');
              onFilterScopeChange('all');
            }}
          >
            重置筛选条件
          </button>
        </div>
      ) : (
        <div className="knowledge-grid">
          {filteredKnowledge.map((item) => (
            <div className="knowledge-card-wrapper" key={item.id}>
              <button
                type="button"
                className="knowledge-card-clickable"
                onClick={() => onOpen(item)}
              >
                <div className="knowledge-card-header">
                  <div className="knowledge-card-meta">
                    <FileText size={18} />
                    <span className="quiet-badge">
                      {item.scope === 'personal'
                        ? '个人知识'
                        : item.scope === 'project'
                          ? '项目共享'
                          : item.scope === 'team'
                            ? '团队共享'
                            : roles.find((role) => role.id === item.scope)
                                ?.name}
                    </span>
                  </div>
                </div>
                <h3>{item.title}</h3>
                <p>{item.content}</p>
                <footer>
                  <span
                    className={item.state === 'confirmed' ? 'confirmed' : ''}
                  >
                    {item.state === 'confirmed' ? '已确认' : '待确认草稿'}
                  </span>
                  <span
                    className={
                      item.expired
                        ? 'knowledge-expired'
                        : item.expiresSoon
                          ? 'knowledge-expiring'
                          : ''
                    }
                  >
                    <CalendarClock size={12} /> {expiryLabel(item)}
                  </span>
                  <span>
                    v{item.version || 1} · {formatTime(item.updatedAt)}
                  </span>
                </footer>
              </button>
              <div className="knowledge-card-actions">
                <button
                  type="button"
                  className="card-action-btn"
                  title="快速重命名"
                  onClick={() => onRename(item)}
                >
                  <Pencil size={13} />
                </button>
                <button
                  type="button"
                  className="card-action-btn danger"
                  title="删除知识"
                  onClick={() => onDelete(item)}
                >
                  <Trash2 size={13} />
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
    </main>
  );
}

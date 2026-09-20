'use client';

import { useEffect, useState } from 'react';
import {
  BookOpen,
  ArrowDown,
  ArrowUp,
  Check,
  Code2,
  Copy,
  Lightbulb,
  LoaderCircle,
  Plus,
  Save,
  Search,
  Sparkles,
  Workflow,
  X,
} from 'lucide-react';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from '@/components/ui/dialog';
import { COLORS } from '@/server/roles.mjs';
import { api, type ManagementState } from './workbench-api';

export type Assistant = {
  id: string;
  name: string;
  desc: string;
  greeting: string;
  icon: string;
  color: string;
  instructions: string;
  model: string;
  workflow: string;
  prompts: string[];
  skillIds: string[];
  tools: { files: boolean; web: boolean; terminal: boolean };
  archived: boolean;
  providerIds?: string[];
  requiresVision?: boolean;
  requiredContextWindow?: number;
  capabilityIds?: string[];
  nodeId?: string;
  workspaceMode?: 'shared' | 'isolated';
};
export const assistantIcons = {
  lightbulb: Lightbulb,
  code: Code2,
  sparkles: Sparkles,
  book: BookOpen,
  search: Search,
  workflow: Workflow,
};
export const blankAssistant: Assistant = {
  id: '',
  name: '',
  desc: '',
  greeting: '',
  icon: 'sparkles',
  color: '#278977',
  instructions: '',
  model: '',
  workflow: '',
  prompts: [],
  skillIds: [],
  tools: { files: true, web: true, terminal: false },
  archived: false,
  providerIds: [],
  requiresVision: false,
  requiredContextWindow: 1,
  capabilityIds: [],
  nodeId: '',
  workspaceMode: 'isolated',
};
const iconNames = ['灵感', '代码', '智能', '知识', '检索', '流程'];
const colorNames = ['金色', '蓝色', '绿色', '玫红', '灰色', '红色'];

export function AssistantEditor({
  initial,
  templates,
  skills,
  onSave,
  onClose,
}: {
  initial: Assistant;
  templates: Assistant[];
  skills: { id: string; name: string }[];
  onSave: (role: Assistant) => Promise<void>;
  onClose: () => void;
}) {
  const [form, setForm] = useState<Assistant>(() => structuredClone(initial));
  const [section, setSection] = useState('identity');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [bindings, setBindings] = useState<ManagementState | null>(null);
  const [bindingError, setBindingError] = useState('');
  useEffect(() => {
    let cancelled = false;
    void api<ManagementState>('manage')
      .then((value) => {
        if (!cancelled) setBindings(value);
      })
      .catch((err) => {
        if (!cancelled) setBindingError((err as Error).message);
      });
    return () => {
      cancelled = true;
    };
  }, []);
  const Icon =
    assistantIcons[form.icon as keyof typeof assistantIcons] || Sparkles;
  const field = (key: keyof Assistant, value: unknown) => {
    setError('');
    setForm((f) => ({ ...f, [key]: value }));
  };
  return (
    <Dialog open onOpenChange={(open) => !open && !busy && onClose()}>
      <DialogContent
        className="work-dialog assistant-editor"
        showCloseButton={!busy}
      >
        <DialogTitle>{initial.id ? '编辑助手' : '新建助手'}</DialogTitle>
        <DialogDescription className="sr-only">助手配置</DialogDescription>
        <div className="assistant-preview">
          <span
            className="assistant-avatar"
            style={{ color: form.color, background: `${form.color}14` }}
          >
            <Icon size={24} />
          </span>
          <div>
            <strong>{form.name || '新助手'}</strong>
            <p>{form.desc || '自定义助手'}</p>
          </div>
          {form.id && (
            <button
              type="button"
              className="icon-button"
              title={`复制通信 ID：${form.id}`}
              aria-label="复制助手通信 ID"
              onClick={async () => {
                try {
                  await navigator.clipboard.writeText(form.id);
                } catch {
                  setError('无法访问剪贴板');
                }
              }}
            >
              <Copy size={16} />
            </button>
          )}
        </div>
        {!initial.id && (
          <label className="template-picker">
            起始配置
            <select
              aria-label="起始配置"
              defaultValue=""
              onChange={(e) => {
                const template = templates.find((r) => r.id === e.target.value);
                setForm(
                  template
                    ? {
                        ...structuredClone(template),
                        id: '',
                        name: `${template.name}副本`,
                        archived: false,
                      }
                    : structuredClone(blankAssistant),
                );
              }}
            >
              <option value="">空白助手</option>
              {templates.map((r) => (
                <option key={r.id} value={r.id}>
                  {r.name}
                </option>
              ))}
            </select>
          </label>
        )}
        <div className="editor-tabs" role="tablist" aria-label="助手配置分类">
          {[
            ['identity', '基本信息'],
            ['instructions', '工作规范'],
            ['tools', '工具与 Skills'],
          ].map(([id, name]) => (
            <button
              key={id}
              type="button"
              role="tab"
              id={`editor-tab-${id}`}
              aria-controls="editor-panel"
              aria-selected={section === id}
              tabIndex={section === id ? 0 : -1}
              onKeyDown={(event) => {
                const ids = ['identity', 'instructions', 'tools'];
                const index = ids.indexOf(id);
                const next =
                  event.key === 'ArrowRight'
                    ? (index + 1) % 3
                    : event.key === 'ArrowLeft'
                      ? (index + 2) % 3
                      : event.key === 'Home'
                        ? 0
                        : event.key === 'End'
                          ? 2
                          : -1;
                if (next < 0) return;
                event.preventDefault();
                setSection(ids[next]);
                document.getElementById(`editor-tab-${ids[next]}`)?.focus();
              }}
              onClick={() => setSection(id)}
            >
              {name}
            </button>
          ))}
        </div>
        <form
          noValidate
          onSubmit={async (e) => {
            e.preventDefault();
            if (!form.name.trim() || !form.instructions.trim()) {
              setError(
                !form.name.trim() ? '请填写助手名称。' : '请填写工作规范。',
              );
              setSection(!form.name.trim() ? 'identity' : 'instructions');
              return;
            }
            setError('');
            setBusy(true);
            try {
              await onSave({
                ...form,
                prompts: form.prompts.filter((p) => p.trim()),
              });
            } catch (err) {
              setError((err as Error).message);
            } finally {
              setBusy(false);
            }
          }}
        >
          <fieldset
            disabled={busy}
            className="editor-fields"
            id="editor-panel"
            role="tabpanel"
            aria-labelledby={`editor-tab-${section}`}
          >
            {section === 'identity' && (
              <>
                <label>
                  助手名称
                  <input
                    aria-label="助手名称"
                    maxLength={40}
                    value={form.name}
                    onChange={(e) => field('name', e.target.value)}
                  />
                </label>
                <label>
                  简介
                  <input
                    maxLength={240}
                    value={form.desc}
                    onChange={(e) => field('desc', e.target.value)}
                  />
                </label>
                <div className="identity-pickers">
                  <fieldset>
                    <legend>图标</legend>
                    <div className="icon-picker">
                      {Object.entries(assistantIcons).map(
                        ([id, ItemIcon], i) => (
                          <button
                            key={id}
                            type="button"
                            className="icon-button"
                            title={iconNames[i]}
                            aria-label={iconNames[i]}
                            aria-pressed={form.icon === id}
                            onClick={() => field('icon', id)}
                          >
                            <ItemIcon size={18} />
                          </button>
                        ),
                      )}
                    </div>
                  </fieldset>
                  <fieldset>
                    <legend>颜色</legend>
                    <div className="color-picker">
                      {COLORS.map((color, i) => (
                        <button
                          key={color}
                          type="button"
                          style={{ background: color }}
                          title={colorNames[i]}
                          aria-label={colorNames[i]}
                          aria-pressed={form.color === color}
                          onClick={() => field('color', color)}
                        >
                          {form.color === color && <Check size={16} />}
                        </button>
                      ))}
                    </div>
                  </fieldset>
                </div>
                <label>
                  欢迎语
                  <input
                    maxLength={120}
                    value={form.greeting}
                    onChange={(e) => field('greeting', e.target.value)}
                  />
                </label>
                <fieldset className="prompt-editor">
                  <legend>快捷任务</legend>
                  {form.prompts.map((prompt, i) => (
                    <div key={i}>
                      <input
                        aria-label={`快捷任务 ${i + 1}`}
                        maxLength={500}
                        value={prompt}
                        onChange={(e) =>
                          field(
                            'prompts',
                            form.prompts.map((p, at) =>
                              at === i ? e.target.value : p,
                            ),
                          )
                        }
                      />
                      <button
                        type="button"
                        className="icon-button"
                        title="移除快捷任务"
                        aria-label={`移除快捷任务 ${i + 1}`}
                        onClick={() =>
                          field(
                            'prompts',
                            form.prompts.filter((_, at) => at !== i),
                          )
                        }
                      >
                        <X size={16} />
                      </button>
                    </div>
                  ))}
                  <button
                    type="button"
                    className="text-button"
                    disabled={form.prompts.length >= 6}
                    onClick={() => field('prompts', [...form.prompts, ''])}
                  >
                    <Plus size={15} />
                    添加快捷任务
                  </button>
                </fieldset>
              </>
            )}
            {section === 'instructions' && (
              <>
                <label>
                  工作规范
                  <textarea
                    aria-label="工作规范"
                    rows={11}
                    maxLength={12000}
                    value={form.instructions}
                    onChange={(e) => field('instructions', e.target.value)}
                  />
                </label>
                <label>
                  模型
                  <input
                    aria-label="助手模型"
                    placeholder="跟随工作空间"
                    maxLength={120}
                    value={form.model}
                    onChange={(e) => field('model', e.target.value)}
                  />
                </label>
                <fieldset>
                  <legend>模型能力要求</legend>
                  <label>
                    <input
                      type="checkbox"
                      checked={Boolean(form.requiresVision)}
                      onChange={(event) =>
                        field('requiresVision', event.target.checked)
                      }
                    />
                    需要视觉能力
                  </label>
                  <label>
                    最低上下文长度
                    <input
                      type="number"
                      min={1}
                      max={10000000}
                      step={1}
                      required
                      value={form.requiredContextWindow ?? 1}
                      onChange={(event) =>
                        field(
                          'requiredContextWindow',
                          Number(event.target.value),
                        )
                      }
                    />
                  </label>
                </fieldset>
                <fieldset className="tool-options">
                  <legend>供应商路由</legend>
                  {(bindings?.providers || []).map((provider) => (
                    <label key={provider.id}>
                      <input
                        type="checkbox"
                        checked={(form.providerIds || []).includes(provider.id)}
                        onChange={(event) =>
                          field(
                            'providerIds',
                            event.target.checked
                              ? [...(form.providerIds || []), provider.id]
                              : (form.providerIds || []).filter(
                                  (id) => id !== provider.id,
                                ),
                          )
                        }
                      />
                      <span>
                        {provider.name || provider.id}
                        {provider.enabled === false ? '（已停用）' : ''}
                      </span>
                    </label>
                  ))}
                  {bindings && !bindings.providers.length && (
                    <span className="manage-muted">暂无供应商配置</span>
                  )}
                </fieldset>
                {(form.providerIds || []).length > 1 && (
                  <fieldset>
                    <legend>路由顺序</legend>
                    {(form.providerIds || []).map((id, index, ids) => (
                      <div className="manage-row" key={id}>
                        <div className="manage-main">
                          <strong>
                            {index + 1}.{' '}
                            {bindings?.providers.find(
                              (provider) => provider.id === id,
                            )?.name || id}
                          </strong>
                        </div>
                        {([-1, 1] as const).map((offset) => (
                          <button
                            type="button"
                            className="icon-button"
                            key={offset}
                            title={offset < 0 ? '提高优先级' : '降低优先级'}
                            aria-label={`${offset < 0 ? '提高' : '降低'}路由 ${index + 1} 优先级`}
                            disabled={
                              index + offset < 0 || index + offset >= ids.length
                            }
                            onClick={() => {
                              const next = [...ids];
                              [next[index], next[index + offset]] = [
                                next[index + offset],
                                next[index],
                              ];
                              field('providerIds', next);
                            }}
                          >
                            {offset < 0 ? (
                              <ArrowUp size={16} />
                            ) : (
                              <ArrowDown size={16} />
                            )}
                          </button>
                        ))}
                      </div>
                    ))}
                  </fieldset>
                )}
                <div className="manage-columns">
                  <label>
                    执行节点
                    <select
                      value={form.nodeId || ''}
                      onChange={(event) => field('nodeId', event.target.value)}
                    >
                      <option value="">控制端本地</option>
                      {(bindings?.nodes || []).map((node) => (
                        <option key={node.id} value={node.id}>
                          {node.name || node.id}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label>
                    工作目录模式
                    <select
                      value={form.workspaceMode || 'shared'}
                      onChange={(event) =>
                        field('workspaceMode', event.target.value)
                      }
                    >
                      <option value="isolated">独立 worktree / 快照</option>
                      <option value="shared">使用指定目录</option>
                    </select>
                  </label>
                </div>
              </>
            )}
            {section === 'tools' && (
              <>
                <fieldset className="tool-options">
                  <legend>工具</legend>
                  {(
                    [
                      ['files', '文件读写与搜索'],
                      ['web', '网页搜索与读取'],
                      ['terminal', '终端命令（工作目录沙箱）'],
                    ] as const
                  ).map(([key, name]) => (
                    <label key={key}>
                      <input
                        type="checkbox"
                        checked={form.tools[key]}
                        onChange={(e) =>
                          field('tools', {
                            ...form.tools,
                            [key]: e.target.checked,
                          })
                        }
                      />
                      <span>{name}</span>
                    </label>
                  ))}
                </fieldset>
                <fieldset className="tool-options">
                  <legend>Skills</legend>
                  {skills.map((skill) => (
                    <label key={skill.id}>
                      <input
                        type="checkbox"
                        checked={form.skillIds.includes(skill.id)}
                        onChange={(e) =>
                          field(
                            'skillIds',
                            e.target.checked
                              ? [...form.skillIds, skill.id]
                              : form.skillIds.filter((id) => id !== skill.id),
                          )
                        }
                      />
                      <span>{skill.name}</span>
                    </label>
                  ))}
                </fieldset>
                <label>
                  自定义 Skill
                  <textarea
                    aria-label="自定义 Skill"
                    rows={7}
                    maxLength={20000}
                    value={form.workflow}
                    onChange={(e) => field('workflow', e.target.value)}
                  />
                </label>
                <fieldset className="tool-options">
                  <legend>已安装能力与 MCP</legend>
                  {(bindings?.capabilities || []).map((capability) => (
                    <label key={capability.id}>
                      <input
                        type="checkbox"
                        checked={(form.capabilityIds || []).includes(
                          capability.id,
                        )}
                        onChange={(event) =>
                          field(
                            'capabilityIds',
                            event.target.checked
                              ? [...(form.capabilityIds || []), capability.id]
                              : (form.capabilityIds || []).filter(
                                  (id) => id !== capability.id,
                                ),
                          )
                        }
                      />
                      <span>
                        {capability.name || capability.id}
                        {capability.enabled === false ? '（已停用）' : ''}
                      </span>
                    </label>
                  ))}
                  {bindings && !bindings.capabilities.length && (
                    <span className="manage-muted">暂无已安装能力</span>
                  )}
                </fieldset>
              </>
            )}
          </fieldset>
          {error && (
            <p className="editor-error" role="alert">
              {error}
            </p>
          )}
          {bindingError && (
            <p className="editor-error" role="alert">
              能力配置载入失败：{bindingError}
            </p>
          )}
          <div className="editor-footer">
            <button
              type="button"
              disabled={busy}
              className="secondary-button"
              onClick={onClose}
            >
              取消
            </button>
            <button className="primary-button" type="submit" disabled={busy}>
              {busy ? (
                <LoaderCircle size={16} className="spin" />
              ) : (
                <Save size={16} />
              )}
              {initial.id ? '保存助手' : '创建助手'}
            </button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}

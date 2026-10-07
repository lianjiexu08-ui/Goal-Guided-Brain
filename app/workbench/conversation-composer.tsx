/* oxlint-disable */
// @ts-nocheck
'use client';
import { ArrowUp, FolderOpen, LoaderCircle, Paperclip } from 'lucide-react';
import { modelDisplayName, formatBytes } from './model';
import type { WorkbenchContext } from './view-context';

export function ConversationComposer({
  context,
}: {
  context: WorkbenchContext;
}) {
  const {
    composerRef,
    assistantName,
    isRecruitmentView,
    drafts,
    draftKey,
    markDraftDirty,
    setDrafts,
    setDraftAttachments,
    setDraggingFiles,
    setDraftConflict,
    clipboardFiles,
    uploadAttachments,
    busy,
    submit,
    attachmentInputRef,
    draggingFiles,
    isMobile,
    draftAttachments,
    attachmentDraftKey,
    conversationWorkspace,
    openSettings,
    openTeamSettings,
    isTeamMember,
    selectedModelOption,
    modelOptions,
    changeTeamModel,
    data,
    draftConflict,
    resolveDraftConflict,
    draftSyncState,
    assistant,
  } = context;
  return (
    <div className="composer-area">
      <div
        className="composer"
        onDragEnter={(event) => {
          event.preventDefault();
          setDraggingFiles(true);
        }}
        onDragOver={(event) => event.preventDefault()}
        onDragLeave={(event) => {
          event.preventDefault();
          if (!event.currentTarget.contains(event.relatedTarget as Node | null))
            setDraggingFiles(false);
        }}
        onDrop={(event) => {
          event.preventDefault();
          setDraggingFiles(false);
          void uploadAttachments(Array.from(event.dataTransfer.files));
        }}
      >
        <textarea
          ref={composerRef}
          aria-label={`发送给${assistantName}`}
          enterKeyHint="send"
          inputMode="text"
          autoCapitalize="sentences"
          spellCheck
          placeholder={
            isRecruitmentView
              ? '描述你想完成的事，先不用决定要几个智能体…'
              : `告诉${assistantName}，你想完成什么…`
          }
          value={drafts[draftKey] || ''}
          disabled={!assistant.id || assistant.archived}
          onChange={(e) => {
            markDraftDirty(draftKey);
            setDrafts((d) => ({ ...d, [draftKey]: e.target.value }));
            setDraftConflict((current) =>
              current?.key === draftKey
                ? { ...current, localContent: e.target.value }
                : current,
            );
          }}
          onPaste={(event) => {
            const files = clipboardFiles(event);
            if (!files.length) return;
            event.preventDefault();
            void uploadAttachments(files);
          }}
          onKeyDown={(e) => {
            if (
              e.key === 'Enter' &&
              !e.shiftKey &&
              !e.nativeEvent.isComposing
            ) {
              e.preventDefault();
              if (!busy) void submit();
            }
          }}
        />
        <input
          ref={attachmentInputRef}
          className="attachment-picker"
          type="file"
          multiple
          aria-label="选择要添加的文件"
          onChange={(event) => {
            const files = Array.from(event.target.files || []);
            event.target.value = '';
            if (files.length) void uploadAttachments(files);
          }}
        />
        <div
          className={`composer-attachments${draggingFiles ? ' is-dragging' : ''}`}
        >
          {draggingFiles ? (
            <span>松开即可添加文件</span>
          ) : (
            <span>
              <Paperclip size={13} />
              {isMobile
                ? '选择或粘贴图片、文件，发送时会携带文件内容'
                : '拖入或粘贴图片、文件，发送时会携带文件内容'}
            </span>
          )}
          {!!draftAttachments[attachmentDraftKey]?.length && (
            <div className="attachment-list draft-attachments">
              {draftAttachments[attachmentDraftKey].map((attachment) => (
                <button
                  type="button"
                  className="attachment-chip"
                  key={attachment.id}
                  title="移除附件"
                  onClick={() => {
                    markDraftDirty(attachmentDraftKey);
                    setDraftAttachments((current) => ({
                      ...current,
                      [attachmentDraftKey]: current[attachmentDraftKey].filter(
                        (item) => item.id !== attachment.id,
                      ),
                    }));
                    setDraftConflict((current) =>
                      current?.key === attachmentDraftKey
                        ? {
                            ...current,
                            localAttachments: current.localAttachments.filter(
                              (item) => item.id !== attachment.id,
                            ),
                          }
                        : current,
                    );
                  }}
                >
                  <Paperclip size={13} />
                  {attachment.name}
                  <small>{formatBytes(attachment.size)} · 点击移除</small>
                </button>
              ))}
            </div>
          )}
        </div>
        <div className="composer-bottom">
          <button
            type="button"
            className="mobile-attachment-button secondary-button"
            aria-label="添加附件"
            onClick={() => attachmentInputRef.current?.click()}
            disabled={busy || !assistant.id || assistant.archived}
          >
            <Paperclip size={15} />
            添加文件
          </button>
          <button
            className="workspace-path"
            title={`工作目录：${conversationWorkspace || '未设置'}${isTeamMember ? '；点击查看团队设置，历史成员会话保留原目录' : ''}`}
            onClick={isTeamMember ? openTeamSettings : openSettings}
          >
            <FolderOpen size={15} />
            <span>
              {conversationWorkspace?.split('/').filter(Boolean).pop() ||
                '选择工作目录'}
            </span>
          </button>
          <div className="composer-controls">
            {selectedModelOption ? (
              <label
                className="model-switcher"
                title={
                  isTeamMember
                    ? '切换当前团队成员使用的模型'
                    : '仅切换本次独立对话使用的模型'
                }
              >
                <span className="sr-only">选择模型</span>
                <select
                  aria-label="选择模型"
                  title={`${selectedModelOption.providerName} · ${modelDisplayName(selectedModelOption.model)}`}
                  value={selectedModelOption.key}
                  disabled={busy}
                  onChange={(event) => void changeTeamModel(event.target.value)}
                >
                  {modelOptions.map((option) => (
                    <option key={option.key} value={option.key}>
                      {option.providerName} · {modelDisplayName(option.model)}
                      {!option.model.tools ? ' · 纯文本' : ''}
                      {option.providerHealth?.ok === false
                        ? ' · 最近检查失败'
                        : ''}
                      {option.providerHealth?.ok === true
                        ? ' · 最近检查通过'
                        : ''}
                    </option>
                  ))}
                </select>
                <small
                  className="model-id"
                  title={`实际请求模型 ID：${selectedModelOption.model.id}`}
                >
                  ID: {selectedModelOption.model.id}
                </small>
                {!selectedModelOption.model.tools && <small>纯文本模式</small>}
              </label>
            ) : (
              <span className="model-label">尚未配置模型</span>
            )}
            <button
              className="send-button"
              aria-label="发送任务"
              disabled={
                busy ||
                (!drafts[draftKey]?.trim() &&
                  !draftAttachments[attachmentDraftKey]?.length) ||
                !data ||
                !assistant.id ||
                assistant.archived
              }
              onClick={submit}
            >
              {busy ? (
                <LoaderCircle size={18} className="spin" />
              ) : (
                <ArrowUp size={20} />
              )}
            </button>
          </div>
        </div>
        {selectedModelOption?.providerHealth?.ok === false && (
          <details className="composer-model-status model-health-warning">
            <summary>最近一次连通性检查失败 · 查看详情</summary>
            <p>
              最近一次连通性检查失败
              {selectedModelOption.providerHealth.error
                ? `：${selectedModelOption.providerHealth.error}`
                : ''}
              ，发送时仍会按当前选择尝试并在可恢复错误时自动切换。
            </p>
          </details>
        )}
        {selectedModelOption?.providerHealth?.ok === true && (
          <p className="composer-model-status model-health-ok">
            最近一次连通性检查通过 ·{' '}
            {selectedModelOption.providerHealth.latencyMs || 0} ms
          </p>
        )}
      </div>
      {draftConflict?.key === draftKey && (
        <div className="draft-conflict-panel" role="alert">
          <div className="draft-conflict-copy">
            <span>检测到其他设备同时修改了这份草稿，请选择要保留的版本。</span>
            <div className="draft-conflict-versions">
              <span>
                <strong>本机版本：</strong>
                {draftConflict.localContent || '（空）'}
              </span>
              <span>
                <strong>远端版本：</strong>
                {draftConflict.remoteContent || '（空）'}
              </span>
            </div>
          </div>
          <div className="draft-conflict-actions">
            <button type="button" onClick={() => resolveDraftConflict('local')}>
              保留本机并覆盖远端
            </button>
            <button
              type="button"
              onClick={() => resolveDraftConflict('remote')}
            >
              使用其他设备版本
            </button>
          </div>
        </div>
      )}
      <p className="composer-hint">
        <span className="composer-keyboard-hint">
          Enter 发送 · Shift + Enter 换行
        </span>
        <span>
          {isRecruitmentView ? '先澄清需求，再确认团队方案' : '任务在后台执行'}
        </span>
        <span className={`draft-sync-status ${draftSyncState}`}>
          {draftSyncState === 'saving'
            ? '草稿同步中…'
            : draftSyncState === 'conflict'
              ? '草稿存在并行修改，请选择版本'
              : draftSyncState === 'offline'
                ? '服务暂不可用，已保存在本机'
                : draftSyncState === 'saved'
                  ? '草稿已同步'
                  : ''}
        </span>
      </p>
    </div>
  );
}

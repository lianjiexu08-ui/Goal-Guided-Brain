/* oxlint-disable */
// @ts-nocheck
'use client';
import { api } from '../workbench-api';
import { MAX_ATTACHMENTS, type Attachment } from '../drafts/model';
import { MAX_ATTACHMENT_BYTES } from './model';
import type {
  Knowledge,
  Task,
  TeamForm,
  TeamMessage,
  TeamRecruitment,
  TeamSpace,
} from './model';

export function createWorkbenchActions(deps: Record<string, any>) {
  const {
    setBusy,
    refresh,
    setNotice,
    setSelectedReviewTaskIds,
    selectedReviewTaskIds,
    reviewTasks,
    batchReviewNote,
    setBatchReviewNote,
    setBatchReviewBusy,
    draftAttachments,
    attachmentDraftKey,
    isTeamMember,
    isTeamConversation,
    teamSpace,
    setDraftAttachments,
    setDraftConflict,
    markDraftDirty,
    drafts,
    draftKey,
    getDraftVersionRef,
    assistant,
    role,
    selectedModelOption,
    setSelected,
    sessionSelectionKey,
    clearServerDraft,
    currentSession,
    modelOptions,
    setModelOverrides,
    modelOverrideKey,
    assistantName,
    recruitmentApprovals,
    setSelectedSpaceId,
    setRole,
    setView,
    isMobile,
    setOpenMobile,
    data,
    setSettingsForm,
    setProfileForm,
    profileForm,
    setModal,
    setMobileTeamQuery,
    setKnowledgeHistory,
    setDeletingKnowledge,
    setKnowledgeForm,
    isConversationView,
    conversationWorkspace,
    setHandoffTask,
    setHandoffRole,
    setHandoffNote,
    setTeamRenameForm,
    activeRoles,
    setEditingTeamId,
    setTeamForm,
    setTeamTemplateId,
    setTeamTemplateForm,
    teamTemplates,
    recruitmentSpace,
    setDrafts,
    confirmedSpaces,
    selectedSpaceId,
    tasks,
    setTaskDetail,
    setTimelineFilter,
    timelineLoading,
    setTimelineLoading,
    teamTimeline,
    setTimelineHistory,
    setTimelineHasMore,
    setEditingAssistant,
  } = deps;
  async function action(fn: () => Promise<void>) {
    setBusy(true);
    try {
      await fn();
      await refresh();
    } catch (error) {
      setNotice((error as Error).message);
    } finally {
      setBusy(false);
    }
  }
  function toggleReviewTask(taskId: string) {
    setSelectedReviewTaskIds((current) =>
      current.includes(taskId)
        ? current.filter((id) => id !== taskId)
        : [...current, taskId],
    );
  }
  function toggleAllReviewTasks() {
    setSelectedReviewTaskIds((current) => {
      const ids = reviewTasks.map((task) => task.id);
      return ids.length > 0 && ids.every((id) => current.includes(id))
        ? []
        : ids;
    });
  }
  async function batchReview(decision: 'accept' | 'reject') {
    const selectedIds = selectedReviewTaskIds.filter((id) =>
      reviewTasks.some((task) => task.id === id),
    );
    if (!selectedIds.length) {
      setNotice('请先选择至少一项待处理交付。');
      return;
    }
    const note = batchReviewNote.trim();
    if (decision === 'reject' && !note) {
      setNotice('批量退回复核时需要填写统一的修改说明。');
      return;
    }
    setBatchReviewBusy(true);
    await action(async () => {
      const result = await api<{ succeeded: number; decision: string }>(
        'tasks/batch-review',
        'POST',
        {
          taskIds: selectedIds,
          decision,
          ...(note ? { note } : {}),
        },
      );
      setSelectedReviewTaskIds([]);
      setBatchReviewNote('');
      setNotice(
        `已${decision === 'accept' ? '通过' : '退回'} ${result.succeeded || selectedIds.length} 项交付。`,
      );
    });
    setBatchReviewBusy(false);
  }
  async function uploadAttachments(files: File[]) {
    const existing = draftAttachments[attachmentDraftKey] || [];
    const incoming = files
      .filter((file) => file.size > 0)
      .slice(0, Math.max(0, MAX_ATTACHMENTS - existing.length));
    if (!incoming.length) return;
    const oversized = files.find((file) => file.size > MAX_ATTACHMENT_BYTES);
    if (oversized) {
      setNotice(`“${oversized.name || '文件'}”超过 10 MB，未添加。`);
      return;
    }
    if (files.length > incoming.length) {
      setNotice(`每次对话最多保留 ${MAX_ATTACHMENTS} 个附件。`);
    }
    await action(async () => {
      const uploaded: Attachment[] = [];
      for (const file of incoming) {
        const bytes = new Uint8Array(await file.arrayBuffer());
        let binary = '';
        for (let offset = 0; offset < bytes.length; offset += 0x8000)
          binary += String.fromCharCode(
            ...bytes.subarray(offset, offset + 0x8000),
          );
        uploaded.push(
          await api<Attachment>('attachments', 'POST', {
            name: file.name || `粘贴文件-${Date.now()}`,
            mime: file.type || 'application/octet-stream',
            data: btoa(binary),
            ...((isTeamMember || isTeamConversation) && teamSpace?.id
              ? { teamId: teamSpace.id }
              : {}),
          }),
        );
      }
      setDraftAttachments((current) => ({
        ...current,
        [attachmentDraftKey]: [
          ...(current[attachmentDraftKey] || []),
          ...uploaded,
        ].slice(0, MAX_ATTACHMENTS),
      }));
      setDraftConflict((current) =>
        current?.key === attachmentDraftKey
          ? {
              ...current,
              localAttachments: [
                ...current.localAttachments,
                ...uploaded,
              ].slice(0, MAX_ATTACHMENTS),
            }
          : current,
      );
      markDraftDirty(attachmentDraftKey);
      setNotice(`已添加 ${uploaded.length} 个附件，发送时会携带文件内容。`);
    });
  }
  function clipboardFiles(event: React.ClipboardEvent<HTMLTextAreaElement>) {
    const files = Array.from(event.clipboardData.files);
    if (files.length) return files;
    return Array.from(event.clipboardData.items)
      .filter((item) => item.kind === 'file')
      .map((item) => item.getAsFile())
      .filter((file): file is File => !!file);
  }
  async function submit() {
    const attachmentIds = (draftAttachments[attachmentDraftKey] || []).map(
      (item) => item.id,
    );
    const content = drafts[draftKey] || '';
    const sentVersion = getDraftVersionRef().current[draftKey] || 0;
    if (
      (!content.trim() && !attachmentIds.length) ||
      assistant.archived ||
      !assistant.id
    )
      return;
    await action(async () => {
      // The single team-recruitment entry is the team's front door. Keep its messages in
      // the same space timeline so PM replies and delegated work stay linked.
      if (teamSpace?.pmRoleId === role) {
        const message = await api<TeamMessage & { sessionId?: string }>(
          `spaces/${teamSpace.id}/messages`,
          'POST',
          {
            clientMessageId: `chat-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
            content,
            attachmentIds,
            ...(selectedModelOption
              ? {
                  model: selectedModelOption.model.id,
                  providerId: selectedModelOption.providerId,
                  allowModelWithoutTools: !selectedModelOption.model.tools,
                }
              : {}),
          },
        );
        if (message.sessionId) {
          setSelected((s) => ({
            ...s,
            [sessionSelectionKey]: message.sessionId,
          }));
        }
        if (getDraftVersionRef().current[draftKey] === sentVersion) {
          await clearServerDraft(
            draftKey,
            { spaceId: teamSpace?.id || null, roleId: role },
            content,
            attachmentIds,
          );
          setDrafts((s) => ({ ...s, [draftKey]: '' }));
          setDraftAttachments((s) => ({ ...s, [attachmentDraftKey]: [] }));
        }
        return;
      }
      const task = await api<Task>('tasks', 'POST', {
        role,
        sessionId: currentSession,
        prompt: content,
        attachmentIds,
        ...(isTeamMember && teamSpace
          ? { teamId: teamSpace.id, spaceId: teamSpace.id }
          : {}),
        ...(selectedModelOption
          ? {
              model: selectedModelOption.model.id,
              providerId: selectedModelOption.providerId,
              allowModelWithoutTools: !selectedModelOption.model.tools,
            }
          : {}),
      });
      setSelected((s) => ({
        ...s,
        [task.spaceId ? `${task.spaceId}:${task.role}` : sessionSelectionKey]:
          task.sessionId,
      }));
      if (getDraftVersionRef().current[draftKey] === sentVersion) {
        await clearServerDraft(
          draftKey,
          { spaceId: teamSpace?.id || null, roleId: role },
          content,
          attachmentIds,
        );
        setDrafts((s) => ({ ...s, [draftKey]: '' }));
        setDraftAttachments((s) => ({ ...s, [attachmentDraftKey]: [] }));
      }
    });
  }
  async function retryTeamMessage(message: TeamMessage) {
    if (!teamSpace || message.status !== 'blocked') return;
    await action(async () => {
      const retried = await api<TeamMessage & { sessionId?: string }>(
        `spaces/${teamSpace.id}/messages`,
        'POST',
        {
          clientMessageId: message.clientMessageId || undefined,
          content: message.content,
          attachmentIds: message.attachmentIds || [],
          ...(selectedModelOption
            ? {
                model: selectedModelOption.model.id,
                providerId: selectedModelOption.providerId,
                allowModelWithoutTools: !selectedModelOption.model.tools,
              }
            : {}),
        },
      );
      if (retried.sessionId) {
        setSelected((s) => ({
          ...s,
          [sessionSelectionKey]: retried.sessionId,
        }));
      }
    });
  }
  async function changeTeamModel(value: string) {
    const option = modelOptions.find((item) => item.key === value);
    if (!option) return;
    await action(async () => {
      if (!teamSpace || !isTeamMember) {
        setModelOverrides((current) => ({
          ...current,
          [modelOverrideKey]: option.key,
        }));
        setNotice(
          `本次对话已切换到 ${option.providerName} · ${option.model.name}`,
        );
        return;
      }
      const currentSettings = teamSpace.memberSettings || {};
      await api(`spaces/${teamSpace.id}`, 'PUT', {
        ...(role === teamSpace.pmRoleId
          ? { model: option.model.id, providerId: option.providerId }
          : {}),
        memberSettings: {
          ...currentSettings,
          [role]: {
            ...currentSettings[role],
            modelHint: option.model.id,
            providerIds: [option.providerId],
          },
        },
      });
      setModelOverrides((current) => {
        const next = { ...current };
        delete next[modelOverrideKey];
        return next;
      });
      setNotice(
        `${assistantName} 已切换到 ${option.providerName} · ${option.model.name}`,
      );
    });
  }
  async function confirmTeamRecruitment() {
    if (!teamSpace?.recruitment?.proposal) return;
    const proposalVersion = teamSpace.recruitment.proposal.version;
    await action(async () => {
      const saved = await api<TeamSpace>(
        `spaces/${teamSpace.id}/recruitment/confirm`,
        'POST',
        { version: proposalVersion, capabilityApprovals: recruitmentApprovals },
      );
      await refresh();
      setSelectedSpaceId(saved.id);
      setRole(saved.pmRoleId);
      setSelected((current) => ({
        ...current,
        [`${saved.id}:${saved.pmRoleId}`]: undefined,
      }));
      setView('workspace');
      setNotice(`团队“${saved.name}”已确认，项目经理可以开始安排任务`);
    });
  }
  function openSettings() {
    if (isMobile) setOpenMobile(false);
    setSettingsForm({
      workspace: data?.config.workspace || '',
      model: data?.config.model || 'deepseek-v4-flash',
    });
    setProfileForm(data?.config.profile || profileForm);
    setModal('settings');
  }
  function dismissMobileInput() {
    if (!isMobile || typeof document === 'undefined') return;
    const active = document.activeElement;
    if (active instanceof HTMLElement) active.blur();
  }
  function openMobileSwitcher() {
    if (!isMobile) {
      setOpenMobile(true);
      return;
    }
    dismissMobileInput();
    setOpenMobile(false);
    setMobileTeamQuery('');
    setModal('mobile-switcher');
  }
  function openKnowledge(task?: Task, item?: Knowledge) {
    setKnowledgeHistory(null);
    setDeletingKnowledge(false);
    setKnowledgeForm(
      item || {
        title: task?.title || '',
        content: task?.result || '',
        scope: task?.spaceId || teamSpace?.id ? 'team' : 'project',
        teamId: task?.spaceId || teamSpace?.id || null,
        projectPath:
          task?.workspace ||
          (isConversationView ? conversationWorkspace : data?.config.workspace),
        state: task ? 'draft' : 'confirmed',
        source: task ? `任务 ${task.id}` : '手动添加',
      },
    );
    setModal('knowledge');
  }
  function openHandoff(task: Task) {
    setHandoffTask(task);
    setHandoffRole(handoffRoles(task)[0]?.id || '');
    setHandoffNote('');
    setModal('handoff');
  }
  function openTeamRename() {
    if (!teamSpace) return;
    setTeamRenameForm({ name: teamSpace.name });
    setModal('rename-team');
  }
  function openTeamSettings() {
    if (!teamSpace) return;
    const pm =
      activeRoles.find((item) => item.id === teamSpace.pmRoleId) ||
      activeRoles[0];
    setEditingTeamId(teamSpace.id);
    setTeamForm({
      name: teamSpace.name,
      goal: teamSpace.goal,
      pmRoleId: teamSpace.pmRoleId || pm?.id || 'project_manager',
      memberRoleIds: teamSpace.memberRoleIds?.length
        ? [...teamSpace.memberRoleIds]
        : pm
          ? [pm.id]
          : [],
      allowedTeamIds: Array.isArray(teamSpace.collaboration?.allowedTeamIds)
        ? [...teamSpace.collaboration.allowedTeamIds]
        : [],
      workspace: teamSpace.workspace || data?.config.workspace || '',
      workspaceMode: teamSpace.workspaceMode || 'isolated',
      teamType: (teamSpace.teamType as TeamForm['teamType']) || 'custom',
      allowCollaboration: teamSpace.collaboration?.enabled !== false,
      autonomyMode: teamSpace.autonomy?.mode === 'assist' ? 'assist' : 'auto',
      autonomyMaxDepth: String(teamSpace.autonomy?.maxDepth || 4),
      autonomyMaxJobs: String(teamSpace.autonomy?.maxJobs || 32),
      autonomyBudgetTokens: String(teamSpace.autonomy?.budgetTokens || 200000),
      model: teamSpace.model || '',
      providerId: teamSpace.providerId || '',
    });
    setTeamTemplateId('');
    setModal('team');
  }
  async function toggleTeamAutonomy() {
    if (!teamSpace || teamSpace.recruitment?.phase !== 'confirmed') return;
    const paused = teamSpace.status === 'paused';
    await action(async () => {
      await api<TeamSpace>(
        `spaces/${teamSpace.id}/autonomy/${paused ? 'resume' : 'pause'}`,
        'POST',
      );
      setNotice(
        paused
          ? '团队自治已恢复，可以继续接收和执行新任务。'
          : '团队自治已暂停，新的任务不会继续派发。',
      );
    });
  }
  function openSaveTeamTemplate() {
    if (!teamSpace || teamSpace.recruitment?.phase !== 'confirmed') return;
    setTeamTemplateForm({
      name: `${teamSpace.name} 模板`,
      description: teamSpace.purpose || teamSpace.goal || '',
    });
    setModal('team-template');
  }
  function openCreateTeam(templateId = '') {
    const template = teamTemplates.find((item) => item.id === templateId);
    const pm =
      activeRoles.find(
        (item) => item.id === (template?.pmRoleId || 'project_manager'),
      ) || activeRoles[0];
    const memberRoleIds = template?.memberRoleIds?.length
      ? [...template.memberRoleIds]
      : pm
        ? [pm.id]
        : [];
    setEditingTeamId(null);
    setTeamTemplateId(template?.id || '');
    setTeamForm({
      name: template ? `${template.name} · 新团队` : '',
      goal: template?.goal || '',
      pmRoleId: template?.pmRoleId || pm?.id || 'project_manager',
      memberRoleIds,
      allowedTeamIds: [],
      workspace: data?.config.workspace || '',
      workspaceMode: template?.workspaceMode || 'isolated',
      teamType: template?.teamType || 'custom',
      allowCollaboration: template?.collaboration?.enabled !== false,
      autonomyMode: template?.autonomy?.mode === 'assist' ? 'assist' : 'auto',
      autonomyMaxDepth: String(template?.autonomy?.maxDepth || 4),
      autonomyMaxJobs: String(template?.autonomy?.maxJobs || 32),
      autonomyBudgetTokens: String(template?.autonomy?.budgetTokens || 200000),
      model: template?.model || '',
      providerId: template?.providerId || '',
    });
    setModal('team');
  }
  async function startRecruitment(forceNew = false) {
    if (!forceNew && recruitmentSpace) {
      selectTeam(recruitmentSpace.id);
      setView('recruitment');
      if (isMobile) setOpenMobile(false);
      return;
    }
    const pm =
      activeRoles.find((item) => item.id === 'project_manager') ||
      activeRoles[0];
    if (!pm) return;
    await action(async () => {
      const saved = await api<TeamSpace>('spaces', 'POST', {
        // This is an internal draft label. The visible team name is chosen
        // from the actual work described in the Team Charter after approval.
        name: '待命名需求',
        goal: '通过多轮交流明确需求、交付物和团队职责。',
        pmRoleId: pm.id,
        memberRoleIds: [pm.id],
        workspace: data?.config.workspace || '',
        recruitment: { phase: 'discovery' },
      });
      setSelectedSpaceId(saved.id);
      setRole(saved.pmRoleId);
      setDrafts((current) => ({
        ...current,
        [`${saved.id}:${saved.pmRoleId}`]: '',
      }));
      setView('recruitment');
      if (isMobile) setOpenMobile(false);
      setNotice('招募已开始，描述你希望团队完成的目标');
    });
  }
  function openTeamConversation() {
    if (recruitmentSpace) selectTeam(recruitmentSpace.id);
    else void startRecruitment();
    setView('recruitment');
    if (isMobile) setOpenMobile(false);
  }
  function openTeamOverview() {
    const target =
      confirmedSpaces.find((space) => space.id === selectedSpaceId) ||
      confirmedSpaces[0];
    if (!target) {
      // Keep the requested destination while the initial workspace snapshot is
      // still loading. Falling back to recruitment during that short window
      // makes the mobile tab appear unresponsive and loses the user's intent.
      if (!data) {
        setView('team');
        if (isMobile) setOpenMobile(false);
        return;
      }
      openTeamConversation();
      return;
    }
    selectTeam(target.id);
    setView('team');
    if (isMobile) setOpenMobile(false);
  }
  async function loadOlderTeamTimeline() {
    const space = teamSpace;
    const earliest = teamTimeline[0];
    if (!space || !earliest || timelineLoading) return;
    setTimelineLoading(true);
    try {
      const cursor = encodeURIComponent(`${earliest.at}|${earliest.id}`);
      const page = await api<{ items: TeamTimelineItem[]; hasMore: boolean }>(
        `spaces/${space.id}/timeline?limit=60&before=${cursor}`,
      );
      setTimelineHistory((current) => {
        const existing = current[space.id] || [];
        const merged = new Map(
          [...existing, ...(page.items || [])].map((item) => [item.id, item]),
        );
        return {
          ...current,
          [space.id]: [...merged.values()].sort(
            (a, b) => a.at.localeCompare(b.at) || a.id.localeCompare(b.id),
          ),
        };
      });
      setTimelineHasMore((current) => ({
        ...current,
        [space.id]: page.hasMore === true,
      }));
    } catch (error) {
      setNotice(`加载更早团队动态失败：${(error as Error).message}`);
    } finally {
      setTimelineLoading(false);
    }
  }
  function selectTeam(id: string) {
    const next = data?.spaces?.find((space) => space.id === id);
    if (!next) return;
    setModal(null);
    // Execution records belong to the selected team. Never leave an open
    // inspector from Team A visible while the user is browsing Team B.
    setTaskDetail(null);
    setTimelineFilter('all');
    setSelectedSpaceId(next.id);
    setRole(next.pmRoleId);
  }
  function showTask(task: Task) {
    if (task.spaceId) setSelectedSpaceId(task.spaceId);
    setRole(task.role);
    setSelected((s) => ({
      ...s,
      [task.spaceId ? `${task.spaceId}:${task.role}` : task.role]:
        task.sessionId,
    }));
    setView('workspace');
  }
  function openRiskTeam(teamId: string) {
    selectTeam(teamId);
    setView('team');
    if (isMobile) setOpenMobile(false);
  }
  function openRiskTask(taskId: string) {
    const task = tasks.find((item) => item.id === taskId);
    if (task) showTask(task);
  }
  function handoffRoles(task: Task | null) {
    const team = task?.spaceId
      ? data?.spaces?.find((space) => space.id === task.spaceId)
      : null;
    return activeRoles.filter(
      (item) =>
        item.id !== task?.role &&
        (!team || team.memberRoleIds.includes(item.id)),
    );
  }
  function editRole() {
    setEditingAssistant(assistant);
  }
  return {
    action,
    toggleReviewTask,
    toggleAllReviewTasks,
    batchReview,
    uploadAttachments,
    clipboardFiles,
    submit,
    retryTeamMessage,
    changeTeamModel,
    confirmTeamRecruitment,
    openSettings,
    dismissMobileInput,
    openMobileSwitcher,
    openKnowledge,
    openHandoff,
    openTeamRename,
    openTeamSettings,
    toggleTeamAutonomy,
    openSaveTeamTemplate,
    openCreateTeam,
    startRecruitment,
    openTeamConversation,
    openTeamOverview,
    loadOlderTeamTimeline,
    selectTeam,
    showTask,
    openRiskTeam,
    openRiskTask,
    handoffRoles,
    editRole,
  };
}

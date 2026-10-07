import { commitTeamHandoff } from '../team-handoff-store.mjs';
import { handoffContext } from '../team-handoff-context.mjs';
import { fail, findTeam, required, teamMeta, terminal } from './primitives.mjs';

export function delegateToTeam(control, body, principal) {
  // Re-check the live lease even when invoked outside the MCP HTTP adapter.
  control.ensureCurrent(principal);
  const {
    task: sourceTask,
    meta: sourceMeta,
    team: source,
  } = control.currentTeam(principal);
  if (source.recruitment.phase !== 'confirmed')
    throw fail('团队招募方案尚未确认，不能发起跨团队任务。', 409);
  const target = findTeam(control.store, body.targetTeamId || body.teamId);
  if (!target || target.status !== 'active')
    throw fail('目标团队不存在或未启用。', 404);
  if (target.recruitment.phase !== 'confirmed')
    throw fail('目标团队尚未完成招募。', 409);
  if (target.id === source.id) throw fail('目标团队不能是当前团队。');
  if (!control.collaborationAllowed(source, target))
    throw fail('当前团队未允许与目标团队协作。', 403);
  const prompt = required(body.prompt || body.goal, '协作目标');
  const key = required(body.idempotencyKey, '协作幂等键', 200);
  const acceptance = body.acceptance
    ? required(body.acceptance, '验收标准', 20000)
    : '';
  const content = `${prompt}${acceptance ? `\n\n验收标准：\n${acceptance}` : ''}`;
  if (content.length > 32000)
    throw fail('协作目标和验收标准合计不能超过 32000 个字符。');
  const result = commitTeamHandoff({
    store: control.store,
    source,
    target,
    content,
    initiatorTaskId: sourceTask.id,
    followupMessageId: body.followupMessageId || null,
    clientMessageId: `mcp:${sourceTask.id}:${key}`,
    legacyMessageId: `handoff:${source.id}:${target.id}:${key}`,
    createTask: (message) => {
      const followup = handoffContext(
        control.store,
        source,
        target,
        body.followupMessageId,
      );
      const activeJobs = control.records
        .list('jobs')
        .filter(
          (job) =>
            (job.teamId || job.spaceId) === target.id &&
            !terminal.has(job.status),
        );
      if (activeJobs.length >= (target.autonomy?.maxJobs || 32))
        throw fail('目标团队已达到任务上限。', 409);
      // Each delegation has its own conversation; concurrent sources must not
      // inject unrelated requests into an active target manager's session.
      return control.createTask({
        role: target.pmRoleId,
        prompt: `团队「${source.name}」请求本团队协作。请先阅读协作消息，判断目标与验收标准，必要时向来源团队说明阻塞；目标明确后由本团队项目经理负责拆解、执行和汇总。\n\n${content}${followup?.prompt || ''}`,
        workspace: target.workspace,
        teamId: target.id,
        spaceId: target.id,
        sourceMessageId: message.id,
        contextExtra: JSON.stringify({
          sourceTeamId: source.id,
          sourceTaskId: sourceTask.id,
          sourceJobId: sourceMeta.jobId || null,
        }),
        acceptance,
      });
    },
  });
  const meta = teamMeta(control.store, result.task.id);
  return {
    duplicate: result.duplicate,
    messageId: result.message.id,
    sourceMessageId: result.sourceMessageId,
    taskId: result.task.id,
    jobId: meta.jobId || null,
    sourceTeamId: source.id,
    targetTeamId: target.id,
    status: result.task.status,
  };
}

import { randomUUID } from 'node:crypto';
import { commitTeamHandoff } from './team-handoff-store.mjs';
import { handoffContext } from './team-handoff-context.mjs';

export function createTeamHandoff({ store, space, body, newTask, required }) {
  if (space.status !== 'active') throw new Error('团队空间当前不可发起协作。');
  if (space.recruitment?.phase !== 'confirmed')
    throw Object.assign(new Error('当前团队尚未完成招募。'), {
      status: 409,
    });
  if (space.collaboration?.enabled === false)
    throw Object.assign(new Error('当前团队未启用跨团队协作。'), {
      status: 409,
    });
  const targetId = required(body.targetTeamId || body.teamId, '目标团队');
  const target = store
    .teamSpaces()
    .find(
      (candidate) => candidate.id === targetId || candidate.chatId === targetId,
    );
  if (!target || target.status !== 'active')
    throw new Error('目标团队不存在或已暂停。');
  if (target.recruitment.phase !== 'confirmed')
    throw Object.assign(new Error('目标团队尚未完成招募。'), {
      status: 409,
    });
  if (target.id === space.id) throw new Error('目标团队不能是当前团队。');
  const allowed = Array.isArray(space.collaboration?.allowedTeamIds)
    ? space.collaboration.allowedTeamIds
    : [];
  if (
    allowed.length &&
    !allowed.includes(target.id) &&
    !allowed.includes(target.chatId)
  )
    throw new Error('当前团队未允许与目标团队协作。');
  const prompt = required(body.content, '协作目标', 32000);
  const acceptance =
    typeof body.acceptance === 'string' ? body.acceptance.trim() : '';
  if (acceptance.length > 20000)
    throw new Error('验收标准不能超过 20000 个字符。');
  const content = acceptance
    ? `${prompt}\n\n验收标准：\n${acceptance}`
    : prompt;
  if (content.length > 32000)
    throw new Error('协作目标和验收标准合计不能超过 32000 个字符。');
  const clientMessageId = required(
    body.clientMessageId || randomUUID(),
    '消息 ID',
    200,
  );
  const followup = handoffContext(store, space, target, body.followupMessageId);
  const result = commitTeamHandoff({
    store,
    source: space,
    target,
    clientMessageId,
    content,
    followupMessageId: followup?.messageId || null,
    createTask: (message) =>
      newTask({
        role: target.pmRoleId,
        prompt: `团队「${space.name}」向本团队发起协作请求。请阅读请求并自主判断是否接受、拆解和安排执行。\n\n协作目标：\n${content}${followup?.prompt || ''}`,
        workspace: target.workspace,
        teamId: target.id,
        spaceId: target.id,
        sourceMessageId: message.id,
        acceptance,
      }),
  });
  return {
    status: result.duplicate ? 200 : 201,
    body: {
      ...result.message,
      taskId: result.task.id,
      sessionId: result.task.sessionId,
      sourceTeamId: space.id,
      targetTeamId: target.id,
      sourceMessageId: result.sourceMessageId,
    },
  };
}

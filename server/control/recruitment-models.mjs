import { fail } from './primitives.mjs';

export function validateRecruitmentModels(plane, members) {
  const providerRows = plane.records.list('providers');
  const decisionOnlyProviders = members.flatMap((member) => {
    const ids = member.providerIds?.length
      ? member.providerIds
      : plane.store.role(member.roleId)?.providerIds || [];
    return ids
      .filter((id) =>
        providerRows.some(
          (provider) =>
            provider.id === id && provider.protocol === 'typesafe-system-one',
        ),
      )
      .map((id) => `${member.memberId || member.roleId}:${id}`);
  });
  if (decisionOnlyProviders.length)
    throw fail(
      `招募方案不能把 TypeSafe 作为成员执行模型：${decisionOnlyProviders.join('、')}。请改用普通聊天模型；TypeSafe 只能用于 evaluate_decision。`,
      409,
    );
  const unavailableProviders = members.flatMap((member) =>
    (member.providerIds || [])
      .filter(
        (id) =>
          !providerRows.some(
            (provider) => provider.id === id && provider.enabled !== false,
          ),
      )
      .map((id) => `${member.memberId || member.roleId}:${id}`),
  );
  if (unavailableProviders.length)
    throw fail(
      `招募方案包含未启用的模型供应商：${unavailableProviders.join('、')}。请先启用供应商或移除该绑定。`,
      409,
    );
  const invalidModels = members
    .filter((member) => {
      if (!member.modelHint) return false;
      const templateProviderIds =
        plane.store.role(member.roleId)?.providerIds || [];
      const allowedProviderIds = member.providerIds?.length
        ? member.providerIds
        : templateProviderIds;
      const candidates = allowedProviderIds.length
        ? providerRows.filter(
            (provider) =>
              allowedProviderIds.includes(provider.id) &&
              provider.enabled !== false &&
              provider.protocol !== 'typesafe-system-one',
          )
        : providerRows.filter(
            (provider) =>
              provider.enabled !== false &&
              provider.protocol !== 'typesafe-system-one',
          );
      return !candidates.some((provider) =>
        provider.models?.some((model) => model.id === member.modelHint),
      );
    })
    .map((member) => `${member.memberId || member.roleId}:${member.modelHint}`);
  if (invalidModels.length)
    throw fail(
      `招募方案中的模型未在可用供应商中配置：${invalidModels.join('、')}。modelHint 必须使用 list_capability_catalog 中的精确 model.id，或留空继承模板模型，不能填写“沿用”等说明文字。`,
      409,
    );
  const incompatibleModels = members.flatMap((member) => {
    if (!member.modelHint) return [];
    const template = plane.store.role(member.roleId);
    const effectiveTools = { ...template?.tools, ...member.toolAccess };
    const requiresToolCalling =
      Object.values(effectiveTools).some(Boolean) ||
      (member.capabilityIds || []).length > 0;
    if (!requiresToolCalling) return [];
    const templateProviderIds = template?.providerIds || [];
    const allowedProviderIds = member.providerIds?.length
      ? member.providerIds
      : templateProviderIds;
    const candidates = allowedProviderIds.length
      ? providerRows.filter(
          (provider) =>
            allowedProviderIds.includes(provider.id) &&
            provider.enabled !== false &&
            provider.protocol !== 'typesafe-system-one',
        )
      : providerRows.filter(
          (provider) =>
            provider.enabled !== false &&
            provider.protocol !== 'typesafe-system-one',
        );
    const model = candidates
      .flatMap((provider) => provider.models || [])
      .find(
        (candidate) =>
          candidate.id === member.modelHint &&
          (!requiresToolCalling || candidate.tools === true),
      );
    return model
      ? []
      : [`${member.memberId || member.roleId}:${member.modelHint}`];
  });
  if (incompatibleModels.length)
    throw fail(
      `招募方案中的模型不支持成员所需的工具或能力：${incompatibleModels.join('、')}。请更换支持工具调用的模型，或明确关闭该成员的工具权限。`,
      409,
    );
}

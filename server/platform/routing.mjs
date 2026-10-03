/**
 * Shared model routing policy used by local and remote task execution.
 * Keeping this in one place prevents the two execution paths from drifting
 * when provider selection options evolve.
 */
export function selectTaskRoute({
  providers,
  assistant,
  providerIds,
  modelOverride = '',
  allowWithoutTools = false,
  exclude,
}) {
  return providers.select(
    {
      ...assistant,
      providerIds,
      requiredTools: true,
    },
    {
      modelOverride: modelOverride || '',
      exactModel: !!modelOverride,
      allowWithoutTools: allowWithoutTools === true,
      ...(Array.isArray(exclude) && exclude.length ? { exclude } : {}),
    },
  );
}

export function applyTextOnlyModelPolicy(assistant, route, allowWithoutTools) {
  const textOnlyModel =
    allowWithoutTools === true && route?.modelSpec?.tools !== true;
  if (!textOnlyModel) return { assistant, textOnlyModel: false };
  return {
    assistant: {
      ...assistant,
      tools: { files: false, web: false, terminal: false },
      capabilityIds: [],
    },
    textOnlyModel: true,
  };
}

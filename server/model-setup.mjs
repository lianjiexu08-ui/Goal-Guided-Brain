import { TEXT_PROTOCOLS } from './providers.mjs';

// Configuration evidence only: never probe a provider or return credential data.
export function inspectModelSetup({
  providers,
  vault,
  legacyAvailable = false,
}) {
  const status = vault.status();
  const credentials = new Set(
    status.unlocked ? vault.list().map((entry) => entry.id) : [],
  );
  const credentialStates = Object.fromEntries(
    providers.map((provider) => [
      provider.id,
      !provider.credentialId
        ? 'not-required'
        : !status.initialized
          ? 'missing-vault'
          : !status.unlocked
            ? 'locked'
            : credentials.has(provider.credentialId)
              ? 'ready'
              : 'missing',
    ]),
  );
  const chat = providers.filter((provider) =>
    TEXT_PROTOCOLS.has(provider.protocol),
  );
  const enabled = chat.filter((provider) => provider.enabled !== false);
  const populated = enabled.filter((provider) => provider.models?.length);
  const ready = populated.filter((provider) =>
    ['ready', 'not-required'].includes(credentialStates[provider.id]),
  );
  const state = !providers.length
    ? legacyAvailable
      ? 'legacy'
      : 'missing'
    : !chat.length
      ? providers.every(
          (provider) => provider.protocol === 'typesafe-system-one',
        )
        ? 'decision-only'
        : 'unsupported'
      : !enabled.length
        ? 'disabled'
        : !populated.length
          ? 'empty-models'
          : !ready.length
            ? 'credentials'
            : 'configured';
  return {
    credentialStates,
    summary: {
      state,
      configuredProviders: chat.length,
      readyProviders: ready.length,
      readyModels: ready.reduce(
        (count, provider) => count + provider.models.length,
        0,
      ),
    },
  };
}

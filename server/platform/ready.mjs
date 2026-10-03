import fs from 'node:fs';
import path from 'node:path';
import { loadUsageMeter } from '../metering.mjs';

export function createPlatformReady({
  auth,
  vault,
  dataDir,
  usageMeterOverride,
  setUsageMeter,
}) {
  const ready = (async () => {
    await auth.init();
    const usageMeter =
      typeof usageMeterOverride === 'function'
        ? usageMeterOverride
        : await loadUsageMeter();
    setUsageMeter(usageMeter);
    try {
      fs.rmSync(path.join(dataDir, '.vault_pass'), { force: true });
    } catch {}
    const vaultPassphrase = process.env.WORKBENCH_VAULT_PASSWORD || '';
    if (vaultPassphrase) {
      if (vault.status().initialized) await vault.unlock(vaultPassphrase);
      else await vault.initialize(vaultPassphrase);
    }
  })();
  ready.catch(() => {});
  return ready;
}

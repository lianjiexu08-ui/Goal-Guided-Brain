import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export default async function globalTeardown() {
  const dataDir = process.env.GGB_E2E_DATA_DIR || path.join(os.tmpdir(), 'ggb-browser-e2e-fixture');
  fs.rmSync(dataDir, { recursive: true, force: true });
}

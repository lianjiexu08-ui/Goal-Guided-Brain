import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { defineConfig, devices } from '@playwright/test';

const dataDir = process.env.GGB_E2E_DATA_DIR || path.join(os.tmpdir(), 'ggb-browser-e2e-fixture');
fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
// The web server and the test worker both need to know where the isolated
// fixture lives. The global teardown removes it after the run.
process.env.GGB_E2E_DATA_DIR = dataDir;

export default defineConfig({
  testDir: './tests/e2e',
  fullyParallel: false,
  workers: 1,
  timeout: 45_000,
  expect: { timeout: 10_000 },
  reporter: 'list',
  globalTeardown: './tests/e2e/global-teardown.mjs',
  use: {
    baseURL: 'http://127.0.0.1:3288',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
  },
  projects: [
    {
      name: 'desktop',
      use: { ...devices['Desktop Chrome'] },
    },
    {
      name: 'mobile',
      // Use a Chromium mobile viewport so the baseline works with the
      // browser that is installed by the standard Playwright setup.
      use: { ...devices['Pixel 5'] },
    },
  ],
  webServer: {
    command: 'node scripts/dev.mjs',
    url: 'http://127.0.0.1:3288/',
    timeout: 120_000,
    reuseExistingServer: false,
    env: {
      ...process.env,
      WORKBENCH_DATA_DIR: dataDir,
      WORKBENCH_REQUIRE_AUTH: 'false',
      WORKBENCH_UI_PORT: '3288',
      WORKBENCH_API_PORT: '3289',
    },
  },
});

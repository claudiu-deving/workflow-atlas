import { defineConfig, devices } from '@playwright/test';
import path from 'node:path';

// e2e runs the REAL server against an isolated, freshly-seeded home dir on a private port,
// so tests never touch the developer's ~/.workflow-atlas. The `pretest:e2e` npm script wipes
// .atlas-e2e-home first, so every run seeds the bundled demo content clean.
const PORT = 5199;
const ATLAS_HOME = path.join(process.cwd(), '.atlas-e2e-home');

export default defineConfig({
  testDir: './tests/e2e',
  fullyParallel: false,        // one shared server + project; keep tests serial and deterministic
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? 'line' : [['list']],
  timeout: 30000,
  expect: { timeout: 5000 },
  use: {
    baseURL: `http://localhost:${PORT}`,
    trace: 'retain-on-failure',
    actionTimeout: 10000,
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'], viewport: { width: 1440, height: 900 } } }],
  webServer: {
    command: 'node server/server.mjs',
    url: `http://localhost:${PORT}/api/health`,
    reuseExistingServer: false,
    timeout: 30000,
    env: {
      PORT: String(PORT),
      WORKFLOW_ATLAS_HOME: ATLAS_HOME,
      WORKFLOW_ATLAS_PROJECT: 'e2e',
      WORKFLOW_ATLAS_SEED: '1',
      ATLAS_NO_OPEN: '1',
    },
  },
});

import { defineConfig, devices } from '@playwright/test';
export default defineConfig({
  testDir: './tests/e2e',
  fullyParallel: false,
  workers: 1,
  timeout: 60000,
  retries: 0,
  use: {
    launchOptions: process.env.PLAYWRIGHT_EXECUTABLE_PATH
      ? { executablePath: process.env.PLAYWRIGHT_EXECUTABLE_PATH }
      : {},
    baseURL: process.env.E2E_BASE_URL ?? 'http://127.0.0.1:5189',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'], viewport: { width: 1500, height: 1000 } },
    },
  ],
  webServer: process.env.E2E_BASE_URL
    ? undefined
    : {
        command: 'npm run dev -- --port 5189',
        env: { API_PORT: '4329', WORKSPACE_E2E_ISOLATED: '1' },
        url: 'http://127.0.0.1:5189',
        reuseExistingServer: false,
        timeout: 60000,
      },
});

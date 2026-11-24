import { defineConfig, devices } from '@playwright/test'

/**
 * Playwright Web E2E config for PlumeLens (Chromium against Vite dev server).
 *
 * Packaged Electron E2E lives in `tests/e2e-electron/playwright.config.ts`.
 */
export default defineConfig({
  testDir: './tests/e2e',
  timeout: 30_000,
  fullyParallel: true,
  // Cap concurrency so a single Vite dev server is never saturated on high-core machines.
  workers: process.env.CI ? 2 : 4,
  retries: process.env.CI ? 1 : 0,
  use: {
    baseURL: 'http://localhost:5173',
    trace: 'retain-on-failure',
    timezoneId: 'Asia/Shanghai',
  },
  projects: [
    {
      name: 'chromium',
      // Uses Desktop Chrome default 1280x720; tests needing wider desktop viewports call setViewportSize().
      use: { ...devices['Desktop Chrome'] },
    },
  ],
  webServer: {
    command: 'npx vite --port 5173',
    url: 'http://localhost:5173',
    reuseExistingServer: !process.env.CI,
    timeout: 60_000,
  },
})

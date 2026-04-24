import { defineConfig, devices } from '@playwright/test'

/**
 * Playwright config for PlumeLens.
 *
 * Current scope：用 Chromium 直接访问 Vite dev server（端口 5173）做 UI 层 E2E，
 * 包括视觉回归（screenshots）。Electron 主进程 E2E 等里程碑 0 打包闭环通过后再加。
 *
 * Tests assume `npm run start:web` is running, or rely on Playwright's webServer.
 */
export default defineConfig({
  testDir: './tests/e2e',
  timeout: 30_000,
  retries: 0,
  // 视觉回归快照默认行为
  expect: {
    toHaveScreenshot: {
      maxDiffPixels: 100,
      threshold: 0.15,
    },
  },
  use: {
    baseURL: 'http://localhost:5173',
    trace: 'on-first-retry',
    viewport: { width: 1680, height: 1040 },
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
  webServer: {
    // 独立 renderer server（见 vite.config.ts）；复用已存在的 server 避免每次重启
    command: 'npx vite --port 5173',
    url: 'http://localhost:5173',
    reuseExistingServer: true,
    timeout: 60_000,
  },
})

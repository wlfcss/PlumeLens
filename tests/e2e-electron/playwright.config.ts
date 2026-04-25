/**
 * 单独的 Playwright config 用于真实 Electron app 测试。
 *
 * 与根目录的 playwright.config.ts（webServer 模式）不同：
 * - 不启动 vite dev server（直接启动打包好的 PlumeLens.app）
 * - 只跑 tests/e2e-electron/ 下的 spec
 * - serial 模式（同时只能起一个 Electron 实例）
 */
import { defineConfig } from '@playwright/test'

export default defineConfig({
  testDir: '.',
  timeout: 60_000,
  retries: 0,
  fullyParallel: false,
  workers: 1,
  reporter: 'list',
  use: {
    trace: 'retain-on-failure',
  },
  // 不需要 webServer：用 _electron.launch 直接拉打包应用
})

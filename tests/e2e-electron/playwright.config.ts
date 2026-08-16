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
  // 单个用例最多跑多久。本机 6 个 cold-start 用例合计 47s（最慢的 Phase 4 要退出
  // 再重启 engine，15.6s），但 GitHub macos runner 慢 4-5 倍：v0.7.6 tag 构建里
  // Phase 4 就是撞了 60s 上限被判超时，而同一份产物本机 15.6s 通过。CI 上给到
  // 180s，本机跑仍是几十秒结束，不会拖慢日常开发。
  timeout: process.env.CI ? 180_000 : 60_000,
  retries: 0,
  fullyParallel: false,
  workers: 1,
  reporter: 'list',
  use: {
    trace: 'retain-on-failure',
  },
  // 不需要 webServer：用 _electron.launch 直接拉打包应用
})

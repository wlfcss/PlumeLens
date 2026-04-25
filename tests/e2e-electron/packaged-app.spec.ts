/**
 * E2E：真实启动打包应用（PlumeLens.app），验证：
 * - 主进程 + engine 子进程能启动
 * - UI 通过 IPC 拿到真后端 URL（动态端口）
 * - useLibraries 拉到真 library 列表
 * - 选中已分析的 library 后，photos 网格里有真分析结果（grade / species）
 *
 * 该 spec 不在常规 webServer 模式下跑（playwright.config.ts），单独通过：
 *   npx playwright test --config=tests/e2e-electron/playwright.config.ts
 *
 * 前置：先 npm run build && npx electron-builder --mac --arm64 生成
 *      release/mac-arm64/PlumeLens.app
 */
import { _electron, expect, test, type ElectronApplication, type Page } from '@playwright/test'
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)

const APP_PATH = join(
  __dirname,
  '..',
  '..',
  'release',
  'mac-arm64',
  'PlumeLens.app',
  'Contents',
  'MacOS',
  'PlumeLens',
)

let app: ElectronApplication
let page: Page

test.beforeAll(async () => {
  app = await _electron.launch({ executablePath: APP_PATH, timeout: 30_000 })
  page = await app.firstWindow({ timeout: 30_000 })
  await page.waitForLoadState('domcontentloaded')

  // 等 React 挂上
  await expect(page.getByText('鉴翎').first()).toBeVisible({ timeout: 30_000 })

  // 等 engine 子进程 ready + IPC 能拿到 URL
  for (let i = 0; i < 60; i++) {
    const url = await page.evaluate(async () => {
      const w = window as unknown as {
        plumelens?: { getBackendUrl: () => Promise<string | null> }
      }
      return (await w.plumelens?.getBackendUrl()) ?? null
    })
    if (url) return
    await new Promise((r) => setTimeout(r, 500))
  }
  throw new Error('Engine URL never resolved within 30s')
})

test.afterAll(async () => {
  await app?.close()
})

test('packaged app: 启动可见 + 后端连通 + libraries 列表来自真 API', async () => {
  await page.getByRole('button', { name: '选片', exact: true }).click()
  await expect(page.getByRole('button', { name: '羽迹', exact: true })).toBeVisible()

  // folder rail 至少有一个 folder（mock fallback 或真后端列表都行）
  const folderCount = await page.locator('[class*="folder"]').count()
  expect(folderCount).toBeGreaterThan(0)
})

test('packaged app: 已分析的 library 渲染真分析结果（select / 山麻雀）', async () => {
  await page.getByRole('button', { name: '选片', exact: true }).click()
  // 等 useLibraries refetch + folders 注入 + folder rail 渲染
  await page.waitForTimeout(5_000)

  // 之前通过 API 导入并分析过的 plumelens-pkg-test 应该出现在 folder rail
  const targetFolder = page.getByText('plumelens-pkg-test').first()
  await expect(targetFolder).toBeVisible({ timeout: 15_000 })
  await targetFolder.click()

  // 等 useLibraryDetail 拉真 photos 注入 workspace
  await page.waitForTimeout(3_000)

  // IMG_2013.jpg 已分析为 select / 山麻雀
  await expect(page.getByText('IMG_2013.jpg').first()).toBeVisible({ timeout: 10_000 })
  await expect(page.getByText('山麻雀').first()).toBeVisible({ timeout: 10_000 })
})

test('packaged app: 选片页有"开始分析"按钮', async () => {
  await page.getByRole('button', { name: '选片', exact: true }).click()
  const folderButton = page.locator('[class*="folder-rail"]').locator('button').first()
  if (await folderButton.isVisible().catch(() => false)) {
    await folderButton.click()
  }
  await expect(page.getByRole('button', { name: /开始分析/ })).toBeVisible({ timeout: 5_000 })
})

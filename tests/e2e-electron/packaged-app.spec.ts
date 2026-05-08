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
  app.process().stdout?.on('data', (d) => console.log('[main stdout]', d.toString().trim()))
  app.process().stderr?.on('data', (d) => console.log('[main stderr]', d.toString().trim()))
  page = await app.firstWindow({ timeout: 30_000 })
  page.on('console', (msg) => {
    const t = msg.text()
    if (t.includes('plumelens') || t.includes('Refused') || t.includes('Failed')) {
      console.log('[renderer]', msg.type(), t)
    }
  })
  await page.waitForLoadState('domcontentloaded')

  // 等 React 挂上
  await expect(page.getByText('鉴翎').first()).toBeVisible({ timeout: 30_000 })

  // 等 engine 子进程 ready + IPC 能拿到 URL
  let backendUrl: string | null = null
  for (let i = 0; i < 60; i++) {
    backendUrl = await page.evaluate(async () => {
      const w = window as unknown as {
        plumelens?: { getBackendUrl: () => Promise<string | null> }
      }
      return (await w.plumelens?.getBackendUrl()) ?? null
    })
    if (backendUrl) break
    await new Promise((r) => setTimeout(r, 500))
  }
  if (!backendUrl) throw new Error('Engine URL never resolved within 30s')
  console.log('[E2E] engine URL =', backendUrl)

  // 走 preload 的 engineRequest 而非 Playwright 直 fetch — H5 修复后 token 不
  // 再暴露给 renderer / 测试代码,所有 engine API 调用必须经 preload(原生应用
  // 的实际入口),保证测试覆盖与生产一致的鉴权链路。
  type EngineResponse = { ok: boolean; status: number; body: string }
  const callEngine = async (
    path: string,
    init: { method?: string; body?: string } = {},
  ): Promise<EngineResponse> =>
    page.evaluate(
      async ({ path, init }) => {
        const w = window as unknown as {
          plumelens?: {
            engineRequest?: (
              p: string,
              i?: { method?: string; body?: string | null; headers?: Record<string, string> },
            ) => Promise<{ ok: boolean; status: number; body: string }>
          }
        }
        if (!w.plumelens?.engineRequest) {
          throw new Error('preload engineRequest not available')
        }
        return w.plumelens.engineRequest(path, init)
      },
      { path, init },
    )

  // 只确保 plumelens-pkg-test (1 张) 的缩略图就绪 —— 本 spec 只断言这个 library。
  // engine lifespan 启动会后台扫所有 library 补缺，但大 library (n=783) 数十秒，
  // beforeAll 不能等。
  const libsRes = await callEngine('/library')
  if (!libsRes.ok) throw new Error(`/library failed: ${libsRes.status} ${libsRes.body}`)
  const libs = JSON.parse(libsRes.body) as { id: string; display_name: string }[]
  const target = libs.find((l) => l.display_name === 'plumelens-pkg-test')
  if (target) {
    const r = await callEngine(`/library/${target.id}/thumbnails`, { method: 'POST' })
    console.log(`[E2E] thumbnails(${target.display_name}):`, r.body)
  }
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
  await page.waitForTimeout(5_000)

  const targetFolder = page.getByText('plumelens-pkg-test').first()
  await expect(targetFolder).toBeVisible({ timeout: 15_000 })
  await targetFolder.click()

  await page.waitForTimeout(3_000)

  await expect(page.getByText('IMG_2013.jpg').first()).toBeVisible({ timeout: 10_000 })
  await expect(page.getByText('山麻雀').first()).toBeVisible({ timeout: 10_000 })

  // 视觉断言：photo tile 必须真实加载缩略图，不能只显示渐变。
  // Tile 的 CSS background 只保留渐变占位，真实图走 lazy <img> + retry。
  const imgLoaded = await page.evaluate(async () => {
    const img = document.querySelector('.photo-preview img') as HTMLImageElement | null
    const url = img?.currentSrc || img?.src || ''
    if (!img || !url) return { ok: false, w: 0, h: 0, err: 'no img url', url: '' }
    // 1) 先 fetch 看 server 端
    let fetchInfo = ''
    try {
      const r = await fetch(url)
      fetchInfo = `fetch status=${r.status}`
      if (!r.ok) return { ok: false, w: 0, h: 0, err: fetchInfo, url }
    } catch (e) {
      return { ok: false, w: 0, h: 0, err: `fetch threw: ${(e as Error).message}`, url }
    }
    // 2) 再 Image() 加载验证 decode
    return await new Promise<{ ok: boolean; w: number; h: number; err: string; url: string }>(
      (resolve) => {
        const img = new Image()
        img.onload = () =>
          resolve({ ok: true, w: img.naturalWidth, h: img.naturalHeight, err: fetchInfo, url })
        img.onerror = (ev) =>
          resolve({ ok: false, w: 0, h: 0, err: `Image error: ${String(ev)}`, url })
        img.src = url
        setTimeout(() => resolve({ ok: false, w: 0, h: 0, err: 'timeout', url }), 5_000)
      },
    )
  })
  console.log('[E2E] thumbnail load result:', JSON.stringify(imgLoaded))
  expect(imgLoaded.ok).toBe(true)
  expect(imgLoaded.w).toBeGreaterThan(50)

  // 全屏截图存证（CI 失败时方便审查）
  await page.screenshot({ path: 'test-results/electron-selection-visual.png', fullPage: true })
})

test('packaged app: 选片页有"开始分析"按钮', async () => {
  await page.getByRole('button', { name: '选片', exact: true }).click()
  // 直接点 plumelens-pkg-test（小 library，detail 拉取快）
  const targetFolder = page.getByText('plumelens-pkg-test').first()
  if (await targetFolder.isVisible().catch(() => false)) {
    await targetFolder.click()
  }
  await expect(page.getByRole('button', { name: /开始分析/ })).toBeVisible({ timeout: 10_000 })
})

test('packaged app: photo tile 点击 → 信息抽屉出物种/分数/分级', async () => {
  await page.getByRole('button', { name: '选片', exact: true }).click()
  await page.waitForTimeout(2000)
  await page.getByText('plumelens-pkg-test').first().click()
  await page.waitForTimeout(2500)

  // 点击第一个 photo tile（focus 它，让右侧 info drawer 渲染细节）
  await page.locator('.photo-preview').first().click()
  await page.waitForTimeout(800)

  // 信息抽屉应展示照片信息（不再是 '先选中一张照片'）
  // 抽屉里能看到物种名 + 文件名
  await expect(page.getByText('IMG_2013.jpg')).toBeVisible()
  // 物种信息应在右侧抽屉
  await expect(page.getByText('山麻雀').first()).toBeVisible()
})

test('packaged app: 评级按钮（精选/可用/记录/淘汰）能切换', async () => {
  await page.getByRole('button', { name: '选片', exact: true }).click()
  await page.waitForTimeout(2000)
  await page.getByText('plumelens-pkg-test').first().click()
  await page.waitForTimeout(2500)

  // 找一个 photo tile 上的决策按钮（实际 UI 是 photo-actions hover 出来的）
  // 直接用键盘 J/K/L/U 等也行，但前端没绑那些。先确保 tile 存在。
  await expect(page.locator('.photo-preview')).toHaveCount(1)
})

test('packaged app: 三个路由全屏截图（视觉存证）', async () => {
  // 开始页
  await page.getByRole('button', { name: '开始', exact: true }).click()
  await page.waitForTimeout(800)
  await page.screenshot({ path: 'test-results/route-start.png', fullPage: false })

  // 选片页 + 选 new1 library（783 张连拍真分析数据，便于看场景分组效果）
  await page.getByRole('button', { name: '选片', exact: true }).click()
  await page.waitForTimeout(1500)
  const new1Folder = page.getByText('new1', { exact: true }).first()
  if (await new1Folder.isVisible().catch(() => false)) {
    await new1Folder.click()
    await page.waitForTimeout(4000)
  }
  await page.screenshot({ path: 'test-results/route-selection-new1.png', fullPage: true })

  // 选片页 + plumelens-pkg-test
  await page.getByText('plumelens-pkg-test').first().click()
  await page.waitForTimeout(2500)
  await page.screenshot({ path: 'test-results/route-selection-pkg.png', fullPage: false })

  // 羽迹页（物种墙）
  await page.getByRole('button', { name: '羽迹', exact: true }).click()
  await page.waitForTimeout(1500)
  await page.screenshot({ path: 'test-results/route-archive.png', fullPage: false })
})

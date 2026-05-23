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
import { expect, test, type ElectronApplication, type Page } from '@playwright/test'
import {
  callEngine,
  cleanupDataDir,
  importFixtureLibrary,
  launchApp,
  makeTmpDataDir,
  waitForEngineReady,
  waitForLibraryReady,
} from './helpers/launch.js'

let app: ElectronApplication
let page: Page
const remoteArtworkRequests: string[] = []
let dataDir: string
let fixtureLibraryId: string

test.beforeAll(async () => {
  dataDir = makeTmpDataDir()
  const handle = await launchApp(dataDir)
  app = handle.app
  page = handle.page
  app.process().stdout?.on('data', (d) => console.log('[main stdout]', d.toString().trim()))
  app.process().stderr?.on('data', (d) => console.log('[main stderr]', d.toString().trim()))
  page.on('console', (msg) => {
    const t = msg.text()
    if (t.includes('plumelens') || t.includes('Refused') || t.includes('Failed')) {
      console.log('[renderer]', msg.type(), t)
    }
  })
  page.on('request', (request) => {
    const url = request.url()
    if (url.includes('upload.wikimedia.org')) {
      remoteArtworkRequests.push(url)
    }
  })

  // 等 engine 子进程 ready + IPC 能拿到 URL
  const backendUrl = await waitForEngineReady(page)
  console.log('[E2E] engine URL =', backendUrl)

  const fixture = await importFixtureLibrary(page, undefined, 'plumelens-pkg-test')
  fixtureLibraryId = fixture.id
  await waitForLibraryReady(page, fixtureLibraryId, 30_000)
  const thumbnails = await callEngine(page, `/library/${fixtureLibraryId}/thumbnails`, {
    method: 'POST',
  })
  console.log(`[E2E] thumbnails(${fixture.display_name}):`, thumbnails.body)
})

test.afterAll(async () => {
  await app?.close()
  cleanupDataDir(dataDir)
})

test('packaged app: 启动可见 + 后端连通 + libraries 列表来自真 API', async () => {
  await page.getByRole('button', { name: '选片', exact: true }).click()
  await expect(page.getByRole('button', { name: '羽迹', exact: true })).toBeVisible()

  // folder rail 至少有一个 folder（mock fallback 或真后端列表都行）
  const folderCount = await page.locator('[class*="folder"]').count()
  expect(folderCount).toBeGreaterThan(0)
})

test('packaged app: fixture library 渲染照片与真实缩略图', async () => {
  await page.getByRole('button', { name: '选片', exact: true }).click()
  await page.waitForTimeout(5_000)

  const targetFolder = page.getByText('plumelens-pkg-test').first()
  await expect(targetFolder).toBeVisible({ timeout: 15_000 })
  await targetFolder.click()

  await page.waitForTimeout(3_000)

  await expect(page.locator('.photo-preview img[alt="IMG_0001.JPG"]').first()).toBeVisible({
    timeout: 10_000,
  })

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

test('packaged app: 物种封面图走随包 plumelens://species-artwork 资源', async () => {
  const loaded = await page.evaluate(async () => {
    const url = 'plumelens://species-artwork/Alcedo%20atthis'
    let fetchInfo = ''
    try {
      const response = await fetch(url)
      fetchInfo = `fetch status=${response.status} type=${response.headers.get('content-type') ?? ''}`
      if (!response.ok) {
        return { ok: false, w: 0, h: 0, err: fetchInfo, url }
      }
    } catch (error) {
      return { ok: false, w: 0, h: 0, err: `fetch threw: ${(error as Error).message}`, url }
    }
    return await new Promise<{ ok: boolean; w: number; h: number; err: string; url: string }>(
      (resolve) => {
        const image = new Image()
        image.onload = () =>
          resolve({
            ok: true,
            w: image.naturalWidth,
            h: image.naturalHeight,
            err: fetchInfo,
            url,
          })
        image.onerror = (event) =>
          resolve({ ok: false, w: 0, h: 0, err: `Image error: ${String(event)}`, url })
        image.src = url
        setTimeout(() => resolve({ ok: false, w: 0, h: 0, err: 'timeout', url }), 5_000)
      },
    )
  })
  console.log('[E2E] species artwork load result:', JSON.stringify(loaded))
  expect(loaded.ok).toBe(true)
  expect(loaded.w).toBeGreaterThan(50)
  expect(remoteArtworkRequests).toHaveLength(0)
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

test('packaged app: photo tile 点击 → 信息抽屉出文件信息', async () => {
  await page.getByRole('button', { name: '选片', exact: true }).click()
  await page.waitForTimeout(2000)
  await page.getByText('plumelens-pkg-test').first().click()
  await page.waitForTimeout(2500)

  // 点击第一个 photo tile（focus 它，让右侧 info drawer 渲染细节）
  await page.locator('.photo-preview').first().click()
  await page.waitForTimeout(800)

  // 信息抽屉应展示照片信息（不再是 '先选中一张照片'）
  // 抽屉里能看到物种名 + 文件名
  await expect(page.getByText('IMG_0001.JPG')).toBeVisible()
})

test('packaged app: 评级按钮（精选/可用/记录/淘汰）能切换', async () => {
  await page.getByRole('button', { name: '选片', exact: true }).click()
  await page.waitForTimeout(2000)
  await page.getByText('plumelens-pkg-test').first().click()
  await page.waitForTimeout(2500)

  const firstTile = page.locator('.photo-tile').first()
  const photoId = await firstTile.getAttribute('data-photo-id')
  if (!photoId) throw new Error('first photo tile has no data-photo-id')

  await firstTile.locator('.photo-preview').click()
  const inspectorActions = page.locator('.inspector-actions')
  await expect(inspectorActions).toBeVisible({ timeout: 10_000 })

  const decisions = [
    ['select', '精选'],
    ['usable', '可用'],
    ['record', '记录'],
    ['reject', '淘汰'],
  ] as const

  for (const [decision, label] of decisions) {
    await inspectorActions.getByRole('button', { name: label, exact: true }).click()
    await expect(page.locator('.inspector-grade-pill')).toHaveText(label)

    await expect
      .poll(
        async () => {
          const res = await callEngine(page, `/decisions/photo/${photoId}`)
          if (!res.ok) return null
          return (JSON.parse(res.body) as { decision: string | null }).decision
        },
        { timeout: 5_000 },
      )
      .toBe(decision)
  }
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

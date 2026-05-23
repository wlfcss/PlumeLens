/**
 * E2E smoke tests: UI rendering + route navigation + visual snapshots.
 *
 * 后端 API 全部通过 `page.route()` mock，保证测试不依赖真 Python engine 启动。
 */
import { expect, test, type Page, type Route } from '@playwright/test'

// ---------------- Mock helpers ----------------

interface MockState {
  libraries: Array<{
    id: string
    display_name: string
    parent_path: string
    root_path: string
    status: string
    total_count: number
    analyzed_count: number
    recursive: boolean
    last_opened_at: string
    last_scanned_at: string | null
    last_analyzed_at: string | null
  }>
}

// 默认 mock：1 个测试 library + 4 张 photos（让前端 selection / archive 有真数据可渲染）
const DEFAULT_LIB = {
  id: 'lib-test',
  display_name: '测试库',
  parent_path: '/tmp',
  root_path: '/tmp/lib-test',
  status: 'ready',
  total_count: 4,
  analyzed_count: 4,
  recursive: true,
  last_opened_at: '2026-04-23T07:00:00+00:00',
  last_scanned_at: '2026-04-23T07:00:00+00:00',
  last_analyzed_at: '2026-04-23T07:00:00+00:00',
}

const DEFAULT_PHOTOS = [
  { id: 'p1', file_name: 'IMG_0001.JPG', species: '须浮鸥', latin: 'Chlidonias hybrida', grade: 'select', score: 0.91 },
  { id: 'p2', file_name: 'IMG_0002.JPG', species: '翠鸟', latin: 'Alcedo atthis', grade: 'usable', score: 0.72 },
  { id: 'p3', file_name: 'IMG_0003.JPG', species: '池鹭', latin: 'Ardeola bacchus', grade: 'record', score: 0.45 },
  { id: 'p4', file_name: 'IMG_0004.JPG', species: '白鹭', latin: 'Egretta garzetta', grade: 'reject', score: 0.20 },
]

async function mockBackend(page: Page, state: MockState = { libraries: [DEFAULT_LIB] }): Promise<void> {
  await page.route('**/health', (route: Route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        status: 'ok',
        version: '0.1.0',
        pipeline: {
          ready: true,
          version: 'v1-mocktest',
          quality_available: true,
          pose_available: true,
          species_available: true,
          models: {
            yolo: { loaded: true, provider: 'CPUExecutionProvider' },
            bird_visibility: { loaded: true, provider: 'CPUExecutionProvider' },
            clipiqa: { loaded: true, provider: 'CPUExecutionProvider' },
            hyperiqa: { loaded: true, provider: 'CPUExecutionProvider' },
            dinov3_species_v4: { loaded: true, provider: 'torch:mps:torch.bfloat16' },
          },
        },
      }),
    }),
  )

  await page.route('**/library', (route: Route) => {
    if (route.request().method() === 'GET') {
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(state.libraries),
      })
    } else {
      route.fallback()
    }
  })

  // /library/{id} detail：包含 4 张测试 photos
  await page.route('**/library/lib-test', (route: Route) => {
    const photos = DEFAULT_PHOTOS.map((p, idx) => ({
      id: p.id,
      file_path: `/tmp/lib-test/${p.file_name}`,
      file_name: p.file_name,
      format: 'jpg',
      width: 4000,
      height: 3000,
      thumb_grid: null,
      thumb_preview: null,
      created_at: `2026-04-23T07:0${idx}:00+00:00`,
      shot_at: `2026-04-23T07:0${idx}:00+00:00`,
      exif:
        idx < 2
          ? {
              GPSInfo: {
                '1': 'N',
                '2': [[31, 1], [37, 1], [idx, 1]],
                '3': 'E',
                '4': [[121, 1], [30, 1], [idx, 1]],
              },
            }
          : null,
      scene_id: idx,
      pipeline_version: 'v1-mocktest',
      grade: p.grade,
      quality_score: p.score,
      bird_count: 1,
      species: p.species,
      species_latin: p.latin,
      decision: null,
    }))
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ library: state.libraries[0] ?? DEFAULT_LIB, photos }),
    })
  })

  // 其他路由（decisions、analysis 等）默认 200 空响应
  await page.route('**/decisions/**', (route: Route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ decision: null }),
    }),
  )
}

// ---------------- Basic rendering ----------------

test.describe('App shell', () => {
  test.beforeEach(async ({ page }) => {
    await mockBackend(page)
  })

  test('loads without crashes and shows the app title', async ({ page }) => {
    await page.goto('/')
    // App title is rendered via i18next, either in start hero or brand header
    await expect(page.getByText('鉴翎').first()).toBeVisible()
  })

  test('shows the PlumeLens brand mark', async ({ page }) => {
    await page.goto('/')
    await expect(page.locator('.brand-mark__copy')).toContainText('鉴翎')
    await expect(page.locator('.brand-mark__logo')).toBeVisible()
  })

  test('start screen has the primary CTA', async ({ page }) => {
    await page.goto('/')
    await expect(
      page.getByRole('button', { name: /选择照片文件夹/ }),
    ).toBeVisible()
  })
})

test.describe('Start recent folders', () => {
  test('keeps all recent folders accessible when there are more than four', async ({ page }) => {
    const libraries = Array.from({ length: 6 }, (_, index) => ({
      ...DEFAULT_LIB,
      id: `lib-recent-${index + 1}`,
      display_name: `最近文件夹-${index + 1}`,
      root_path: `/tmp/recent-${index + 1}`,
      last_opened_at: `2026-04-2${index}T07:00:00+00:00`,
    }))
    await mockBackend(page, { libraries })
    await page.goto('/')

    const stack = page.getByTestId('recent-folder-stack')
    await expect(stack).toBeVisible()
    await expect(page.getByText('6 项')).toBeVisible()
    await expect(stack.locator('.folder-line')).toHaveCount(6)

    const metrics = await stack.evaluate((node) => ({
      clientHeight: node.clientHeight,
      scrollHeight: node.scrollHeight,
    }))
    expect(metrics.scrollHeight).toBeGreaterThan(metrics.clientHeight)
  })
})

// ---------------- Route navigation ----------------

test.describe('Route switcher', () => {
  test.beforeEach(async ({ page }) => {
    await mockBackend(page)
    await page.goto('/')
  })

  test('navigates to selection', async ({ page }) => {
    await page.getByRole('button', { name: '选片', exact: true }).click()
    // 选片页应出现文件夹侧栏或筛选工具栏某个标志
    await expect(page.getByText(/当前工作集|文件夹导航/).first()).toBeVisible()
  })

  test('navigates to archive', async ({ page }) => {
    await page.getByRole('button', { name: '羽迹', exact: true }).click()
    // 羽迹页有 tab 切换（物种 / 地理分布）
    await expect(page.getByRole('button', { name: '物种' }).first()).toBeVisible()
    await expect(page.getByRole('button', { name: '地理分布' }).first()).toBeVisible()
    await expect(page.getByRole('button', { name: '照片', exact: true })).toHaveCount(0)
  })

  test('returns to start from brand mark', async ({ page }) => {
    await page.getByRole('button', { name: '选片', exact: true }).click()
    // 点 brand mark 回开始页
    await page.locator('.brand-mark').first().click()
    await expect(
      page.getByRole('button', { name: /选择照片文件夹/ }),
    ).toBeVisible()
  })
})

// ---------------- Backend health indicator ----------------

test.describe('Backend health indicator', () => {
  test('shows "engine ready" badge when health returns ok', async ({ page }) => {
    await mockBackend(page)
    await page.goto('/')
    // 允许 TanStack Query 完成首次请求
    await expect(page.getByText(/本地引擎就绪/).first()).toBeVisible({
      timeout: 5000,
    })
  })

  test('shows "error" state when health endpoint 500s', async ({ page }) => {
    await page.route('**/health', (route) => route.fulfill({ status: 500 }))
    await page.route('**/library', (route) =>
      route.fulfill({ status: 200, contentType: 'application/json', body: '[]' }),
    )
    await page.goto('/')
    await expect(page.getByText(/后端连接失败/).first()).toBeVisible({
      timeout: 5000,
    })
  })
})

// ---------------- Visual snapshots ----------------

test.describe('Visual regression', () => {
  test.beforeEach(async ({ page }) => {
    await mockBackend(page)
  })

  test('start screen snapshot', async ({ page }) => {
    await page.goto('/')
    // 等一下确保 glyph 灯阵动画稳定在某一帧
    await page.waitForTimeout(500)
    await expect(page).toHaveScreenshot('start-screen.png', {
      fullPage: false,
      animations: 'disabled',
    })
  })

  test('selection screen snapshot', async ({ page }) => {
    await page.goto('/')
    await page.getByRole('button', { name: '选片', exact: true }).click()
    await page.waitForTimeout(500)
    await expect(page).toHaveScreenshot('selection-screen.png', {
      fullPage: false,
      animations: 'disabled',
    })
  })

  test('archive screen snapshot', async ({ page }) => {
    await page.goto('/')
    await page.getByRole('button', { name: '羽迹', exact: true }).click()
    await page.waitForTimeout(500)
    // 物种详情面板的封面走 plumelens://species-artwork 随包资源协议；
    // Chromium UI 层 E2E 无 Electron protocol handler,这里仅等待常规 img 稳定。
    await page.waitForFunction(
      () => Array.from(document.images).every((img) => img.complete),
      undefined,
      { timeout: 5000 },
    ).catch(() => {
      // 网络不可达时不阻塞快照（snapshot 容忍小差异）
    })
    await expect(page).toHaveScreenshot('archive-screen.png', {
      fullPage: false,
      animations: 'disabled',
      maxDiffPixels: 80000,
      maxDiffPixelRatio: 0.08, // 容忍 cover 图加载差异
    })
  })
})

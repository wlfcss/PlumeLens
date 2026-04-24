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

async function mockBackend(page: Page, state: MockState = { libraries: [] }): Promise<void> {
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
            dinov3_backbone: { loaded: true, provider: 'CPUExecutionProvider' },
            species_ensemble: { loaded: true, provider: 'CPUExecutionProvider' },
          },
        },
      }),
    }),
  )

  await page.route('**/library', (route: Route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(state.libraries),
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
    await expect(page.getByText('PLUMELENS').first()).toBeVisible()
  })

  test('start screen has the primary CTA', async ({ page }) => {
    await page.goto('/')
    await expect(
      page.getByRole('button', { name: /选择照片文件夹/ }),
    ).toBeVisible()
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
    // 羽迹页有 tab 切换（照片 / 物种）
    await expect(page.getByRole('button', { name: '物种' }).first()).toBeVisible()
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
    await expect(page).toHaveScreenshot('archive-screen.png', {
      fullPage: false,
      animations: 'disabled',
    })
  })
})

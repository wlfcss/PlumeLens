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
  {
    id: 'p1',
    file_name: 'IMG_0001.JPG',
    species: '须浮鸥',
    latin: 'Chlidonias hybrida',
    grade: 'select',
    score: 0.91,
  },
  {
    id: 'p2',
    file_name: 'IMG_0002.JPG',
    species: '翠鸟',
    latin: 'Alcedo atthis',
    grade: 'usable',
    score: 0.72,
  },
  {
    id: 'p3',
    file_name: 'IMG_0003.JPG',
    species: '池鹭',
    latin: 'Ardeola bacchus',
    grade: 'record',
    score: 0.45,
  },
  {
    id: 'p4',
    file_name: 'IMG_0004.JPG',
    species: '白鹭',
    latin: 'Egretta garzetta',
    grade: 'reject',
    score: 0.2,
  },
]

async function mockBackend(
  page: Page,
  state: MockState = { libraries: [DEFAULT_LIB] },
): Promise<void> {
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
  await page.route(
    (url) => url.pathname === '/library/lib-test',
    (route: Route) => {
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
                  '2': [
                    [31, 1],
                    [37, 1],
                    [idx, 1],
                  ],
                  '3': 'E',
                  '4': [
                    [121, 1],
                    [30, 1],
                    [idx, 1],
                  ],
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
    },
  )

  // The renderer now consumes authoritative membership rather than filtering detail locally.
  await page.route('**/library/*/selection/query', (route: Route) => {
    const query = JSON.parse(route.request().postData() ?? '{}')
    const photos = DEFAULT_PHOTOS.filter(
      (photo) =>
        (query.grades ?? []).includes(photo.grade) &&
        !query.only_flying &&
        (!query.photo_query ||
          [photo.file_name, photo.species, photo.latin].some((value) =>
            value.toLowerCase().includes(String(query.photo_query).toLowerCase()),
          )),
    )
    const selected = new Set<string>(query.species_keys ?? [])
    const matched = photos.filter((photo) => !selected.size || selected.has(`sci:${photo.latin}`))
    return route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        library_id: 'lib-test',
        projection_revision: 'smoke-1',
        query,
        matched_photo_ids: matched.map((photo) => photo.id),
        matched_count: matched.length,
        total_count: DEFAULT_PHOTOS.length,
        pending_count: 0,
        failed_count: 0,
        no_bird_count: 0,
        facets: DEFAULT_PHOTOS.map((photo) => ({
          key: `sci:${photo.latin}`,
          name: photo.species,
          latin_name: photo.latin,
          english_name: null,
          search_aliases: [],
          photo_count: photos.filter((row) => row.latin === photo.latin).length,
          review_photo_count: 0,
        })),
      }),
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

// ---------------- Basic rendering & layout ----------------

test.describe('App shell', () => {
  test.beforeEach(async ({ page }) => {
    await mockBackend(page)
  })

  test('renders brand mark, primary CTA, and viewport-locked start screen with pinned pipeline bar', async ({
    page,
  }) => {
    await page.goto('/')
    await expect(page.locator('.brand-mark__copy')).toContainText('鉴翎')
    await expect(page.locator('.brand-mark__logo')).toBeVisible()
    await expect(page.getByRole('button', { name: /选择照片文件夹/ })).toBeVisible()

    const startScreen = page.locator('.start-screen')
    const pipelineBar = page.locator('.pipeline-bar')
    await expect(startScreen).toBeVisible()
    await expect(pipelineBar).toBeVisible()

    // 等待进场位移动画结束，确保 getBoundingClientRect() 测量的是最终静止位置
    await startScreen.evaluate((el) => Promise.all(el.getAnimations().map((a) => a.finished)))

    // 尝试在首页主体滚动，首页与根文档都不应出现纵向滚动（底部装饰鸟图须被裁切）
    await page.mouse.move(640, 360)
    await page.mouse.wheel(0, 500)

    const metrics = await page.evaluate(() => {
      const start = document.querySelector<HTMLElement>('.start-screen')
      if (start) start.scrollTop = 200
      const bar = document.querySelector<HTMLElement>('.pipeline-bar')
      const barRect = bar?.getBoundingClientRect()
      return {
        docScrollHeight: document.documentElement.scrollHeight,
        innerHeight: window.innerHeight,
        windowScrollY: window.scrollY,
        startScrollHeight: start?.scrollHeight ?? 0,
        startClientHeight: start?.clientHeight ?? 0,
        startScrollTop: start?.scrollTop ?? 0,
        barBottom: barRect?.bottom ?? 0,
      }
    })

    expect(metrics.docScrollHeight).toBeLessThanOrEqual(metrics.innerHeight)
    expect(metrics.windowScrollY).toBe(0)
    expect(metrics.startScrollHeight).toBeLessThanOrEqual(metrics.startClientHeight)
    expect(metrics.startScrollTop).toBe(0)
    expect(Math.abs(metrics.barBottom - metrics.innerHeight)).toBeLessThanOrEqual(1)
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

    const metrics = await page.evaluate(() => {
      const list = document.querySelector<HTMLElement>('.start-list')
      const bar = document.querySelector<HTMLElement>('.pipeline-bar')
      const start = document.querySelector<HTMLElement>('.start-screen')
      const folderStack = document.querySelector<HTMLElement>('[data-testid="recent-folder-stack"]')
      return {
        stackClientHeight: folderStack?.clientHeight ?? 0,
        stackScrollHeight: folderStack?.scrollHeight ?? 0,
        listBottom: list?.getBoundingClientRect().bottom ?? 0,
        barTop: bar?.getBoundingClientRect().top ?? 0,
        startScrollHeight: start?.scrollHeight ?? 0,
        startClientHeight: start?.clientHeight ?? 0,
      }
    })
    expect(metrics.stackScrollHeight).toBeGreaterThan(metrics.stackClientHeight)
    expect(metrics.listBottom).toBeLessThanOrEqual(metrics.barTop)
    expect(metrics.startScrollHeight).toBeLessThanOrEqual(metrics.startClientHeight)
  })
})

// ---------------- Route navigation & cross-platform layout geometry ----------------

test.describe('Route switcher & layout geometry', () => {
  test.beforeEach(async ({ page }) => {
    await mockBackend(page)
    await page.goto('/')
  })

  test('navigates across start, selection, archive, and back without horizontal overflow', async ({
    page,
  }) => {
    for (const viewport of [
      { width: 1680, height: 1040 },
      { width: 1280, height: 720 },
    ]) {
      await page.setViewportSize(viewport)

      // 选片页
      await page.getByRole('button', { name: '选片', exact: true }).click()
      await expect(page.getByText(/当前工作集|文件夹导航/).first()).toBeVisible()
      await expect(page.locator('.photo-tile').first()).toBeVisible()
      await page
        .locator('.inspector')
        .evaluate((el) => Promise.all(el.getAnimations().map((a) => a.finished)))

      const selectionLayout = await page.evaluate(() => {
        const settingsBtn = document.querySelector<HTMLElement>('button[aria-label="设置"]')
        const inspector = document.querySelector<HTMLElement>('.inspector')
        return {
          docOverflowX: document.documentElement.scrollWidth - window.innerWidth,
          settingsRight: settingsBtn?.getBoundingClientRect().right ?? 0,
          inspectorRight: inspector?.getBoundingClientRect().right ?? 0,
          innerWidth: window.innerWidth,
        }
      })
      expect(selectionLayout.docOverflowX).toBeLessThanOrEqual(1)
      expect(selectionLayout.settingsRight).toBeLessThanOrEqual(selectionLayout.innerWidth + 1)
      expect(selectionLayout.inspectorRight).toBeLessThanOrEqual(selectionLayout.innerWidth + 1)

      // 羽迹页
      await page.getByRole('button', { name: '羽迹', exact: true }).click()
      await expect(page.getByRole('button', { name: '物种' }).first()).toBeVisible()
      await expect(page.getByRole('button', { name: '地理分布' }).first()).toBeVisible()
      await expect(page.getByRole('button', { name: '照片', exact: true })).toHaveCount(0)

      const archiveOverflowX = await page.evaluate(
        () => document.documentElement.scrollWidth - window.innerWidth,
      )
      expect(archiveOverflowX).toBeLessThanOrEqual(1)

      // 点 brand mark 回开始页
      await page.locator('.brand-mark').first().click()
      await expect(page.getByRole('button', { name: /选择照片文件夹/ })).toBeVisible()
    }
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

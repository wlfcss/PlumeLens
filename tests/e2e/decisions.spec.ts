/**
 * E2E: 选片页 decision 切换行为 + 物种百科面板渲染。
 *
 * 后端 /library + /decisions 全 mock，保证测试只聚焦前端 UX 行为。
 */
import { expect, test, type Page, type Route } from '@playwright/test'

interface DecisionRecord {
  photo_id: string
  decision: 'select' | 'usable' | 'record' | 'reject' | null
}

const TEST_LIB = {
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

const TEST_PHOTOS = [
  { id: 'p1', file_name: 'IMG_0001.JPG', species: '须浮鸥', latin: 'Chlidonias hybrida', grade: 'select', score: 0.91 },
  { id: 'p2', file_name: 'IMG_0002.JPG', species: '翠鸟', latin: 'Alcedo atthis', grade: 'usable', score: 0.72 },
  { id: 'p3', file_name: 'IMG_0003.JPG', species: '池鹭', latin: 'Ardeola bacchus', grade: 'record', score: 0.45 },
  { id: 'p4', file_name: 'IMG_0004.JPG', species: '白鹭', latin: 'Egretta garzetta', grade: 'reject', score: 0.20 },
]

async function mockBackend(page: Page): Promise<void> {
  await page.route('**/health', (route: Route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        status: 'ok',
        version: '0.1.0',
        pipeline: {
          ready: true,
          version: 'v1-mock',
          quality_available: true,
          pose_available: true,
          species_available: true,
          models: {},
        },
      }),
    }),
  )
  await page.route('**/library', (route: Route) => {
    if (route.request().method() === 'GET') {
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify([TEST_LIB]),
      })
    } else {
      route.fallback()
    }
  })
  await page.route('**/library/lib-test', (route: Route) => {
    const photos = TEST_PHOTOS.map((p, idx) => ({
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
      pipeline_version: 'v1-mock',
      grade: p.grade,
      quality_score: p.score,
      bird_count: 1,
      species: p.species,
      species_latin: p.latin,
      decision: null,
      best_detection: {
        index: 0,
        bbox: { x1: 1700, y1: 800, x2: 2200, y2: 2200, confidence: 0.93 },
        pose: null,
        quality: { clipiqa: p.score, hyperiqa: p.score, combined: p.score },
        species: p.species,
        species_latin: p.latin,
        manual_species: false,
        species_candidates: [
          {
            canonical_sci: p.latin,
            canonical_zh: p.species,
            canonical_en: p.species === '须浮鸥' ? 'whiskered tern' : null,
            confidence: p.score,
          },
        ],
      },
      detections:
        p.id === 'p1'
          ? [
              {
                index: 0,
                is_best: true,
                bbox: { x1: 1700, y1: 800, x2: 2200, y2: 2200, confidence: 0.93 },
                pose: null,
                quality: { clipiqa: p.score, hyperiqa: p.score, combined: p.score },
                species: p.species,
                species_latin: p.latin,
                manual_species: false,
                species_candidates: [
                  {
                    canonical_sci: p.latin,
                    canonical_zh: p.species,
                    canonical_en: 'whiskered tern',
                    confidence: p.score,
                  },
                ],
              },
              {
                index: 1,
                is_best: false,
                bbox: { x1: 2300, y1: 900, x2: 2750, y2: 2100, confidence: 0.82 },
                pose: null,
                quality: { clipiqa: 0.76, hyperiqa: 0.71, combined: 0.73 },
                species: '翠鸟',
                species_latin: 'Alcedo atthis',
                manual_species: false,
                species_candidates: [
                  {
                    canonical_sci: 'Alcedo atthis',
                    canonical_zh: '翠鸟',
                    canonical_en: 'common kingfisher',
                    confidence: 0.82,
                  },
                ],
              },
            ]
          : null,
    }))
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ library: TEST_LIB, photos }),
    })
  })
  // /decisions 端点：内存里记录被 PUT 的 decision
  const decisionStore: DecisionRecord[] = []
  await page.route('**/decisions/photo/**', async (route: Route) => {
    const url = route.request().url()
    const photoId = url.split('/decisions/photo/')[1]
    const method = route.request().method()
    if (url.includes('/species/')) {
      const [id, birdIndexRaw] = photoId.split('/species/')
      const body = JSON.parse(route.request().postData() ?? '{}')
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          photo_id: id,
          bird_index: Number(birdIndexRaw),
          canonical_sci: body.canonical_sci ?? null,
          canonical_zh: body.canonical_zh ?? null,
          canonical_en: body.canonical_en ?? null,
        }),
      })
      return
    }
    if (method === 'PUT') {
      const body = JSON.parse(route.request().postData() ?? '{}')
      const idx = decisionStore.findIndex((d) => d.photo_id === photoId)
      if (idx >= 0) decisionStore[idx].decision = body.decision
      else decisionStore.push({ photo_id: photoId, decision: body.decision })
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ photo_id: photoId, decision: body.decision }),
      })
    } else {
      const existing = decisionStore.find((d) => d.photo_id === photoId)
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          photo_id: photoId,
          decision: existing?.decision ?? null,
        }),
      })
    }
  })
}

test.describe('Photo decision flow (mock backend)', () => {
  test.beforeEach(async ({ page }) => {
    await mockBackend(page)
    await page.goto('/')
    await page.getByRole('button', { name: '选片', exact: true }).click()
    // 等文件夹列表渲染
    await expect(page.getByText(/当前工作集|文件夹导航/).first()).toBeVisible()
  })

  test('user can navigate into selection and see photo tiles', async ({ page }) => {
    // mock-workspace 数据会让至少一个照片 tile 可见
    // 等主工作区面板出现
    await expect(page.locator('.photo-tile, [class*="tile"]').first()).toBeVisible({
      timeout: 5000,
    })
    await expect(page.locator('.photo-actions .icon-button')).toHaveCount(0)
  })

  test('export drawer supports manual grade and score range', async ({ page }) => {
    await page.locator('.folder-actions').getByRole('button', { name: '导出' }).click()
    await expect(page.getByText('当前范围将导出 3 张')).toBeVisible()

    await page.getByLabel('淘汰').check()
    await expect(page.getByText('当前范围将导出 4 张')).toBeVisible()

    await page.getByPlaceholder('最低').fill('50')
    await expect(page.getByText('当前范围将导出 2 张')).toBeVisible()
  })

  test('quick filter tabs are clickable', async ({ page }) => {
    const filters = page.locator('.filter-row')
    await expect(filters.getByRole('button', { name: '精选', exact: true })).toBeVisible()
    await expect(filters.getByRole('button', { name: '可用', exact: true })).toBeVisible()
    await expect(filters.getByRole('button', { name: '记录', exact: true })).toBeVisible()
    await expect(filters.getByRole('button', { name: '淘汰', exact: true })).toBeVisible()
    await expect(filters.getByRole('button', { name: '无鸟', exact: true })).toBeVisible()
    await filters.getByRole('button', { name: '淘汰', exact: true }).click()
    await expect(filters.getByRole('button', { name: '淘汰', exact: true })).toBeVisible()
  })

  test('deep review closes after attempted internal scroll', async ({ page }) => {
    await page.locator('.photo-preview').first().dblclick()
    await expect(page.locator('.review-panel')).toBeVisible()

    await page.locator('.review-stage').evaluate((element) => {
      element.scrollTop = 900
    })

    const closeButton = page.locator('.review-panel__close')
    await expect(closeButton).toBeVisible()
    const switcherButtons = page.locator('.review-heading__switcher .icon-button')
    await expect(switcherButtons).toHaveCount(3)
    const controlRects = await switcherButtons.evaluateAll((buttons) =>
      buttons.map((button) => {
        const rect = button.getBoundingClientRect()
        return { height: rect.height, top: rect.top }
      }),
    )
    expect(
      Math.max(...controlRects.map((rect) => rect.top)) -
        Math.min(...controlRects.map((rect) => rect.top)),
    ).toBeLessThanOrEqual(1)
    expect(
      Math.max(...controlRects.map((rect) => rect.height)) -
        Math.min(...controlRects.map((rect) => rect.height)),
    ).toBeLessThanOrEqual(1)
    const box = await closeButton.boundingBox()
    expect(box?.y ?? -1).toBeGreaterThanOrEqual(0)
    expect(box).not.toBeNull()
    if (!box) return

    await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2)
    await expect(page.locator('.review-panel')).toHaveCount(0)
  })

  test('deep review uses 90 percent modal and preserves image aspect ratio', async ({ page }) => {
    await page.locator('.photo-preview').first().dblclick()
    await expect(page.locator('.review-panel')).toBeVisible()

    const backdropRect = await page.locator('.overlay-backdrop').evaluate((element) => {
      const rect = element.getBoundingClientRect()
      return { width: rect.width, height: rect.height }
    })
    const panelRect = await page.locator('.review-panel').evaluate((element) => {
      const style = window.getComputedStyle(element)
      return {
        width: Number.parseFloat(style.width),
        height: Number.parseFloat(style.height),
      }
    })
    expect(panelRect.width / backdropRect.width).toBeCloseTo(0.9, 2)
    expect(panelRect.height / backdropRect.height).toBeCloseTo(0.9, 2)

    await expect
      .poll(async () =>
        page.locator('.review-image').evaluateAll((elements) =>
          elements.map((element) => {
            const rect = element.getBoundingClientRect()
            return rect.width / rect.height
          }),
        ),
      )
      .toHaveLength(2)

    const imageRects = await page.locator('.review-image').evaluateAll((elements) =>
      elements.map((element) => {
        const imageRect = element.getBoundingClientRect()
        const frameRect = element.parentElement?.getBoundingClientRect()
        return {
          imageHeight: imageRect.height,
          imageWidth: imageRect.width,
          frameHeight: frameRect?.height ?? 0,
          frameWidth: frameRect?.width ?? 0,
        }
      }),
    )
    expect(imageRects[0].imageWidth / imageRects[0].imageHeight).toBeCloseTo(4 / 3, 1)
    expect(imageRects[1].imageWidth / imageRects[1].imageHeight).toBeCloseTo(1750 / 3000, 1)
    for (const rect of imageRects) {
      expect(rect.imageWidth).toBeLessThanOrEqual(rect.frameWidth + 1)
      expect(rect.imageHeight).toBeLessThanOrEqual(rect.frameHeight + 1)
    }
  })

  test('deep review supports keyboard/photo strip navigation', async ({ page }) => {
    await page.locator('.photo-preview').first().dblclick()
    await expect(page.locator('.review-panel')).toBeVisible()
    // 默认筛选只展示精选 / 可用 / 记录，淘汰照片不进入当前复审胶片条。
    await expect(page.locator('.review-filmstrip__item')).toHaveCount(3)

    await page.keyboard.press('ArrowRight')
    await expect(page.locator('.review-heading h2')).toContainText('IMG_0002.JPG')

    await page.locator('.review-filmstrip__item').nth(2).click()
    await expect(page.locator('.review-heading h2')).toContainText('IMG_0003.JPG')

    await page.keyboard.press('Escape')
    await expect(page.locator('.review-panel')).toHaveCount(0)
  })

  test('deep review can override species per bird detection', async ({ page }) => {
    await page.locator('.photo-preview').first().dblclick()
    await expect(page.locator('.review-panel')).toBeVisible()

    await expect(page.locator('.species-editor__bird')).toHaveCount(2)
    await page.getByRole('button', { name: '鸟 2' }).click()
    await page.getByPlaceholder('搜索中文名、英文名或拉丁名').fill('暗绿绣眼鸟')
    await page.getByRole('button', { name: /暗绿绣眼鸟/ }).click()

    await expect(page.locator('.species-editor__manual')).toContainText('人工')
    await expect(page.locator('.species-editor__current')).toContainText('暗绿绣眼鸟')
  })
})


test.describe('Archive species panel (local wiki data)', () => {
  test.beforeEach(async ({ page }) => {
    await mockBackend(page)
    await page.goto('/')
  })

  test('archive tab renders species cards', async ({ page }) => {
    await page.getByRole('button', { name: '羽迹', exact: true }).click()
    await page.getByRole('button', { name: '物种', exact: true }).click()
    await expect(page.locator('.collection-card--lit').first()).toBeVisible({
      timeout: 5000,
    })
  })

  test('species detail panel shows Wikipedia link when available', async ({ page }) => {
    await page.getByRole('button', { name: '羽迹', exact: true }).click()
    await page.getByRole('button', { name: '物种', exact: true }).click()
    await page.locator('.collection-card--lit').first().click()
    // mock-workspace 里首选物种（按分数排序）应是须浮鸥或翠鸟（Wikipedia 都有对应页）
    // 等待右侧详情面板出现 Wikipedia → 外链
    await expect(page.getByText('Wikipedia →')).toBeVisible({ timeout: 5000 })
    const link = page.getByText('Wikipedia →')
    const href = await link.getAttribute('href')
    expect(href).toMatch(/wikipedia\.org/)
  })

  test('archive map opens matching photo list', async ({ page }) => {
    await page.getByRole('button', { name: '羽迹', exact: true }).click()
    await page.getByRole('button', { name: '地理分布', exact: true }).click()
    await expect(page.locator('.china-map-card')).toBeVisible()
    await page.locator('.map-pin').first().click()
    await expect(page.locator('.map-photo-card').first()).toBeVisible()
  })
})

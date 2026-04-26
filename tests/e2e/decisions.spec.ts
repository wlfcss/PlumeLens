/**
 * E2E: 选片页 decision 切换行为 + 物种百科面板渲染。
 *
 * 后端 /library + /decisions 全 mock，保证测试只聚焦前端 UX 行为。
 */
import { expect, test, type Page, type Route } from '@playwright/test'

interface DecisionRecord {
  photo_id: string
  decision: 'unreviewed' | 'selected' | 'maybe' | 'rejected'
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
  { id: 'p1', file_name: 'IMG_0001.JPG', species: '须浮鸥', grade: 'select', score: 0.91 },
  { id: 'p2', file_name: 'IMG_0002.JPG', species: '翠鸟', grade: 'usable', score: 0.72 },
  { id: 'p3', file_name: 'IMG_0003.JPG', species: '池鹭', grade: 'record', score: 0.45 },
  { id: 'p4', file_name: 'IMG_0004.JPG', species: '白鹭', grade: 'reject', score: 0.20 },
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
      scene_id: idx,
      pipeline_version: 'v1-mock',
      grade: p.grade,
      quality_score: p.score,
      bird_count: 1,
      species: p.species,
      decision: 'unreviewed',
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
          decision: existing?.decision ?? 'unreviewed',
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
  })

  test('quick filter tabs are clickable', async ({ page }) => {
    // 选片页顶部四个 quick filter: 全部/待看/已选/待定/淘汰/精选/新增种
    await expect(page.getByRole('button', { name: '待看', exact: true })).toBeVisible()
    await page.getByRole('button', { name: '已选', exact: true }).click()
    // 点了"已选"不应闪崩
    await expect(page.getByRole('button', { name: '已选', exact: true })).toBeVisible()
  })
})


test.describe('Archive species panel (local wiki data)', () => {
  test.beforeEach(async ({ page }) => {
    await mockBackend(page)
    await page.goto('/')
  })

  test('archive tab renders species cards', async ({ page }) => {
    await page.getByRole('button', { name: '羽迹', exact: true }).click()
    // 物种墙模式的卡片（mock 数据里有 4 个物种）
    await page.getByRole('button', { name: '物种', exact: true }).click()
    await expect(page.locator('[class*="archive-card"]').first()).toBeVisible({
      timeout: 5000,
    })
  })

  test('species detail panel shows Wikipedia link when available', async ({ page }) => {
    await page.getByRole('button', { name: '羽迹', exact: true }).click()
    await page.getByRole('button', { name: '物种', exact: true }).click()
    // 点击第一个物种卡片
    await page.locator('[class*="archive-card"]').first().click()
    // mock-workspace 里首选物种（按分数排序）应是须浮鸥或翠鸟（Wikipedia 都有对应页）
    // 等待右侧详情面板出现 Wikipedia → 外链
    await expect(page.getByText('Wikipedia →')).toBeVisible({ timeout: 5000 })
    const link = page.getByText('Wikipedia →')
    const href = await link.getAttribute('href')
    expect(href).toMatch(/wikipedia\.org/)
  })
})

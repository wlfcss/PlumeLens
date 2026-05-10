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

interface TestPhotoFixture {
  id: string
  file_name: string
  species: string
  latin: string
  grade: 'select' | 'usable' | 'record' | 'reject'
  score: number
  analysisStatus?: 'done' | 'failed'
  birdCount?: number
  bbox?: { x1: number; y1: number; x2: number; y2: number; confidence: number }
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

const TEST_LIB_2 = {
  id: 'lib-other',
  display_name: '备用库',
  parent_path: '/tmp',
  root_path: '/tmp/lib-other',
  status: 'ready',
  total_count: 1,
  analyzed_count: 1,
  recursive: true,
  last_opened_at: '2026-04-22T07:00:00+00:00',
  last_scanned_at: '2026-04-22T07:00:00+00:00',
  last_analyzed_at: '2026-04-22T07:00:00+00:00',
}

const TEST_PHOTOS: TestPhotoFixture[] = [
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

const TEST_PHOTOS_OTHER: TestPhotoFixture[] = [
  {
    id: 'q1',
    file_name: 'OTHER_0001.JPG',
    species: '红嘴蓝鹊',
    latin: 'Urocissa erythroryncha',
    grade: 'select',
    score: 0.88,
  },
]

const TEST_STACK_PHOTOS: TestPhotoFixture[] = [
  {
    id: 's1',
    file_name: 'STACK_0001.JPG',
    species: '印度寿带',
    latin: 'Terpsiphone paradisi',
    grade: 'record',
    score: 0.567,
    bbox: { x1: 1700, y1: 800, x2: 2200, y2: 2200, confidence: 0.93 },
  },
  {
    id: 's2',
    file_name: 'STACK_0002.JPG',
    species: '印度寿带',
    latin: 'Terpsiphone paradisi',
    grade: 'record',
    score: 0.577,
    bbox: { x1: 1710, y1: 800, x2: 2210, y2: 2200, confidence: 0.93 },
  },
  {
    id: 's3',
    file_name: 'STACK_0003.JPG',
    species: '白鹭',
    latin: 'Egretta garzetta',
    grade: 'usable',
    score: 0.681,
    bbox: { x1: 2700, y1: 780, x2: 3220, y2: 2180, confidence: 0.91 },
  },
  {
    id: 's4',
    file_name: 'STACK_0004.JPG',
    species: '白鹭',
    latin: 'Egretta garzetta',
    grade: 'usable',
    score: 0.693,
    bbox: { x1: 2710, y1: 780, x2: 3230, y2: 2180, confidence: 0.91 },
  },
]

const TEST_SINGLE_BURST_PHOTOS: TestPhotoFixture[] = Array.from({ length: 12 }, (_, idx) => ({
  id: `burst-${idx + 1}`,
  file_name: `5Y3A${String(8091 + idx)}.JPG`,
  species: '东亚石䳭',
  latin: 'Saxicola stejnegeri',
  grade: idx % 4 === 0 ? 'select' : 'usable',
  score: Math.max(0.61, 0.772 - idx * 0.014),
}))

const TEST_DRIFT_STACK_PHOTOS: TestPhotoFixture[] = Array.from({ length: 6 }, (_, idx) => ({
  id: `drift-${idx + 1}`,
  file_name: `DRIFT_${String(idx + 1).padStart(4, '0')}.JPG`,
  species: idx === 3 ? '寿带' : '印度寿带',
  latin: idx === 3 ? 'Terpsiphone incei' : 'Terpsiphone paradisi',
  grade: idx === 0 ? 'select' : 'usable',
  score: Math.max(0.65, 0.754 - idx * 0.008),
  bbox: {
    x1: 900 + idx * 290,
    y1: 800,
    x2: 1400 + idx * 290,
    y2: 2200,
    confidence: 0.93,
  },
}))

const TEST_MANY_GROUP_PHOTOS: TestPhotoFixture[] = Array.from({ length: 64 }, (_, idx) => {
  const grade = (['select', 'usable', 'record', 'reject'] as const)[idx % 4]
  const species = (['白鹭', '东亚石䳭', '印度寿带'] as const)[idx % 3]
  const latin =
    species === '白鹭'
      ? 'Egretta garzetta'
      : species === '东亚石䳭'
        ? 'Saxicola stejnegeri'
        : 'Terpsiphone paradisi'

  return {
    id: `many-${idx + 1}`,
    file_name: `MANY_${String(idx + 1).padStart(4, '0')}.JPG`,
    species,
    latin,
    grade,
    score: Math.max(0.42, 0.88 - idx * 0.006),
  }
})

async function mockBackend(
  page: Page,
  options: {
    driftingStack?: boolean
    includeFailed?: boolean
    manyGroups?: boolean
    singleBurstScene?: boolean
    stackedBursts?: boolean
  } = {},
): Promise<void> {
  const primaryPhotosBase = options.manyGroups
    ? TEST_MANY_GROUP_PHOTOS
    : options.driftingStack
      ? TEST_DRIFT_STACK_PHOTOS
      : options.singleBurstScene
        ? TEST_SINGLE_BURST_PHOTOS
        : options.stackedBursts
          ? TEST_STACK_PHOTOS
          : TEST_PHOTOS
  const failedPhoto: TestPhotoFixture = {
    id: 'failed-1',
    file_name: 'BROKEN_0005.JPG',
    species: '未识别',
    latin: 'Unknown',
    grade: 'reject',
    score: 0,
    analysisStatus: 'failed',
    birdCount: 0,
  }
  const primaryPhotos: TestPhotoFixture[] = options.includeFailed
    ? [...primaryPhotosBase, failedPhoto]
    : primaryPhotosBase
  let libraryState = {
    ...TEST_LIB,
    analyzed_count: primaryPhotos.length,
    total_count: primaryPhotos.length,
  }
  let libraryState2 = { ...TEST_LIB_2 }

  await page.addInitScript(() => {
    const openedFinderPaths: string[] = []
    const openedExternalUrls: string[] = []
    ;(window as unknown as { __openedFinderPaths: string[] }).__openedFinderPaths =
      openedFinderPaths
    ;(window as unknown as { __openedExternalUrls: string[] }).__openedExternalUrls =
      openedExternalUrls
    ;(window as unknown as { plumelens: Record<string, unknown> }).plumelens = {
      getBackendUrl: async () => 'http://127.0.0.1:8000',
      // playwright e2e 走 vite-served renderer,无 preload engineRequest;
      // api-client 自动走 fallback fetch,本测试不验证 preload 内部。
      getAppVersion: async () => '0.1.0',
      openFolder: async () => null,
      selectExportDirectory: async () => '/tmp/plumelens-export',
      openLogsDir: async () => '',
      openPathInFinder: async (path: string) => {
        openedFinderPaths.push(path)
        return { ok: true }
      },
      openExternalUrl: async (url: string) => {
        openedExternalUrls.push(url)
        return { ok: true }
      },
      onBackendReady: () => {},
      onBackendError: () => {},
      onEngineStatus: (callback: (payload: { kind: 'ready'; url: string }) => void) => {
        window.setTimeout(() => callback({ kind: 'ready', url: 'http://127.0.0.1:8000' }), 0)
        return () => {}
      },
      listEditors: async () => ({ topaz: null, photoshop: null }),
      openInEditor: async () => ({ ok: false, reason: 'not_installed' }),
      getUserSettings: async () => ({}),
      saveUserSettings: async (partial: Record<string, unknown>) => partial,
      restartEngine: async () => true,
    }
  })
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
          models: {
            yolo: { loaded: true, provider: 'CoreMLExecutionProvider' },
            bird_visibility: { loaded: true, provider: 'CoreMLExecutionProvider' },
            clipiqa: { loaded: true, provider: 'CoreMLExecutionProvider' },
            hyperiqa: { loaded: true, provider: 'CoreMLExecutionProvider' },
            dinov3_species_v4: { loaded: true, provider: 'torch:mps:torch.bfloat16' },
          },
        },
      }),
    }),
  )
  await page.route('**/archive/geo/summary', (route: Route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        total_with_gps: 2,
        resolved: 2,
        pending: 0,
        photos_without_gps: 2,
      }),
    }),
  )
  await page.route('**/archive/geo/provinces', (route: Route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify([{ province: '上海市', photo_count: 2, species_count: 2 }]),
    }),
  )
  await page.route('**/archive/geo/cities?*', (route: Route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify([{ city: '上海市', photo_count: 2, species_count: 2 }]),
    }),
  )
  await page.route('**/archive/geo/spots?*', (route: Route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify([
        {
          lat: 31.23,
          lon: 121.47,
          place: '测试湿地',
          photo_count: 2,
          species_count: 2,
          species: [
            {
              name: '须浮鸥',
              latin_name: 'Chlidonias hybrida',
              english_name: 'whiskered tern',
              photo_count: 1,
            },
            { name: '翠鸟', latin_name: 'Alcedo atthis', english_name: null, photo_count: 1 },
          ],
          photos: [
            {
              photo_id: 'p1',
              file_name: 'IMG_0001.JPG',
              species: [
                {
                  name: '须浮鸥',
                  latin_name: 'Chlidonias hybrida',
                  english_name: 'whiskered tern',
                  photo_count: 1,
                },
              ],
              species_latin: 'Chlidonias hybrida',
              species_zh: '须浮鸥',
              thumb_grid: null,
              grade: 'select',
              quality_score: 0.91,
            },
          ],
        },
      ]),
    }),
  )
  await page.route('**/library', (route: Route) => {
    if (route.request().method() === 'GET') {
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify([libraryState, libraryState2]),
      })
    } else {
      route.fallback()
    }
  })
  await page.route('**/library/lib-test', async (route: Route) => {
    if (route.request().method() === 'PATCH') {
      const body = JSON.parse(route.request().postData() ?? '{}')
      libraryState = {
        ...libraryState,
        display_name: String(body.display_name ?? '').trim(),
      }
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(libraryState),
      })
      return
    }
    const photos = primaryPhotos.map((p, idx) => {
      const burstSecond =
        options.driftingStack || options.singleBurstScene
          ? idx
          : options.stackedBursts
            ? idx + (idx >= 2 ? 3 : 0)
            : idx < 2
              ? idx
              : idx * 20
      const manyGroupHour = 7 + Math.floor(idx / 60)
      const manyGroupMinute = idx % 60
      const shotAt = options.manyGroups
        ? `2026-04-23T${String(manyGroupHour).padStart(2, '0')}:${String(manyGroupMinute).padStart(2, '0')}:00+00:00`
        : options.driftingStack || options.singleBurstScene || options.stackedBursts
          ? `2026-04-23T07:00:${String(burstSecond).padStart(2, '0')}+00:00`
          : `2026-04-23T07:0${idx}:00+00:00`
      const bbox = p.bbox ?? { x1: 1700, y1: 800, x2: 2200, y2: 2200, confidence: 0.93 }

      return {
        id: p.id,
        file_path: `/tmp/lib-test/${p.file_name}`,
        file_name: p.file_name,
        format: 'jpg',
        width: 4000,
        height: 3000,
        thumb_grid: null,
        thumb_preview: `preview/${p.id}.jpg`,
        created_at: shotAt,
        shot_at: shotAt,
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
        scene_id:
          options.driftingStack || options.singleBurstScene || options.stackedBursts ? 111 : idx,
        pipeline_version: 'v1-mock',
        grade: p.grade,
        quality_score: p.score,
        bird_count: p.birdCount ?? 1,
        analysis_status: p.analysisStatus ?? 'done',
        analysis_error_code: p.analysisStatus === 'failed' ? 'decode_error' : null,
        analysis_error: p.analysisStatus === 'failed' ? 'mock decode error' : null,
        species: p.species,
        species_latin: p.latin,
        decision: null,
        best_detection:
          p.analysisStatus === 'failed'
            ? null
            : {
                index: 0,
                bbox,
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
          p.analysisStatus === 'failed'
            ? null
            : p.id === 'p1'
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
      }
    })
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ library: libraryState, photos }),
    })
  })
  await page.route('**/library/lib-other', async (route: Route) => {
    if (route.request().method() === 'PATCH') {
      const body = JSON.parse(route.request().postData() ?? '{}')
      libraryState2 = {
        ...libraryState2,
        display_name: String(body.display_name ?? '').trim(),
      }
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(libraryState2),
      })
      return
    }
    const photos = TEST_PHOTOS_OTHER.map((p, idx) => ({
      id: p.id,
      file_path: `/tmp/lib-other/${p.file_name}`,
      file_name: p.file_name,
      format: 'jpg',
      width: 4000,
      height: 3000,
      thumb_grid: null,
      thumb_preview: `preview/${p.id}.jpg`,
      created_at: `2026-04-22T07:0${idx}:00+00:00`,
      shot_at: `2026-04-22T07:0${idx}:00+00:00`,
      exif: null,
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
            canonical_en: 'red-billed blue magpie',
            confidence: p.score,
          },
        ],
      },
      detections: null,
    }))
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ library: libraryState2, photos }),
    })
  })
  await page.route('**/export/library/**', (route: Route) => {
    const libraryId = route.request().url().split('/export/library/')[1]
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        library_id: libraryId,
        output_dir: `/tmp/plumelens-export/${libraryId}-20260505-120000`,
        selected_count: 2,
        exported_count: 2,
        companion_count: 0,
        xmp_count: 2,
        skipped_missing: 0,
        failed_count: 0,
        manifest: {
          json: `/tmp/plumelens-export/${libraryId}-20260505-120000/鉴翎导出报告.json`,
          csv: `/tmp/plumelens-export/${libraryId}-20260505-120000/鉴翎导出清单.csv`,
        },
      }),
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

async function waitForSelectionScrollSettled(page: Page): Promise<void> {
  await page.locator('.selection-main.selection-scroll').evaluate((node) => {
    const scroller = node as HTMLElement
    return new Promise<void>((resolve) => {
      let previousTop = scroller.scrollTop
      let stableFrames = 0
      let frameCount = 0

      const tick = () => {
        const currentTop = scroller.scrollTop
        stableFrames = Math.abs(currentTop - previousTop) < 0.5 ? stableFrames + 1 : 0
        previousTop = currentTop
        frameCount += 1

        if (stableFrames >= 2 || frameCount >= 12) {
          resolve()
          return
        }

        requestAnimationFrame(tick)
      }

      requestAnimationFrame(tick)
    })
  })
}

test.describe('Photo stack interactions (mock backend)', () => {
  test('stack action hints only reveal on hover and expanded stacks can collapse', async ({
    page,
  }) => {
    await mockBackend(page, { stackedBursts: true })
    await page.goto('/')
    await page.getByRole('button', { name: '选片', exact: true }).click()

    const stackGroup = page.locator('.photo-group').first()
    const expand = page.getByRole('button', { name: '展开 2 张连拍' }).first()
    await expect(expand).toBeVisible()
    await expect(stackGroup.locator('.photo-tile')).toHaveCount(2)
    await expect(page.getByRole('button', { name: '展开 1 张连拍' })).toHaveCount(0)
    await expect(page.getByRole('button', { name: '收起 1 张连拍' })).toHaveCount(0)
    await expect(
      page.locator('.photo-stack-action__count').filter({ hasText: /×\s*1/ }),
    ).toHaveCount(0)
    await expect(expand.locator('.photo-stack-action__hint')).toHaveCSS('opacity', '0')

    await expand.hover()
    await expect(expand.locator('.photo-stack-action__hint')).toHaveCSS('opacity', '1')
    await expand.click()

    const collapse = page.getByRole('button', { name: '收起 2 张连拍' }).first()
    await expect(collapse).toBeVisible()
    await expect(stackGroup.locator('.photo-tile')).toHaveCount(3)
    await waitForSelectionScrollSettled(page)
    await expect(collapse.locator('.photo-stack-action__hint')).toHaveCSS('opacity', '0')

    await collapse.hover()
    await expect(collapse.locator('.photo-stack-action__hint')).toHaveCSS('opacity', '1')
    await collapse.click()

    await expect(page.getByRole('button', { name: '展开 2 张连拍' }).first()).toBeVisible()
    await expect(stackGroup.locator('.photo-tile')).toHaveCount(2)
    await expect(page.getByRole('button', { name: '收起 2 张连拍' })).toHaveCount(0)
    await expect(page.getByRole('button', { name: '展开 1 张连拍' })).toHaveCount(0)
    await expect(page.getByRole('button', { name: '收起 1 张连拍' })).toHaveCount(0)

    await stackGroup.locator('.photo-preview--stack').first().click()
    await page.keyboard.press('Space')
    await expect(page.locator('.review-panel')).toBeVisible()
    await expect(page.locator('.review-heading h2')).toContainText('STACK_0002.JPG')
  })

  test('single-stack scenes start expanded while keeping the stack affordance', async ({
    page,
  }) => {
    await mockBackend(page, { singleBurstScene: true })
    await page.goto('/')
    await page.getByRole('button', { name: '选片', exact: true }).click()

    const collapse = page.getByRole('button', { name: '收起 12 张连拍' })
    await expect(collapse).toBeVisible()
    await expect(page.getByRole('button', { name: '展开 12 张连拍' })).toHaveCount(0)
    await expect(
      page.locator('.photo-stack-action__count').filter({ hasText: /×\s*12/ }),
    ).toHaveCount(1)
    await expect(page.locator('.photo-tile')).toHaveCount(12)

    await collapse.click()
    await expect(page.getByRole('button', { name: '展开 12 张连拍' })).toBeVisible()
    await expect(page.locator('.photo-tile')).toHaveCount(1)
  })

  test('slowly drifting subjects stay in one burst stack despite species label jitter', async ({
    page,
  }) => {
    await mockBackend(page, { driftingStack: true })
    await page.goto('/')
    await page.getByRole('button', { name: '选片', exact: true }).click()

    const stackGroup = page.locator('.photo-group').first()
    const collapse = page.getByRole('button', { name: '收起 6 张连拍' })

    await expect(collapse).toBeVisible()
    await expect(stackGroup.locator('.photo-tile')).toHaveCount(6)
    await expect(
      page.locator('.photo-stack-action__count').filter({ hasText: /×\s*[2345]/ }),
    ).toHaveCount(0)
    await expect(stackGroup).toContainText('DRIFT_0006.JPG')

    await collapse.click()
    await expect(page.getByRole('button', { name: '展开 6 张连拍' })).toBeVisible()
    await expect(stackGroup.locator('.photo-tile')).toHaveCount(1)
  })

  test('deep review navigation leaves the active burst stack', async ({ page }) => {
    await mockBackend(page, { stackedBursts: true })
    await page.goto('/')
    await page.getByRole('button', { name: '选片', exact: true }).click()

    const stackGroup = page.locator('.photo-group').first()
    await page.getByRole('button', { name: '展开 2 张连拍' }).first().click()
    await stackGroup.locator('.photo-tile').nth(1).locator('.photo-preview').dblclick()

    await expect(page.locator('.review-panel')).toBeVisible()
    await expect(page.locator('.review-heading h2')).toContainText('STACK_0002.JPG')
    await expect(page.locator('.review-sequence--stack')).toBeVisible()
    await expect(page.locator('.review-filmstrip__item')).toHaveCount(4)
    await expect(page.locator('.review-filmstrip__meta small')).toHaveText([
      'STACK_0001.JPG',
      'STACK_0002.JPG',
      'STACK_0003.JPG',
      'STACK_0004.JPG',
    ])

    await page.keyboard.press('ArrowRight')
    await expect(page.locator('.review-heading h2')).toContainText('STACK_0003.JPG')
  })

  test('grouped scenes stay time-ordered and never overlap', async ({ page }) => {
    await mockBackend(page)
    await page.goto('/')
    await page.getByRole('button', { name: '选片', exact: true }).click()

    const groups = page.locator('.photo-group')
    await expect(groups).toHaveCount(3)
    await expect(groups.first()).toContainText('IMG_0003.JPG')

    await page.getByRole('button', { name: '文件名' }).click()
    await expect(groups.first()).toContainText('IMG_0003.JPG')

    const groupRects = await groups.evaluateAll((nodes) =>
      nodes.map((node) => {
        const rect = node.getBoundingClientRect()
        return { bottom: rect.bottom, top: rect.top }
      }),
    )
    for (let index = 1; index < groupRects.length; index += 1) {
      expect(groupRects[index].top).toBeGreaterThanOrEqual(groupRects[index - 1].bottom + 24)
    }
  })

  test('compact quick filters preserve the current scroll position', async ({ page }) => {
    await page.setViewportSize({ width: 1680, height: 1040 })
    await mockBackend(page, { manyGroups: true })
    await page.goto('/')
    await page.getByRole('button', { name: '选片', exact: true }).click()

    const scroller = page.locator('.selection-main.selection-scroll')
    await expect(page.locator('.photo-group').first()).toBeVisible()
    await scroller.evaluate((node) => {
      const scrollerElement = node as HTMLElement
      scrollerElement.scrollTo({ top: 1200 })
      scrollerElement.dispatchEvent(new Event('scroll', { bubbles: true }))
    })
    await waitForSelectionScrollSettled(page)

    const before = await scroller.evaluate((node) => (node as HTMLElement).scrollTop)
    expect(before).toBeGreaterThan(900)

    const compactFilters = page.locator('.selection-compact-filter-row')
    await expect(page.locator('.selection-compact-header--visible')).toBeVisible()
    await expect(compactFilters).toBeVisible()
    await compactFilters.getByRole('button', { name: '可用', exact: true }).click()
    await waitForSelectionScrollSettled(page)

    const after = await scroller.evaluate((node) => (node as HTMLElement).scrollTop)
    expect(after).toBeGreaterThan(before - 120)
  })

  test('back-to-top returns the virtualized selection list to the absolute top', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1680, height: 1040 })
    await mockBackend(page, { manyGroups: true })
    await page.goto('/')
    await page.getByRole('button', { name: '选片', exact: true }).click()

    const scroller = page.locator('.selection-main.selection-scroll')
    await expect(page.locator('.photo-group').first()).toBeVisible()
    await scroller.evaluate((node) => {
      const scrollerElement = node as HTMLElement
      const maxScroll = Math.max(0, scrollerElement.scrollHeight - scrollerElement.clientHeight)
      scrollerElement.scrollTo({ top: Math.max(2400, maxScroll * 0.45) })
      scrollerElement.dispatchEvent(new Event('scroll', { bubbles: true }))
    })
    await waitForSelectionScrollSettled(page)

    const before = await scroller.evaluate((node) => (node as HTMLElement).scrollTop)
    expect(before).toBeGreaterThan(1800)
    await expect(page.locator('.selection-scroll-top--visible')).toBeVisible()

    await page.getByRole('button', { name: '回到顶部' }).click()

    await expect
      .poll(async () => scroller.evaluate((node) => (node as HTMLElement).scrollTop), {
        timeout: 2500,
      })
      .toBeLessThan(2)
    await expect(page.locator('.folder-topline h1')).toBeVisible()
    await expect(page.locator('.selection-compact-header--visible')).toHaveCount(0)
  })
})

test.describe('Selection metric layout (mock backend)', () => {
  test.use({ viewport: { width: 1080, height: 720 } })

  test('keeps the failed metric in the first row at default window width', async ({ page }) => {
    await mockBackend(page, { includeFailed: true })
    await page.goto('/')
    await page.getByRole('button', { name: '选片', exact: true }).click()

    const strip = page.locator('.metric-strip--selection')
    const cells = strip.locator('.metric-cell')

    await expect(strip).toBeVisible()
    await expect(cells).toHaveCount(7)

    const cellRects = await cells.evaluateAll((nodes) =>
      nodes.map((node) => {
        const rect = node.getBoundingClientRect()
        return { height: rect.height, left: rect.left, top: Math.round(rect.top) }
      }),
    )
    expect(new Set(cellRects.map((rect) => rect.top)).size).toBe(1)
    expect(cellRects[6].left).toBeGreaterThan(cellRects[5].left)

    const stripBox = await strip.boundingBox()
    expect(stripBox?.height).toBeLessThan(90)
  })
})

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

  test('folder alias can be edited and used by export drawer', async ({ page }) => {
    await expect(page.locator('.folder-topline h1')).toContainText('测试库')

    await page.getByRole('button', { name: '编辑文件夹别名' }).click()
    await page.getByRole('textbox', { name: '文件夹别名' }).fill('洋湖湿地早晨')
    const updateRequest = page.waitForRequest(
      (request) => request.method() === 'PATCH' && request.url().endsWith('/library/lib-test'),
    )
    await page.getByRole('button', { name: '保存文件夹别名' }).click()

    expect(JSON.parse((await updateRequest).postData() ?? '{}')).toEqual({
      display_name: '洋湖湿地早晨',
    })
    await expect(page.locator('.folder-topline h1')).toContainText('洋湖湿地早晨')
    await expect(page.locator('.folder-rail-item--active')).toContainText('洋湖湿地早晨')

    await page.locator('.folder-actions').getByRole('button', { name: '导出' }).click()
    await expect(page.locator('.export-sidecar')).toContainText('洋湖湿地早晨')
  })

  test('folder context menu can open Finder from start and selection lists', async ({ page }) => {
    await page.locator('.folder-rail-item--active').click({ button: 'right' })
    await page.getByRole('menuitem', { name: '在 Finder 中打开' }).click()
    await expect
      .poll(() =>
        page.evaluate(
          () => (window as unknown as { __openedFinderPaths: string[] }).__openedFinderPaths,
        ),
      )
      .toContain('/tmp/lib-test')

    await page.getByRole('button', { name: '开始', exact: true }).click()
    await page.locator('.folder-line').first().click({ button: 'right' })
    await page.getByRole('menuitem', { name: '在 Finder 中打开' }).click()
    await expect
      .poll(() =>
        page.evaluate(
          () => (window as unknown as { __openedFinderPaths: string[] }).__openedFinderPaths,
        ),
      )
      .toContain('/tmp/lib-test')
  })

  test('export drawer supports manual grade and score range', async ({ page }) => {
    await page.locator('.folder-actions').getByRole('button', { name: '导出' }).click()
    await expect(page.locator('.export-sidecar')).toBeVisible()
    await expect(page.getByText('当前范围将导出 3 张')).toBeVisible()
    await expect(page.getByRole('button', { name: /合并导出/ })).toBeVisible()
    await page.getByRole('button', { name: /按评级分类/ }).click()
    await expect(page.getByText('文件夹 / 评级 / 照片')).toBeVisible()

    await page.getByLabel('淘汰').check()
    await expect(page.getByText('当前范围将导出 4 张')).toBeVisible()

    await page.getByPlaceholder('最低').fill('50')
    await expect(page.getByText('当前范围将导出 2 张')).toBeVisible()

    await page.getByRole('button', { name: '选择位置' }).click()
    await expect(page.getByText('/tmp/plumelens-export')).toBeVisible()

    await page.getByRole('button', { name: '收起' }).first().click()
    await expect(page.locator('.export-sidecar--collapsed')).toBeVisible()
    await page.getByRole('button', { name: '展开' }).click()

    const requestPromise = page.waitForRequest('**/export/library/lib-test')
    await page.getByRole('button', { name: '开始导出' }).click()
    expect(JSON.parse((await requestPromise).postData() ?? '{}')).toMatchObject({
      layout: 'by_grade',
    })
    await expect(page.locator('.export-sidecar--collapsed')).toBeVisible()
    await expect(page.getByText('导出完成')).toBeVisible()
    await page.getByRole('button', { name: '展开' }).click()
    await expect(
      page.getByText('已导出 2 张，附带 0 个同伴文件，写入 2 条 XMP 元数据，失败 0 张'),
    ).toBeVisible()
  })

  test('export running collapses and does not block space review shortcut', async ({ page }) => {
    let releaseExport: (() => void) | null = null
    const exportRelease = new Promise<void>((resolve) => {
      releaseExport = resolve
    })

    await page.unroute('**/export/library/**')
    await page.route('**/export/library/lib-test', async (route: Route) => {
      await exportRelease
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          library_id: 'lib-test',
          output_dir: '/tmp/plumelens-export/测试库-20260505-120000',
          selected_count: 2,
          exported_count: 2,
          companion_count: 0,
          xmp_count: 2,
          skipped_missing: 0,
          failed_count: 0,
          manifest: {
            json: '/tmp/plumelens-export/测试库-20260505-120000/鉴翎导出报告.json',
            csv: '/tmp/plumelens-export/测试库-20260505-120000/鉴翎导出清单.csv',
          },
        }),
      })
    })

    await page.locator('.folder-actions').getByRole('button', { name: '导出' }).click()
    await page.getByRole('button', { name: '选择位置' }).click()
    await page.getByRole('button', { name: '开始导出' }).click()

    await expect(page.locator('.export-sidecar--collapsed')).toBeVisible()
    await expect(page.getByText('正在导出')).toBeVisible()

    await page.getByRole('button', { name: /IMG_0001\.JPG/ }).click()
    await page.keyboard.press('Space')
    await expect(page.locator('.review-panel')).toBeVisible()
    await expect(page.locator('.review-heading h2')).toContainText('IMG_0001.JPG')

    releaseExport?.()
    await expect(page.getByText('导出完成')).toBeVisible()
  })

  test('multiple folders can keep independent export sessions', async ({ page }) => {
    await page.locator('.folder-actions').getByRole('button', { name: '导出' }).click()
    await expect(page.locator('.export-sidecar')).toHaveCount(1)
    await expect(page.locator('.export-sidecar').first()).toContainText('测试库')
    await expect(page.locator('.export-sidecar').first()).toContainText('当前范围将导出 3 张')

    await page.getByRole('button', { name: /备用库/ }).click()
    await expect(page.locator('.folder-topline h1')).toContainText('备用库')
    await page.locator('.folder-actions').getByRole('button', { name: '导出' }).click()

    const sidecars = page.locator('.export-sidecar')
    await expect(sidecars).toHaveCount(2)
    await expect(sidecars.nth(0)).toContainText('测试库')
    await expect(sidecars.nth(0)).toContainText('当前范围将导出 3 张')
    await expect(sidecars.nth(1)).toContainText('备用库')
    await expect(sidecars.nth(1)).toContainText('当前范围将导出 1 张')

    await sidecars.nth(0).getByRole('button', { name: '选择位置' }).click()
    await sidecars.nth(1).getByRole('button', { name: '选择位置' }).click()

    const requests: Promise<string>[] = [
      page.waitForRequest('**/export/library/lib-test').then((request) => request.url()),
      page.waitForRequest('**/export/library/lib-other').then((request) => request.url()),
    ]
    await sidecars.nth(0).getByRole('button', { name: '开始导出' }).click()
    await sidecars.nth(1).getByRole('button', { name: '开始导出' }).click()

    await expect(page.locator('.export-sidecar--collapsed')).toHaveCount(2)
    expect(await Promise.all(requests)).toHaveLength(2)
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

    const poseChips = page.locator('.review-pose-chips')
    await expect(poseChips).toBeVisible()
    await expect(poseChips).toContainText('可见性')
    await expect(poseChips.locator('.review-pose-chips__chip--muted')).toHaveCount(1)
    await expect(poseChips).toContainText('暂无结果')
    await expect(page.locator('.compact-kv').filter({ hasText: '姿态' })).toContainText('暂无结果')

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

    const detailLayout = await page.locator('.review-detail').evaluate((element) => {
      const detailRect = element.getBoundingClientRect()
      const footerRect = element.querySelector('.review-detail__footer')?.getBoundingClientRect()
      const actionsRect = element
        .querySelector('.inspector-actions--compact')
        ?.getBoundingClientRect()
      const scoreChildren = Array.from(element.querySelector('.score-header')?.children ?? []).map(
        (child) => {
          const rect = child.getBoundingClientRect()
          return { bottom: rect.bottom, top: rect.top }
        },
      )
      const scoreHasOverlap = scoreChildren.some(
        (rect, index) => index > 0 && rect.top < scoreChildren[index - 1].bottom - 0.5,
      )
      return {
        actionsBottom: actionsRect?.bottom ?? 0,
        detailBottom: detailRect.bottom,
        footerBottom: footerRect?.bottom ?? 0,
        scoreHasOverlap,
      }
    })
    expect(detailLayout.scoreHasOverlap).toBe(false)
    expect(Math.abs(detailLayout.detailBottom - detailLayout.footerBottom)).toBeLessThanOrEqual(1)
    expect(detailLayout.actionsBottom).toBeLessThanOrEqual(detailLayout.detailBottom + 1)

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

  test('deep review opens GPS coordinates through the external URL bridge', async ({ page }) => {
    await page.getByRole('button', { name: /IMG_0001\.JPG/ }).dblclick()
    await expect(page.locator('.review-panel')).toBeVisible()

    const gpsLink = page.locator('a.compact-kv__value--link[href*="maps.apple.com"]').first()
    await expect(gpsLink).toBeVisible()
    await gpsLink.click()

    await expect
      .poll(() =>
        page.evaluate(
          () => (window as unknown as { __openedExternalUrls: string[] }).__openedExternalUrls,
        ),
      )
      .toContainEqual(expect.stringContaining('https://maps.apple.com/'))
    await expect
      .poll(() =>
        page.evaluate(
          () => (window as unknown as { __openedExternalUrls: string[] }).__openedExternalUrls,
        ),
      )
      .toContainEqual(expect.stringContaining('q=31.61667%2C121.50000'))
  })

  test('deep review exposes zoom scale controls and fullscreen viewer', async ({ page }) => {
    await page.locator('.photo-preview').first().dblclick()
    await expect(page.locator('.review-panel')).toBeVisible()

    const primaryPane = page.locator('.review-stage__pane').first()
    await expect(primaryPane.getByRole('button', { name: '1.5 倍放大' })).toBeVisible()
    await primaryPane.getByRole('button', { name: '4 倍放大' }).click()
    await expect(primaryPane.getByRole('button', { name: '4 倍放大' })).toHaveClass(
      /review-zoom-control__item--active/,
    )

    const primaryImage = primaryPane.locator('.review-image')
    const primaryBox = await primaryImage.boundingBox()
    expect(primaryBox).not.toBeNull()
    await page.mouse.move(primaryBox!.x + 120, primaryBox!.y + 120)
    await page.mouse.down()
    await expect(primaryImage).toHaveClass(/review-image--loupe-active/)
    await page.mouse.up()
    await expect(primaryImage).not.toHaveClass(/review-image--loupe-active/)

    await primaryPane.getByRole('button', { name: '全屏查看' }).click()
    const fullscreen = page.locator('.review-fullscreen')
    await expect(fullscreen).toBeVisible()
    await expect(fullscreen.locator('.detect-box, .af-area, .af-point, .pose-point')).toHaveCount(0)

    const fullscreenImage = fullscreen.locator('.review-image')
    await fullscreen.getByRole('button', { name: '2.5 倍放大' }).click()
    const fullscreenBox = await fullscreenImage.boundingBox()
    expect(fullscreenBox).not.toBeNull()
    await page.mouse.move(fullscreenBox!.x + 240, fullscreenBox!.y + 180)
    await page.mouse.down()
    await expect(fullscreenImage).toHaveClass(/review-image--loupe-active/)
    await page.mouse.up()

    await page.keyboard.press('Escape')
    await expect(fullscreen).toHaveCount(0)
    await expect(page.locator('.review-panel')).toBeVisible()
  })

  test('deep review supports keyboard/photo strip navigation', async ({ page }) => {
    await page.locator('.photo-preview').first().dblclick()
    await expect(page.locator('.review-panel')).toBeVisible()
    await expect(page.locator('.review-heading h2')).toContainText('IMG_0003.JPG')
    await expect(page.locator('.review-sequence--single')).toBeVisible()
    // 默认筛选只展示精选 / 可用 / 记录，淘汰照片不进入当前复审胶片条。
    await expect(page.locator('.review-filmstrip__item')).toHaveCount(3)

    await page.keyboard.press('ArrowRight')
    await expect(page.locator('.review-heading h2')).toContainText('IMG_0002.JPG')

    await page.locator('.review-filmstrip__item').nth(2).click()
    await expect(page.locator('.review-heading h2')).toContainText('IMG_0001.JPG')

    await page.keyboard.press('Escape')
    await expect(page.locator('.review-panel')).toHaveCount(0)
  })

  test('deep review can override species per bird detection', async ({ page }) => {
    await page.getByRole('button', { name: /IMG_0001\.JPG/ }).dblclick()
    await expect(page.locator('.review-panel')).toBeVisible()

    await expect(page.locator('.species-editor__bird')).toHaveCount(2)
    await page.getByRole('button', { name: '鸟 2' }).click()
    await page.locator('.species-editor__current--toggle').click()
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
    await page
      .getByRole('button', { name: /已点亮/ })
      .first()
      .click()
    await expect(page.locator('.collection-card--lit').first()).toBeVisible({
      timeout: 5000,
    })
    await expect(page.locator('.collection-toolbar')).toHaveCount(0)

    await page
      .getByRole('button', { name: /国家一级保护/ })
      .first()
      .click()
    await expect(page.locator('.archive-filter-cell--protected1')).toHaveAttribute(
      'aria-pressed',
      'true',
    )
    await expect(page.locator('.collection-section__heading')).toHaveCount(1)
    await expect(page.locator('.collection-section__heading')).toContainText('国家一级保护')

    await page.getByRole('button', { name: /图鉴总数/ }).click()
    await expect(page.locator('.archive-filter-cell--all')).toHaveAttribute('aria-pressed', 'true')
  })

  test('species detail panel shows Wikipedia link when available', async ({ page }) => {
    await page.getByRole('button', { name: '羽迹', exact: true }).click()
    await page.getByRole('button', { name: '物种', exact: true }).click()
    await page
      .getByRole('button', { name: /已点亮/ })
      .first()
      .click()
    await page.locator('.collection-card--lit').first().click()
    // mock-workspace 里首选物种（按分数排序）应是须浮鸥或翠鸟（Wikipedia 都有对应页）
    // 等待右侧详情面板出现 Wikipedia 外链
    await expect(page.getByText('中文维基百科 →')).toBeVisible({ timeout: 5000 })
    const link = page.getByText('中文维基百科 →')
    const href = await link.getAttribute('href')
    expect(href).toMatch(/wikipedia\.org/)
  })

  test('archive map renders ECharts geo data', async ({ page }) => {
    await page.getByRole('button', { name: '羽迹', exact: true }).click()
    await page.getByRole('button', { name: '地理分布', exact: true }).click()
    await expect(page.locator('.china-map-card')).toBeVisible()
    await expect(page.locator('.archive-geo__chart canvas')).toBeVisible()
    await expect(page.getByText('1 个省份有照片')).toBeVisible()
  })
})

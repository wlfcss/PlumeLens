/** Browser contracts for authoritative species facets; the fixtures do no model inference. */
import { readFileSync } from 'node:fs'
import { expect, test, type Page, type Route } from '@playwright/test'
import type {
  BirdDetectionDetail,
  LibrarySummary,
  PhotoRow,
  SelectionQuery,
  SelectionQueryResult,
} from '../../renderer/src/lib/api-client'

const KING = 'sci:Alcedo atthis'
const EGRET = 'sci:Egretta garzetta'
const UNKNOWN = 'state:unidentified'
const DEFAULT_GRADES = ['select', 'usable', 'record']
const APP_VERSION = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8'))
  .version as string

function bird(
  sci: string | null,
  name: string | null,
  source = 'model',
  flying = false,
  index = 0,
): BirdDetectionDetail {
  const point = { x: 100, y: 100, confidence: 0.9 }
  return {
    index,
    is_best: index === 0,
    bbox: { x1: 100 + index * 200, y1: 100, x2: 300 + index * 200, y2: 400, confidence: 0.95 },
    pose: {
      bill: point,
      crown: point,
      nape: point,
      left_eye: point,
      right_eye: point,
      belly: point,
      breast: point,
      back: point,
      tail: point,
      left_wing: point,
      right_wing: point,
      head_visible: true,
      eye_visible: true,
      body_visible: true,
      tail_visible: true,
      wings_visible: flying,
      posture: flying ? 'flying' : 'perched',
      posture_confidence: flying ? 0.9 : 0.1,
      posture_method: 'classifier',
      view_angle: 'side',
      facing: 'left',
    },
    quality: { combined: 0.78, clipiqa: 0.8, hyperiqa: 0.76 },
    species: name,
    species_latin: sci,
    species_source: source as BirdDetectionDetail['species_source'],
    manual_species: source === 'manual',
    species_candidates: sci
      ? [
          {
            canonical_sci: sci,
            canonical_zh: name,
            canonical_en: sci === 'Alcedo atthis' ? 'common kingfisher' : 'little egret',
            confidence: 0.8,
            recognition_state: source === 'model_unconfirmed' ? 'uncertain' : 'recognized',
          },
        ]
      : [],
  }
}

function photo(index: number, detections: BirdDetectionDetail[], grade = 'usable'): PhotoRow {
  return {
    id: `p${index}`,
    file_path: `/tmp/species/p${index}.JPG`,
    file_name: `SPECIES_${String(index).padStart(2, '0')}.JPG`,
    format: 'JPG',
    width: 1200,
    height: 800,
    thumb_grid: null,
    thumb_preview: null,
    created_at: '2026-11-17T08:00:00+08:00',
    shot_at: `2026-11-17T08:00:${String(index).padStart(2, '0')}+08:00`,
    scene_id: index,
    pipeline_version: 'species-test-v1',
    grade,
    quality_score: 0.9 - index * 0.02,
    bird_count: detections.length,
    species: detections[0]?.species ?? null,
    species_latin: detections[0]?.species_latin ?? null,
    species_source: detections[0]?.species_source ?? 'none',
    manual_species: false,
    decision: null,
    analysis_status: 'done',
    exif: null,
    best_detection: detections[0] ?? null,
    detections,
  }
}

function summarizeBird(detection: NonNullable<PhotoRow['best_detection']>) {
  const { pose, species_candidates, ...identity } = detection
  const keypoints = new Set([
    'bill',
    'crown',
    'nape',
    'left_eye',
    'right_eye',
    'belly',
    'breast',
    'back',
    'tail',
    'left_wing',
    'right_wing',
  ])
  return {
    ...identity,
    pose: pose
      ? Object.fromEntries(Object.entries(pose).filter(([name]) => !keypoints.has(name)))
      : null,
    candidate_confidence: species_candidates?.[0]?.confidence,
    candidate_recognition_state: species_candidates?.[0]?.recognition_state,
  }
}

function fixedPhotos(): PhotoRow[] {
  const rows = [
    photo(1, [bird('Alcedo atthis', '普通翠鸟')], 'select'),
    photo(2, [
      bird('Alcedo atthis', '普通翠鸟'),
      bird('Alcedo atthis', '普通翠鸟', 'model', false, 1),
    ]),
    photo(3, [bird('Alcedo atthis', '普通翠鸟', 'model_unconfirmed', true)]),
    photo(4, [bird('Alcedo atthis', '普通翠鸟', 'conflict')], 'record'),
    photo(5, [bird('Egretta garzetta', '白鹭', 'model', true)], 'select'),
    // The non-best kingfisher is perched; only the egret is flying.
    photo(6, [
      bird('Egretta garzetta', '白鹭', 'model', true),
      bird('Alcedo atthis', '普通翠鸟', 'model', false, 1),
    ]),
    photo(7, [bird(null, null, 'none', true)], 'record'),
    photo(8, [bird('Urocissa erythroryncha', '红嘴蓝鹊')], 'select'),
    photo(9, [bird('Alcedo atthis', '普通翠鸟', 'model', true)], 'reject'),
    {
      ...photo(10, [], 'reject'),
      analysis_status: 'failed' as const,
      analysis_error_code: 'broken_image',
    },
  ]
  // One scene has a genuine burst and a separate singleton, all must survive a species facet.
  for (const row of rows.filter((item) => ['p1', 'p2', 'p6'].includes(item.id))) row.scene_id = 99
  rows[5].shot_at = '2026-11-17T08:04:00+08:00'
  return rows
}

function library(id: string, name: string, count: number): LibrarySummary {
  return {
    id,
    display_name: name,
    root_path: `/tmp/${id}`,
    parent_path: '/tmp',
    status: 'ready',
    total_count: count,
    analyzed_count: count,
    recursive: true,
    last_opened_at:
      id === 'species-main' ? '2026-11-17T09:00:00+08:00' : '2026-11-16T09:00:00+08:00',
    last_scanned_at: null,
    last_analyzed_at: null,
  }
}

interface MockControl {
  failQueries: number
  failSave: boolean
  staleExport: boolean
  disconnectExport: boolean
  snapshotReads: number
  revision: number
  requests: SelectionQuery[]
  exports: Record<string, unknown>[]
  rows: PhotoRow[]
  libraryViews: (string | null)[]
  reviewRequests: string[]
}

/** This is an independent protocol fixture, not production selection code. */
function queryFixture(
  libraryId: string,
  rows: PhotoRow[],
  query: SelectionQuery,
  revision: string,
): SelectionQueryResult {
  const identities = (row: PhotoRow) =>
    row.analysis_status === 'done' && row.bird_count
      ? (row.detections ?? (row.best_detection ? [row.best_detection] : []))
      : []
  const key = (d: BirdDetectionDetail) =>
    d.species_latin && d.species_source !== 'none' ? `sci:${d.species_latin}` : UNKNOWN
  const review = (d: BirdDetectionDetail) =>
    ['model_unconfirmed', 'conflict'].includes(d.species_source ?? '')
  const eligible = (d: BirdDetectionDetail) =>
    (query.include_review || !review(d)) && (!query.only_flying || d.pose?.posture === 'flying')
  const base = rows.filter((row) => {
    const texts = [
      row.file_name,
      row.species,
      row.species_latin,
      ...identities(row).flatMap((d) => [d.species, d.species_latin]),
    ]
    if (
      query.photo_query &&
      !texts.some((value) => value?.toLowerCase().includes(query.photo_query.toLowerCase()))
    )
      return false
    if (row.analysis_status === 'failed') return query.include_failed && !query.only_flying
    if (row.analysis_status !== 'done') return !query.only_flying
    if (!row.bird_count) return query.include_no_bird && !query.only_flying
    return query.grades.includes((row.decision ?? row.grade) as SelectionQuery['grades'][number])
  })
  const matched = base.filter((row) => {
    if (query.species_keys.length)
      return identities(row).some((d) => query.species_keys.includes(key(d)) && eligible(d))
    return !query.only_flying || identities(row).some((d) => d.pose?.posture === 'flying')
  })
  const metadata = new Map(rows.flatMap(identities).map((d) => [key(d), d]))
  for (const selected of query.species_keys)
    if (!metadata.has(selected))
      metadata.set(selected, bird(selected.replace('sci:', ''), selected.replace('sci:', '')))
  const facets = [...metadata].map(([speciesKey, d]) => ({
    key: speciesKey,
    name: speciesKey === UNKNOWN ? '含未识别鸟' : d.species!,
    latin_name: d.species_latin,
    english_name:
      speciesKey === KING ? 'common kingfisher' : speciesKey === EGRET ? 'little egret' : null,
    search_aliases:
      speciesKey === KING ? ['翠鸟', '普通翠鸟', 'common kingfisher', 'Alcedo atthis'] : [],
    photo_count: base.filter((row) =>
      identities(row).some((entry) => key(entry) === speciesKey && eligible(entry)),
    ).length,
    review_photo_count: base.filter((row) =>
      identities(row).some(
        (entry) => key(entry) === speciesKey && eligible(entry) && review(entry),
      ),
    ).length,
  }))
  return {
    library_id: libraryId,
    projection_revision: revision,
    query,
    facets,
    matched_photo_ids: matched.map((row) => row.id),
    matched_count: matched.length,
    total_count: rows.length,
    pending_count: rows.filter(
      (row) => row.analysis_status !== 'done' && row.analysis_status !== 'failed',
    ).length,
    failed_count: rows.filter((row) => row.analysis_status === 'failed').length,
    no_bird_count: rows.filter((row) => row.analysis_status === 'done' && !row.bird_count).length,
  }
}

async function installBackend(page: Page): Promise<MockControl> {
  const control: MockControl = {
    failQueries: 0,
    failSave: false,
    staleExport: false,
    disconnectExport: false,
    snapshotReads: 0,
    revision: 1,
    requests: [],
    exports: [],
    rows: fixedPhotos(),
    libraryViews: [],
    reviewRequests: [],
  }
  const otherRows = [{ ...photo(20, [bird('Egretta garzetta', '白鹭')], 'select'), id: 'other-1' }]
  const selectionSnapshots = new Map<string, typeof control.rows>()
  const libraries = [
    library('species-main', '鸟种测试库', 10),
    library('species-other', '另一文件夹', 1),
  ]
  await page.addInitScript((appVersion: string) => {
    ;(window as unknown as { plumelens: Record<string, unknown> }).plumelens = {
      getBackendUrl: async () => 'http://127.0.0.1:8000',
      onBackendReady: () => () => {},
      onEngineStatus: (callback: (event: unknown) => void) => {
        setTimeout(() => callback({ kind: 'ready', url: 'http://127.0.0.1:8000' }), 0)
        return () => {}
      },
      selectExportDirectory: async () => '/tmp/species-export',
      getAppVersion: async () => appVersion,
      listEditors: async () => ({ topaz: null, photoshop: null }),
    }
  }, APP_VERSION)
  await page.route('http://127.0.0.1:8000/**', async (route: Route) => {
    const request = route.request()
    const { pathname: path, searchParams } = new URL(request.url())
    const json = (body: unknown, status = 200) =>
      route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) })
    if (path === '/health')
      return json({
        status: 'ok',
        version: APP_VERSION,
        pipeline: {
          ready: true,
          version: 'test',
          quality_available: true,
          pose_available: true,
          species_available: true,
          models: {},
        },
      })
    if (path === '/library') return json(libraries)
    const lib = path.match(/^\/library\/(species-main|species-other)$/)?.[1]
    if (lib) {
      const view = searchParams.get('view')
      control.libraryViews.push(view)
      const revision = String(control.revision)
      const rows = lib === 'species-main' ? control.rows : otherRows
      if (searchParams.has('include_selection_snapshot')) {
        selectionSnapshots.set(`${lib}/${revision}`, structuredClone(rows))
      }
      return json({
        library: libraries.find((entry) => entry.id === lib),
        photos:
          view === 'summary'
            ? rows.map((row) => ({
                ...row,
                exif: null,
                input_revision: 0,
                best_detection: row.best_detection ? summarizeBird(row.best_detection) : null,
                detections: row.detections?.map(summarizeBird),
              }))
            : rows,
        projection_revision: revision,
      })
    }
    const reviewId = path.match(/^\/library\/photo\/([^/]+)\/review$/)?.[1]
    if (reviewId) {
      control.reviewRequests.push(reviewId)
      const libraryId = reviewId === 'other-1' ? 'species-other' : 'species-main'
      const row = (libraryId === 'species-main' ? control.rows : otherRows).find(
        (item) => item.id === reviewId,
      )
      return row
        ? json({ library_id: libraryId, photo: { ...row, input_revision: 0 } })
        : json({ detail: 'Photo not found' }, 404)
    }
    const selectionLibrary = path.match(/^\/library\/(.+)\/selection\/query$/)?.[1]
    if (selectionLibrary) {
      const query = request.postDataJSON() as SelectionQuery
      control.requests.push(query)
      if (control.failQueries > 0) {
        control.failQueries -= 1
        return json({ detail: 'query unavailable' }, 400)
      }
      const revision = searchParams.get('projection_revision')
      const rows = revision
        ? selectionSnapshots.get(`${selectionLibrary}/${revision}`)
        : selectionLibrary === 'species-main'
          ? control.rows
          : otherRows
      if (!rows) return json({ detail: 'Selection snapshot expired' }, 409)
      return json(queryFixture(selectionLibrary, rows, query, revision ?? String(control.revision)))
    }
    const decision = path.match(/^\/decisions\/photo\/(p\d+)$/)?.[1]
    if (decision && request.method() === 'PUT') {
      if (control.failSave) return json({ detail: 'injected save failure' }, 500)
      const row = control.rows.find((entry) => entry.id === decision)!
      row.decision = request.postDataJSON().decision
      control.revision += 1
      return json({ photo_id: decision, decision: row.decision })
    }
    const speciesEdit = path.match(/^\/decisions\/photo\/(p\d+)\/species\/(\d+)$/)
    if (speciesEdit && request.method() === 'PUT') {
      if (control.failSave) return json({ detail: 'injected species save failure' }, 500)
      const row = control.rows.find((entry) => entry.id === speciesEdit[1])!
      const index = Number(speciesEdit[2])
      const value = request.postDataJSON()
      const target = row.detections!.find((entry) => entry.index === index)!
      target.species = value.canonical_zh ?? value.canonical_sci
      target.species_latin = value.canonical_sci
      target.manual_species = true
      target.species_source = 'manual'
      if (target.is_best) {
        row.species = target.species
        row.species_latin = target.species_latin
        row.manual_species = true
        row.species_source = 'manual'
      }
      control.revision += 1
      return json({ photo_id: row.id, bird_index: index, ...value })
    }
    if (path.endsWith('/formats'))
      return json({ formats: [{ ext: 'JPG', count: 10, bytes: 10000, is_raw: false }] })
    if (path.startsWith('/export/library/')) {
      const body = request.postDataJSON() as Record<string, unknown>
      control.exports.push(body)
      if (control.staleExport) {
        control.staleExport = false
        control.rows = [...control.rows, photo(11, [bird('Alcedo atthis', '普通翠鸟')], 'select')]
        control.revision += 1
        return json({ detail: { code: 'selection_changed' } }, 409)
      }
      return json({
        job_id: 'species-job',
        library_id: 'species-main',
        total: 5,
        total_bytes: 5000,
      })
    }
    if (path.startsWith('/export/jobs/')) {
      const snapshot = {
        job_id: 'species-job',
        library_id: 'species-main',
        status: 'succeeded',
        total: 5,
        processed: 5,
        exported: 5,
        companions: 0,
        xmp: 0,
        missing: 0,
        failed: 0,
        total_bytes: 5000,
        copied_bytes: 5000,
        current_file: null,
        output_dir: '/tmp/species-export/result',
        result: {
          library_id: 'species-main',
          output_dir: '/tmp/species-export/result',
          selected_count: 5,
          exported_count: 5,
          companion_count: 0,
          xmp_count: 0,
          skipped_missing: 0,
          failed_count: 0,
          manifest: { json: null, csv: null },
        },
        error: null,
      }
      if (control.disconnectExport) {
        const running = { ...snapshot, status: 'running', processed: 1, exported: 1, result: null }
        if (path.endsWith('/events'))
          return route.fulfill({
            status: 200,
            contentType: 'text/event-stream',
            body: `data: ${JSON.stringify(running)}\n\n`,
          })
        control.snapshotReads += 1
        return json(control.snapshotReads === 1 ? running : snapshot)
      }
      return path.endsWith('/events')
        ? route.fulfill({
            status: 200,
            contentType: 'text/event-stream',
            body: `data: ${JSON.stringify(snapshot)}\n\n`,
          })
        : json(snapshot)
    }
    if (path.endsWith('/events') || path.endsWith('/progress'))
      return route.fulfill({ status: 200, contentType: 'text/event-stream', body: ': idle\n\n' })
    return json({})
  })
  return control
}

async function start(page: Page) {
  await page.goto('/')
  await page.getByRole('button', { name: '选片', exact: true }).click()
  await expectCount(page, 8)
}
async function expectCount(page: Page, count: number) {
  await expect(page.locator('.selection-result-summary [role="status"]')).toHaveText(
    `显示 ${count} / 共 10 张`,
  )
}
function mainTrigger(page: Page) {
  return page.locator('.selection-controls .species-filter__trigger')
}
function panel(page: Page) {
  return page.locator('.species-filter__panel:popover-open')
}
async function openFilter(page: Page) {
  await mainTrigger(page).click()
  await expect(panel(page)).toBeVisible()
}
function speciesOption(page: Page, key: string) {
  return panel(page).locator(`input[name="species"][value="${key}"]`)
}
async function closeFilter(page: Page) {
  await panel(page).getByRole('button', { name: '完成', exact: true }).click()
}

test.describe('Selection species filter', () => {
  test('loads per-photo EXIF only when opening deep review from a summary', async ({ page }) => {
    const state = await installBackend(page)
    const photo = state.rows.find((row) => row.id === 'p8')!
    photo.exif = { Make: 'Fixture camera', Model: 'Native review' }
    await start(page)
    expect(state.libraryViews.length).toBeGreaterThan(0)
    expect(state.libraryViews.every((view) => view === 'summary')).toBe(true)
    expect(state.reviewRequests).toEqual([])
    await page.locator('.photo-tile[data-photo-id="p8"] .photo-preview').dblclick()
    const review = page.locator('dialog:has(> .review-panel)')
    await expect(review).toContainText('Native review')
    expect(state.reviewRequests).toEqual(['p8'])
    await page.keyboard.press('Escape')
    await expect(review).toHaveCount(0)
    await expectCount(page, 8)
  })

  test('searches aliases, pinyin and scientific names; multi-select uses a deduplicated OR', async ({
    page,
  }) => {
    const state = await installBackend(page)
    await start(page)
    await openFilter(page)
    const search = panel(page).getByRole('searchbox')
    await expect(search).toBeFocused()
    await search.fill('putongcuiniao')
    await expect(speciesOption(page, KING)).toBeVisible()
    await search.fill('Alcedo atthis')
    await expect(speciesOption(page, KING).locator('..')).toContainText('5 张')
    await speciesOption(page, KING).check()
    await expectCount(page, 5)
    await search.fill('little egret')
    await speciesOption(page, EGRET).check()
    await expectCount(page, 6)
    expect(new Set(state.requests.at(-1)?.species_keys)).toEqual(new Set([KING, EGRET]))
    await closeFilter(page)
    await expect(mainTrigger(page)).toContainText('2 种')
  })

  test('review toggle controls only the selected species and preserves selected zero-count options', async ({
    page,
  }) => {
    await installBackend(page)
    await start(page)
    await openFilter(page)
    await speciesOption(page, KING).check()
    await expectCount(page, 5)
    await panel(page).getByLabel('包含待审判断', { exact: true }).uncheck()
    await expectCount(page, 3)
    await closeFilter(page)
    const noReviewChip = page
      .locator('.selection-result-summary')
      .getByRole('button', { name: /不含待审/ })
    await expect(noReviewChip).toBeVisible()
    await noReviewChip.click()
    await expectCount(page, 5)
    await expect(noReviewChip).toHaveCount(0)
    await openFilter(page)
    await expect(panel(page).getByLabel('包含待审判断', { exact: true })).toBeChecked()
    await expect(speciesOption(page, KING)).toBeChecked()
    await panel(page).getByLabel('包含待审判断', { exact: true }).uncheck()
    await expectCount(page, 3)
    await closeFilter(page)
    await page
      .locator('.selection-controls')
      .getByRole('button', { name: '仅飞版', exact: true })
      .click()
    await expectCount(page, 0)
    await expect(page.getByRole('heading', { name: '没有符合条件的照片' })).toBeVisible()
    await openFilter(page)
    await expect(speciesOption(page, KING)).toBeChecked()
    await expect(speciesOption(page, KING).locator('..')).toContainText('0 张')
    await panel(page).getByRole('button', { name: '清除鸟种筛选' }).click()
    await expectCount(page, 4) // Clearing this facet restores include-review=true: p3/p5/p6/p7.
  })

  test('flight matches the selected bird, including non-best birds and unidentified birds', async ({
    page,
  }) => {
    await installBackend(page)
    await start(page)
    await openFilter(page)
    await speciesOption(page, KING).check()
    await closeFilter(page)
    await page
      .locator('.selection-controls')
      .getByRole('button', { name: '仅飞版', exact: true })
      .click()
    await expectCount(page, 1)
    await expect(page.locator('.photo-tile[data-photo-id="p6"]')).toHaveCount(0)
    await openFilter(page)
    await speciesOption(page, KING).uncheck()
    await speciesOption(page, EGRET).check()
    await expectCount(page, 2)
    await speciesOption(page, EGRET).uncheck()
    await speciesOption(page, UNKNOWN).check()
    await expectCount(page, 1)
    await closeFilter(page)
    await expect(page.locator('.photo-tile[data-photo-id="p7"]')).toBeVisible()
  })

  test('grouped results retain the matching singleton and folder filters are isolated and restored', async ({
    page,
  }) => {
    await installBackend(page)
    await start(page)
    await openFilter(page)
    await speciesOption(page, KING).check()
    await closeFilter(page)
    await expectCount(page, 5)
    await expect(page.locator('.photo-tile[data-photo-id="p6"]')).toBeVisible()
    await page
      .locator('.folder-rail')
      .getByRole('button', { name: /另一文件夹/ })
      .click()
    await expect(page.locator('.selection-result-summary [role="status"]')).toHaveText(
      '显示 1 / 共 1 张',
    )
    await expect(mainTrigger(page)).toContainText('全部')
    await page
      .locator('.folder-rail')
      .getByRole('button', { name: /鸟种测试库/ })
      .click()
    await expectCount(page, 5)
    await expect(mainTrigger(page)).toContainText('普通翠鸟')
  })

  test('native popover closes with Escape and restores focus without triggering photo review', async ({
    page,
  }) => {
    await installBackend(page)
    await start(page)
    await page.locator('.photo-tile[data-photo-id="p1"] .photo-preview').click()
    await openFilter(page)
    await speciesOption(page, KING).focus()
    await page.keyboard.press('Space')
    await expect(speciesOption(page, KING)).toBeChecked()
    await expectCount(page, 5)
    await expect(page.locator('.review-panel')).toHaveCount(0)
    await panel(page).getByRole('searchbox').fill('翠鸟')
    await page.keyboard.press('Escape')
    // Search inputs may first consume Escape to clear their value; a second closes the popover.
    if (await panel(page).count()) await page.keyboard.press('Escape')
    await expect(panel(page)).toHaveCount(0)
    await expect(mainTrigger(page)).toBeFocused()
    await expect(page.locator('.review-panel')).toHaveCount(0)
  })

  test('failed authoritative queries show a local retry instead of an empty result', async ({
    page,
  }) => {
    const state = await installBackend(page)
    state.failQueries = 1
    await page.goto('/')
    await page.getByRole('button', { name: '选片', exact: true }).click()
    const error = page.locator('.selection-filter-empty[role="alert"]')
    await expect(error).toContainText('筛选加载失败')
    await error.getByRole('button', { name: '重试' }).click()
    await expectCount(page, 8)
    await expect(error).toHaveCount(0)
  })

  test('changed source files explain how to recover and updating the folder starts a rescan', async ({
    page,
  }) => {
    await installBackend(page)
    await page.route('**/analysis/batch', (route) =>
      route.fulfill({
        status: 409,
        contentType: 'application/json',
        body: JSON.stringify({ detail: { code: 'source_changed' } }),
      }),
    )
    await page.route('**/library/import', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(library('species-main', '鸟种测试库', 10)),
      }),
    )
    await start(page)
    const rejectedAnalysis = page.waitForResponse(
      (response) =>
        response.url().endsWith('/analysis/batch') &&
        response.request().method() === 'POST' &&
        response.status() === 409,
    )
    await page
      .locator('.folder-actions')
      .getByRole('button', { name: '开始分析', exact: true })
      .click()
    await rejectedAnalysis
    await expect(page.getByRole('alert')).toContainText('源照片已变化，请先更新文件夹后重新分析。')
    const rescan = page.waitForRequest(
      (request) => request.url().endsWith('/library/import') && request.method() === 'POST',
    )
    await page
      .locator('.folder-actions')
      .getByRole('button', { name: '更新文件夹', exact: true })
      .click()
    expect((await rescan).postDataJSON()).toEqual({
      root_path: '/tmp/species-main',
      recursive: true,
    })
  })

  test('save 500 leaves no optimistic decision after identical refetch', async ({ page }) => {
    const state = await installBackend(page)
    state.failSave = true
    await start(page)
    await page.locator('.photo-tile[data-photo-id="p1"] .photo-preview').click()
    const saved = page.waitForResponse(
      (response) => response.url().includes('/decisions/photo/p1') && response.status() === 500,
    )
    await page
      .locator('.inspector-actions')
      .getByRole('button', { name: '淘汰', exact: true })
      .click()
    await saved
    await expect(page.getByRole('alert').filter({ hasText: '保存失败' }).first()).toBeVisible()
    await expect(page.locator('.inspector-hero__meta')).toContainText('系统')
    await expect(page.locator('.photo-tile[data-photo-id="p1"]')).not.toContainText('人工')
    expect(state.rows[0].decision).toBeNull()
    await page.locator('.photo-tile[data-photo-id="p1"] .photo-preview').dblclick()
    const review = page.locator('dialog:has(> .review-panel)')
    await expect(review).toBeVisible()
    const modalSave = page.waitForResponse(
      (response) => response.url().includes('/decisions/photo/p1') && response.status() === 500,
    )
    await page.keyboard.press('4')
    await modalSave
    await expect(review.getByRole('alert')).toContainText('保存失败')
    await expect(review.locator('.review-heading h2')).toHaveText('SPECIES_01.JPG')
    expect(state.rows[0].decision).toBeNull()
  })

  test('Tab focus on B opens B with Space and review contains focus including input Escape', async ({
    page,
  }) => {
    await installBackend(page)
    await start(page)
    const a = page.locator('.photo-tile[data-photo-id="p1"] .photo-preview')
    const b = page.locator('.photo-tile[data-photo-id="p2"] .photo-preview')
    await a.click()
    await a.focus()
    // An expanded burst also has a collapse button in its natural tab order.
    for (let i = 0; i < 4 && !(await b.evaluate((node) => node === document.activeElement)); i += 1)
      await page.keyboard.press('Tab')
    await expect(b).toBeFocused()
    await page.keyboard.press('Space')
    const review = page.locator('dialog:has(> .review-panel)')
    await expect(review).toBeVisible()
    await expect(review.locator('.review-heading h2')).toHaveText('SPECIES_02.JPG')
    for (let i = 0; i < 12; i += 1) {
      await page.keyboard.press('Tab')
      expect(await review.evaluate((node) => node.contains(document.activeElement))).toBe(true)
    }
    // Native modal dialogs may send Tab to browser chrome; the application background
    // must remain inert even when code tries to focus a control behind the dialog.
    await page.locator('.command-bar input').evaluate((node) => (node as HTMLInputElement).focus())
    expect(await review.evaluate((node) => node.contains(document.activeElement))).toBe(true)
    await review.locator('.species-editor__current').click()
    await review.getByPlaceholder('搜索中文名、英文名或拉丁名').focus()
    await page.keyboard.press('Escape')
    await expect(review).toHaveCount(0)
    await expect(b).toBeFocused()
  })

  test('current-filter export sends the authoritative query and revision, then recovers a stale revision', async ({
    page,
  }) => {
    const state = await installBackend(page)
    state.staleExport = true
    await start(page)
    await openFilter(page)
    await speciesOption(page, KING).check()
    await closeFilter(page)
    await expectCount(page, 5)
    await page.locator('.folder-actions').getByRole('button', { name: '导出', exact: true }).click()
    const drawer = page.locator('.export-sidecar')
    await expect(drawer.getByRole('radio', { name: '当前筛选 5 张' })).toBeChecked()
    await drawer.getByRole('button', { name: '选择位置' }).click()
    await drawer.getByRole('button', { name: '开始导出' }).click()
    await expect(drawer.getByText('筛选结果已变化，已刷新数量。请核对后重新开始。')).toBeVisible()
    await expect(drawer.getByRole('radio', { name: '当前筛选 6 张' })).toBeChecked()
    await expect(drawer.getByText('当前范围将导出 6 张')).toBeVisible()
    expect(state.exports[0]).toMatchObject({
      scope: 'selection',
      projection_revision: '1',
      selection_query: { species_keys: [KING], include_review: true, grades: DEFAULT_GRADES },
    })
    await drawer.getByRole('button', { name: '开始导出' }).click()
    await expect.poll(() => state.exports.length).toBe(2)
    expect(state.exports[1]).toMatchObject({ scope: 'selection', projection_revision: '2' })
    await expect(page.getByText('导出完成', { exact: true })).toBeVisible()
  })
  test('rejected kingfishers can be filtered without archive grade eligibility', async ({
    page,
  }) => {
    await installBackend(page)
    await start(page)
    await openFilter(page)
    await speciesOption(page, KING).check()
    await closeFilter(page)
    const grades = page.locator('.selection-controls .filter-row__grades')
    for (const name of ['精选', '可用', '记录'])
      await grades.getByRole('button', { name, exact: true }).click()
    await grades.getByRole('button', { name: '淘汰', exact: true }).click()
    await page
      .locator('.selection-controls')
      .getByRole('button', { name: '仅飞版', exact: true })
      .click()
    await expectCount(page, 1)
    await expect(page.locator('.photo-tile[data-photo-id="p9"]')).toBeVisible()
  })

  test('successful species edits update membership without closing or jumping the review session', async ({
    page,
  }) => {
    await installBackend(page)
    await start(page)
    await openFilter(page)
    await speciesOption(page, KING).check()
    await closeFilter(page)
    await page.locator('.photo-tile[data-photo-id="p1"] .photo-preview').dblclick()
    const review = page.locator('dialog:has(> .review-panel)')
    await review.locator('.species-editor__current').click()
    await review.getByPlaceholder('搜索中文名、英文名或拉丁名').fill('白鹭')
    await review.locator('.species-editor__option').filter({ hasText: 'Egretta garzetta' }).click()
    await expect(review.locator('.review-heading h2')).toHaveText('SPECIES_01.JPG')
    await expect(review).toContainText('当前照片已不再符合筛选条件')
    await page.keyboard.press('Escape')
    await expectCount(page, 4)
    await expect(page.locator('.photo-tile[data-photo-id="p1"]')).toHaveCount(0)
  })

  test('format lookup errors disable copying and offer a working local retry', async ({ page }) => {
    await installBackend(page)
    let attempts = 0
    let allowFormats = false
    await page.route('**/export/library/*/formats', (route) => {
      attempts += 1
      return route.fulfill({
        status: allowFormats ? 200 : 400,
        contentType: 'application/json',
        body: JSON.stringify(
          !allowFormats
            ? { detail: 'unavailable' }
            : { formats: [{ ext: 'JPG', count: 10, bytes: 10000, is_raw: false }] },
        ),
      })
    })
    await start(page)
    await page.locator('.folder-actions').getByRole('button', { name: '导出', exact: true }).click()
    const drawer = page.locator('.export-sidecar')
    const failure = drawer.getByRole('alert')
    await expect(failure).toContainText('格式')
    await drawer.getByRole('button', { name: '选择位置' }).click()
    await expect(drawer.getByRole('button', { name: '开始导出' })).toBeDisabled()
    const failedAttempts = attempts
    allowFormats = true
    await failure.getByRole('button', { name: '重试' }).click()
    await expect(drawer.getByLabel(/JPG/)).toBeChecked()
    await expect(drawer.getByRole('button', { name: '开始导出' })).toBeEnabled()
    expect(attempts).toBeGreaterThan(failedAttempts)
  })

  test('an interrupted export stream keeps checking snapshots until the task finishes', async ({
    page,
  }) => {
    const state = await installBackend(page)
    state.disconnectExport = true
    await start(page)
    await page.locator('.folder-actions').getByRole('button', { name: '导出', exact: true }).click()
    const drawer = page.locator('.export-sidecar')
    await drawer.getByRole('button', { name: '选择位置' }).click()
    await drawer.getByRole('button', { name: '开始导出' }).click()
    await expect(page.getByText('导出完成', { exact: true })).toBeVisible({ timeout: 10000 })
    expect(state.snapshotReads).toBeGreaterThanOrEqual(2)
  })
  test('a missing export snapshot reports interruption and stops recovery requests', async ({
    page,
  }) => {
    const state = await installBackend(page)
    state.disconnectExport = true
    let missingSnapshots = 0
    await page.route('**/export/jobs/species-job', (route) => {
      missingSnapshots += 1
      return route.fulfill({
        status: 404,
        contentType: 'application/json',
        body: JSON.stringify({ detail: 'job_not_found' }),
      })
    })
    await start(page)
    await page.locator('.folder-actions').getByRole('button', { name: '导出', exact: true }).click()
    const drawer = page.locator('.export-sidecar')
    await drawer.getByRole('button', { name: '选择位置' }).click()
    await drawer.getByRole('button', { name: '开始导出' }).click()
    await expect(drawer.locator('.export-error')).toContainText('引擎重启中断了导出')
    await expect(drawer.getByRole('button', { name: '取消导出', exact: true })).toHaveCount(0)
    const readsAfterFailure = missingSnapshots
    await page.clock.install()
    await page.clock.runFor(5_000)
    expect(missingSnapshots).toBe(readsAfterFailure)
  })
  test('library export rejects out-of-range and reversed scores until the range is corrected', async ({
    page,
  }) => {
    const state = await installBackend(page)
    await start(page)
    await page.locator('.folder-actions').getByRole('button', { name: '导出', exact: true }).click()
    const drawer = page.locator('.export-sidecar')
    await drawer.getByRole('radio', { name: '整个文件夹', exact: true }).check()
    await drawer.getByRole('button', { name: '选择位置' }).click()
    const minimum = drawer.getByRole('spinbutton', { name: '最低', exact: true })
    const maximum = drawer.getByRole('spinbutton', { name: '最高', exact: true })
    const begin = drawer.getByRole('button', { name: '开始导出', exact: true })
    for (const [min, max] of [
      ['-1', '100'],
      ['0', '101'],
      ['90', '20'],
    ]) {
      await minimum.fill(min)
      await maximum.fill(max)
      await expect(minimum).toHaveAttribute('aria-invalid', 'true')
      await expect(drawer.getByRole('alert')).toContainText('0–100')
      await expect(begin).toBeDisabled()
    }
    expect(state.exports).toHaveLength(0)
    await minimum.fill('20')
    await maximum.fill('90')
    await expect(minimum).toHaveAttribute('aria-invalid', 'false')
    await expect(drawer.getByRole('alert')).toHaveCount(0)
    await expect(begin).toBeEnabled()
  })
  test('Escape closes only the native species profile above the review dialog', async ({
    page,
  }) => {
    await installBackend(page)
    await start(page)
    await page.locator('.photo-tile[data-photo-id="p1"] .photo-preview').dblclick()
    const review = page.locator('dialog:has(> .review-panel)')
    await review.locator('.species-name-action').first().click()
    const profile = page.getByTestId('species-detail-popover')
    await expect(profile).toBeVisible()
    await expect(profile.getByRole('heading', { name: /翠鸟/ })).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(profile).toHaveCount(0)
    await expect(review).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(review).toHaveCount(0)
  })
  test('species panel stays within the viewport and keeps its actions visible at desktop sizes', async ({
    page,
  }) => {
    await installBackend(page)
    const geometry: Array<{ width: number; insideViewport: boolean; actionsVisible: boolean }> = []
    for (const viewport of [
      { width: 1680, height: 1040 },
      { width: 1360, height: 860 },
    ]) {
      await page.setViewportSize(viewport)
      await start(page)
      await openFilter(page)
      await speciesOption(page, KING).check()
      await speciesOption(page, EGRET).check()
      await expectCount(page, 6)
      const popup = panel(page)
      await expect(popup.getByLabel('包含待审判断', { exact: true })).toBeVisible()
      await expect(popup.locator('.species-filter__pending')).toContainText('含待审 2 张')
      const optionScroller = popup.locator('.species-filter__options-scroll')
      const lastOption = popup.locator('.species-filter__option').last()
      await lastOption.scrollIntoViewIfNeeded()
      const lastRect = await lastOption.boundingBox()
      const scrollRect = await optionScroller.boundingBox()
      expect(lastRect).not.toBeNull()
      expect(scrollRect).not.toBeNull()
      expect(lastRect!.y).toBeGreaterThanOrEqual(scrollRect!.y)
      expect(lastRect!.y + lastRect!.height).toBeLessThanOrEqual(scrollRect!.y + scrollRect!.height)
      const lastCheckbox = lastOption.getByRole('checkbox')
      await expect(lastCheckbox).not.toBeChecked()
      await lastCheckbox.check()
      await expectCount(page, 7)
      await lastCheckbox.uncheck()
      await expectCount(page, 6)
      await optionScroller.evaluate((node) => {
        node.scrollTop = 0
      })
      const rect = await popup.boundingBox()
      expect(rect).not.toBeNull()
      const doneRect = await popup.getByRole('button', { name: '完成', exact: true }).boundingBox()
      geometry.push({
        width: viewport.width,
        insideViewport:
          rect!.x >= 0 &&
          rect!.y >= 0 &&
          rect!.x + rect!.width <= viewport.width &&
          rect!.y + rect!.height <= viewport.height,
        actionsVisible: Boolean(
          doneRect &&
          doneRect.y >= rect!.y &&
          doneRect.y + doneRect.height <= rect!.y + rect!.height,
        ),
      })
      await closeFilter(page)
    }
    expect(geometry).toEqual([
      { width: 1680, insideViewport: true, actionsVisible: true },
      { width: 1360, insideViewport: true, actionsVisible: true },
    ])
  })
})

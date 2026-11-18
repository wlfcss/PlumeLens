/**
 * Rebuild anonymous demo inputs first:
 * UV_NO_SYNC=1 uv run python tests/e2e-electron/fixtures/prepare_readme_demo.py
 * npx playwright test --config=tests/e2e-electron/readme.config.ts
 *
 * Screenshots are unmodified app rendering. Bird photos come from the bundled,
 * attributed Commons artwork; model output is real and species/grades are
 * explicitly manually confirmed for this demonstration, not a quality benchmark.
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, test, type Page } from '@playwright/test'
import {
  callEngine,
  importFixtureLibrary,
  launchApp,
  makeTmpDataDir,
  REPO_ROOT,
  waitForEngineReady,
  waitForLibraryReady,
  type LaunchHandle,
} from './helpers/launch.js'

const demoRoot = process.env.PLUMELENS_README_DEMO_ROOT ?? '/private/tmp/PlumeLens演示图库'
const demo = JSON.parse(readFileSync(join(demoRoot, 'manifest.json'), 'utf8')) as {
  photo_dir: string
  photos: {
    file_name: string
    canonical_sci: string
    canonical_zh: string
    canonical_en: string
    decision: string
  }[]
}
const { version } = JSON.parse(readFileSync(join(REPO_ROOT, 'package.json'), 'utf8')) as {
  version: string
}
const imageDir = join(REPO_ROOT, 'assets', 'readme')

interface DemoPhoto {
  id: string
  file_name: string
  bird_count: number
  analysis_status: string
  best_detection: {
    index: number
    bbox: { x1: number; y1: number; x2: number; y2: number }
  } | null
}

async function settled(page: Page): Promise<void> {
  await page.evaluate(async () => {
    await document.fonts.ready
    const images = [...document.querySelectorAll<HTMLImageElement>('.photo-preview img')].filter(
      (img) => {
        const rect = img.getBoundingClientRect()
        return rect.bottom > 0 && rect.top < innerHeight && rect.width > 0
      },
    )
    await Promise.all(images.map((image) => image.decode().catch(() => {})))
  })
}

async function capture(page: Page, fileName: string): Promise<void> {
  await settled(page)
  expect(await page.evaluate(() => ({ width: innerWidth, height: innerHeight }))).toEqual({
    width: 1680,
    height: 1040,
  })
  const text = await page.locator('body').innerText()
  expect(text).not.toContain('/Users/wlfcss')
  expect(text).not.toContain('/Desktop/鸟照片')
  await page.screenshot({
    path: join(imageDir, fileName),
    fullPage: false,
    scale: 'css',
    animations: 'disabled',
  })
}

test('capture real demo workspace and species filter', async () => {
  const dataDir = process.env.PLUMELENS_README_DATA_DIR ?? makeTmpDataDir()
  let handle: LaunchHandle | null = null
  const report: Record<string, unknown> = { dataDir, demoRoot, version, manualDemo: true }
  try {
    handle = await launchApp(dataDir)
    await waitForEngineReady(handle.page, dataDir)
    expect(await handle.app.evaluate(({ app }) => app.getVersion())).toBe(version)
    const health = await callEngine(handle.page, '/health')
    expect(JSON.parse(health.body).version).toBe(version)
    const library = await importFixtureLibrary(handle.page, demo.photo_dir, '春日观鸟')
    await waitForLibraryReady(handle.page, library.id)
    if (process.env.PLUMELENS_README_SKIP_ANALYSIS !== '1') {
      const start = await callEngine(handle.page, '/analysis/batch', {
        method: 'POST',
        body: JSON.stringify({ library_id: library.id }),
      })
      expect(start.ok).toBe(true)
      console.log('[readme] real model analysis started:', start.body)
      await expect
        .poll(
          async () => {
            const result = await callEngine(handle!.page, `/analysis/library/${library.id}/stats`)
            const stats = JSON.parse(result.body).stats as Record<string, number>
            return (stats.pending ?? 0) + (stats.processing ?? 0)
          },
          { timeout: 300_000, intervals: [1_000, 2_000] },
        )
        .toBe(0)
    }
    const response = await callEngine(handle.page, `/library/${library.id}`)
    const detail = JSON.parse(response.body) as { photos: DemoPhoto[] }
    expect(detail.photos).toHaveLength(demo.photos.length)
    report.analysis = detail.photos.map((photo) => ({
      file: photo.file_name,
      status: photo.analysis_status,
      birds: photo.bird_count,
    }))
    for (const photo of detail.photos) {
      expect(photo.analysis_status, photo.file_name).toBe('done')
      expect(photo.best_detection, photo.file_name).not.toBeNull()
      const expected = demo.photos.find((row) => row.file_name === photo.file_name)!
      const bird = photo.best_detection!
      const confirmed = await callEngine(
        handle.page,
        `/decisions/photo/${photo.id}/species/${bird.index}`,
        {
          method: 'PUT',
          body: JSON.stringify({
            canonical_sci: expected.canonical_sci,
            canonical_zh: expected.canonical_zh,
            canonical_en: expected.canonical_en,
            bbox: bird.bbox,
          }),
        },
      )
      expect(confirmed.ok, confirmed.body).toBe(true)
      const rated = await callEngine(handle.page, `/decisions/photo/${photo.id}`, {
        method: 'PUT',
        body: JSON.stringify({ decision: expected.decision }),
      })
      expect(rated.ok, rated.body).toBe(true)
    }
    report.libraryId = library.id
    console.log('[readme] real analysis and explicit manual confirmation finished')
    await handle.app.close()
    handle = await launchApp(dataDir)
    await waitForEngineReady(handle.page, dataDir)
    await handle.app.evaluate(({ BrowserWindow }) => {
      BrowserWindow.getAllWindows()[0].setContentSize(1680, 1040)
    })
    await expect(handle.page.getByText('春日观鸟').first()).toBeVisible()
    await capture(handle.page, 'start-screen.png')

    await handle.page.getByRole('button', { name: '选片', exact: true }).click()
    await expect(handle.page.getByRole('button', { name: '鸟种：全部', exact: true })).toBeVisible()
    await handle.page.getByRole('button', { name: '平铺', exact: true }).first().click()
    await expect(handle.page.locator('.photo-preview img').first()).toBeVisible()
    await capture(handle.page, 'selection-screen.png')

    const picker = handle.page.getByRole('button', { name: '鸟种：全部', exact: true })
    await picker.click()
    await handle.page.getByRole('checkbox', { name: /普通翠鸟|翠鸟/ }).check()
    await handle.page.getByRole('checkbox', { name: /^白鹭/ }).check()
    await expect(handle.page.getByText('显示 5 / 共 12 张', { exact: true })).toBeVisible()
    await capture(handle.page, 'species-filter.png')
    await handle.page.keyboard.press('Escape')

    await handle.page.getByRole('button', { name: '羽迹', exact: true }).click()
    await handle.page.locator('.archive-filter-cell--collected').click()
    await expect(handle.page.locator('.collection-card--lit').first()).toBeVisible()
    await handle.page.locator('.collection-card').filter({ hasText: 'Alcedo atthis' }).click()
    await expect(
      handle.page.locator('.archive-detail').getByText('Alcedo atthis', { exact: true }),
    ).toBeVisible()
    await capture(handle.page, 'archive-screen.png')
    report.screenshots = [
      'start-screen.png',
      'selection-screen.png',
      'archive-screen.png',
      'species-filter.png',
    ]
  } finally {
    if (handle) await handle.app.close().catch(() => {})
    writeFileSync(
      `/private/tmp/plumelens-readme-capture-report-${version}.json`,
      JSON.stringify(report, null, 2) + '\n',
    )
    // Keep this task-owned isolated DB for repeatable captures/review; never use real userData.
  }
})

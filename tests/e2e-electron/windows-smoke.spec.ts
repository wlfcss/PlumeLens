import { expect, test } from '@playwright/test'
import { spawn } from 'node:child_process'
import { join } from 'node:path'
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import {
  launchApp,
  makeTmpDataDir,
  waitForEngineReady,
  callEngine,
  importFixtureLibrary,
  waitForLibraryReady,
  REPO_ROOT,
} from './helpers/launch.js'

test('Windows: cold start, real photo analysis, export, clean exit and history reload', async () => {
  const full = process.env.PLUMELENS_FULL_VALIDATION === '1'
  const continuing = full && process.env.PLUMELENS_CONTINUE_VALIDATION === '1'
  test.setTimeout(full ? 7_200_000 : 600_000)
  const dataDir = process.env.PLUMELENS_TEST_DATA_DIR ?? makeTmpDataDir()
  const fixtureDir =
    process.env.PLUMELENS_TEST_PHOTOS ?? join(REPO_ROOT, '.tools', 'windows-fixtures', '照片 测试')
  test.skip(
    process.platform !== 'win32' ||
      (!process.env.PLUMELENS_TEST_LIBRARY_ID && !existsSync(fixtureDir)),
    'Requires Windows photo fixtures or an existing validation library',
  )
  let handle = await launchApp(dataDir)
  let monitor: ReturnType<typeof spawn> | undefined
  const resourceOutput = process.env.PLUMELENS_RESOURCE_REPORT
  try {
    await waitForEngineReady(handle.page, dataDir)
    await expect(handle.page.getByRole('button', { name: /选择照片文件夹/ })).toBeVisible()
    const errors: string[] = []
    handle.page.on('pageerror', (error) => errors.push(error.message))
    const library = process.env.PLUMELENS_TEST_LIBRARY_ID
      ? { id: process.env.PLUMELENS_TEST_LIBRARY_ID!, display_name: 'Windows 鸟片测试' }
      : await importFixtureLibrary(handle.page, fixtureDir, 'Windows 鸟片测试')
    if (!continuing) await waitForLibraryReady(handle.page, library.id, full ? 1_800_000 : 90_000)
    const detail = await callEngine(handle.page, `/library/${library.id}`)
    const photos = JSON.parse(detail.body).photos
    expect(photos.length).toBeGreaterThan(0)
    const health = JSON.parse((await callEngine(handle.page, '/health')).body)
    expect(health.pipeline.ready).toBe(true)
    expect(health.pipeline.quality_available).toBe(true)
    expect(health.pipeline.species_available).toBe(true)
    if (process.env.PLUMELENS_REQUIRE_NATIVE_AMD === '1') {
      expect(health.pipeline.models.yolo.provider).toBe('AMDGPUExecutionProvider')
    }
    if (full && !continuing) {
      // This isolated workspace may contain an interrupted earlier test run.
      // Start a fresh ledger so every original is verified with current code.
      expect(
        (
          await callEngine(handle.page, `/analysis/library/${library.id}/cancel`, {
            method: 'POST',
          })
        ).ok,
      ).toBe(true)
      await expect
        .poll(
          async () => {
            const snapshot = JSON.parse(
              (await callEngine(handle.page, `/analysis/library/${library.id}/stats`)).body,
            )
            return (snapshot.stats.processing ?? 0) + (snapshot.stats.pending ?? 0)
          },
          { timeout: 120_000 },
        )
        .toBe(0)
    }
    const started = continuing
      ? await callEngine(handle.page, `/analysis/library/${library.id}/resume`, { method: 'POST' })
      : await callEngine(handle.page, '/analysis/batch', {
          method: 'POST',
          body: JSON.stringify({ library_id: library.id, force_rerun: full }),
        })
    expect(started.ok, started.body).toBe(true)
    if (full && !continuing) {
      await expect
        .poll(
          async () =>
            JSON.parse(
              (await callEngine(handle.page, `/analysis/library/${library.id}/stats`)).body,
            ).stats.completed ?? 0,
          { timeout: 120_000 },
        )
        .toBeGreaterThanOrEqual(3)
      expect(
        (await callEngine(handle.page, `/analysis/library/${library.id}/pause`, { method: 'POST' }))
          .ok,
      ).toBe(true)
      await expect
        .poll(
          async () =>
            JSON.parse(
              (await callEngine(handle.page, `/analysis/library/${library.id}/stats`)).body,
            ).stats.processing ?? 0,
          { timeout: 120_000 },
        )
        .toBe(0)
      await handle.app.close()
      handle = await launchApp(dataDir)
      await waitForEngineReady(handle.page, dataDir)
      expect(
        (
          await callEngine(handle.page, `/analysis/library/${library.id}/resume`, {
            method: 'POST',
          })
        ).ok,
      ).toBe(true)
    }
    if (resourceOutput) {
      const logs = join(dataDir, 'logs')
      const latest = readdirSync(logs)
        .filter((name) => name.startsWith('engine.stderr.'))
        .sort()
        .at(-1)!
      const pid = Number(
        readFileSync(join(logs, latest), 'utf8').match(/Started server process \[(\d+)\]/)?.[1],
      )
      expect(pid).toBeGreaterThan(0)
      monitor = spawn(
        process.env.PLUMELENS_PYTHON!,
        [
          join(REPO_ROOT, 'scripts', 'monitor-windows.py'),
          '--pid',
          String(pid),
          '--seconds',
          '6600',
          '--stop-file',
          resourceOutput + '.stop',
          '--output',
          resourceOutput,
        ],
        { windowsHide: true, stdio: 'ignore' },
      )
    }
    const measuredStart = performance.now()
    await expect
      .poll(
        async () => {
          const response = await callEngine(handle.page, `/analysis/library/${library.id}/stats`)
          const snapshot = JSON.parse(response.body)
          writeFileSync(
            join(
              REPO_ROOT,
              '.tools',
              full
                ? 'full-validation-progress.json'
                : (process.env.PLUMELENS_SMOKE_PROGRESS_FILE ?? 'smoke-progress.json'),
            ),
            JSON.stringify(
              {
                dataDir,
                libraryId: library.id,
                total: photos.length,
                ...snapshot,
                updated: new Date().toISOString(),
              },
              null,
              2,
            ),
          )
          if ((snapshot.stats.dead ?? 0) > 0) {
            const tasks = await callEngine(handle.page, `/analysis/library/${library.id}/tasks`)
            throw new Error(`Dead analysis tasks: ${tasks.body}`)
          }
          return snapshot.stats.completed ?? 0
        },
        { timeout: full ? 6_600_000 : 480_000, intervals: [500, 1_000, 2_000] },
      )
      .toBe(photos.length)
    if (resourceOutput && monitor) {
      writeFileSync(resourceOutput + '.stop', '')
      await new Promise<void>((resolve) => monitor!.once('exit', () => resolve()))
      writeFileSync(
        resourceOutput + '.run.json',
        JSON.stringify(
          {
            photos: photos.length,
            measured_seconds_after_resume: (performance.now() - measuredStart) / 1000,
            health,
          },
          null,
          2,
        ),
      )
    }
    const analyzed = JSON.parse((await callEngine(handle.page, `/library/${library.id}`)).body)
    expect(analyzed.library.analyzed_count).toBe(photos.length)
    const selectionQuery = {
      grades: ['select', 'usable', 'record', 'reject'],
      include_no_bird: true,
    }
    const selectionResponse = await callEngine(
      handle.page,
      `/library/${library.id}/selection/query`,
      { method: 'POST', body: JSON.stringify(selectionQuery) },
    )
    expect(selectionResponse.ok, selectionResponse.body).toBe(true)
    const selection = JSON.parse(selectionResponse.body)
    expect(selection.matched_count).toBe(photos.length)
    const exported = await callEngine(handle.page, `/export/library/${library.id}`, {
      method: 'POST',
      body: JSON.stringify({
        target_dir: join(REPO_ROOT, '.tools', 'windows-exports'),
        grades: ['select', 'usable', 'record', 'reject'],
        include_companions: false,
        include_xmp_sidecars: true,
        include_manifest: true,
        copy_files: !full,
        scope: 'selection',
        selection_query: selectionQuery,
        projection_revision: selection.projection_revision,
      }),
    })
    expect(exported.ok, exported.body).toBe(true)
    const jobId = JSON.parse(exported.body).job_id
    await expect
      .poll(
        async () => {
          const snapshot = JSON.parse((await callEngine(handle.page, `/export/jobs/${jobId}`)).body)
          return snapshot.status
        },
        { timeout: 30_000 },
      )
      .toBe('succeeded')
    const result = JSON.parse((await callEngine(handle.page, `/export/jobs/${jobId}`)).body).result
    expect(result.exported_count).toBe(full ? 0 : photos.length)
    expect(result.xmp_count).toBe(photos.length)
    expect(result.failed_count).toBe(0)
    expect(JSON.parse(readFileSync(result.manifest.json, 'utf8'))['照片清单']).toHaveLength(
      photos.length,
    )
    // This test imported through preload/API; refresh the renderer's query
    // cache just as a new user session would before checking persisted UI.
    await handle.page.reload()
    await expect(handle.page.getByText('Windows 鸟片测试').first()).toBeVisible({ timeout: 15_000 })
    await handle.page.screenshot({ path: join(REPO_ROOT, '.tools', 'windows-start-screen.png') })
    await handle.page.getByText('Windows 鸟片测试').first().click()
    await expect(handle.page.getByRole('button', { name: '选片', exact: true })).toBeVisible()
    const clearFilters = handle.page.getByRole('button', { name: '清除全部筛选' })
    if (await clearFilters.isVisible()) await clearFilters.click()
    const noBird = handle.page.getByRole('button', { name: '无鸟', exact: true })
    if ((await noBird.getAttribute('aria-pressed')) !== 'true') await noBird.click()
    await expect
      .poll(
        () =>
          handle.page
            .locator('img[src^="plumelens://thumb/"]')
            .evaluateAll(
              (images) =>
                images.filter((image) => (image as HTMLImageElement).naturalWidth > 0).length,
            ),
        { timeout: 30_000 },
      )
      .toBeGreaterThan(0)
    await handle.page.screenshot({
      path: join(REPO_ROOT, '.tools', 'windows-selection-screen.png'),
    })
    expect(errors).toEqual([])
    const logs = join(dataDir, 'logs')
    const engineLog = readdirSync(logs)
      .filter((name) => name.startsWith('engine.stderr.'))
      .sort()
      .at(-1)!
    const enginePid = Number(
      readFileSync(join(logs, engineLog), 'utf8').match(/Started server process \[(\d+)\]/)?.[1],
    )
    expect(enginePid).toBeGreaterThan(0)
    await handle.app.close()
    await expect
      .poll(
        () => {
          try {
            process.kill(enginePid, 0)
            return true
          } catch {
            return false
          }
        },
        { timeout: 20_000 },
      )
      .toBe(false)
    expect(readFileSync(join(logs, engineLog), 'utf8')).toContain('Application shutdown complete')
    handle = await launchApp(dataDir)
    await waitForEngineReady(handle.page, dataDir)
    await expect(handle.page.getByText('Windows 鸟片测试').first()).toBeVisible()
  } catch (error) {
    await handle.page.screenshot({ path: test.info().outputPath('windows-failure.png') }).catch(() => {})
    const diagnostics = await handle.page
      .evaluate(() => ({
        text: document.body.innerText,
        visibility: document.visibilityState,
        viewport: { width: innerWidth, height: innerHeight },
        images: Array.from(document.images, (image) => ({
          src: image.src,
          currentSrc: image.currentSrc,
          width: image.naturalWidth,
          complete: image.complete,
        })),
      }))
      .catch(() => null)
    writeFileSync(
      test.info().outputPath('windows-diagnostics.json'),
      JSON.stringify({ dataDir, diagnostics }, null, 2),
    )
    const logs = join(dataDir, 'logs')
    if (existsSync(logs)) {
      for (const name of readdirSync(logs)) {
        if (name === 'engine.jsonl' || name.startsWith('engine.stderr.')) {
          writeFileSync(test.info().outputPath(name), readFileSync(join(logs, name)))
        }
      }
    }
    throw error
  } finally {
    if (resourceOutput) writeFileSync(resourceOutput + '.stop', '')
    monitor?.kill()
    await handle.app.close().catch(() => {})
  }
})

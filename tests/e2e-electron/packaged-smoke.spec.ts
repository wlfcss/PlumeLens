/**
 * 跨平台打包应用端到端冒烟验证（macOS 挂载 DMG 与 Windows 解压 ZIP 共用）。
 *
 * 覆盖核心交付链路（零 waitForTimeout 硬睡眠）：
 * 1. /health 模型就绪（YOLO / 姿态 / 画质 / 物种全链路可用）
 * 2. 导入确定性鸟图样本并执行真实批量分析
 * 3. 选片查询与离线导出（含 XMP 边车 + 中文清单 JSON）
 * 4. 选片页 plumelens://thumb/ 缩略图真实解码 + 羽迹页 plumelens://species-artwork/ 离线加载（零外网 Wikimedia 请求）
 * 5. 零未捕获 pageerror，关闭应用后后端进程优雅退出无残留，同目录重启历史仍完整可见
 */
import { expect, test } from '@playwright/test'
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  FIXTURE_PHOTOS_DIR,
  callEngine,
  cleanupDataDir,
  importFixtureLibrary,
  launchApp,
  makeTmpDataDir,
  waitForEngineReady,
  waitForLibraryReady,
} from './helpers/launch.js'

test('Packaged app: real inference, thumbnails, offline artwork, export and clean shutdown', async () => {
  test.setTimeout(process.env.CI ? 480_000 : 240_000)

  const dataDir = makeTmpDataDir()
  const fixtureDir = process.env.PLUMELENS_TEST_PHOTOS || FIXTURE_PHOTOS_DIR
  const exportDir = join(dataDir, 'smoke-exports')
  mkdirSync(exportDir, { recursive: true })

  let handle = await launchApp(dataDir)
  try {
    await waitForEngineReady(handle.page, dataDir)
    await expect(handle.page.getByRole('button', { name: /选择照片文件夹/ })).toBeVisible()

    const pageErrors: string[] = []
    const externalWikiRequests: string[] = []
    handle.page.on('pageerror', (error) => pageErrors.push(error.message))
    handle.page.on('request', (request) => {
      if (request.url().includes('wikimedia.org')) externalWikiRequests.push(request.url())
    })

    // 1. 核验完整管线健康状态
    const health = JSON.parse((await callEngine(handle.page, '/health')).body)
    expect(health.pipeline.ready).toBe(true)
    expect(health.pipeline.quality_available).toBe(true)
    expect(health.pipeline.pose_available).toBe(true)
    expect(health.pipeline.species_available).toBe(true)

    // 2. 导入确定性鸟图样本并执行真实批量分析
    const library = await importFixtureLibrary(handle.page, fixtureDir, 'Packaged Smoke Lib')
    await waitForLibraryReady(handle.page, library.id, 60_000)

    const initialDetail = JSON.parse(
      (await callEngine(handle.page, `/library/${library.id}`)).body,
    )
    const photos = initialDetail.photos as Array<{ id: string }>
    expect(photos.length).toBeGreaterThan(0)

    const started = await callEngine(handle.page, '/analysis/batch', {
      method: 'POST',
      body: JSON.stringify({ library_id: library.id, force_rerun: false }),
    })
    expect(started.ok, started.body).toBe(true)

    await expect
      .poll(
        async () => {
          const snapshot = JSON.parse(
            (await callEngine(handle.page, `/analysis/library/${library.id}/stats`)).body,
          )
          if ((snapshot.stats.dead ?? 0) > 0) {
            const tasks = await callEngine(handle.page, `/analysis/library/${library.id}/tasks`)
            throw new Error(`Dead analysis tasks: ${tasks.body}`)
          }
          return snapshot.stats.completed ?? 0
        },
        { timeout: process.env.CI ? 360_000 : 180_000, intervals: [500, 1_000, 2_000] },
      )
      .toBe(photos.length)

    const analyzed = JSON.parse((await callEngine(handle.page, `/library/${library.id}`)).body)
    expect(analyzed.library.analyzed_count).toBe(photos.length)

    // 3. 选片查询与导出（复制原片 + XMP 边车 + 清单）
    const selectionQuery = {
      grades: ['select', 'usable', 'record', 'reject'],
      include_no_bird: true,
    }
    const selectionResp = await callEngine(
      handle.page,
      `/library/${library.id}/selection/query`,
      { method: 'POST', body: JSON.stringify(selectionQuery) },
    )
    expect(selectionResp.ok, selectionResp.body).toBe(true)
    const selection = JSON.parse(selectionResp.body)
    expect(selection.matched_count).toBe(photos.length)

    const exported = await callEngine(handle.page, `/export/library/${library.id}`, {
      method: 'POST',
      body: JSON.stringify({
        target_dir: exportDir,
        grades: ['select', 'usable', 'record', 'reject'],
        include_companions: false,
        include_xmp_sidecars: true,
        include_manifest: true,
        copy_files: true,
        scope: 'selection',
        selection_query: selectionQuery,
        projection_revision: selection.projection_revision,
      }),
    })
    expect(exported.ok, exported.body).toBe(true)
    const jobId = JSON.parse(exported.body).job_id
    await expect
      .poll(
        async () =>
          JSON.parse((await callEngine(handle.page, `/export/jobs/${jobId}`)).body).status,
        { timeout: 30_000 },
      )
      .toBe('succeeded')
    const exportResult = JSON.parse((await callEngine(handle.page, `/export/jobs/${jobId}`)).body)
      .result
    expect(exportResult.exported_count).toBe(photos.length)
    expect(exportResult.xmp_count).toBe(photos.length)
    expect(exportResult.failed_count).toBe(0)
    expect(JSON.parse(readFileSync(exportResult.manifest.json, 'utf8'))['照片清单']).toHaveLength(
      photos.length,
    )

    // 4. 刷新前端验证缩略图（plumelens://thumb/）与离线物种封面（plumelens://species-artwork/）
    await handle.page.reload()
    await expect(handle.page.getByText('Packaged Smoke Lib').first()).toBeVisible({
      timeout: 15_000,
    })
    await handle.page.getByText('Packaged Smoke Lib').first().click()
    await expect(handle.page.getByRole('button', { name: '选片', exact: true })).toBeVisible()

    const noBirdBtn = handle.page.getByRole('button', { name: '无鸟', exact: true })
    if ((await noBirdBtn.getAttribute('aria-pressed')) !== 'true') await noBirdBtn.click()
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

    await handle.page.getByRole('button', { name: '羽迹', exact: true }).click()
    await expect(handle.page.getByRole('button', { name: '物种' }).first()).toBeVisible({
      timeout: 10_000,
    })
    // 切至完整图鉴验证离线物种封面协议（plumelens://species-artwork/）返回有效 WebP 且零外网请求
    await handle.page.getByText('图鉴总数').first().click()
    await expect(handle.page.locator('.collection-card').first()).toBeVisible({ timeout: 10_000 })
    const artworkCheck = await handle.page.evaluate(async () => {
      const resp = await fetch('plumelens://species-artwork/Alcedo%20atthis')
      if (!resp.ok) return { ok: false, status: resp.status, width: 0, contentType: '' }
      const blob = await resp.blob()
      const bitmap = await createImageBitmap(blob)
      const width = bitmap.width
      bitmap.close()
      return { ok: true, status: resp.status, width, contentType: resp.headers.get('content-type') }
    })
    expect(artworkCheck.ok).toBe(true)
    expect(artworkCheck.contentType).toContain('image/webp')
    expect(artworkCheck.width).toBeGreaterThan(0)
    expect(externalWikiRequests).toEqual([])
    expect(pageErrors).toEqual([])

    // 5. 关闭应用并验证后端进程优雅退出，同 dataDir 重启历史仍可见
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
    await expect(handle.page.getByText('Packaged Smoke Lib').first()).toBeVisible({
      timeout: 15_000,
    })
  } catch (error) {
    await handle.page
      .screenshot({ path: test.info().outputPath('packaged-smoke-failure.png') })
      .catch(() => {})
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
    await handle.app.close().catch(() => {})
    cleanupDataDir(dataDir)
  }
})

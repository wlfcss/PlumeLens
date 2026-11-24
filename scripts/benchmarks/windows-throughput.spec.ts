import { expect, test } from '@playwright/test'
import { spawn } from 'node:child_process'
import { join } from 'node:path'
import { readFileSync, readdirSync, writeFileSync, rmSync } from 'node:fs'
import {
  launchApp,
  waitForEngineReady,
  callEngine,
  REPO_ROOT,
} from '../../tests/e2e-electron/helpers/launch.js'

test('Windows: measure bounded concurrency with real GPU and memory counters', async () => {
  test.skip(
    process.platform !== 'win32' || !process.env.PLUMELENS_PERF_DATA_DIR,
    'Requires Windows performance fixtures',
  )
  test.setTimeout(600_000)
  const concurrency = process.env.PLUMELENS_ANALYSIS_CONCURRENCY ?? 'auto'
  const dataDir = process.env.PLUMELENS_PERF_DATA_DIR!
  const libraryId = process.env.PLUMELENS_PERF_LIBRARY_ID!
  const output = join(REPO_ROOT, '.tools', `windows-throughput-${concurrency}.json`)
  const stopFile = output + '.stop'
  rmSync(stopFile, { force: true })
  const { app, page } = await launchApp(dataDir)
  let monitor: ReturnType<typeof spawn> | undefined
  try {
    await waitForEngineReady(page, dataDir)
    const health = JSON.parse((await callEngine(page, '/health')).body)
    expect(health.pipeline.models.yolo.provider).toBe('AMDGPUExecutionProvider')
    if (concurrency === 'auto') {
      expect(health.resources.configuration.analysis_concurrency).toBe(3)
      expect(health.resources.configuration.thumbnail_concurrency).toBe(4)
      expect(health.resources.configuration.worker_threads).toBe(8)
      expect(health.resources.manual_overrides).not.toContain('analysis_concurrency')
    }
    const detail = JSON.parse((await callEngine(page, `/library/${libraryId}`)).body)
    expect(detail.photos.length).toBe(32)
    const logDir = join(dataDir, 'logs')
    const log = readdirSync(logDir)
      .filter((name) => name.startsWith('engine.stderr.'))
      .sort()
      .at(-1)!
    const pid = Number(
      readFileSync(join(logDir, log), 'utf8').match(/Started server process \[(\d+)\]/)?.[1],
    )
    expect(pid).toBeGreaterThan(0)
    monitor = spawn(
      process.env.PLUMELENS_PYTHON!,
      [
        join(REPO_ROOT, 'scripts', 'monitor-windows.py'),
        '--pid',
        String(pid),
        '--seconds',
        '580',
        '--stop-file',
        stopFile,
        '--output',
        output,
      ],
      { windowsHide: true, stdio: 'ignore' },
    )
    const started = performance.now()
    const response = await callEngine(page, '/analysis/batch', {
      method: 'POST',
      body: JSON.stringify({ library_id: libraryId, force_rerun: true }),
    })
    expect(response.ok, response.body).toBe(true)
    await expect
      .poll(
        async () => {
          const snapshot = JSON.parse(
            (await callEngine(page, `/analysis/library/${libraryId}/stats`)).body,
          )
          if (snapshot.stats.dead || snapshot.stats.failed)
            throw new Error(JSON.stringify(snapshot))
          return snapshot.stats.completed
        },
        { timeout: 540_000, intervals: [1000] },
      )
      .toBe(32)
    const seconds = (performance.now() - started) / 1000
    writeFileSync(
      output + '.result.json',
      JSON.stringify(
        {
          concurrency: health.resources.configuration.analysis_concurrency,
          requested: concurrency,
          photos: 32,
          seconds,
          photos_per_minute: (32 * 60) / seconds,
          health,
        },
        null,
        2,
      ),
    )
    writeFileSync(stopFile, '')
    await new Promise<void>((resolve) => monitor!.once('exit', () => resolve()))
    const resources = JSON.parse(readFileSync(output, 'utf8'))
    expect(resources.samples.length).toBeGreaterThan(10)
    expect(resources.summary.private_bytes.max).toBeLessThan(13 * 1024 ** 3)
  } finally {
    writeFileSync(stopFile, '')
    monitor?.kill()
    await app.close()
  }
})

/** Real packaged lifecycle and protocol regressions; all files/processes are test-owned. */
import { execFileSync, spawn } from 'node:child_process'
import { mkdirSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, test } from '@playwright/test'
import {
  callEngine,
  APP_PATH,
  cleanupDataDir,
  importFixtureLibrary,
  launchApp,
  makeTmpDataDir,
  REPO_ROOT,
  waitForEngineReady,
  waitForLibraryReady,
  type LaunchHandle,
} from './helpers/launch.js'

let handle: LaunchHandle
let closed = false
const observedEnginePids = new Set<number>()
const mainErrors: string[] = []
const expectedAppVersion = JSON.parse(readFileSync(join(REPO_ROOT, 'package.json'), 'utf8'))
  .version as string

function watchMainErrors(target: LaunchHandle): void {
  target.app.process().stderr?.on('data', (data: Buffer) => {
    const text = data.toString()
    if (text.includes('uncaughtException') || text.includes('ERR_STREAM_WRITE_AFTER_END')) {
      mainErrors.push(text)
    }
  })
}

function assertNoForcedShutdown(dataDir: string): void {
  expect(readFileSync(join(dataDir, 'logs', 'electron.log'), 'utf8')).not.toContain(
    'shutdown timed out',
  )
}

function ownedEnginePids(parentPid = handle.app.process().pid): number[] {
  return execFileSync('/bin/ps', ['-axo', 'pid=,ppid=,command='], { encoding: 'utf8' })
    .split('\n')
    .flatMap((line) => {
      const match = line.match(/^\s*(\d+)\s+(\d+)\s+(.+)$/)
      if (
        !match ||
        Number(match[2]) !== parentPid ||
        !match[3].includes('/Resources/plumelens-engine/plumelens-engine')
      ) {
        return []
      }
      return [Number(match[1])]
    })
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

test.beforeAll(async () => {
  const dataDir = makeTmpDataDir()
  handle = await launchApp(dataDir)
  watchMainErrors(handle)
  await waitForEngineReady(handle.page, dataDir)
  for (const pid of ownedEnginePids()) observedEnginePids.add(pid)
})

test('packaged lifecycle: duplicate userData launch exits without replacing the active engine', async () => {
  const before = ownedEnginePids()
  expect(before).toHaveLength(1)
  const duplicate = spawn(APP_PATH, [`--user-data-dir=${handle.dataDir}`], {
    env: {
      ...process.env,
      PLUMELENS_SKIP_ORPHAN_KILL: '1',
      PLUMELENS_E2E_DISABLE_CLOSE_CONFIRM: '1',
      PLUMELENS_E2E_SKIP_LOG_CONSENT: '1',
    },
    stdio: 'ignore',
  })
  try {
    await expect.poll(() => duplicate.exitCode, { timeout: 15_000 }).toBe(0)
    expect(ownedEnginePids()).toEqual(before)
    expect((await callEngine(handle.page, '/library')).ok).toBe(true)
  } finally {
    if (duplicate.exitCode === null && duplicate.signalCode === null) duplicate.kill('SIGKILL')
  }
})

test('packaged lifecycle: a different userData instance starts and quits independently', async () => {
  const before = ownedEnginePids()
  const otherDir = makeTmpDataDir()
  const other = await launchApp(otherDir)
  watchMainErrors(other)
  try {
    await waitForEngineReady(other.page, otherDir)
    expect(ownedEnginePids(other.app.process().pid)).toHaveLength(1)
    expect(ownedEnginePids()).toEqual(before)
    expect((await callEngine(handle.page, '/library')).ok).toBe(true)
    expect((await callEngine(other.page, '/library')).ok).toBe(true)
  } finally {
    const otherPids = ownedEnginePids(other.app.process().pid)
    await other.app.close()
    await expect
      .poll(() => otherPids.filter((pid) => isAlive(pid)), { timeout: 20_000 })
      .toEqual([])
    assertNoForcedShutdown(otherDir)
    cleanupDataDir(otherDir)
  }
  expect(ownedEnginePids()).toEqual(before)
})

test.afterAll(async () => {
  if (!closed) await handle?.app.close().catch(() => {})
  if (handle) cleanupDataDir(handle.dataDir)
  expect(mainErrors).toEqual([])
})

test('packaged security: sandbox, isolated preload, bearer auth and local path confinement', async ({
  request,
}, testInfo) => {
  const runtime = await handle.app.evaluate(({ app, BrowserWindow }) => {
    const window = BrowserWindow.getAllWindows()[0]
    const contents = window.webContents as typeof window.webContents & {
      getLastWebPreferences: () => {
        sandbox?: boolean
        contextIsolation?: boolean
        nodeIntegration?: boolean
      }
    }
    const prefs = contents.getLastWebPreferences()
    return {
      packaged: app.isPackaged,
      appVersion: app.getVersion(),
      userData: app.getPath('userData'),
      electron: process.versions.electron,
      chromium: process.versions.chrome,
      node: process.versions.node,
      sandbox: prefs.sandbox,
      contextIsolation: prefs.contextIsolation,
      nodeIntegration: prefs.nodeIntegration,
    }
  })
  expect(runtime.packaged).toBe(true)
  expect(runtime.appVersion).toBe(expectedAppVersion)
  expect(realpathSync(runtime.userData)).toBe(realpathSync(handle.dataDir))
  expect(runtime.electron).toBe('41.6.0')
  expect(runtime.sandbox).toBe(true)
  expect(runtime.contextIsolation).toBe(true)
  expect(runtime.nodeIntegration).toBe(false)
  await testInfo.attach('runtime', {
    body: JSON.stringify(runtime, null, 2),
    contentType: 'application/json',
  })

  const renderer = await handle.page.evaluate(() => {
    const w = window as unknown as {
      require?: unknown
      process?: unknown
      plumelens?: Record<string, unknown>
    }
    return {
      requireType: typeof w.require,
      processType: typeof w.process,
      bridge: Object.keys(w.plumelens ?? {}),
    }
  })
  expect(renderer.requireType).toBe('undefined')
  expect(renderer.processType).toBe('undefined')
  expect(renderer.bridge).toContain('engineRequest')
  expect(renderer.bridge).not.toContain('getBackendAuthToken')
  expect(renderer.bridge).not.toContain('authToken')
  const backend = await waitForEngineReady(handle.page, handle.dataDir)
  expect((await request.get(`${backend}/library`)).status()).toBe(401)
  expect((await callEngine(handle.page, '/library')).ok).toBe(true)
  const health = await callEngine(handle.page, '/health')
  expect(health.ok).toBe(true)
  const healthPayload = JSON.parse(health.body)
  expect(healthPayload.version).toBe(expectedAppVersion)
  const pipeline = healthPayload.pipeline
  expect(pipeline.ready).toBe(true)
  expect(pipeline.quality_available).toBe(true)
  expect(pipeline.pose_available).toBe(true)
  expect(pipeline.species_available).toBe(true)
  const models = Object.values(pipeline.models) as { loaded: boolean; provider: string | null }[]
  expect(models.length).toBeGreaterThanOrEqual(5)
  for (const model of models) {
    expect(model.loaded).toBe(true)
    expect(model.provider).toBeTruthy()
  }
  await testInfo.attach('pipeline', { body: health.body, contentType: 'application/json' })

  const refusedExternalPath = await handle.page.evaluate(async () => {
    const w = window as unknown as {
      plumelens: { engineRequest: (path: string) => Promise<unknown> }
    }
    try {
      await w.plumelens.engineRequest('https://example.invalid/private')
      return false
    } catch {
      return true
    }
  })
  expect(refusedExternalPath).toBe(true)

  const outside = join(handle.dataDir, 'private-test-data.txt')
  const grid = join(handle.dataDir, 'derived', 'thumbnails', 'grid')
  mkdirSync(grid, { recursive: true })
  writeFileSync(outside, 'test-secret-must-not-be-served')
  symlinkSync(outside, join(grid, 'escape.jpg'))
  const protocol = await handle.page.evaluate(async () => {
    const status = async (url: string) => {
      const response = await fetch(url)
      return { status: response.status, body: await response.text() }
    }
    return {
      traversal: await status('plumelens://thumb/grid/%252e%252e/private-test-data.txt'),
      symlink: await status('plumelens://thumb/grid/escape.jpg'),
      badHost: await status('plumelens://unsupported/file.jpg'),
      artworkStatus: (await fetch('plumelens://species-artwork/Alcedo%20atthis')).status,
    }
  })
  expect(protocol.traversal.status).toBe(403)
  expect(protocol.symlink.status).toBe(403)
  expect(protocol.badHost.status).toBe(400)
  expect(protocol.artworkStatus).toBe(200)
  expect(JSON.stringify(protocol)).not.toContain('test-secret-must-not-be-served')
})

test('packaged lifecycle: owned engine crash automatically recovers authenticated IPC', async () => {
  const before = ownedEnginePids()
  expect(before).toHaveLength(1)
  const enginePid = before[0]
  observedEnginePids.add(enginePid)
  // Only this app's direct engine child is targeted; no process-name-wide kill.
  process.kill(enginePid, 'SIGKILL')
  await expect
    .poll(
      async () => {
        const current = ownedEnginePids()
        if (current.length !== 1 || current[0] === enginePid) return false
        observedEnginePids.add(current[0])
        try {
          const health = await callEngine(handle.page, '/health')
          return health.ok && JSON.parse(health.body).pipeline.ready === true
        } catch {
          return false
        }
      },
      { timeout: 60_000, intervals: [500, 1_000] },
    )
    .toBe(true)
  expect((await callEngine(handle.page, '/library')).ok).toBe(true)
  expect(isAlive(enginePid)).toBe(false)
})

test('packaged selection: new query API and native species picker use the frozen backend', async () => {
  const library = await importFixtureLibrary(handle.page, undefined, 'packaged-selection-contract')
  await waitForLibraryReady(handle.page, library.id)
  const unfiltered = await callEngine(handle.page, `/library/${library.id}/selection/query`, {
    method: 'POST',
    body: JSON.stringify({ species_keys: [] }),
  })
  expect(unfiltered.ok).toBe(true)
  const preview = JSON.parse(unfiltered.body)
  expect(preview.total_count).toBe(5)
  expect(preview.matched_count).toBe(5)
  expect(preview.projection_revision).toMatch(/^[0-9a-f]+$/)
  const filtered = await callEngine(handle.page, `/library/${library.id}/selection/query`, {
    method: 'POST',
    body: JSON.stringify({ species_keys: ['sci:Alcedo atthis'] }),
  })
  expect(filtered.ok).toBe(true)
  expect(JSON.parse(filtered.body).matched_count).toBe(0)
  await handle.page.reload()
  await expect(handle.page.getByText('packaged-selection-contract').first()).toBeVisible({
    timeout: 15_000,
  })
  await handle.page.getByRole('button', { name: '选片', exact: true }).click()
  await handle.app.evaluate(({ BrowserWindow }) => {
    BrowserWindow.getAllWindows()[0].setSize(1360, 860)
  })
  const picker = handle.page.getByRole('button', { name: '鸟种：全部', exact: true })
  await expect(picker).toBeVisible()
  await picker.click()
  await expect(handle.page.getByRole('searchbox', { name: '查找当前文件夹中的鸟种' })).toBeFocused()
  await expect(handle.page.getByRole('checkbox', { name: '包含待审判断' })).toBeChecked()
  const done = handle.page.getByRole('button', { name: '完成', exact: true })
  const bounds = await done.boundingBox()
  const viewport = await handle.page.evaluate(() => ({ width: innerWidth, height: innerHeight }))
  expect(bounds).not.toBeNull()
  expect(bounds!.x).toBeGreaterThanOrEqual(0)
  expect(bounds!.y).toBeGreaterThanOrEqual(0)
  expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(viewport.width)
  expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(viewport.height)
  await handle.page.screenshot({
    path: test.info().outputPath('species-filter-1360.png'),
    fullPage: false,
  })
  await handle.page.keyboard.press('Escape')
  await expect(picker).toHaveAttribute('aria-expanded', 'false')
  await expect(picker).toBeFocused()
  await handle.app.evaluate(({ BrowserWindow }) => {
    BrowserWindow.getAllWindows()[0].setSize(1680, 1040)
  })
})

test('packaged lifecycle: quitting waits for engine exit and leaves no owned child', async () => {
  const library = await importFixtureLibrary(handle.page, undefined, 'shutdown-sse-regression')
  await waitForLibraryReady(handle.page, library.id)
  await handle.page.evaluate(async (path) => {
    const w = window as unknown as {
      plumelens: {
        engineSseSubscribe: (
          path: string,
          onEvent: (event: { type: string; message?: string }) => void,
        ) => () => void
      }
    }
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('SSE did not open')), 5_000)
      // Intentionally keep this subscription open while requesting application quit.
      w.plumelens.engineSseSubscribe(path, (event) => {
        if (event.type === 'message') {
          clearTimeout(timer)
          resolve()
        } else if (event.type === 'error') {
          clearTimeout(timer)
          reject(new Error(event.message ?? 'SSE failed'))
        }
      })
    })
  }, `/analysis/library/${library.id}/progress`)
  for (const pid of ownedEnginePids()) observedEnginePids.add(pid)
  const appProcess = handle.app.process()
  await handle.app.close()
  closed = true
  await expect
    .poll(() => appProcess.exitCode !== null || appProcess.signalCode !== null, { timeout: 20_000 })
    .toBe(true)
  await expect
    .poll(() => [...observedEnginePids].filter((pid) => isAlive(pid)), { timeout: 20_000 })
    .toEqual([])
  assertNoForcedShutdown(handle.dataDir)
})

test('packaged lifecycle: engine observes a killed owner and exits itself', async () => {
  const dataDir = makeTmpDataDir()
  const isolated = await launchApp(dataDir)
  watchMainErrors(isolated)
  let enginePids: number[] = []
  try {
    await waitForEngineReady(isolated.page, dataDir)
    enginePids = ownedEnginePids(isolated.app.process().pid)
    expect(enginePids).toHaveLength(1)
    const parentPid = isolated.app.process().pid
    if (!parentPid) throw new Error('isolated app has no PID')
    process.kill(parentPid, 'SIGKILL')
    await expect
      .poll(() => enginePids.filter((pid) => isAlive(pid)), { timeout: 20_000 })
      .toEqual([])
    expect(readFileSync(join(dataDir, 'logs', 'engine.jsonl'), 'utf8')).toContain(
      'Parent exited; requesting own engine shutdown',
    )
  } finally {
    await isolated.app.close().catch(() => {})
    // Only a failed test needs this bounded cleanup, and only its recorded engine is signalled.
    for (const pid of enginePids) {
      if (isAlive(pid)) process.kill(pid, 'SIGTERM')
    }
    cleanupDataDir(dataDir)
  }
})

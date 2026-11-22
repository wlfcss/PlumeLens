/**
 * Measure the built desktop UI against one isolated benchmark backend.
 *
 * npm run build
 * node scripts/benchmark-library.mjs --data-dir /tmp/fixture --port-file /tmp/port.json \
 *   --output /tmp/ui.json --cold-runs 1 --warm-runs 2 --filters 5
 */
/* global AbortSignal, Element, document, fetch, getComputedStyle, innerHeight, innerWidth,
devicePixelRatio, performance, requestAnimationFrame, window */

import { createRequire } from 'node:module'
import { mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises'
import { arch, platform, release, tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import process from 'node:process'
import { setTimeout as sleep } from 'node:timers/promises'
import { fileURLToPath, URL, URLSearchParams } from 'node:url'
import { parseArgs } from 'node:util'

import { _electron } from '@playwright/test'

const require = createRequire(import.meta.url)
const root = fileURLToPath(new URL('..', import.meta.url))
const openSelector = '.start-screen [data-testid="recent-folder-stack"] button.folder-line'
const filterSelector = '.species-filter__options input[name="species"]'
const summarySelector = '.selection-result-summary [role="status"]'
const defaultTimeoutMs = 60_000
const filterStartPhases = ['natural', 'summary-in-flight', 'summary-finished']

const { values } = parseArgs({
  options: {
    'data-dir': { type: 'string' },
    'port-file': { type: 'string' },
    output: { type: 'string' },
    'cold-runs': { type: 'string', default: '1' },
    'warm-runs': { type: 'string', default: '2' },
    filters: { type: 'string', default: '5' },
    'species-key': { type: 'string', multiple: true },
    'filter-start-phase': { type: 'string', default: 'natural' },
    trace: { type: 'boolean' },
    'sample-ms': { type: 'string', default: '220' },
    'timeout-ms': { type: 'string', default: String(defaultTimeoutMs) },
    help: { type: 'boolean' },
  },
})

if (values.help) {
  process.stdout.write(
    'Usage: node scripts/benchmark-library.mjs --data-dir PATH --port-file PATH --output PATH\n' +
      '       [--cold-runs 1] [--warm-runs 2] [--filters 5] [--sample-ms 220]\n' +
      '       [--trace] [--species-key "sci:Passer montanus"] [--filter-start-phase natural]\n' +
      `       phases: ${filterStartPhases.join(', ')}\n`,
  )
  process.exit(0)
}

function integer(name, minimum) {
  const value = Number(values[name])
  if (!Number.isInteger(value) || value < minimum) {
    throw new Error(`--${name} must be an integer of at least ${minimum}`)
  }
  return value
}

function pathArgument(name) {
  if (!values[name]) throw new Error(`--${name} is required`)
  return resolve(values[name])
}

/** Match the backend untouched. Only Electron's subprocess startup handshake is redirected. */
async function createEngineShim(port) {
  const dir = await mkdtemp(join(tmpdir(), 'plumelens-benchmark-shim-'))
  const path = join(dir, 'engine-benchmark')
  await writeFile(
    path,
    `#!/bin/sh\nprintf '%s\\n' 'PLUMELENS_PORT ${port}' 'PLUMELENS_READY' >&2\nexec /bin/sleep 86400\n`,
    { mode: 0o700 },
  )
  return { dir, path }
}

function recordRequests(page, origin, libraryPath, captureTrace) {
  const items = new Map()
  const reads = new Set()
  page.on('request', (request) => {
    const url = new URL(request.url())
    if (
      url.origin !== origin ||
      (!['/library', libraryPath, `${libraryPath}/selection/query`].includes(url.pathname) &&
        !/^\/library\/photo\/[^/]+\/review$/.test(url.pathname))
    )
      return

    let filter = null
    if (request.method() === 'POST') {
      filter = request.postDataJSON()?.species_keys ?? null
    }
    items.set(request, {
      endpoint: url.pathname,
      queryString: url.search,
      method: request.method(),
      speciesKeys: filter,
      observedStartEpochMs: Date.now(),
      status: null,
      timing: null,
      responseBodyBytes: null,
    })
  })
  page.on('response', (response) => {
    const item = items.get(response.request())
    if (!item) return
    item.status = response.status()
    item.responseMediaType = response.headers()['content-type']
    item.responseHeadersEpochMs = Date.now()
    if (captureTrace) item.traceRequestId = response.headers()['x-plumelens-benchmark-request-id']
  })
  page.on('requestfinished', (request) => {
    const item = items.get(request)
    if (!item) return
    item.timing = request.timing()
    item.observedFinishEpochMs = Date.now()
    const task = request.sizes().then(
      (sizes) => {
        item.responseBodyBytes = sizes.responseBodySize
      },
      (error) => {
        item.sizesError = String(error)
      },
    )
    reads.add(task)
    void task.finally(() => reads.delete(task))
  })
  page.on('requestfailed', (request) => {
    const item = items.get(request)
    if (!item) return
    item.timing = request.timing()
    item.observedFinishEpochMs = Date.now()
    item.error = request.failure()?.errorText ?? 'unknown'
  })
  function summaries() {
    return [...items.values()].filter(
      ({ endpoint, method, queryString }) =>
        method === 'GET' &&
        endpoint === libraryPath &&
        new URLSearchParams(queryString).get('view') === 'summary',
    )
  }

  async function confirmSummaryStreams() {
    const pending = summaries().filter(
      (item) =>
        item.responseMediaType === 'application/x-ndjson' &&
        item.status === 200 &&
        item.error === 'net::ERR_ABORTED',
    )
    if (!captureTrace || !pending.length || page.isClosed()) return
    const completions = await page.evaluate(() => {
      const events = window.__PLUMELENS_BENCHMARK_TRACE__ ?? []
      const complete = new Map(
        events
          .filter(({ name, area, status }) =>
            name === 'api.transport_end' && area === 'library-detail' && status === 200,
          )
          .map(({ id, at }) => [id, at]),
      )
      return events
        .filter(({ name, area, id }) =>
          name === 'api.fetch_start' && area === 'library-detail' && complete.has(id),
        )
        .map(({ id, at }) => ({
          start: performance.timeOrigin + at,
          finish: performance.timeOrigin + complete.get(id),
        }))
    })
    for (const item of pending) {
      const start = item.timing?.startTime ?? item.observedStartEpochMs
      const sameRequest = completions.find(({ start: fetchStart }) => Math.abs(fetchStart - start) < 75)
      if (!sameRequest) continue
      // Chromium may tell DevTools that a stream was aborted after the
      // renderer has fully consumed it. Retain both observations.
      item.devToolsError = item.error
      item.rendererFinishedEpochMs = sameRequest.finish
      delete item.error
    }
  }

  return {
    summaries,
    confirmSummaryStreams,
    finish: async () => {
      await confirmSummaryStreams()
      await Promise.allSettled(reads)
      return [...items.values()]
    },
  }
}

/**
 * Observe actual paintable images within the scroll pane, ignoring virtual overscan.
 * The click clock is grabbed before React receives the same user input event.
 */
async function measurePaintableResult(page, locator, clickSelector, timeoutMs, previousSummary) {
  await page.evaluate(
    ({ clickSelector, previousSummary, timeoutMs }) => {
      window.__plumelensBenchmark = null
      const recordClick = (event) => {
        if (!(event.target instanceof Element) || !event.target.closest(clickSelector)) return
        document.removeEventListener('click', recordClick, true)
        const start = performance.now()
        let firstReady = null
        let previousFirst = null
        let previousAll = null
        let framesFirst = 0
        let framesAll = 0

        function observe(now) {
          const pane = document.querySelector('.selection-main')
          const status = pane?.querySelector('.selection-result-summary')
          const summary = status?.querySelector('[role="status"]')?.textContent?.trim() ?? ''
          const ariaBusy = status?.getAttribute('aria-busy') ?? null
          const updated =
            ariaBusy === 'false' &&
            summary &&
            (previousSummary === undefined || summary !== previousSummary)
          let visible = []
          if (pane && updated) {
            const paneRect = pane.getBoundingClientRect()
            const viewportLeft = Math.max(0, paneRect.left)
            const viewportRight = Math.min(innerWidth, paneRect.right)
            const viewportTop = Math.max(0, paneRect.top)
            const viewportBottom = Math.min(innerHeight, paneRect.bottom)
            visible = [...pane.querySelectorAll('.photo-tile[data-photo-id] .photo-preview')]
              .map((preview) => {
                const rect = preview.getBoundingClientRect()
                const width =
                  Math.min(viewportRight, rect.right) - Math.max(viewportLeft, rect.left)
                const height =
                  Math.min(viewportBottom, rect.bottom) - Math.max(viewportTop, rect.top)
                if (width < 16 || height < 16) return null
                const image = preview.querySelector('img')
                const decoded = Boolean(
                  image?.currentSrc &&
                  image.complete &&
                  image.naturalWidth > 0 &&
                  Number(getComputedStyle(image).opacity) > 0,
                )
                return {
                  id: preview.closest('[data-photo-id]').getAttribute('data-photo-id'),
                  position: [rect.x, rect.y, rect.width, rect.height].map(Math.round),
                  decoded,
                }
              })
              .filter(Boolean)
          }

          const first = visible[0]?.decoded ? JSON.stringify(visible[0]) : null
          const all =
            visible.length && visible.every((thumb) => thumb.decoded)
              ? JSON.stringify(visible)
              : null
          framesFirst = first ? (first === previousFirst ? framesFirst + 1 : 1) : 0
          framesAll = all ? (all === previousAll ? framesAll + 1 : 1) : 0
          previousFirst = first
          previousAll = all

          if (framesFirst >= 2 && !firstReady) {
            firstReady = { ms: now - start, photoId: visible[0].id }
          }
          if (framesAll >= 2 || now - start >= timeoutMs) {
            window.__plumelensBenchmark = {
              clickEpochMs: performance.timeOrigin + start,
              completedEpochMs: performance.timeOrigin + now,
              firstThumbnailMs: firstReady?.ms ?? null,
              firstPhotoId: firstReady?.photoId ?? null,
              viewportThumbnailsMs: framesAll >= 2 ? now - start : null,
              viewportPhotoIds: visible.map((thumb) => thumb.id),
              viewportCount: visible.length,
              resultSummary: summary,
              timedOut: framesAll < 2,
            }
            if (framesAll < 2) {
              window.__plumelensBenchmark.phase = !pane
                ? 'selection-pane-not-visible'
                : !status || !summary
                  ? 'selection-summary-not-visible'
                  : !updated
                    ? 'selection-summary-not-fresh'
                    : !visible.length
                      ? 'no-viewport-photos'
                      : !firstReady
                        ? 'first-thumbnail-not-ready'
                        : 'viewport-thumbnails-not-ready'
              window.__plumelensBenchmark.diagnostics = {
                ariaBusy,
                previousSummary: previousSummary ?? null,
                mountedPhotoCount: pane?.querySelectorAll('[data-photo-id]').length ?? null,
                decodedVisibleCount: visible.filter((thumb) => thumb.decoded).length,
                alert: pane?.querySelector('[role="alert"]')?.textContent?.trim() ?? null,
              }
            }
            return
          }
          requestAnimationFrame(observe)
        }
        requestAnimationFrame(observe)
      }
      document.addEventListener('click', recordClick, true)
    },
    { clickSelector, previousSummary, timeoutMs },
  )
  await locator.click({ timeout: timeoutMs })
  const metric = await page.waitForFunction(() => window.__plumelensBenchmark, undefined, {
    timeout: timeoutMs + 5_000,
  })
  const result = await metric.jsonValue()
  await metric.dispose()
  return result
}

async function startSampling(app, page, origin, intervalMs) {
  const cdp = await page.context().newCDPSession(page)
  const samples = []
  const errors = []
  let stopped = false

  const worker = (async () => {
    while (!stopped) {
      const epochMs = Date.now()
      try {
        const [memory, heap, backend] = await Promise.allSettled([
          app.evaluate(({ app, BrowserWindow }) => {
            const window = BrowserWindow.getAllWindows()[0]
            const rendererPid = window.webContents.getOSProcessId()
            const renderer = app.getAppMetrics().find((sample) => sample.pid === rendererPid)
            return {
              rendererPid,
              workingSetKiB: renderer?.memory.workingSetSize ?? null,
              peakWorkingSetKiB: renderer?.memory.peakWorkingSetSize ?? null,
            }
          }),
          cdp.send('Runtime.getHeapUsage'),
          readBackend(origin, '/__benchmark/runtime'),
        ])
        const metrics = {
          renderer: memory.status === 'fulfilled' ? memory.value : null,
          heap: heap.status === 'fulfilled' ? heap.value : null,
          backend: backend.status === 'fulfilled' ? backend.value : null,
        }
        for (const [type, entry] of Object.entries({ memory, heap, backend })) {
          if (entry.status === 'rejected')
            errors.push({ epochMs, type, error: String(entry.reason) })
        }
        samples.push({ epochMs, readMs: Date.now() - epochMs, ...metrics })
      } catch (error) {
        errors.push({ epochMs, error: String(error) })
      }
      if (!stopped) await sleep(intervalMs)
    }
  })()
  return async () => {
    stopped = true
    await worker
    await cdp.detach().catch((error) => {
      errors.push({ epochMs: Date.now(), type: 'detach', error: String(error) })
    })
    return { samples, errors }
  }
}

async function readBackend(origin, path, init) {
  const response = await fetch(`${origin}${path}`, { ...init, signal: AbortSignal.timeout(30_000) })
  if (!response.ok)
    throw new Error(`${path} returned HTTP ${response.status}: ${await response.text()}`)
  return await response.json()
}

async function ensureAnalysisRunning(origin, libraryId, statsPath) {
  let status = await readBackend(origin, statsPath)
  if (!status.stats.processing && !status.stats.pending) {
    await readBackend(origin, '/analysis/batch', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ library_id: libraryId }),
    })
  }
  const deadline = Date.now() + 15_000
  while (Date.now() < deadline) {
    status = await readBackend(origin, statsPath)
    if (status.stats.processing > 0) return status
    await sleep(200)
  }
  throw new Error(
    `No processing task after starting the benchmark workload: ${JSON.stringify(status)}`,
  )
}

function openFolder(page, timeoutMs) {
  return measurePaintableResult(page, page.locator(openSelector).first(), openSelector, timeoutMs)
}

async function waitForFilterStartPhase(network, phase, timeoutMs) {
  const startedEpochMs = Date.now()
  const deadline = startedEpochMs + timeoutMs
  while (Date.now() < deadline) {
    await network.confirmSummaryStreams()
    const summary = network
      .summaries()
      .find((item) =>
        phase === 'summary-in-flight'
          ? item.observedFinishEpochMs === undefined
          : item.observedFinishEpochMs >= startedEpochMs && item.status === 200 && !item.error,
      )
    if (summary) {
      return {
        phase,
        startedEpochMs,
        releasedEpochMs: Date.now(),
        summaryStartedEpochMs: summary.observedStartEpochMs,
        summaryFinishedEpochMs: summary.observedFinishEpochMs ?? null,
      }
    }
    await sleep(25)
  }
  throw new Error(`No naturally observed ${phase} within ${timeoutMs} ms`)
}

async function measureSpeciesFilters(
  page,
  count,
  timeoutMs,
  run,
  speciesKeys,
  filterStartPhase,
  network,
) {
  if (!count) return
  run.phase = 'open-species-filter'
  await page.locator('.species-filter__trigger:visible').click()
  const panel = page.locator('.species-filter__panel:visible')
  await panel.waitFor({ timeout: timeoutMs })
  run.phase = 'wait-species-options'
  try {
    await panel
      .locator('.species-filter__options[aria-busy="false"]')
      .waitFor({ timeout: timeoutMs })
  } catch (error) {
    run.speciesOptions = await page
      .evaluate(() => {
        const fieldset = document.querySelector('.species-filter__panel:popover-open fieldset')
        return {
          ariaBusy: fieldset?.getAttribute('aria-busy') ?? null,
          options: fieldset?.querySelectorAll('input[name="species"]').length ?? 0,
          summary:
            document
              .querySelector('.selection-result-summary [role="status"]')
              ?.textContent?.trim() ?? '',
        }
      })
      .catch(() => null)
    throw error
  }
  const keys = await panel
    .locator('label:not(.is-empty) input[name="species"]')
    .evaluateAll((inputs) =>
      inputs.map((input) => input.value).filter((value) => value.startsWith('sci:')),
    )
  if (!keys.length)
    throw new Error('No visible scientific species facet was available to benchmark')
  if (speciesKeys.some((key) => !keys.includes(key))) {
    throw new Error(
      `Requested species missing from the facet: ${speciesKeys.filter((key) => !keys.includes(key)).join(', ')}`,
    )
  }
  run.speciesOrder = speciesKeys.length ? speciesKeys : keys
  if (filterStartPhase !== 'natural') {
    run.phase = 'wait-filter-start-phase'
    run.filterStartGate = await waitForFilterStartPhase(
      network,
      filterStartPhase,
      Math.min(timeoutMs, 40_000),
    )
  }
  for (let index = 0; index < count; index += 1) {
    const speciesKey = run.speciesOrder[index % run.speciesOrder.length]
    const selector = `${filterSelector}[value=${JSON.stringify(speciesKey)}]`
    const option = panel.locator(selector)
    run.phase = 'select-species'
    let sample
    try {
      const previousSummary = (await page.locator(summarySelector).textContent()).trim()
      sample = {
        speciesKey,
        ...(await measurePaintableResult(page, option, selector, timeoutMs, previousSummary)),
      }
    } catch (error) {
      run.species.push({
        speciesKey,
        phase: run.phase,
        error: String(error),
        timedOut: error.name === 'TimeoutError',
      })
      throw error
    }
    run.species.push(sample)
    const filteredSummary = page.locator(summarySelector)
    run.phase = 'reset-species-filter'
    try {
      const preClear =
        sample.firstThumbnailMs === null ? null : (await filteredSummary.textContent()).trim()
      if (await option.isChecked({ timeout: timeoutMs })) await option.click({ timeout: timeoutMs })
      await page.waitForFunction(
        ({ preClear, summarySelector }) => {
          const node = document.querySelector(summarySelector)
          return (
            node?.closest('.selection-result-summary')?.getAttribute('aria-busy') === 'false' &&
            (preClear === null || node.textContent?.trim() !== preClear)
          )
        },
        { preClear, summarySelector },
        { timeout: timeoutMs },
      )
    } catch (error) {
      sample.resetError = String(error)
      throw error
    }
  }
  run.phase = 'close-species-filter'
  await page.keyboard.press('Escape')
}

async function runRenderer({
  dataDir,
  origin,
  shim,
  backend,
  coldRun,
  warmRuns,
  filters,
  speciesKeys,
  filterStartPhase,
  trace,
  intervalMs,
  timeoutMs,
  viewport,
}) {
  process.stderr.write(`[library benchmark] ${backend.workload} cold app ${coldRun}\n`)
  const env = {
    ...process.env,
    PLUMELENS_PYTHON: shim.path,
    PLUMELENS_E2E_DISABLE_CLOSE_CONFIRM: '1',
  }
  delete env.ELECTRON_RENDERER_URL
  if (trace) env.PLUMELENS_BENCHMARK_TRACE = '1'
  else delete env.PLUMELENS_BENCHMARK_TRACE
  const launchEpochMs = Date.now()
  const run = {
    coldRun,
    launchEpochMs,
    phase: 'launch-app',
    open: [],
    species: [],
    memory: { samples: [], errors: [] },
    requests: [],
    diagnostics: [],
    analysisCheckpoints: [],
  }
  const statsPath = `/analysis/library/${encodeURIComponent(backend.libraryId)}/stats`
  const libraryPath = `/library/${encodeURIComponent(backend.libraryId)}`
  let app
  let page
  let stopSampling
  let network
  let closing = false

  async function recordQueue(field, getStats = () => readBackend(origin, statsPath)) {
    const checkpoint = { epochMs: Date.now(), field }
    try {
      run[field] = await getStats()
      checkpoint.completedEpochMs = Date.now()
    } catch (error) {
      run[field] = null
      checkpoint.error = String(error)
    }
    run.analysisCheckpoints.push(checkpoint)
  }

  async function recordOpen(cache) {
    run.phase = cache === 'cold-renderer' ? 'open-cold-library' : 'open-warm-library'
    const observedStartEpochMs = Date.now()
    try {
      run.open.push({ cache, ...(await openFolder(page, timeoutMs)) })
    } catch (error) {
      run.open.push({
        cache,
        phase: run.phase,
        observedStartEpochMs,
        observedFinishEpochMs: Date.now(),
        firstThumbnailMs: null,
        timedOut: error.name === 'TimeoutError',
        error: String(error),
      })
      throw error
    }
  }

  try {
    app = await _electron.launch({
      executablePath: require('electron'),
      args: [join(root, 'out', 'main', 'index.js'), `--user-data-dir=${dataDir}`],
      env,
      timeout: Math.min(timeoutMs, 30_000),
    })
    run.electronMainPid = app.process().pid
    app.process().once('exit', (code, signal) => {
      if (!closing) run.diagnostics.push({ epochMs: Date.now(), type: 'app-exit', code, signal })
    })
    run.phase = 'wait-app-window'
    page = await app.firstWindow({ timeout: timeoutMs })
    page.setDefaultTimeout(timeoutMs)
    run.networkCaptureStartedEpochMs = Date.now()
    network = recordRequests(page, origin, libraryPath, trace)
    page.on('pageerror', (error) =>
      run.diagnostics.push({ epochMs: Date.now(), error: error.message }),
    )
    page.on('crash', () => {
      run.diagnostics.push({ epochMs: Date.now(), type: 'renderer-crash' })
    })
    page.on('close', () => {
      if (!closing) run.diagnostics.push({ epochMs: Date.now(), type: 'page-close' })
    })
    await app.evaluate(({ BrowserWindow }, { width, height }) => {
      const view = BrowserWindow.getAllWindows()[0]
      view.setSize(width, height)
      view.webContents.setBackgroundThrottling(false)
      view.show()
      view.focus()
    }, viewport)
    run.phase = 'wait-start-library-list'
    await page.locator(openSelector).first().waitFor({ timeout: timeoutMs })
    if ((await page.locator(openSelector).count()) !== 1) {
      throw new Error('Expected only the isolated benchmark library on the start screen')
    }
    Object.assign(
      run,
      await page.evaluate(() => ({
        rendererInitializationEpochMs: performance.timeOrigin,
        startListReadyEpochMs: performance.timeOrigin + performance.now(),
      })),
    )
    stopSampling = await startSampling(app, page, origin, intervalMs)
    run.phase = 'start-analysis-workload'
    if (backend.workload !== 'idle') {
      await recordQueue('analysisStart', () =>
        ensureAnalysisRunning(origin, backend.libraryId, statsPath),
      )
      if (!run.analysisStart) throw new Error(run.analysisCheckpoints.at(-1).error)
    } else {
      await recordQueue('analysisStart')
    }
    await recordOpen('cold-renderer')
    await recordQueue('analysisAfterColdOpen')
    const startRoute = page.locator('nav.route-switcher button').first()
    for (let warmIndex = 0; warmIndex < warmRuns; warmIndex += 1) {
      run.phase = 'return-to-start'
      await startRoute.click()
      await page.locator(openSelector).first().waitFor({ timeout: timeoutMs })
      await recordOpen('same-renderer-revisit')
    }
    await recordQueue('analysisBeforeSpecies')
    await measureSpeciesFilters(
      page,
      filters,
      timeoutMs,
      run,
      speciesKeys,
      filterStartPhase,
      network,
    )
    run.phase = 'complete'
  } catch (error) {
    run.error = {
      phase: run.phase,
      message: String(error),
      timedOut: error.name === 'TimeoutError',
    }
  } finally {
    if (app) {
      await recordQueue('analysisEnd')
      if (stopSampling) {
        try {
          run.memory = await stopSampling()
        } catch (error) {
          run.diagnostics.push({ phase: 'stop-memory-sampling', error: String(error) })
        }
      } else if (page && !page.isClosed()) {
        try {
          const finishSampling = await startSampling(app, page, origin, intervalMs)
          run.memory = await finishSampling()
        } catch (error) {
          run.diagnostics.push({ phase: 'collect-partial-memory', error: String(error) })
        }
      }
      if (network) run.requests = await network.finish()
      if (page && !page.isClosed()) {
        const pageState = await page
          .evaluate(
            (captureTrace) => ({
              viewport: { width: innerWidth, height: innerHeight, scaleFactor: devicePixelRatio },
              rendererTrace: captureTrace
                ? {
                    timeOrigin: performance.timeOrigin,
                    events: window.__PLUMELENS_BENCHMARK_TRACE__ ?? null,
                  }
                : undefined,
            }),
            trace,
          )
          .catch(() => null)
        run.viewport = pageState?.viewport ?? null
        if (trace) run.rendererTrace = pageState?.rendererTrace ?? null
      }
      try {
        closing = true
        await app.close()
      } catch (error) {
        run.diagnostics.push({ phase: 'close-app', error: String(error) })
      }
    }
  }

  const libraryResponses = run.requests.filter(
    (request) =>
      request.endpoint === libraryPath &&
      request.method === 'GET' &&
      request.status === 200 &&
      request.timing?.responseEnd >= 0,
  )
  for (const opening of run.open) {
    const prefetched = libraryResponses.filter(
      ({ timing }) => timing.startTime + timing.responseEnd < opening.clickEpochMs,
    )
    opening.detailResponseCompletedBeforeClick = prefetched.some(
      ({ queryString }) => new URLSearchParams(queryString).get('view') !== 'summary',
    )
    opening.summaryResponseCompletedBeforeClick = prefetched.some(
      ({ queryString }) => new URLSearchParams(queryString).get('view') === 'summary',
    )
  }
  const coldOpen = run.open[0]
  if (typeof coldOpen?.firstThumbnailMs === 'number') {
    const firstThumbnailEpochMs = coldOpen.clickEpochMs + coldOpen.firstThumbnailMs
    run.launchToFirstThumbnailMs = firstThumbnailEpochMs - launchEpochMs
    run.rendererInitializationToFirstThumbnailMs =
      firstThumbnailEpochMs - run.rendererInitializationEpochMs
    run.startListReadyToFirstThumbnailMs = firstThumbnailEpochMs - run.startListReadyEpochMs
  }
  run.partial =
    Boolean(run.error) ||
    run.open.some((entry) => entry.timedOut) ||
    run.species.some((entry) => entry.timedOut || entry.resetError)
  return run
}

async function main() {
  if (platform() !== 'darwin') {
    throw new Error('This native Electron benchmark launcher requires macOS')
  }
  const dataDir = await realpath(pathArgument('data-dir'))
  const portFile = pathArgument('port-file')
  const output = pathArgument('output')
  const backend = JSON.parse(await readFile(portFile, 'utf-8'))
  if (
    !Number.isInteger(backend.port) ||
    backend.port < 1 ||
    backend.port > 65_535 ||
    !Number.isInteger(backend.pid) ||
    !backend.libraryId ||
    !backend.workload
  ) {
    throw new Error('The port file must contain a valid { port, pid, libraryId, workload }')
  }
  await stat(join(root, 'out', 'main', 'index.js'))
  const speciesKeys = values['species-key'] ?? []
  const filters = integer('filters', 0)
  const filterStartPhase = values['filter-start-phase']
  if (
    !filterStartPhases.includes(filterStartPhase) ||
    (filterStartPhase !== 'natural' && backend.workload !== 'analysis')
  ) {
    throw new Error('--filter-start-phase must be a supported phase for the selected case workload')
  }
  if (
    speciesKeys.length &&
    (speciesKeys.length !== filters || new Set(speciesKeys).size !== speciesKeys.length)
  ) {
    throw new Error('Pass exactly one distinct --species-key per measured --filters click')
  }
  const settings = {
    coldRuns: integer('cold-runs', 1),
    warmRuns: integer('warm-runs', 0),
    filters,
    intervalMs: integer('sample-ms', 60),
    timeoutMs: integer('timeout-ms', 1000),
    viewport: { width: 1360, height: 860 },
  }
  const options = { speciesKeys, filterStartPhase, trace: Boolean(values.trace) }
  const result = {
    platform: { os: platform(), arch: arch(), release: release() },
    renderer: 'native Electron, built main/preload/renderer from source',
    nativeThumbnailProtocol: 'plumelens://thumb',
    coldDefinition:
      'First library click in a new renderer after the recent list is ready. Backend and OS caches are not flushed.',
    warmDefinition:
      'Click the same library after going back to Start in the same renderer. Application caches are left intact.',
    visibleReadyDefinition:
      'Decoded and paintable image with stable ID and bounds for two consecutive animation frames, within the scroll pane and at least 16 px visible in both axes.',
    partialDefinition:
      'Completed and timed-out observations are retained per renderer. A failed stage may skip later observations within the same renderer.',
    backend,
    settings,
    ...(options.trace || speciesKeys.length || filterStartPhase !== 'natural' ? { options } : {}),
    startedEpochMs: Date.now(),
    runs: [],
  }
  const origin = `http://127.0.0.1:${backend.port}`
  const health = await readBackend(origin, '/health')
  if (!health.pipeline?.ready) throw new Error('The backend is not ready')
  const shim = await createEngineShim(backend.port)
  try {
    for (let coldRun = 1; coldRun <= settings.coldRuns; coldRun += 1) {
      const run = await runRenderer({
        dataDir,
        origin,
        shim,
        backend,
        coldRun,
        ...settings,
        ...options,
      })
      result.runs.push(run)
      process.stderr.write(
        `[library benchmark] app ${coldRun} saved ${run.open.length} opens and ${run.species.length} filters${run.partial ? ' (partial)' : ''}\n`,
      )
    }
  } catch (error) {
    result.error = String(error)
    throw error
  } finally {
    result.partial = Boolean(result.error) || result.runs.some((run) => run.partial)
    result.finishedEpochMs = Date.now()
    await mkdir(dirname(output), { recursive: true })
    await writeFile(output, `${JSON.stringify(result, null, 2)}\n`)
    await rm(shim.dir, { recursive: true, force: true })
  }
  process.stdout.write(`${output}\n`)
}

await main()

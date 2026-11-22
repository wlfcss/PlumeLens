import { afterEach, expect, it, vi } from 'vitest'

afterEach(() => {
  vi.unstubAllGlobals()
  delete window.__PLUMELENS_BENCHMARK_TRACE__
  vi.resetModules()
})

it('keeps the normal renderer and API path free of trace entries', async () => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('[]')))
  const { benchmarkTrace } = await import('@/lib/benchmark-trace')
  const { api } = await import('@/lib/api-client')

  expect(await api.listLibraries()).toEqual([])
  expect(benchmarkTrace).toBeUndefined()
  expect(window.__PLUMELENS_BENCHMARK_TRACE__).toBeUndefined()
})

it('correlates native transport and parsing without storing paths or response data', async () => {
  vi.stubGlobal('plumelens', {
    benchmarkTraceEnabled: true,
    engineRequest: vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      statusText: 'OK',
      body: '{"id":"private-response"}',
      contentType: 'application/json',
      benchmarkTiming: {
        timeOrigin: performance.timeOrigin + 10,
        fetchStart: 1,
        headers: 2,
        body: 3,
      },
    }),
  })
  const { api } = await import('@/lib/api-client')

  await expect(api.libraryDetail('private-folder-id', { view: 'summary' })).resolves.toEqual({
    id: 'private-response',
  })
  const events = window.__PLUMELENS_BENCHMARK_TRACE__!
  expect(events.map((event) => event.name)).toEqual([
    'api.start',
    'api.transport_end',
    'api.fetch_start',
    'api.headers',
    'api.body',
    'api.parse_start',
    'api.parse_end',
  ])
  expect(events.slice(2, 5).map((event) => event.at)).toEqual([11, 12, 13])
  expect(new Set(events.map((event) => event.id))).toEqual(new Set([1]))
  expect(new Set(events.map((event) => event.area))).toEqual(new Set(['library-detail']))
  expect(JSON.stringify(events)).not.toContain('private')
})

it('uses one opaque ID across commit edges and bounds an opt-in page trace', async () => {
  const events = (window.__PLUMELENS_BENCHMARK_TRACE__ = [])
  const { benchmarkTrace: trace } = await import('@/lib/benchmark-trace')
  const pair = { projectionRevision: 'unreported' }
  trace?.markFor('selection.pair_ready', pair)
  trace?.markFor('selection.pair_commit', pair)
  for (let index = 0; index < 5000; index += 1) trace?.mark('selection.route_commit')

  expect(events).toHaveLength(4096)
  expect(events[0]).toMatchObject({ name: 'selection.pair_ready', id: 1 })
  expect(events[1]).toMatchObject({ name: 'selection.pair_commit', id: 1 })
  expect(JSON.stringify(events)).not.toContain('unreported')
})

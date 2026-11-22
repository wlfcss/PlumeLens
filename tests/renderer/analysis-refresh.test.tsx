import React from 'react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

import type { EngineSseBridgeEvent } from '@/env'
import { useAnalysisProgress } from '@/hooks/use-analysis'
import {
  LIBRARIES_KEY,
  LIBRARY_DETAIL_KEY,
  useAllLibraryDetails,
  useLibraryDetail,
  useLibraryEvents,
} from '@/hooks/use-library'
import {
  api,
  type AnalysisProgressEvent,
  type LibraryDetail,
  type QueueStatsResponse,
} from '@/lib/api-client'
import { logger } from '@/lib/logger'

const libraryId = 'analysis-refresh'
const detailKey = LIBRARY_DETAIL_KEY(libraryId)
const listeners = new Map<string, (event: EngineSseBridgeEvent) => void>()
const progressPath = `/analysis/library/${libraryId}/progress`
const libraryPath = `/library/${libraryId}/events`
let client: QueryClient

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] })
  client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } })
  vi.stubGlobal('plumelens', {
    engineSseSubscribe: (path: string, listener: (event: EngineSseBridgeEvent) => void) => {
      listeners.set(path, listener)
      return () => listeners.delete(path)
    },
  })
  vi.spyOn(logger, 'warn').mockImplementation(() => {})
})

afterEach(() => {
  cleanup()
  client.clear()
  listeners.clear()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

function Wrapper({ children }: React.PropsWithChildren) {
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>
}

function emit(path: string, event: EngineSseBridgeEvent) {
  act(() => {
    const listener = listeners.get(path)
    expect(listener).toBeDefined()
    listener!(event)
  })
}

function progress(overrides: Partial<AnalysisProgressEvent> = {}) {
  emit(progressPath, {
    type: 'message',
    event: 'message',
    data: JSON.stringify({
      library_id: libraryId,
      run_id: 'run-1',
      desired_state: 'running',
      total: 10,
      completed: 0,
      failed: 0,
      dead: 0,
      processing: 1,
      pending: 9,
      current_photo_id: null,
      ...overrides,
    } satisfies AnalysisProgressEvent),
  })
}

const advance = (ms: number) => act(() => vi.advanceTimersByTimeAsync(ms))

it.each([false, true])(
  'keeps shared detail refetches pinned with archive enabled=%s',
  async (enabled) => {
    const snapshot: LibraryDetail = {
      library: {
        id: libraryId,
        display_name: 'Analysis refresh',
        parent_path: '/tmp',
        root_path: '/tmp/analysis-refresh',
        status: 'ready',
        total_count: 0,
        analyzed_count: 0,
        recursive: true,
        last_opened_at: '2026-11-19T10:00:00Z',
        last_scanned_at: null,
        last_analyzed_at: null,
      },
      photos: [],
      projection_revision: 'first',
    }
    const fetch = vi
      .spyOn(api, 'libraryDetail')
      .mockResolvedValueOnce(snapshot)
      .mockResolvedValueOnce({ ...snapshot, projection_revision: 'refreshed' })
    const hook = renderHook(
      () => ({
        active: useLibraryDetail(libraryId),
        archive: useAllLibraryDetails([libraryId], enabled),
      }),
      { wrapper: Wrapper },
    )
    await advance(1)
    expect(fetch).toHaveBeenCalledTimes(1)
    expect(client.getQueryCache().find({ queryKey: detailKey })?.getObserversCount()).toBe(
      enabled ? 2 : 1,
    )

    await act(() =>
      client.invalidateQueries({ queryKey: detailKey, exact: true }, { cancelRefetch: false }),
    )
    await advance(1)
    expect(fetch).toHaveBeenCalledTimes(2)
    for (const [id, options] of fetch.mock.calls) {
      expect(id).toBe(libraryId)
      expect(options?.includeSelectionSnapshot).toBe(true)
      expect(options?.view).toBe('summary')
    }
    expect(hook.result.current.active.data?.projection_revision).toBe('refreshed')
    expect(hook.result.current.archive).toEqual(enabled ? [hook.result.current.active.data] : [])
  },
)

it('updates progress immediately and publishes the result tail without aborting a detail load', async () => {
  const { promise, resolve } = Promise.withResolvers<void>()
  const invalidate = vi.spyOn(client, 'invalidateQueries').mockImplementation((filters) => {
    if (filters?.queryKey?.[0] === 'library') return promise
    return Promise.resolve()
  })
  const detailReads = () =>
    invalidate.mock.calls.filter(([filters]) => filters?.queryKey?.[0] === 'library')
  const view = renderHook(() => useAnalysisProgress(libraryId), { wrapper: Wrapper })

  emit(progressPath, { type: 'open' })
  progress()
  progress({ processing: 2, pending: 8 })
  expect(view.result.current?.processing).toBe(2)
  expect(detailReads()).toHaveLength(0)

  progress({ completed: 1, pending: 8 })
  progress({ completed: 2, pending: 7 })
  const queue = client.getQueryData<QueueStatsResponse>(['queue-stats', libraryId])
  expect(queue?.stats.completed).toBe(2)
  expect(invalidate).toHaveBeenCalledWith({ queryKey: LIBRARIES_KEY }, { cancelRefetch: false })
  await advance(14_999)
  expect(detailReads()).toHaveLength(0)
  await advance(1)
  expect(detailReads()).toEqual([[{ queryKey: detailKey, exact: true }, { cancelRefetch: false }]])

  progress({ desired_state: 'completed', completed: 10, pending: 0, processing: 0 })
  progress({ desired_state: 'completed', completed: 10, pending: 0, processing: 0 })
  expect(view.result.current?.desired_state).toBe('completed')
  expect(detailReads()).toHaveLength(1)
  await act(async () => resolve())
  expect(detailReads()).toHaveLength(2)

  emit(progressPath, { type: 'error', message: 'stream closed' })
  await advance(5000)
  emit(progressPath, { type: 'open' })
  expect(detailReads()).toHaveLength(3)
})

it('ignores the library stream initial snapshot and refreshes on actual events or reconnects', async () => {
  const invalidate = vi.spyOn(client, 'invalidateQueries')
  const detailReads = () =>
    invalidate.mock.calls.filter(([filters]) => filters?.queryKey?.[0] === 'library')
  renderHook(() => useLibraryEvents(libraryId), { wrapper: Wrapper })

  emit(libraryPath, { type: 'open' })
  emit(libraryPath, { type: 'message', event: 'library_snapshot', data: '{}' })
  await advance(200)
  expect(detailReads()).toHaveLength(0)

  emit(libraryPath, { type: 'message', event: 'thumbnail_batch', data: '{}' })
  emit(libraryPath, { type: 'message', event: 'scene_groups_ready', data: '{}' })
  await advance(200)
  expect(detailReads()).toEqual([[{ queryKey: detailKey, exact: true }, { cancelRefetch: false }]])

  emit(libraryPath, { type: 'error', message: 'stream closed' })
  await advance(5000)
  emit(libraryPath, { type: 'open' })
  emit(libraryPath, { type: 'message', event: 'library_snapshot', data: '{}' })
  await advance(200)
  expect(detailReads()).toHaveLength(2)
})

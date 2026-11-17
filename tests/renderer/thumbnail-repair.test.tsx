import React, { type ReactNode } from 'react'
import { act, cleanup, renderHook, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useThumbnailRepair } from '@/hooks/use-thumbnail-repair'
import { api, type PhotoThumbnailResponse } from '@/lib/api-client'
import type { PhotoRecord } from '@/lib/workspace-types'

vi.mock('@/lib/api-client', () => ({ api: { buildPhotoThumbnail: vi.fn() } }))
beforeEach(() => {
  vi.mocked(api.buildPhotoThumbnail).mockReset()
})
afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

function photo(id: string, src = `plumelens://thumb/grid/${id}.jpg`): PhotoRecord {
  return { id, thumbGridUrl: src, analysisStatus: 'done' } as PhotoRecord
}
function response(id: string): PhotoThumbnailResponse {
  return {
    photo_id: id,
    library_id: 'library-A',
    built: true,
    thumb_grid: `grid/${id}.jpg`,
    thumb_preview: `preview/${id}.jpg`,
  }
}
function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}
function harness(photos: PhotoRecord[]) {
  const client = new QueryClient({
    defaultOptions: { mutations: { retry: false, gcTime: Infinity } },
  })
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  )
  const view = renderHook(
    ({ rows }) => useThumbnailRepair({ libraryId: 'library-A', photos: rows }),
    { initialProps: { rows: photos }, wrapper },
  )
  return { view, client }
}

describe('thumbnail resource repair', () => {
  it('rebuilds a failed resource even when the photo still has a thumbnail URL', async () => {
    vi.mocked(api.buildPhotoThumbnail).mockImplementation(async (id) => response(id))
    const { view, client } = harness([photo('p1')])
    await act(async () => view.result.current('p1', 'error'))
    await waitFor(() => expect(api.buildPhotoThumbnail).toHaveBeenCalledWith('p1'))
    view.unmount()
    client.clear()
  })

  it('drains more than four failed resources as each independent mutation completes', async () => {
    const pending = new Map(
      Array.from({ length: 7 }, (_, index) => [`p${index}`, deferred<PhotoThumbnailResponse>()]),
    )
    vi.mocked(api.buildPhotoThumbnail).mockImplementation((id) => {
      const gate = pending.get(id)
      if (!gate)
        throw new Error(
          `Unexpected repair id ${String(id)}; expected ${[...pending.keys()].join(',')}`,
        )
      return gate.promise
    })
    const { view, client } = harness([...pending.keys()].map((id) => photo(id)))
    await act(async () => {
      for (let index = 0; index < 6; index += 1) view.result.current(`p${index}`, 'error')
    })
    await waitFor(() => expect(api.buildPhotoThumbnail).toHaveBeenCalledTimes(4))
    await act(async () => {
      pending.get('p0')!.resolve(response('p0'))
      pending.get('p1')!.resolve(response('p1'))
    })
    await waitFor(() => expect(api.buildPhotoThumbnail).toHaveBeenCalledTimes(6))
    await act(async () => {
      for (let index = 2; index < 6; index += 1)
        pending.get(`p${index}`)!.resolve(response(`p${index}`))
    })
    await act(async () => view.result.current('p6', 'error'))
    await waitFor(() => expect(api.buildPhotoThumbnail).toHaveBeenCalledTimes(7))
    await act(async () => pending.get('p6')!.resolve(response('p6')))
    view.unmount()
    client.clear()
  })

  it('caps one failing URL at three attempts, honors cooldown, and resets after loading', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-11-17T00:00:00Z'))
    vi.mocked(api.buildPhotoThumbnail).mockImplementation(async (id) => response(id))
    const { view, client } = harness([photo('p1')])
    const reportError = async () => {
      await act(async () => {
        view.result.current('p1', 'error')
        await vi.advanceTimersByTimeAsync(0)
      })
    }
    await reportError()
    expect(api.buildPhotoThumbnail).toHaveBeenCalledTimes(1)
    await reportError()
    expect(api.buildPhotoThumbnail).toHaveBeenCalledTimes(1)
    for (let attempt = 2; attempt <= 4; attempt += 1) {
      await act(async () => {
        await vi.advanceTimersByTimeAsync(30001)
      })
      await reportError()
      expect(api.buildPhotoThumbnail).toHaveBeenCalledTimes(Math.min(attempt, 3))
    }
    await act(async () => view.result.current('p1', 'loaded'))
    await reportError()
    expect(api.buildPhotoThumbnail).toHaveBeenCalledTimes(4)
    view.unmount()
    client.clear()
  })
  it('does not start a duplicate rebuild while a previous repair is still in flight', async () => {
    const pending = deferred<PhotoThumbnailResponse>()
    vi.mocked(api.buildPhotoThumbnail).mockImplementation(() => pending.promise)
    const { view, client } = harness([photo('p1')])
    await act(async () => view.result.current('p1', 'error'))
    await waitFor(() => expect(api.buildPhotoThumbnail).toHaveBeenCalledTimes(1))
    await act(async () => {
      view.result.current('p1', 'loaded')
      view.result.current('p1', 'error')
    })
    expect(api.buildPhotoThumbnail).toHaveBeenCalledTimes(1)
    await act(async () => pending.resolve(response('p1')))
    view.unmount()
    client.clear()
  })
})

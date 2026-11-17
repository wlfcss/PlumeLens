import React, { type ReactNode } from 'react'
import { act, cleanup, renderHook, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { useSelectionQuery } from '@/hooks/use-selection'
import { api, type SelectionQuery, type SelectionQueryResult } from '@/lib/api-client'

vi.mock('@/lib/api-client', () => ({ api: { querySelection: vi.fn() } }))
afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

const query: SelectionQuery = {
  species_keys: [],
  include_review: true,
  grades: ['select', 'usable', 'record'],
  include_no_bird: false,
  include_failed: false,
  only_flying: false,
  photo_query: '',
  sort: 'score',
}
function response(libraryId: string, value: SelectionQuery, photoId: string): SelectionQueryResult {
  return {
    library_id: libraryId,
    projection_revision: `${libraryId}-1`,
    query: value,
    matched_photo_ids: [photoId],
    matched_count: 1,
    total_count: 1,
    pending_count: 0,
    failed_count: 0,
    no_bird_count: 0,
    facets: [],
  }
}
function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}
function harness() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } })
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  )
  return { wrapper, client }
}

describe('authoritative selection query coordination', () => {
  it('retains previous results only for changed conditions within the same folder', async () => {
    const nextCondition = deferred<SelectionQueryResult>()
    const nextFolder = deferred<SelectionQueryResult>()
    vi.mocked(api.querySelection)
      .mockResolvedValueOnce(response('A', query, 'A-original'))
      .mockImplementationOnce(() => nextCondition.promise)
      .mockImplementationOnce(() => nextFolder.promise)
    const { wrapper, client } = harness()
    const view = renderHook(({ libraryId, filter }) => useSelectionQuery(libraryId, filter), {
      initialProps: { libraryId: 'A', filter: query },
      wrapper,
    })
    await waitFor(() => expect(view.result.current.data?.matched_photo_ids).toEqual(['A-original']))
    const narrowed = { ...query, species_keys: ['sci:Alcedo atthis'] }
    view.rerender({ libraryId: 'A', filter: narrowed })
    expect(view.result.current.isPlaceholderData).toBe(true)
    expect(view.result.current.data?.matched_photo_ids).toEqual(['A-original'])
    await act(async () => nextCondition.resolve(response('A', narrowed, 'A-kingfisher')))
    await waitFor(() => expect(view.result.current.isPlaceholderData).toBe(false))
    view.rerender({ libraryId: 'B', filter: narrowed })
    expect(view.result.current.data).toBeUndefined()
    expect(view.result.current.isPlaceholderData).toBe(false)
    await act(async () => nextFolder.resolve(response('B', narrowed, 'B-kingfisher')))
    await waitFor(() =>
      expect(view.result.current.data?.matched_photo_ids).toEqual(['B-kingfisher']),
    )
    view.unmount()
    client.clear()
  })

  it('does not replace the newest species result when an older request resolves late', async () => {
    const oldRequest = deferred<SelectionQueryResult>()
    const newRequest = deferred<SelectionQueryResult>()
    const oldQuery = { ...query, species_keys: ['sci:Alcedo atthis'] }
    const newQuery = { ...query, species_keys: ['sci:Egretta garzetta'] }
    vi.mocked(api.querySelection)
      .mockImplementationOnce(() => oldRequest.promise)
      .mockImplementationOnce(() => newRequest.promise)
    const { wrapper, client } = harness()
    const view = renderHook(({ filter }) => useSelectionQuery('A', filter), {
      initialProps: { filter: oldQuery },
      wrapper,
    })
    await waitFor(() => expect(api.querySelection).toHaveBeenCalledTimes(1))
    view.rerender({ filter: newQuery })
    await waitFor(() => expect(api.querySelection).toHaveBeenCalledTimes(2))
    await act(async () => newRequest.resolve(response('A', newQuery, 'new-egret')))
    await waitFor(() => expect(view.result.current.data?.matched_photo_ids).toEqual(['new-egret']))
    await act(async () => oldRequest.resolve(response('A', oldQuery, 'late-kingfisher')))
    expect(view.result.current.data?.query.species_keys).toEqual(newQuery.species_keys)
    expect(view.result.current.data?.matched_photo_ids).toEqual(['new-egret'])
    view.unmount()
    client.clear()
  })
})

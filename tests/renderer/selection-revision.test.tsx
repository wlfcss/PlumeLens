import React, { type ComponentProps } from 'react'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { afterEach, expect, it, vi } from 'vitest'
import '@/i18n'
import {
  api,
  ApiError,
  type LibraryDetail,
  type LibrarySummary,
  type PhotoRow,
  type SelectionQuery,
  type SelectionQueryResult,
} from '@/lib/api-client'
import type { SelectionScreen } from '@/components/selection-chrome/selection-screen'
import { useUIStore } from '@/stores/ui-store'
import App from '@/App'

vi.mock('@/hooks/use-backend', () => ({
  useBackendHealth: () => ({ data: { pipeline: { ready: false } }, isReady: true, isError: false }),
}))
const { observeSelection } = vi.hoisted(() => ({
  observeSelection: vi.fn<(props: ComponentProps<typeof SelectionScreen>) => void>(),
}))
// Browser/virtual-grid behavior is covered by E2E. Observe App's atomic commitment here.
vi.mock('@/components/selection-chrome/selection-screen', () => ({
  SelectionScreen: (props: ComponentProps<typeof SelectionScreen>) => {
    observeSelection(props)
    return null
  },
}))
vi.mock('@/hooks/use-library', async (original) => ({
  ...(await original<typeof import('@/hooks/use-library')>()),
  useLibraryEvents: () => {},
}))

const initialUI = useUIStore.getState()
const originalScrollTo = HTMLElement.prototype.scrollTo
const clients: QueryClient[] = []
afterEach(() => {
  cleanup()
  observeSelection.mockClear()
  clients.splice(0).forEach((client) => client.clear())
  useUIStore.setState(initialUI)
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  HTMLElement.prototype.scrollTo = originalScrollTo
})

const candidateLibrary: LibrarySummary = {
  id: 'revision-candidate',
  display_name: 'Revision candidate',
  parent_path: '/tmp',
  root_path: '/tmp/candidate',
  status: 'ready',
  total_count: 2,
  analyzed_count: 2,
  recursive: true,
  last_opened_at: '2026-11-17',
  last_scanned_at: null,
  last_analyzed_at: null,
}

function photo(revision: string, id: string): PhotoRow {
  const fileName = `${revision}-${id}.jpg`
  return {
    id,
    file_name: fileName,
    file_path: `${candidateLibrary.root_path}/${fileName}`,
    width: 640,
    height: 480,
    format: 'jpg',
    thumb_grid: null,
    thumb_preview: null,
    created_at: '2026-11-17T10:00:00Z',
    shot_at: '2026-11-17T10:00:00Z',
    scene_id: null,
    pipeline_version: null,
    grade: 'select',
    quality_score: 0.9,
    bird_count: 1,
    species: null,
    species_latin: null,
    manual_species: false,
    decision: null,
    exif: null,
    best_detection: null,
    detections: null,
  }
}

function detail(revision: string): LibraryDetail {
  return {
    library: candidateLibrary,
    photos: [photo(revision, 'shared'), photo(revision, 'other')],
    projection_revision: revision,
  }
}

function result(revision: string, query: SelectionQuery): SelectionQueryResult {
  const ids = query.species_keys.length ? ['shared'] : ['shared', 'other']
  return {
    library_id: candidateLibrary.id,
    projection_revision: revision,
    query,
    matched_photo_ids: ids,
    matched_count: ids.length,
    total_count: 2,
    pending_count: 0,
    failed_count: 0,
    no_bird_count: 0,
    facets: [
      {
        key: 'sci:Test bird',
        name: revision,
        latin_name: 'Test bird',
        english_name: null,
        search_aliases: [],
        photo_count: 1,
        review_photo_count: 0,
      },
    ],
  }
}

function mountWithDetail(snapshot: LibraryDetail, route: 'start' | 'selection' = 'selection') {
  HTMLElement.prototype.scrollTo = vi.fn()
  vi.stubGlobal(
    'EventSource',
    class {
      close() {}
    },
  )
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: Infinity } },
  })
  clients.push(client)
  client.setQueryData(['libraries'], [candidateLibrary])
  client.setQueryData(['library', candidateLibrary.id], snapshot)
  vi.spyOn(api, 'listLibraries').mockResolvedValue([candidateLibrary])
  const detailReads = vi.spyOn(api, 'libraryDetail').mockResolvedValue(snapshot)
  useUIStore.setState({ route, activeFolderId: candidateLibrary.id })
  render(
    <QueryClientProvider client={client}>
      <App />
    </QueryClientProvider>,
  )
  return { client, detailReads }
}

const displayed = () => observeSelection.mock.lastCall?.[0]
const displayedNames = () =>
  displayed()
    ?.flatPhotos.map((item) => item.fileName)
    .toSorted()

it('opens the selection screen from a recent folder before its query settles', async () => {
  const pending = Promise.withResolvers<SelectionQueryResult>()
  const query = vi.spyOn(api, 'querySelection').mockReturnValue(pending.promise)
  mountWithDetail(detail('a'), 'start')
  const folder = await screen.findByRole('button', { name: /Revision candidate/ })
  expect(observeSelection).not.toHaveBeenCalled()

  fireEvent.click(folder)
  expect(observeSelection).toHaveBeenCalled()
  expect(displayedNames()).toEqual([])

  await waitFor(() => expect(query).toHaveBeenCalledOnce())
  await act(async () => pending.resolve(result('a', query.mock.calls[0][1])))
  await waitFor(() => expect(displayedNames()).toEqual(['a-other.jpg', 'a-shared.jpg']))
})

it('reuses unchanged photo projections when a refetch publishes a new coherent revision', async () => {
  const first = detail('a')
  first.photos[1] = { ...first.photos[1], exif: { GPSInfo: { GPSLatitude: [30, 0, 0] } } }
  const second = structuredClone(first)
  second.projection_revision = 'b'
  second.photos[0] = { ...second.photos[0], decision: 'usable', scene_id: 7 }

  const pending = Promise.withResolvers<SelectionQueryResult>()
  const selection = vi
    .spyOn(api, 'querySelection')
    .mockImplementation(async (_id, query, _signal, revision) =>
      revision === 'b' ? pending.promise : result('a', query),
    )
  const { client, detailReads } = mountWithDetail(first)
  const key = ['library', candidateLibrary.id]
  const refresh = () => client.invalidateQueries({ queryKey: key, exact: true })
  const shownPhoto = (id: string) => displayed()?.folderPhotos.find((item) => item.id === id)

  detailReads.mockResolvedValueOnce(structuredClone(first))
  await act(refresh)
  await waitFor(() => expect(displayedNames()).toEqual(['a-other.jpg', 'a-shared.jpg']))
  const before = client.getQueryData<LibraryDetail>(key)!
  const changedPhoto = shownPhoto('shared')!
  const unchangedPhoto = shownPhoto('other')!

  detailReads.mockResolvedValueOnce(second)
  await act(refresh)
  const after = client.getQueryData<LibraryDetail>(key)!
  expect(detailReads).toHaveBeenCalledTimes(2)
  expect(after.projection_revision).toBe('b')
  expect(after.photos[1]).toBe(before.photos[1])
  expect(after.photos[1].exif).toBe(before.photos[1].exif)
  expect(after.photos[0]).not.toBe(before.photos[0])
  await waitFor(() => expect(selection.mock.lastCall?.[3]).toBe('b'))
  expect(displayed()?.speciesFilterProps.facets[0]?.name).toBe('a')
  expect(shownPhoto('shared')).toBe(changedPhoto)

  await act(async () => pending.resolve(result('b', selection.mock.lastCall![1])))
  await waitFor(() => expect(displayed()?.speciesFilterProps.facets[0]?.name).toBe('b'))
  expect(shownPhoto('other')).toBe(unchangedPhoto)
  expect(shownPhoto('shared')).not.toBe(changedPhoto)
  expect(shownPhoto('shared')?.decision).toBe('usable')
  expect(shownPhoto('shared')?.groupId).toBe(`${candidateLibrary.id}-scene-7`)
  expect(changedPhoto.decision).toBeNull()
})

it('applies user filters on the visible revision while newer analysis revisions arrive', async () => {
  const pending = new Map<
    string,
    { query: SelectionQuery; resolve: (value: SelectionQueryResult) => void }
  >()
  const selections = vi
    .spyOn(api, 'querySelection')
    .mockImplementation(async (_id, query, _signal, revision) => {
      if (revision === 'a') return result(revision, query)
      const { promise, resolve } = Promise.withResolvers<SelectionQueryResult>()
      pending.set(`${revision}:${query.species_keys.length}`, { query, resolve })
      return promise
    })
  const { client, detailReads } = mountWithDetail(detail('a'))
  await waitFor(() => expect(displayedNames()).toEqual(['a-other.jpg', 'a-shared.jpg']))

  act(() => {
    client.setQueryData(['library', candidateLibrary.id], detail('b'))
  })
  await waitFor(() => expect(pending.has('b:0')).toBe(true))
  expect(displayedNames()).toEqual(['a-other.jpg', 'a-shared.jpg'])
  expect(displayed()?.speciesFilterProps.loading).toBe(false)

  act(() => {
    displayed()?.speciesFilterProps.onChange({ includeReview: true, keys: ['sci:Test bird'] })
  })
  await waitFor(() => expect(displayedNames()).toEqual(['a-shared.jpg']))
  expect(
    selections.mock.calls.some(
      ([, query, , pin]) => pin === 'a' && query.species_keys.length === 1,
    ),
  ).toBe(true)
  await waitFor(() => expect(pending.has('b:1')).toBe(true))

  act(() => {
    client.setQueryData(['library', candidateLibrary.id], detail('c'))
  })
  await waitFor(() => expect(pending.has('c:1')).toBe(true))
  await act(async () => {
    for (const key of ['b:0', 'b:1']) {
      const request = pending.get(key)!
      request.resolve(result('b', request.query))
    }
  })
  expect(displayedNames()).toEqual(['a-shared.jpg'])
  expect(displayed()?.speciesFilterProps.loading).toBe(false)

  await act(async () => {
    const request = pending.get('c:1')!
    request.resolve(result('c', request.query))
  })
  await waitFor(() => expect(displayedNames()).toEqual(['c-shared.jpg']))
  for (const [rendered] of observeSelection.mock.calls) {
    for (const row of rendered.flatPhotos) {
      expect(row.fileName).toMatch(new RegExp(`^${rendered.speciesFilterProps.facets[0]?.name}-`))
    }
  }
  expect(detailReads).not.toHaveBeenCalled()
})

it('rebuilds an expired pin once and retries that exact revision', async () => {
  const revision = 'expired'
  const selections = vi
    .spyOn(api, 'querySelection')
    .mockRejectedValueOnce(
      new ApiError(409, 'Selection snapshot expired', { detail: 'Selection snapshot expired' }),
    )
    .mockImplementation(async (_id, query) => result(revision, query))
  const { detailReads } = mountWithDetail(detail(revision))

  await waitFor(() => expect(displayedNames()).toEqual(['expired-other.jpg', 'expired-shared.jpg']))
  expect(detailReads).toHaveBeenCalledTimes(1)
  expect(selections).toHaveBeenCalledTimes(2)
  expect(selections.mock.calls.map(([, , , pin]) => pin)).toEqual([revision, revision])
  expect(displayed()?.speciesFilterProps.error).toBe(false)
})

it.each([false, 3] as const)(
  'stops revision reconciliation after a failed detail refresh (retry=%s)',
  async (retry) => {
    HTMLElement.prototype.scrollTo = vi.fn()
    vi.stubGlobal(
      'EventSource',
      class {
        addEventListener() {}
        close() {}
      },
    )
    const library: LibrarySummary = {
      id: 'revision-test',
      display_name: 'Revision test',
      parent_path: '/tmp',
      root_path: '/tmp/revision',
      status: 'ready',
      total_count: 0,
      analyzed_count: 0,
      recursive: true,
      last_opened_at: '2026-11-17',
      last_scanned_at: null,
      last_analyzed_at: null,
    }
    const client = new QueryClient({
      defaultOptions: { queries: { retry, gcTime: Infinity } },
    })
    clients.push(client)
    client.setQueryData(['libraries'], [library])
    client.setQueryData(['library', library.id], {
      library,
      photos: [],
      projection_revision: 'old',
    })
    vi.spyOn(api, 'listLibraries').mockResolvedValue([library])
    const details = vi.spyOn(api, 'libraryDetail').mockImplementation(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10))
      throw new Error('HTTP 500')
    })
    const selections = vi.spyOn(api, 'querySelection').mockImplementation(async (_id, query) => {
      await new Promise((resolve) => setTimeout(resolve, 15))
      return {
        library_id: library.id,
        projection_revision: 'new',
        query,
        matched_photo_ids: [],
        matched_count: 0,
        total_count: 0,
        pending_count: 0,
        failed_count: 0,
        no_bird_count: 0,
        facets: [],
      } satisfies SelectionQueryResult
    })
    useUIStore.setState({ route: 'selection', activeFolderId: library.id })
    const view = render(
      <QueryClientProvider client={client}>
        <App />
      </QueryClientProvider>,
    )
    const flushRequests = async () => {
      // Flush React between request completions so a refetch storm cannot hide in batched renders.
      for (let tick = 0; tick < 10; tick += 1) {
        await act(async () => {
          await new Promise((resolve) => setTimeout(resolve, 30))
        })
      }
    }
    await flushRequests()
    const settledSelections = selections.mock.calls.length
    const settledDetails = details.mock.calls.length
    expect(settledSelections).toBeGreaterThan(0)
    expect(settledDetails).toBeGreaterThan(0)
    await flushRequests()
    expect(selections).toHaveBeenCalledTimes(settledSelections)
    expect(details).toHaveBeenCalledTimes(settledDetails)
    expect(settledDetails).toBeLessThanOrEqual(2)
    view.unmount()
    client.clear()
  },
)

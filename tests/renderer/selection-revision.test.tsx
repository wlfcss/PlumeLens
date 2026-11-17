import React from 'react'
import { act, cleanup, render } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { afterEach, expect, it, vi } from 'vitest'
import '@/i18n'
import { api, type LibrarySummary, type SelectionQueryResult } from '@/lib/api-client'
import { useUIStore } from '@/stores/ui-store'
import App from '@/App'

vi.mock('@/hooks/use-backend', () => ({
  useBackendHealth: () => ({ data: { pipeline: { ready: false } }, isReady: true, isError: false }),
}))
// Browser/virtual-grid behavior is covered by E2E; this regression observes App's data coordination.
vi.mock('@/components/selection-chrome/selection-screen', () => ({ SelectionScreen: () => null }))
vi.mock('@/hooks/use-library', async (original) => ({
  ...(await original<typeof import('@/hooks/use-library')>()),
  useLibraryEvents: () => {},
}))

const initialUI = useUIStore.getState()
const originalScrollTo = HTMLElement.prototype.scrollTo
const clients: QueryClient[] = []
afterEach(() => {
  cleanup()
  clients.splice(0).forEach((client) => client.clear())
  useUIStore.setState(initialUI)
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  HTMLElement.prototype.scrollTo = originalScrollTo
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

import { keepPreviousData, useQuery } from '@tanstack/react-query'

import { api, type SelectionQuery } from '@/lib/api-client'

export const SELECTION_QUERY_KEY = (libraryId: string) => ['selection', libraryId] as const

/** Query keys isolate folders and conditions; late responses cannot replace a newer selection. */
export function useSelectionQuery(libraryId: string | null, query: SelectionQuery, enabled = true) {
  return useQuery({
    queryKey: [...SELECTION_QUERY_KEY(libraryId ?? ''), query],
    queryFn: ({ signal }) => api.querySelection(libraryId!, query, signal),
    enabled: Boolean(libraryId) && enabled,
    placeholderData: (previous, previousQuery) =>
      previousQuery?.queryKey[1] === libraryId ? keepPreviousData(previous) : undefined,
    staleTime: 0,
  })
}

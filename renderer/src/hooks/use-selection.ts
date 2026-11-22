import {
  keepPreviousData,
  useQuery,
  useQueryClient,
  type UseQueryResult,
} from '@tanstack/react-query'
import { useCallback, useEffect, useMemo, useState } from 'react'

import {
  api,
  ApiError,
  type LibraryDetail,
  type SelectionQuery,
  type SelectionQueryResult,
} from '@/lib/api-client'
import { benchmarkTrace } from '@/lib/benchmark-trace'

export const SELECTION_QUERY_KEY = (libraryId: string) => ['selection', libraryId] as const

const selectionQueryKey = (libraryId: string, query: SelectionQuery, revision?: string) =>
  [...SELECTION_QUERY_KEY(libraryId), query, revision] as const

function isSelectionSnapshotExpired(error: unknown): boolean {
  return (
    error instanceof ApiError &&
    error.status === 409 &&
    typeof error.detail === 'object' &&
    error.detail !== null &&
    'detail' in error.detail &&
    error.detail.detail === 'Selection snapshot expired'
  )
}

/** Query keys isolate folders and conditions; late responses cannot replace a newer selection. */
export function useSelectionQuery(
  libraryId: string | null,
  query: SelectionQuery,
  enabled = true,
  projectionRevision?: string,
) {
  return useQuery({
    queryKey: selectionQueryKey(libraryId ?? '', query, projectionRevision),
    queryFn: ({ signal }) => api.querySelection(libraryId!, query, signal, projectionRevision),
    enabled: Boolean(libraryId) && enabled,
    placeholderData: (previous, previousQuery) =>
      previousQuery?.queryKey[1] === libraryId ? keepPreviousData(previous) : undefined,
    ...(projectionRevision && {
      // A pinned revision cannot change. New detail revisions produce a separate query.
      staleTime: 'static' as const,
    }),
  })
}

export interface SelectionSnapshot {
  detail: LibraryDetail
  query: SelectionQuery
  selection: SelectionQueryResult
}

/** Keep the visible photo rows and membership on one authoritative snapshot. */
export function useCoherentSelection(
  libraryId: string | null,
  query: SelectionQuery,
  detailQuery: UseQueryResult<LibraryDetail>,
  enabled: boolean,
) {
  const qc = useQueryClient()
  const [retained, setRetained] = useState<SelectionSnapshot>()
  const [recovery, setRecovery] = useState<{ libraryId: string; query: SelectionQuery }>()
  const previous = enabled && retained?.detail.library.id === libraryId ? retained : undefined
  const latest =
    enabled && detailQuery.data?.library.id === libraryId ? detailQuery.data : undefined
  const attemptedRecovery = recovery?.libraryId === libraryId && recovery.query === query
  // A user edit targets the visible snapshot, even while new detail arrives from analysis.
  const target =
    previous && previous.query !== query && !attemptedRecovery ? previous.detail : latest
  const revision = target?.projection_revision ?? undefined
  const selectionQuery = useSelectionQuery(libraryId, query, Boolean(target), revision)
  const selection = !selectionQuery.isPlaceholderData ? selectionQuery.data : undefined
  const matches =
    selection?.library_id === libraryId && (!revision || selection.projection_revision === revision)
  const pair = useMemo(() => {
    if (!target || !selection || !matches) return undefined
    const snapshot = { detail: target, query, selection }
    benchmarkTrace?.markFor('selection.pair_ready', snapshot)
    return snapshot
  }, [matches, query, selection, target])

  useEffect(() => {
    if (pair) setRetained(pair)
    else if (retained && retained.detail.library.id !== libraryId) setRetained(undefined)
  }, [libraryId, pair, retained])

  const invalidSnapshot =
    Boolean(selection && !matches) || isSelectionSnapshotExpired(selectionQuery.error)
  const shouldRecover = Boolean(libraryId && target && invalidSnapshot && !attemptedRecovery)
  const { refetch: refetchDetail } = detailQuery
  const refetchSnapshot = useCallback(async () => {
    if (!libraryId) return
    const fresh = await refetchDetail({ cancelRefetch: false })
    if (fresh.isSuccess && (fresh.data.projection_revision ?? undefined) === revision) {
      // Recovery explicitly retries the exact pin. Broad invalidations leave immutable queries alone.
      await qc
        .fetchQuery({
          queryKey: selectionQueryKey(libraryId, query, revision),
          queryFn: ({ signal }) => api.querySelection(libraryId, query, signal, revision),
          staleTime: 0,
          retry: false,
        })
        .catch(() => undefined) // Query state carries the error to the retry control.
    }
  }, [libraryId, qc, query, refetchDetail, revision])

  useEffect(() => {
    if (!libraryId || !shouldRecover || detailQuery.isFetching || detailQuery.isError) return
    setRecovery({ libraryId, query })
    void refetchSnapshot()
  }, [
    detailQuery.isError,
    detailQuery.isFetching,
    libraryId,
    query,
    refetchSnapshot,
    shouldRecover,
  ])

  const displayed = pair ?? previous
  const error =
    detailQuery.isError || (!shouldRecover && (selectionQuery.isError || invalidSnapshot))
  return {
    displayed,
    loading: !error && displayed?.query !== query,
    error,
    onRetry: () => {
      if (libraryId) setRecovery({ libraryId, query })
      void refetchSnapshot()
    },
  }
}

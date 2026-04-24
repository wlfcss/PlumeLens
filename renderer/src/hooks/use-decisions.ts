/**
 * Decision mutation hooks — user layer (unreviewed/selected/maybe/rejected).
 *
 * 这些与模型 grade 是两套独立数据，后端持久化在 photo_decisions 表。
 */
import { useMutation, useQueryClient } from '@tanstack/react-query'

import { api, type DecisionValue } from '@/lib/api-client'

/** Set one photo's decision. Optimistically invalidates library detail. */
export function useSetDecision(libraryId: string | null | undefined) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ photoId, decision }: { photoId: string; decision: DecisionValue }) =>
      api.setDecision(photoId, decision),
    onSuccess: () => {
      if (libraryId) {
        qc.invalidateQueries({ queryKey: ['library', libraryId] })
        qc.invalidateQueries({ queryKey: ['decisions', libraryId] })
      }
    },
  })
}

/** Batch update (for keep-best-one / bulk actions). */
export function useBatchSetDecisions(libraryId: string | null | undefined) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (updates: Array<[string, DecisionValue]>) =>
      api.batchSetDecisions(updates),
    onSuccess: () => {
      if (libraryId) {
        qc.invalidateQueries({ queryKey: ['library', libraryId] })
        qc.invalidateQueries({ queryKey: ['decisions', libraryId] })
      }
    },
  })
}

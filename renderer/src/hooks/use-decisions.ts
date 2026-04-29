/**
 * Decision mutation hooks — manual grade overrides (select/usable/record/reject).
 *
 * 无人工覆盖时 decision=null，界面使用系统自动 grade。
 */
import { useMutation, useQueryClient } from '@tanstack/react-query'

import { api, type DecisionValue, type SpeciesOverrideValue } from '@/lib/api-client'

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

/** Set or clear one detected bird's manual species override. */
export function useSetSpeciesOverride(libraryId: string | null | undefined) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({
      birdIndex,
      photoId,
      species,
    }: {
      birdIndex: number
      photoId: string
      species: SpeciesOverrideValue | null
    }) => api.setSpeciesOverride(photoId, birdIndex, species),
    onSuccess: () => {
      if (libraryId) {
        qc.invalidateQueries({ queryKey: ['library', libraryId] })
      }
    },
  })
}

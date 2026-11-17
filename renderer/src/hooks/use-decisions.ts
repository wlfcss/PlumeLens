/**
 * Decision mutation hooks — manual grade overrides (select/usable/record/reject).
 *
 * 无人工覆盖时 decision=null，界面使用系统自动 grade。
 */
import { useMutation, useQueryClient } from '@tanstack/react-query'

import {
  api,
  type DecisionValue,
  type SpeciesOverrideBBox,
  type SpeciesOverrideValue,
} from '@/lib/api-client'

/** Refresh the actual origin folder and its projections after each write.
 * Workspace receives authoritative detail only; failed writes leave no optimistic copy.
 */
function invalidateLibraryQueries(
  qc: ReturnType<typeof useQueryClient>,
  libraryId: string | null | undefined,
  includeDecisions: boolean,
): void {
  if (!libraryId) return
  qc.invalidateQueries({ queryKey: ['library', libraryId] })
  qc.invalidateQueries({ queryKey: ['selection', libraryId] })
  qc.invalidateQueries({ queryKey: ['archive'] })
  if (includeDecisions) {
    qc.invalidateQueries({ queryKey: ['decisions', libraryId] })
  }
}

/** Set one photo's decision; serialize writes to preserve the user's order. */
export function useSetDecision(libraryId: string | null | undefined) {
  const qc = useQueryClient()
  return useMutation({
    scope: { id: 'manual-photo-writes' },
    mutationFn: ({
      photoId,
      decision,
    }: {
      photoId: string
      decision: DecisionValue
      libraryId?: string
    }) => api.setDecision(photoId, decision),
    onSuccess: (_, variables) => {
      invalidateLibraryQueries(qc, variables.libraryId ?? libraryId, true)
    },
    onError: (_, variables) => {
      invalidateLibraryQueries(qc, variables.libraryId ?? libraryId, true)
    },
  })
}

/** Batch update (for keep-best-one / bulk actions). */
export function useBatchSetDecisions(libraryId: string | null | undefined) {
  const qc = useQueryClient()
  return useMutation({
    scope: { id: 'manual-photo-writes' },
    mutationFn: (updates: Array<[string, DecisionValue]>) => api.batchSetDecisions(updates),
    onSuccess: () => {
      invalidateLibraryQueries(qc, libraryId, true)
    },
    onError: () => {
      invalidateLibraryQueries(qc, libraryId, true)
    },
  })
}

/** Set or clear one detected bird's manual species override.
 *
 * `bbox` 是该 detection 当前的原图像素坐标，写入时同步上送 — 后端用它做
 * read-time IoU 匹配，让用户人工标注的归属随鸟稳定。Clear 时 bbox 不传。 */
export function useSetSpeciesOverride(libraryId: string | null | undefined) {
  const qc = useQueryClient()
  return useMutation({
    scope: { id: 'manual-photo-writes' },
    mutationFn: ({
      birdIndex,
      bbox,
      photoId,
      species,
    }: {
      birdIndex: number
      bbox?: SpeciesOverrideBBox | null
      photoId: string
      species: SpeciesOverrideValue | null
      libraryId?: string
    }) => api.setSpeciesOverride(photoId, birdIndex, species, bbox),
    onSuccess: (_, variables) => {
      invalidateLibraryQueries(qc, variables.libraryId ?? libraryId, false)
    },
    onError: (_, variables) => {
      invalidateLibraryQueries(qc, variables.libraryId ?? libraryId, false)
    },
  })
}

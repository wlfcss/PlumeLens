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

/** Set or clear one detected bird's manual species override.
 *
 * `bbox` 是该 detection 当前的原图像素坐标，写入时同步上送 — 后端用它做
 * read-time IoU 匹配，让用户人工标注的归属随鸟稳定。Clear 时 bbox 不传。 */
export function useSetSpeciesOverride(libraryId: string | null | undefined) {
  const qc = useQueryClient()
  return useMutation({
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
    }) => api.setSpeciesOverride(photoId, birdIndex, species, bbox),
    onSuccess: () => {
      if (libraryId) {
        qc.invalidateQueries({ queryKey: ['library', libraryId] })
      }
    },
  })
}

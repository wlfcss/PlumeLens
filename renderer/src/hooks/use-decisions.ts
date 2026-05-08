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

/** 失败时也 invalidate(强制 refetch),让乐观 UI 回滚到后端真实状态。
 *
 * 历史 bug:onError 只 console.warn,前端 setWorkspace 的乐观写入不撤销 → 用户以为标
 * 成功了,实际后端没落库,直到用户手动切 folder 才纠正。 */
function invalidateLibraryQueries(
  qc: ReturnType<typeof useQueryClient>,
  libraryId: string | null | undefined,
  includeDecisions: boolean,
): void {
  if (!libraryId) return
  qc.invalidateQueries({ queryKey: ['library', libraryId] })
  if (includeDecisions) {
    qc.invalidateQueries({ queryKey: ['decisions', libraryId] })
  }
}

/** Set one photo's decision. Optimistically invalidates library detail. */
export function useSetDecision(libraryId: string | null | undefined) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ photoId, decision }: { photoId: string; decision: DecisionValue }) =>
      api.setDecision(photoId, decision),
    onSuccess: () => {
      invalidateLibraryQueries(qc, libraryId, true)
    },
    onError: () => {
      // 失败时同样 invalidate → useLibraryDetail refetch → 同步 useEffect 把后端真值
      // 重新注入 workspace,把乐观写入回滚到正确状态。
      invalidateLibraryQueries(qc, libraryId, true)
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
      invalidateLibraryQueries(qc, libraryId, false)
    },
    onError: () => {
      invalidateLibraryQueries(qc, libraryId, false)
    },
  })
}

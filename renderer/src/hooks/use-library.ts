/**
 * Library hooks (TanStack Query wrappers around api-client).
 *
 * - useLibraries: 列表
 * - useLibraryDetail: 单库详情（缩略图未齐时自动轮询，齐了停止）
 * - useImportLibrary: 导入
 * - useDeleteLibrary: 删除
 * - useBuildThumbnails: 构建缩略图
 */
import { useMutation, useQueries, useQuery, useQueryClient } from '@tanstack/react-query'

import {
  api,
  type ImportLibraryRequest,
  type LibraryDetail,
  type LibrarySummary,
  type PhotoRow,
} from '@/lib/api-client'

const LIBRARIES_KEY = ['libraries'] as const
const LIBRARY_DETAIL_KEY = (id: string) => ['library', id] as const

// 缩略图轮询间隔（缩略图齐全后停止）。3s 比 5s 更跟手，又不会冲爆后端。
const THUMB_POLL_INTERVAL_MS = 3_000
// scene_id 后台分组也用同一节奏轮询
const SCENE_POLL_INTERVAL_MS = 3_000

/**
 * 判断 detail 是否还有缺失字段，决定是否继续轮询：
 *  - 任一 photo 的 thumb_grid 为 null → 缩略图后台生成中
 *  - 任一 photo 的 scene_id 为 null → 场景分组后台运行中
 * 任一为 true 都返回轮询间隔；全齐了返回 false 关闭轮询。
 *
 * 注意：detail 本身可能 undefined（首次拉取 in-flight），此时也开启轮询，确保
 * 即使 cold start 也能动态加载。
 */
function pollIntervalForDetail(
  detail: LibraryDetail | undefined,
): number | false {
  if (!detail) return THUMB_POLL_INTERVAL_MS
  const photos: PhotoRow[] = detail.photos
  // 缩略图未齐
  if (photos.some((p) => p.thumb_grid === null || p.thumb_preview === null)) {
    return THUMB_POLL_INTERVAL_MS
  }
  // 场景分组未齐
  if (photos.some((p) => p.scene_id === null || p.scene_id === undefined)) {
    return SCENE_POLL_INTERVAL_MS
  }
  return false
}

export function useLibraries() {
  return useQuery({
    queryKey: LIBRARIES_KEY,
    queryFn: api.listLibraries,
    staleTime: 10_000,
    // libraries 列表的 last_analyzed_at 也是后台跑批改的，需要轮询同步进度
    refetchInterval: 5_000,
  })
}

export function useLibraryDetail(libraryId: string | null | undefined) {
  return useQuery({
    queryKey: LIBRARY_DETAIL_KEY(libraryId ?? ''),
    queryFn: () => api.libraryDetail(libraryId!),
    enabled: Boolean(libraryId),
    staleTime: 2_000, // 配合轮询缩短 stale，新数据立刻可见
    refetchInterval: (query) => pollIntervalForDetail(query.state.data),
    // 后台跑批时即使窗口失焦也继续 — 用户切回来就能看到新缩略图
    refetchIntervalInBackground: true,
  })
}

/**
 * 拉取所有 library 的 detail（archive / 物种墙跨 library 聚合需要）。
 * 单独 useLibraryDetail 只对 active folder 生效，archive 页要看到所有物种就得这个。
 *
 * 同样支持缩略图/场景未齐时自动轮询，每个 library 独立判断是否继续轮询。
 */
export function useAllLibraryDetails(libraryIds: string[]): LibraryDetail[] {
  const results = useQueries({
    queries: libraryIds.map((id) => ({
      queryKey: LIBRARY_DETAIL_KEY(id),
      queryFn: () => api.libraryDetail(id),
      staleTime: 2_000,
      refetchInterval: (query: { state: { data: LibraryDetail | undefined } }) =>
        pollIntervalForDetail(query.state.data),
      refetchIntervalInBackground: true,
    })),
  })
  return results
    .map((r) => r.data)
    .filter((d): d is LibraryDetail => d !== undefined)
}

export function useImportLibrary() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (body: ImportLibraryRequest) => api.importLibrary(body),
    onSuccess: (_data: LibrarySummary) => {
      qc.invalidateQueries({ queryKey: LIBRARIES_KEY })
    },
  })
}

export function useDeleteLibrary() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (libraryId: string) => api.deleteLibrary(libraryId),
    onSuccess: (_data, libraryId) => {
      qc.invalidateQueries({ queryKey: LIBRARIES_KEY })
      qc.removeQueries({ queryKey: LIBRARY_DETAIL_KEY(libraryId) })
    },
  })
}

export function useBuildThumbnails() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (libraryId: string) => api.buildThumbnails(libraryId),
    onSuccess: (_data, libraryId) => {
      qc.invalidateQueries({ queryKey: LIBRARY_DETAIL_KEY(libraryId) })
    },
  })
}

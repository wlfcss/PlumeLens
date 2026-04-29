/**
 * Library hooks (TanStack Query wrappers around api-client).
 *
 * - useLibraries: 列表
 * - useLibraryDetail: 单库详情
 * - useLibraryEvents: 后端事件驱动刷新缩略图/场景分组
 * - useImportLibrary: 导入
 * - useDeleteLibrary: 删除
 * - useBuildThumbnails: 构建缩略图
 */
import { useMutation, useQueries, useQuery, useQueryClient } from '@tanstack/react-query'
import { useEffect, useRef } from 'react'

import {
  api,
  type ImportLibraryRequest,
  type LibraryDetail,
  type LibrarySummary,
} from '@/lib/api-client'

const LIBRARIES_KEY = ['libraries'] as const
const LIBRARY_DETAIL_KEY = (id: string) => ['library', id] as const

const EVENT_REFRESH_DEBOUNCE_MS = 150

export function useLibraries() {
  return useQuery({
    queryKey: LIBRARIES_KEY,
    queryFn: api.listLibraries,
    staleTime: 10_000,
  })
}

export function useLibraryDetail(libraryId: string | null | undefined) {
  return useQuery({
    queryKey: LIBRARY_DETAIL_KEY(libraryId ?? ''),
    queryFn: () => api.libraryDetail(libraryId!),
    enabled: Boolean(libraryId),
    staleTime: 2_000,
  })
}

/**
 * 拉取所有 library 的 detail（archive / 物种墙跨 library 聚合需要）。
 * 单独 useLibraryDetail 只对 active folder 生效，archive 页要看到所有物种就得这个。
 */
export function useAllLibraryDetails(libraryIds: string[]): LibraryDetail[] {
  const results = useQueries({
    queries: libraryIds.map((id) => ({
      queryKey: LIBRARY_DETAIL_KEY(id),
      queryFn: () => api.libraryDetail(id),
      staleTime: 2_000,
    })),
  })
  return results
    .map((r) => r.data)
    .filter((d): d is LibraryDetail => d !== undefined)
}

export function useLibraryEvents(libraryId: string | null | undefined, enabled = true) {
  const qc = useQueryClient()
  const refreshTimerRef = useRef<number | null>(null)

  useEffect(() => {
    if (!libraryId || !enabled) return undefined
    let source: EventSource | null = null
    let cancelled = false

    const flushRefresh = () => {
      refreshTimerRef.current = null
      qc.invalidateQueries({ queryKey: LIBRARY_DETAIL_KEY(libraryId) })
      qc.invalidateQueries({ queryKey: LIBRARIES_KEY })
    }

    const scheduleRefresh = () => {
      if (refreshTimerRef.current !== null) return
      refreshTimerRef.current = window.setTimeout(flushRefresh, EVENT_REFRESH_DEBOUNCE_MS)
    }

    api.libraryEventsUrl(libraryId)
      .then((url) => {
        if (cancelled) return
        source = new EventSource(url)
        source.onopen = scheduleRefresh
        source.onmessage = scheduleRefresh
        ;[
          'library_snapshot',
          'thumbnail_batch',
          'thumbnail_ready',
          'thumbnail_failed',
          'thumbnail_complete',
          'scene_groups_ready',
        ].forEach((eventName) => {
          source?.addEventListener(eventName, scheduleRefresh)
        })
        source.onerror = (event) => {
          console.warn('Library event stream error (browser will reconnect):', event)
        }
      })
      .catch((error) => {
        console.warn('Failed to resolve library event URL:', error)
      })

    return () => {
      cancelled = true
      source?.close()
      source = null
      if (refreshTimerRef.current !== null) {
        window.clearTimeout(refreshTimerRef.current)
        refreshTimerRef.current = null
      }
    }
  }, [enabled, libraryId, qc])
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

export function useBuildPhotoThumbnail(libraryId: string | null | undefined) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (photoId: string) => api.buildPhotoThumbnail(photoId),
    onSuccess: (data) => {
      const targetLibraryId = data.library_id || libraryId
      if (targetLibraryId) {
        qc.invalidateQueries({ queryKey: LIBRARY_DETAIL_KEY(targetLibraryId) })
      }
      qc.invalidateQueries({ queryKey: LIBRARIES_KEY })
    },
  })
}

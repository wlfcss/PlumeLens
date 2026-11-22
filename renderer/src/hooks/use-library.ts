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
import { useMutation, useQueries, useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query'
import { useEffect } from 'react'

import {
  api,
  type ImportLibraryRequest,
  type LibraryDetail,
  type LibrarySummary,
  type PhotoThumbnailResponse,
  type RelinkLibraryResponse,
} from '@/lib/api-client'
import { logger } from '@/lib/logger'

export const LIBRARIES_KEY = ['libraries'] as const
export const LIBRARY_DETAIL_KEY = (id: string) => ['library', id] as const

const EVENT_REFRESH_DEBOUNCE_MS = 150
const ALL_LIBRARY_DETAIL_CONCURRENCY = 4

/**
 * Module-level singleton limiter: archive/species-wall can mount multiple aggregating
 * hooks, but all library detail requests should share one small concurrency budget.
 */
const libraryDetailQueue: Array<() => void> = []
let activeLibraryDetailRequests = 0

export function __resetLibraryDetailLimiterForTesting(): void {
  libraryDetailQueue.splice(0, libraryDetailQueue.length)
  activeLibraryDetailRequests = 0
}

function abortError(): DOMException {
  return new DOMException('Library detail request aborted', 'AbortError')
}

// Every observer sharing the detail key must register the revision it reads.
function fetchLibraryDetail(id: string, client: QueryClient, signal?: AbortSignal): Promise<LibraryDetail> {
  const previous = client.getQueryData<LibraryDetail>(LIBRARY_DETAIL_KEY(id))
  return api.libraryDetail(id, {
    signal,
    view: 'summary',
    includeSelectionSnapshot: true,
    ...(previous && { previousPhotos: previous.photos }),
  })
}

function drainLibraryDetailQueue(): void {
  while (
    activeLibraryDetailRequests < ALL_LIBRARY_DETAIL_CONCURRENCY &&
    libraryDetailQueue.length > 0
  ) {
    const run = libraryDetailQueue.shift()
    run?.()
  }
}

function limitedLibraryDetail(id: string, client: QueryClient, signal?: AbortSignal): Promise<LibraryDetail> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(abortError())
      return
    }

    let started = false
    const run = (): void => {
      started = true
      if (signal) signal.removeEventListener('abort', onAbort)
      if (signal?.aborted) {
        reject(abortError())
        drainLibraryDetailQueue()
        return
      }

      activeLibraryDetailRequests += 1
      fetchLibraryDetail(id, client, signal)
        .then(resolve, reject)
        .finally(() => {
          activeLibraryDetailRequests = Math.max(0, activeLibraryDetailRequests - 1)
          drainLibraryDetailQueue()
        })
    }

    const onAbort = (): void => {
      if (started) return
      const index = libraryDetailQueue.indexOf(run)
      if (index >= 0) libraryDetailQueue.splice(index, 1)
      reject(abortError())
    }

    if (signal) signal.addEventListener('abort', onAbort, { once: true })
    libraryDetailQueue.push(run)
    drainLibraryDetailQueue()
  })
}

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
    queryFn: ({ client, signal }) => fetchLibraryDetail(libraryId!, client, signal),
    enabled: Boolean(libraryId),
    staleTime: 2_000,
  })
}

/**
 * 拉取所有 library 的 detail（archive / 物种墙跨 library 聚合需要）。
 * 单独 useLibraryDetail 只对 active folder 生效，archive 页要看到所有物种就得这个。
 */
export function useAllLibraryDetails(libraryIds: string[], enabled = true): LibraryDetail[] {
  const results = useQueries({
    queries: (enabled ? libraryIds : []).map((id) => ({
      queryKey: LIBRARY_DETAIL_KEY(id),
      queryFn: ({ client, signal }) => limitedLibraryDetail(id, client, signal),
      staleTime: 2_000,
    })),
  })
  return results.map((r) => r.data).filter((d): d is LibraryDetail => d !== undefined)
}

export function useLibraryEvents(libraryId: string | null | undefined, enabled = true) {
  const qc = useQueryClient()

  useEffect(() => {
    if (!libraryId || !enabled) return undefined
    const detailQuery = { queryKey: LIBRARY_DETAIL_KEY(libraryId), exact: true }
    let source: EventSource | null = null
    let unsubscribeBridge: (() => void) | null = null
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null
    let refreshTimer: ReturnType<typeof setTimeout> | null = null
    let needsCatchUp = false
    let cancelled = false

    const flushRefresh = () => {
      refreshTimer = null
      if (qc.isFetching(detailQuery)) {
        scheduleRefresh()
        return
      }
      void qc.invalidateQueries(detailQuery, { cancelRefetch: false })
      const detail = qc.getQueryData<LibraryDetail>(detailQuery.queryKey)
      if (detail && !detail.projection_revision) {
        void qc.invalidateQueries({ queryKey: ['selection', libraryId] }, { cancelRefetch: false })
      }
      void qc.invalidateQueries({ queryKey: LIBRARIES_KEY }, { cancelRefetch: false })
    }

    const scheduleRefresh = () => {
      if (refreshTimer !== null) return
      refreshTimer = setTimeout(flushRefresh, EVENT_REFRESH_DEBOUNCE_MS)
    }

    const handleOpen = () => {
      // GET already loads the initial snapshot. Reconnection can miss real notifications.
      if (!needsCatchUp) return
      needsCatchUp = false
      scheduleRefresh()
    }

    const connect = (): void => {
      if (cancelled) return
      if (typeof window !== 'undefined' && window.plumelens?.engineSseSubscribe) {
        unsubscribeBridge = window.plumelens.engineSseSubscribe(
          `/library/${libraryId}/events`,
          (bridgeEvent) => {
            if (cancelled) return
            if (bridgeEvent.type === 'open') {
              handleOpen()
              return
            }
            if (bridgeEvent.type === 'message') {
              if (bridgeEvent.event !== 'library_snapshot') scheduleRefresh()
              return
            }
            logger.warn('Library event bridge closed, retrying in 5s:', bridgeEvent.message)
            needsCatchUp = true
            unsubscribeBridge?.()
            unsubscribeBridge = null
            reconnectTimer = setTimeout(connect, 5000)
          },
        )
        return
      }
      api
        .libraryEventsUrl(libraryId)
        .then((url) => {
          if (cancelled) return
          source = new EventSource(url)
          source.onopen = handleOpen
          source.onmessage = scheduleRefresh
          ;[
            'library_updated',
            'thumbnail_batch',
            'thumbnail_ready',
            'thumbnail_failed',
            'thumbnail_complete',
            'scene_groups_ready',
          ].forEach((eventName) => {
            source?.addEventListener(eventName, scheduleRefresh)
          })
          // 原生 EventSource 不对 4xx(429 SSE 限流)自动重连 — CLOSED 状态走
          // 手动 5s backoff 重连,避免 library 事件流静默断掉导致缩略图就绪 /
          // 场景分组完成等通知漏到。CONNECTING(1) 走浏览器原生重连。
          source.onerror = (event) => {
            if (cancelled || !source) return
            needsCatchUp = true
            if (source.readyState === EventSource.CLOSED) {
              logger.warn('Library event stream closed (likely 4xx), retrying in 5s')
              source.close()
              source = null
              reconnectTimer = setTimeout(connect, 5000)
            } else {
              logger.warn('Library event stream error (browser auto-reconnecting):', event)
            }
          }
        })
        .catch((error) => {
          if (cancelled) return
          needsCatchUp = true
          logger.warn('Failed to resolve library event URL, retrying in 5s:', error)
          reconnectTimer = setTimeout(connect, 5000)
        })
    }

    connect()

    return () => {
      cancelled = true
      if (reconnectTimer !== null) clearTimeout(reconnectTimer)
      unsubscribeBridge?.()
      unsubscribeBridge = null
      source?.close()
      source = null
      if (refreshTimer !== null) clearTimeout(refreshTimer)
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
    onError: () => {
      // 失败时也 invalidate 让前端 useLibraries refetch — 后端可能已经 partial
      // import(import 流程半截抛错前已写入 libraries 行)前端不刷新会看不到。
      // 与 useSetDecision/useSetSpeciesOverride 同款乐观 UI 兜底模式。
      qc.invalidateQueries({ queryKey: LIBRARIES_KEY })
    },
  })
}

export function useUpdateLibrary() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ libraryId, displayName }: { libraryId: string; displayName: string }) =>
      api.updateLibrary(libraryId, { display_name: displayName }),
    onSuccess: (data: LibrarySummary) => {
      qc.setQueryData<LibrarySummary[] | undefined>(LIBRARIES_KEY, (current) =>
        current?.map((library) => (library.id === data.id ? data : library)),
      )
      qc.setQueryData<LibraryDetail | undefined>(LIBRARY_DETAIL_KEY(data.id), (current) =>
        current ? { ...current, library: data } : current,
      )
      qc.invalidateQueries({ queryKey: LIBRARIES_KEY })
      qc.invalidateQueries({ queryKey: LIBRARY_DETAIL_KEY(data.id) })
    },
  })
}

export function useRelinkLibrary() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ libraryId, rootPath }: { libraryId: string; rootPath: string }) =>
      api.relinkLibrary(libraryId, { root_path: rootPath }),
    onSuccess: (data: RelinkLibraryResponse) => {
      qc.setQueryData<LibrarySummary[] | undefined>(LIBRARIES_KEY, (current) =>
        current?.map((library) => (library.id === data.library.id ? data.library : library)),
      )
      qc.setQueryData<LibraryDetail | undefined>(LIBRARY_DETAIL_KEY(data.library.id), (current) =>
        current ? { ...current, library: data.library } : current,
      )
      qc.invalidateQueries({ queryKey: LIBRARIES_KEY })
      qc.invalidateQueries({ queryKey: LIBRARY_DETAIL_KEY(data.library.id) })
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
      qc.invalidateQueries({ queryKey: ['selection', libraryId] })
    },
  })
}

export function useBuildPhotoThumbnail(libraryId: string | null | undefined) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (photoId: string) => api.buildPhotoThumbnail(photoId),
    onSuccess: (data: PhotoThumbnailResponse) => {
      const targetLibraryId = data.library_id || libraryId
      if (targetLibraryId) {
        qc.setQueryData<LibraryDetail | undefined>(
          LIBRARY_DETAIL_KEY(targetLibraryId),
          (current) => {
            if (!current || !data.thumb_grid || !data.thumb_preview) return current
            return {
              ...current,
              photos: current.photos.map((photo) =>
                photo.id === data.photo_id
                  ? {
                      ...photo,
                      thumb_grid: data.thumb_grid,
                      thumb_preview: data.thumb_preview,
                    }
                  : photo,
              ),
            }
          },
        )
        qc.invalidateQueries({ queryKey: LIBRARY_DETAIL_KEY(targetLibraryId) })
      }
      qc.invalidateQueries({ queryKey: LIBRARIES_KEY })
    },
  })
}

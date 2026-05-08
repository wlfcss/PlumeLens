/**
 * Analysis hooks — batch start + stats polling + SSE progress subscription.
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useEffect, useRef, useState } from 'react'

import {
  api,
  type AnalysisProgressEvent,
  type QueueStatsResponse,
} from '@/lib/api-client'

const QUEUE_STATS_KEY = (libraryId: string) => ['queue-stats', libraryId] as const
const LIBRARY_DETAIL_KEY = (libraryId: string) => ['library', libraryId] as const
const LIBRARIES_KEY = ['libraries'] as const
const DETAIL_REFRESH_THROTTLE_MS = 2_000

export function useStartBatch() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (params: { libraryId: string; forceRerun?: boolean }) =>
      api.startBatch(params.libraryId, params.forceRerun ?? false),
    onSuccess: (_, { libraryId }) => {
      qc.invalidateQueries({ queryKey: QUEUE_STATS_KEY(libraryId) })
      qc.invalidateQueries({ queryKey: ['library', libraryId] })
    },
  })
}

export function usePauseAnalysis() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (libraryId: string) => api.pauseAnalysis(libraryId),
    onSuccess: (_, libraryId) =>
      qc.invalidateQueries({ queryKey: QUEUE_STATS_KEY(libraryId) }),
  })
}

export function useResumeAnalysis() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (libraryId: string) => api.resumeAnalysis(libraryId),
    onSuccess: (_, libraryId) =>
      qc.invalidateQueries({ queryKey: QUEUE_STATS_KEY(libraryId) }),
  })
}

export function useCancelAnalysis() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (libraryId: string) => api.cancelAnalysis(libraryId),
    onSuccess: (_, libraryId) =>
      qc.invalidateQueries({ queryKey: QUEUE_STATS_KEY(libraryId) }),
  })
}

/** Poll queue stats every 2 s when an analysis is potentially active. */
export function useQueueStats(libraryId: string | null | undefined, enabled = true) {
  return useQuery<QueueStatsResponse>({
    queryKey: QUEUE_STATS_KEY(libraryId ?? ''),
    queryFn: () => api.getQueueStats(libraryId!),
    enabled: Boolean(libraryId) && enabled,
    refetchInterval: 2_000,
  })
}

/**
 * Subscribe to the SSE progress stream for a library. Returns the latest event.
 * Automatically reconnects on open errors; closes when disabled or unmounted.
 *
 * `restartKey` 是一个外部触发器：每次它变化都强制重建 SSE 连接。用法：
 * useStartBatch.onSuccess 后 bump 这个 key，能在 idle SSE 已死的场景下恢复推送。
 */
export function useAnalysisProgress(
  libraryId: string | null | undefined,
  enabled = true,
  restartKey: number = 0,
): AnalysisProgressEvent | null {
  const qc = useQueryClient()
  const [event, setEvent] = useState<AnalysisProgressEvent | null>(null)
  const lastDetailRefreshRef = useRef<{ at: number; signature: string } | null>(null)

  useEffect(() => {
    if (!libraryId || !enabled) return
    let source: EventSource | null = null
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null
    let cancelled = false

    const connect = (): void => {
      if (cancelled) return
      api.progressUrl(libraryId)
        .then((url) => {
          if (cancelled) return
          source = new EventSource(url)
          // 每次连接 / 重连成功立刻 invalidate library detail + libraries 列表 —
          // 5s backoff 期间发生的 progress 事件不会带 Last-Event-ID 重发,通过强制
          // refetch 让 UI 同步到当前真实状态(分析卡死 / 已完成 / 物种识别更新)。
          source.onopen = () => {
            qc.invalidateQueries({ queryKey: LIBRARY_DETAIL_KEY(libraryId) })
            qc.invalidateQueries({ queryKey: LIBRARIES_KEY })
          }
          source.onmessage = (msg) => {
            try {
              const parsed = JSON.parse(msg.data) as AnalysisProgressEvent
              setEvent(parsed)

              // SSE 本身只更新进度按钮；照片卡片/统计来自 library detail 查询。
              // 分析完成数变化时节流刷新 detail/list，让识别结果持续进入 UI。
              const signature = [
                parsed.completed,
                parsed.failed,
                parsed.dead,
                parsed.pending,
                parsed.processing,
                parsed.total,
              ].join(':')
              const active = parsed.pending + parsed.processing > 0
              const finished =
                parsed.total > 0 &&
                parsed.pending + parsed.processing === 0 &&
                parsed.completed + parsed.failed + parsed.dead >= parsed.total
              const previous = lastDetailRefreshRef.current
              const now = Date.now()
              const due =
                !previous ||
                (signature !== previous.signature &&
                  (finished || now - previous.at >= DETAIL_REFRESH_THROTTLE_MS))
              if ((active || finished) && due) {
                lastDetailRefreshRef.current = { at: now, signature }
                qc.invalidateQueries({ queryKey: LIBRARY_DETAIL_KEY(parsed.library_id) })
                qc.invalidateQueries({ queryKey: LIBRARIES_KEY })
              }
            } catch (e) {
              console.warn('SSE malformed frame:', e)
            }
          }
          // 原生 EventSource 只对网络断开 / 5xx 做自动重连;对 4xx(本工程的 429
          // SSE 限流)直接 readyState=CLOSED 不重试。这种 CLOSED 通过手动延时
          // 重连兜底,避免 progress UI 静默卡死。CONNECTING(1) 表示浏览器自己
          // 在重连,我们什么都不做。
          source.onerror = (e) => {
            if (cancelled || !source) return
            if (source.readyState === EventSource.CLOSED) {
              console.warn('SSE closed (likely 4xx), retrying in 5s')
              source.close()
              source = null
              reconnectTimer = setTimeout(connect, 5000)
            } else {
              console.warn('SSE error (browser auto-reconnecting):', e)
            }
          }
        })
        .catch((e) => {
          if (cancelled) return
          console.warn('Failed to resolve SSE URL, retrying in 5s:', e)
          reconnectTimer = setTimeout(connect, 5000)
        })
    }

    connect()

    return () => {
      cancelled = true
      if (reconnectTimer !== null) clearTimeout(reconnectTimer)
      source?.close()
      source = null
    }
  }, [libraryId, enabled, qc, restartKey])

  return event
}

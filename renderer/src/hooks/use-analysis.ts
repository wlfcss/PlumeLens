/**
 * Analysis hooks — batch start + stats polling + SSE progress subscription.
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useEffect, useState } from 'react'

import {
  api,
  type AnalysisProgressEvent,
  type QueueStatsResponse,
} from '@/lib/api-client'

const QUEUE_STATS_KEY = (libraryId: string) => ['queue-stats', libraryId] as const

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
  const [event, setEvent] = useState<AnalysisProgressEvent | null>(null)

  useEffect(() => {
    if (!libraryId || !enabled) return
    let source: EventSource | null = null
    let cancelled = false

    api.progressUrl(libraryId)
      .then((url) => {
        // race fix：cleanup 可能已跑（cancelled=true），别再创建 source
        if (cancelled) return
        source = new EventSource(url)
        source.onmessage = (msg) => {
          try {
            setEvent(JSON.parse(msg.data))
          } catch (e) {
            // eslint-disable-next-line no-console
            console.warn('SSE malformed frame:', e)
          }
        }
        // 注：v0.2.0 起后端不再主动 emit `done`（idle 时也保持流，让用户随时
        // 点「开始分析」能立即看到 pending 变化）。这里保留 listener 是
        // 兼容旧后端 / 防御性写法 — 收到 done 不再 close source。
        source.onerror = (e) => {
          // eslint-disable-next-line no-console
          console.warn('SSE error (browser will reconnect):', e)
        }
      })
      .catch((e) => {
        // eslint-disable-next-line no-console
        console.warn('Failed to resolve SSE URL:', e)
      })

    return () => {
      cancelled = true
      source?.close()
      source = null
    }
  }, [libraryId, enabled, restartKey])

  return event
}

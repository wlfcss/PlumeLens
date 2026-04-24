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
 */
export function useAnalysisProgress(
  libraryId: string | null | undefined,
  enabled = true,
): AnalysisProgressEvent | null {
  const [event, setEvent] = useState<AnalysisProgressEvent | null>(null)

  useEffect(() => {
    if (!libraryId || !enabled) return
    let source: EventSource | null = null
    let cancelled = false

    api.progressUrl(libraryId).then((url) => {
      if (cancelled) return
      source = new EventSource(url)
      source.onmessage = (msg) => {
        try {
          setEvent(JSON.parse(msg.data))
        } catch {
          // ignore malformed frames
        }
      }
      source.addEventListener('done', () => {
        source?.close()
      })
      source.onerror = () => {
        // 让浏览器自动重连；出错不吞数据
      }
    })

    return () => {
      cancelled = true
      source?.close()
    }
  }, [libraryId, enabled])

  return event
}

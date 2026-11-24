/**
 * Analysis hooks — batch start + stats polling + SSE progress subscription.
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useEffect, useRef, useState } from 'react'

import { LIBRARIES_KEY, LIBRARY_DETAIL_KEY } from '@/hooks/use-library'
import { SELECTION_QUERY_KEY } from '@/hooks/use-selection'
import {
  api,
  type AnalysisProgressEvent,
  type LibraryDetail,
  type QueueStatsResponse,
} from '@/lib/api-client'
import { logger } from '@/lib/logger'

const QUEUE_STATS_KEY = (libraryId: string) => ['queue-stats', libraryId] as const
const DETAIL_REFRESH_INTERVAL_MS = 15_000
const DETAIL_IDLE_CHECK_MS = 250

export function useStartBatch() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (params: { libraryId: string; forceRerun?: boolean }) =>
      api.startBatch(params.libraryId, params.forceRerun ?? false),
    onSuccess: (_, { libraryId }) => {
      void qc.invalidateQueries({ queryKey: QUEUE_STATS_KEY(libraryId) })
      void qc.invalidateQueries({ queryKey: LIBRARIES_KEY }, { cancelRefetch: false })
    },
  })
}

export function usePauseAnalysis() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (libraryId: string) => api.pauseAnalysis(libraryId),
    onSuccess: (_, libraryId) => qc.invalidateQueries({ queryKey: QUEUE_STATS_KEY(libraryId) }),
  })
}

export function useResumeAnalysis() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (libraryId: string) => api.resumeAnalysis(libraryId),
    onSuccess: (_, libraryId) => qc.invalidateQueries({ queryKey: QUEUE_STATS_KEY(libraryId) }),
  })
}

export function useCancelAnalysis() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (libraryId: string) => api.cancelAnalysis(libraryId),
    onSuccess: (_, libraryId) => qc.invalidateQueries({ queryKey: QUEUE_STATS_KEY(libraryId) }),
  })
}

/** Poll queue stats every 2 s only while a run is actively running or paused. */
export function useQueueStats(libraryId: string | null | undefined, enabled = true) {
  return useQuery<QueueStatsResponse>({
    queryKey: QUEUE_STATS_KEY(libraryId ?? ''),
    queryFn: () => api.getQueueStats(libraryId!),
    enabled: Boolean(libraryId) && enabled,
    refetchInterval: (query) => {
      const data = query.state.data
      if (!data) return false
      const active =
        data.desired_state === 'running' ||
        data.desired_state === 'paused' ||
        (data.stats?.pending ?? 0) + (data.stats?.processing ?? 0) > 0
      return active ? 2_000 : false
    },
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
  const lastFrame = useRef<AnalysisProgressEvent | null>(null)

  useEffect(() => {
    setEvent(null)

    if (!libraryId || !enabled) return undefined
    const detailQuery = { queryKey: LIBRARY_DETAIL_KEY(libraryId), exact: true }
    let source: EventSource | null = null
    let unsubscribeBridge: (() => void) | null = null
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null
    let detailTimer: ReturnType<typeof setTimeout> | null = null
    let detailDirty = false
    let flushImmediately = false
    let detailInFlight = false
    let nextDetailAt = performance.now() + DETAIL_REFRESH_INTERVAL_MS
    let needsCatchUp = false
    let cancelled = false

    const flushDetail = (): void => {
      if (cancelled || !detailDirty || detailInFlight) return
      if (detailTimer !== null) clearTimeout(detailTimer)
      detailTimer = null

      // Joining a request already on the wire could miss the results that made us dirty.
      const delay = qc.isFetching(detailQuery)
        ? DETAIL_IDLE_CHECK_MS
        : flushImmediately
          ? 0
          : nextDetailAt - performance.now()
      if (delay > 0) {
        detailTimer = setTimeout(flushDetail, delay)
        return
      }

      detailDirty = false
      flushImmediately = false
      detailInFlight = true
      nextDetailAt = performance.now() + DETAIL_REFRESH_INTERVAL_MS
      void qc.invalidateQueries(detailQuery, { cancelRefetch: false }).finally(() => {
        detailInFlight = false
        if (cancelled) return
        const detail = qc.getQueryData<LibraryDetail>(detailQuery.queryKey)
        if (detail && !detail.projection_revision) {
          void qc.invalidateQueries(
            { queryKey: SELECTION_QUERY_KEY(libraryId) },
            { cancelRefetch: false },
          )
        }
        flushDetail()
      })
    }

    const scheduleDetail = (immediate = false): void => {
      detailDirty = true
      flushImmediately ||= immediate
      if (detailTimer === null || immediate) flushDetail()
    }

    const handleOpen = (): void => {
      if (!needsCatchUp) return
      needsCatchUp = false
      scheduleDetail(true)
      void qc.invalidateQueries({ queryKey: LIBRARIES_KEY }, { cancelRefetch: false })
    }

    const handleProgressFrame = (data: string): void => {
      try {
        const parsed = JSON.parse(data) as AnalysisProgressEvent
        if (parsed.library_id !== libraryId) return
        const previous = lastFrame.current?.library_id === libraryId ? lastFrame.current : null
        lastFrame.current = parsed
        setEvent(parsed)

        const active = parsed.pending + parsed.processing > 0
        const resultsChanged =
          previous?.run_id === parsed.run_id && previous
            ? previous.completed !== parsed.completed ||
              previous.failed !== parsed.failed ||
              previous.dead !== parsed.dead
            : parsed.completed + parsed.failed + parsed.dead > 0
        const controlChanged = Boolean(
          previous &&
          (previous.run_id !== parsed.run_id || previous.desired_state !== parsed.desired_state),
        )
        const stopped =
          controlChanged &&
          (parsed.desired_state === 'completed' ||
            parsed.desired_state === 'cancelled' ||
            parsed.desired_state === 'paused')
        const legacyFinished =
          !parsed.desired_state && !active && previous && previous.pending + previous.processing > 0

        // Task starts and queue reordering should not fetch all photos. Results can wait for
        // the next batch, while stopping and reconnection must eventually publish the tail.
        if (stopped || legacyFinished || (resultsChanged && (previous || active))) {
          scheduleDetail(Boolean(stopped || legacyFinished))
          void qc.invalidateQueries({ queryKey: LIBRARIES_KEY }, { cancelRefetch: false })
        } else if (controlChanged) {
          void qc.invalidateQueries({ queryKey: LIBRARIES_KEY }, { cancelRefetch: false })
        }

        if (parsed.desired_state !== undefined) {
          qc.setQueryData<QueueStatsResponse>(QUEUE_STATS_KEY(libraryId), (current) => ({
            library_id: libraryId,
            run_id: parsed.run_id,
            desired_state: parsed.desired_state,
            stats: {
              ...current?.stats,
              completed: parsed.completed,
              failed: parsed.failed,
              dead: parsed.dead,
              pending: parsed.pending,
              processing: parsed.processing,
            },
          }))
        }
      } catch (e) {
        logger.warn('SSE malformed frame:', e)
      }
    }

    const scheduleReconnect = (): void => {
      if (cancelled) return
      if (reconnectTimer !== null) clearTimeout(reconnectTimer)
      reconnectTimer = setTimeout(() => {
        reconnectTimer = null
        connect()
      }, 5000)
    }

    const connect = (): void => {
      if (cancelled) return
      if (typeof window !== 'undefined' && window.plumelens?.engineSseSubscribe) {
        let syncError = false
        const unsub = window.plumelens.engineSseSubscribe(
          `/analysis/library/${libraryId}/progress`,
          (bridgeEvent) => {
            if (cancelled) return
            if (bridgeEvent.type === 'open') {
              handleOpen()
              return
            }
            if (bridgeEvent.type === 'message') {
              handleProgressFrame(bridgeEvent.data)
              return
            }
            logger.warn('SSE bridge closed, retrying in 5s:', bridgeEvent.message)
            needsCatchUp = true
            syncError = true
            unsubscribeBridge?.()
            unsubscribeBridge = null
            scheduleReconnect()
          },
        )
        if (syncError) {
          unsub()
        } else {
          unsubscribeBridge = unsub
        }
        return
      }
      api
        .progressUrl(libraryId)
        .then((url) => {
          if (cancelled) return
          source = new EventSource(url)
          source.onopen = handleOpen
          source.onmessage = (msg) => {
            handleProgressFrame(msg.data)
          }
          source.onerror = (e) => {
            if (cancelled || !source) return
            needsCatchUp = true
            if (source.readyState === EventSource.CLOSED) {
              logger.warn('SSE closed (likely 4xx), retrying in 5s')
              source.close()
              source = null
              scheduleReconnect()
            } else {
              logger.warn('SSE error (browser auto-reconnecting):', e)
            }
          }
        })
        .catch((e) => {
          if (cancelled) return
          needsCatchUp = true
          logger.warn('Failed to resolve SSE URL, retrying in 5s:', e)
          scheduleReconnect()
        })
    }

    connect()

    return () => {
      cancelled = true
      if (reconnectTimer !== null) clearTimeout(reconnectTimer)
      if (detailTimer !== null) clearTimeout(detailTimer)
      unsubscribeBridge?.()
      unsubscribeBridge = null
      source?.close()
      source = null
    }
  }, [libraryId, enabled, qc, restartKey])

  return event?.library_id === libraryId ? event : null
}

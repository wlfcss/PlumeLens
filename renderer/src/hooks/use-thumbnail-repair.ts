import { useCallback, useEffect, useRef } from 'react'
import { useQueryClient } from '@tanstack/react-query'

import type { ThumbnailLoadStatus } from '@/components/thumbnail-image'
import { LIBRARY_DETAIL_KEY, useBuildPhotoThumbnail } from '@/hooks/use-library'
import type { PhotoRecord } from '@/lib/workspace-types'

const THUMBNAIL_REPAIR_COOLDOWN_MS = 30_000
const THUMBNAIL_REPAIR_MAX_CONCURRENT = 4
const THUMBNAIL_MISSING_REPAIR_DELAY_MS = 600
const THUMBNAIL_REPAIR_MAX_ATTEMPTS = 3

interface UseThumbnailRepairOptions {
  libraryId: string | null
  photos: PhotoRecord[]
}

export function useThumbnailRepair({
  libraryId,
  photos,
}: UseThumbnailRepairOptions): (photoId: string, status: ThumbnailLoadStatus) => void {
  const queryClient = useQueryClient()
  const { mutateAsync: rebuildPhotoThumbnail } = useBuildPhotoThumbnail(libraryId)
  const repairingRef = useRef(new Set<string>())
  const queueRef = useRef<string[]>([])
  const activeCountRef = useRef(0)
  const activePhotoIdsRef = useRef(new Set<string>())
  const lastRepairAtRef = useRef(new Map<string, number>())
  const missingTimersRef = useRef(new Map<string, number>())
  const invalidateTimerRef = useRef<number | null>(null)
  const failedResourcesRef = useRef(new Set<string>())
  const attemptsRef = useRef(new Map<string, { src: string | null | undefined; count: number }>())
  const photosRef = useRef(photos)
  photosRef.current = photos

  useEffect(() => {
    const timers = missingTimersRef.current
    return () => {
      for (const id of timers.values()) window.clearTimeout(id)
      timers.clear()
      if (invalidateTimerRef.current !== null) {
        window.clearTimeout(invalidateTimerRef.current)
        invalidateTimerRef.current = null
      }
      queueRef.current = []
      repairingRef.current.clear()
      activePhotoIdsRef.current.clear()
      activeCountRef.current = 0
    }
  }, [libraryId])

  const drainQueue = useCallback(() => {
    while (activeCountRef.current < THUMBNAIL_REPAIR_MAX_CONCURRENT) {
      const nextPhotoId = queueRef.current.shift()
      if (!nextPhotoId) return

      const currentPhoto = photosRef.current.find((photo) => photo.id === nextPhotoId)
      if (
        !currentPhoto ||
        (currentPhoto.thumbGridUrl && !failedResourcesRef.current.has(nextPhotoId)) ||
        !repairingRef.current.has(nextPhotoId)
      ) {
        repairingRef.current.delete(nextPhotoId)
        continue
      }

      activeCountRef.current += 1
      activePhotoIdsRef.current.add(nextPhotoId)
      void rebuildPhotoThumbnail(nextPhotoId)
        .catch(() => undefined)
        .finally(() => {
          activePhotoIdsRef.current.delete(nextPhotoId)
          activeCountRef.current = Math.max(0, activeCountRef.current - 1)
          repairingRef.current.delete(nextPhotoId)
          drainQueue()
        })
    }
  }, [rebuildPhotoThumbnail])

  return useCallback(
    (photoId: string, status: ThumbnailLoadStatus) => {
      if (status === 'loaded') {
        failedResourcesRef.current.delete(photoId)
        attemptsRef.current.delete(photoId)
        lastRepairAtRef.current.delete(photoId)
        if (!activePhotoIdsRef.current.has(photoId)) repairingRef.current.delete(photoId)
        queueRef.current = queueRef.current.filter((queuedPhotoId) => queuedPhotoId !== photoId)
        const timer = missingTimersRef.current.get(photoId)
        if (timer !== undefined) {
          window.clearTimeout(timer)
          missingTimersRef.current.delete(photoId)
        }
        return
      }
      if (status === 'loading') return
      if (status === 'error') failedResourcesRef.current.add(photoId)

      const enqueueBackendRebuild = () => {
        if (repairingRef.current.has(photoId)) return
        const photo = photosRef.current.find((item) => item.id === photoId)
        if (!photo) return
        const previous = attemptsRef.current.get(photoId)
        const sameResource = previous?.src === photo.thumbGridUrl
        const count = sameResource ? (previous?.count ?? 0) : 0
        if (count >= THUMBNAIL_REPAIR_MAX_ATTEMPTS) return
        const now = Date.now()
        const lastRepairAt = lastRepairAtRef.current.get(photoId) ?? 0
        if (sameResource && now - lastRepairAt < THUMBNAIL_REPAIR_COOLDOWN_MS) return
        attemptsRef.current.set(photoId, { src: photo.thumbGridUrl, count: count + 1 })
        repairingRef.current.add(photoId)
        lastRepairAtRef.current.set(photoId, now)
        queueRef.current.push(photoId)
        drainQueue()
      }

      if (status === 'missing') {
        const photo = photosRef.current.find((p) => p.id === photoId)
        if (!photo) return
        if (photo.analysisStatus !== 'done' && photo.analysisStatus !== 'failed') return
        if (missingTimersRef.current.has(photoId)) return
        if (libraryId && invalidateTimerRef.current === null) {
          invalidateTimerRef.current = window.setTimeout(() => {
            invalidateTimerRef.current = null
            void queryClient.invalidateQueries({ queryKey: LIBRARY_DETAIL_KEY(libraryId) })
          }, 250)
        }
        const timerId = window.setTimeout(() => {
          missingTimersRef.current.delete(photoId)
          const refreshed = photosRef.current.find((p) => p.id === photoId)
          if (refreshed?.thumbGridUrl) return
          enqueueBackendRebuild()
        }, THUMBNAIL_MISSING_REPAIR_DELAY_MS)
        missingTimersRef.current.set(photoId, timerId)
        return
      }

      enqueueBackendRebuild()
    },
    [drainQueue, libraryId, queryClient],
  )
}

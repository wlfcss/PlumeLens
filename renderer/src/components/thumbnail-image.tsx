import { useEffect, useMemo, useRef, useState } from 'react'

const MAX_RETRY_ATTEMPTS = 36

function retryDelayMs(attempt: number): number {
  return Math.min(600 * 1.45 ** attempt, 5_000)
}

export type ThumbnailLoadStatus = 'missing' | 'loading' | 'loaded' | 'error'

interface ThumbnailImageProps {
  alt: string
  className?: string
  onStatusChange?: (photoId: string, status: ThumbnailLoadStatus) => void
  photoId?: string
  src: string | null | undefined
}

/**
 * Robust loader for plumelens:// thumbnail URLs.
 *
 * CSS background images do not expose load failures, and Chromium may cache an
 * early 404 while the engine is still rebuilding thumbnails. Rendering a real
 * image lets us retry the visible thumbnail with a cache-busting query string
 * and report load failures so the app can ask the backend to repair that exact
 * photo instead of polling the whole library.
 */
export function ThumbnailImage({
  alt,
  className,
  onStatusChange,
  photoId,
  src,
}: ThumbnailImageProps) {
  const [attempt, setAttempt] = useState(0)
  const [loaded, setLoaded] = useState(false)
  const retryTimerRef = useRef<number | null>(null)

  useEffect(() => {
    if (retryTimerRef.current !== null) {
      window.clearTimeout(retryTimerRef.current)
      retryTimerRef.current = null
    }
    setAttempt(0)
    setLoaded(false)
    if (photoId) {
      onStatusChange?.(photoId, src ? 'loading' : 'missing')
    }
    return () => {
      if (retryTimerRef.current !== null) {
        window.clearTimeout(retryTimerRef.current)
        retryTimerRef.current = null
      }
    }
  }, [onStatusChange, photoId, src])

  useEffect(() => {
    if (!src || loaded) return undefined

    const retryNow = () => {
      if (retryTimerRef.current !== null) {
        window.clearTimeout(retryTimerRef.current)
        retryTimerRef.current = null
      }
      setAttempt((value) => (value >= MAX_RETRY_ATTEMPTS ? 0 : value + 1))
    }

    const handleVisibilityChange = () => {
      if (document.visibilityState === 'visible') retryNow()
    }

    window.addEventListener('focus', retryNow)
    document.addEventListener('visibilitychange', handleVisibilityChange)
    return () => {
      window.removeEventListener('focus', retryNow)
      document.removeEventListener('visibilitychange', handleVisibilityChange)
    }
  }, [loaded, src])

  const displaySrc = useMemo(() => {
    if (!src) return null
    const separator = src.includes('?') ? '&' : '?'
    return `${src}${separator}retry=${attempt}`
  }, [attempt, src])

  if (!displaySrc) return null

  return (
    <img
      alt={alt}
      className={className}
      decoding="async"
      loading="lazy"
      onError={() => {
        if (photoId) onStatusChange?.(photoId, 'error')
        if (attempt >= MAX_RETRY_ATTEMPTS || retryTimerRef.current !== null) return
        retryTimerRef.current = window.setTimeout(() => {
          retryTimerRef.current = null
          setAttempt((value) => value + 1)
        }, retryDelayMs(attempt))
      }}
      onLoad={() => {
        if (retryTimerRef.current !== null) {
          window.clearTimeout(retryTimerRef.current)
          retryTimerRef.current = null
        }
        setLoaded(true)
        if (photoId) onStatusChange?.(photoId, 'loaded')
      }}
      src={displaySrc}
      style={{ opacity: loaded ? 1 : 0 }}
    />
  )
}

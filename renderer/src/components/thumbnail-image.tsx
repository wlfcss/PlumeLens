import { useEffect, useMemo, useRef, useState } from 'react'

const MAX_RETRY_ATTEMPTS = 36

function retryDelayMs(attempt: number): number {
  return Math.min(600 * 1.45 ** attempt, 5_000)
}

/**
 * 跨组件实例的"曾经成功加载过"缓存(模块级 Set,photo grid 内 src URL → 已 loaded)。
 *
 * 解决 react-virtual 重 mount 闪渐变 — 用户搜索/筛选/滚动让虚拟行重排时,
 * virtualRow.key 改变 → 整行 unmount → PhotoTile + ThumbnailImage 重新 mount → 之前
 * 的 loaded state 丢失 → 重新走"opacity 0 渐变占位 → onLoad → opacity 1"流程。
 * 即使浏览器 fs cache 命中,这一帧渐变占位的 UX 也很糟。
 *
 * 用模块级 Set 记录:重新 mount 时如果 src 已在 set,initial state.loaded=true,
 * img 立即可见(opacity:1),onLoad 几 ms 内 fire(浏览器 fs cache 命中)→ 全程
 * 用户看不到渐变占位帧。
 *
 * 失效场景(故意保守):
 * - cache 没有 TTL,进程内永久(数百 photo grid 也不过几十 KB Set 项)
 * - src 含 ?retry=N 时,N 不同 src 也不同 — 错误重试不会污染 cache
 * - rebuildPhotoThumbnail 后 thumb 文件变了但 src URL 不变,cache 还会让前端瞬
 *   显旧图;但 backend rebuild 通常伴随 SSE event → invalidate library detail →
 *   PhotoTile re-render with same src → 浏览器 fs cache 同样命中,新文件 mtime 变
 *   会让 net.fetch 取新内容,所以最终一致。轻微延迟用户能接受。
 */
const loadedSrcCache = new Set<string>()

export type ThumbnailLoadStatus = 'missing' | 'loading' | 'loaded' | 'error'

interface ThumbnailImageProps {
  alt: string
  className?: string
  loading?: 'eager' | 'lazy'
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
  loading = 'eager',
  onStatusChange,
  photoId,
  src,
}: ThumbnailImageProps) {
  const [attempt, setAttempt] = useState(0)
  // initial loaded=true 如果该 src 模块级 cache 命中(之前 mount 已成功 onLoad),
  // 跳过 opacity:0 渐变占位帧 — 浏览器 fs cache 几 ms 内 fire 新 onLoad。
  const [loaded, setLoaded] = useState(() => (src ? loadedSrcCache.has(src) : false))
  const retryTimerRef = useRef<number | null>(null)
  const onStatusChangeRef = useRef(onStatusChange)

  useEffect(() => {
    onStatusChangeRef.current = onStatusChange
  }, [onStatusChange])

  useEffect(() => {
    if (retryTimerRef.current !== null) {
      window.clearTimeout(retryTimerRef.current)
      retryTimerRef.current = null
    }
    setAttempt(0)
    // src 切换时:如果 cache 命中保持 loaded=true(无渐变闪),否则 false 等 onLoad
    setLoaded(src ? loadedSrcCache.has(src) : false)
    if (photoId) {
      onStatusChangeRef.current?.(photoId, src ? 'loading' : 'missing')
    }
    return () => {
      if (retryTimerRef.current !== null) {
        window.clearTimeout(retryTimerRef.current)
        retryTimerRef.current = null
      }
    }
  }, [photoId, src])

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
      loading={loading}
      // 默认不用 loading="lazy" — grid 缩略图体积小(平均 ~15KB,全库 282 张总共 5MB),
      // lazy 会让滚动后总有 100-300ms"渐变占位"窗口,UX 差。eager 一次性请求,
      // main 进程的 plumelens:// 协议并发处理(libuv 4 worker thread + cached realpath
      // root),实测可在 1-2s 内全部就位。大批量弹层可按场景传入 lazy。
      onError={() => {
        // src 之前 loaded 过现在 error(底层文件被删/缩略图重建中),清 cache 让
        // 下次重 mount 不会因 cache hit 显示一帧旧引用。
        if (src) loadedSrcCache.delete(src)
        setLoaded(false)
        if (photoId) onStatusChangeRef.current?.(photoId, 'error')
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
        if (src) loadedSrcCache.add(src)  // 记入跨 mount cache,后续 remount 跳渐变帧
        if (photoId) onStatusChangeRef.current?.(photoId, 'loaded')
      }}
      src={displaySrc}
      style={{ opacity: loaded ? 1 : 0 }}
    />
  )
}

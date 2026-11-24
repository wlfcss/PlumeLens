/**
 * SelectionScreen 滚动 + 紧凑头部 + 回顶按钮的状态机 hook。
 *
 * 职责:
 *   - 跟踪 selection-main 滚动元素 (受控 ref + state pair,因为 react-virtual
 *     需要的是 element 引用,而 React 内部的 scroll listener 要 ref)
 *   - 算 compact 阀值:scrollTop > ENTER_PX 进 compact, < EXIT_PX 退出
 *     (滞回避免临界点抖动)
 *   - 算 scrollTop 按钮显隐:进度 > 1/3 且 scrollTop > 900px 显;
 *     回归到 < 25% 且 < 220px 隐(同样滞回)
 *   - 切换文件夹/视图/排序时强制回顶 + 重置 chrome
 *   - 紧凑头部"更多"下拉:点外面 / Esc 关闭
 *   - 平滑回顶 + 720ms 兜底强制
 *
 * 输入:selectionResetKey — 文件夹/视图/排序变化时触发强制重置。
 *
 * prefers-reduced-motion: reduce 时跳过平滑动画。
 */
import { useCallback, useEffect, useRef, useState } from 'react'

const SELECTION_COMPACT_ENTER_SCROLL_PX = 148
const SELECTION_COMPACT_EXIT_SCROLL_PX = 72
const SELECTION_SCROLL_TOP_SHOW_PROGRESS = 1 / 3
const SELECTION_SCROLL_TOP_HIDE_PROGRESS = 0.25
const SELECTION_SCROLL_TOP_SHOW_MIN_PX = 900
const SELECTION_SCROLL_TOP_HIDE_MAX_PX = 220
const SELECTION_SCROLL_TOP_SETTLE_MS = 720
const SELECTION_SCROLL_TOP_EPSILON = 1

export interface SelectionChromeState {
  compact: boolean
  showScrollTop: boolean
}

export interface SelectionScrollAnchor {
  photoId: string | null
  relativeOffset: number
  scrollTop: number
}

/**
 * 筛选或排序改变列表成员后，决定锚点/焦点应落到哪张照片：
 * 1. 目标照片仍在结果中 → 保持同图
 * 2. 目标照片被筛掉 → 从旧顺序向外查找最近的存活邻图（优先后继，再前驱）
 * 3. 结果为空或无历史位置 → 返回 null
 */
export function resolveSurvivingAnchorPhotoId(
  previousOrder: readonly string[],
  nextOrder: readonly string[],
  preferredPhotoId: string | null,
): string | null {
  if (nextOrder.length === 0 || !preferredPhotoId) return null
  const nextSet = new Set(nextOrder)
  if (nextSet.has(preferredPhotoId)) return preferredPhotoId
  const prevIndex = previousOrder.indexOf(preferredPhotoId)
  if (prevIndex < 0) return null
  for (let distance = 1; distance < previousOrder.length; distance += 1) {
    const forward = previousOrder[prevIndex + distance]
    if (forward && nextSet.has(forward)) return forward
    const backward = previousOrder[prevIndex - distance]
    if (backward && nextSet.has(backward)) return backward
  }
  return null
}

function captureVisiblePhotoAnchor(container: HTMLElement): SelectionScrollAnchor {
  const containerRect = container.getBoundingClientRect()
  const tiles = container.querySelectorAll<HTMLElement>('[data-photo-id]')
  let bestPhotoId: string | null = null
  let bestOffset = 0
  let bestDistance = Number.POSITIVE_INFINITY
  for (const tile of tiles) {
    const photoId = tile.dataset.photoId
    if (!photoId) continue
    const rect = tile.getBoundingClientRect()
    if (rect.bottom <= containerRect.top) continue
    const offset = rect.top - containerRect.top
    const distance = Math.abs(offset)
    if (distance < bestDistance) {
      bestDistance = distance
      bestPhotoId = photoId
      bestOffset = offset
    }
  }
  return {
    photoId: bestPhotoId,
    relativeOffset: bestOffset,
    scrollTop: container.scrollTop,
  }
}

export interface UseSelectionScrollStateResult {
  selectionScrollElement: HTMLElement | null
  setSelectionScrollNode: (node: HTMLElement | null) => void
  compactMoreRef: React.RefObject<HTMLDivElement | null>
  selectionChromeState: SelectionChromeState
  compactMoreOpen: boolean
  setCompactMoreOpen: (open: boolean) => void
  scrollSelectionToTop: () => void
  restoreAnchorPhoto: (photoId: string | null) => void
}

export function useSelectionScrollState(
  folderKey: string,
  layoutKey: string,
): UseSelectionScrollStateResult {
  const selectionScrollRef = useRef<HTMLElement | null>(null)
  const compactMoreRef = useRef<HTMLDivElement | null>(null)
  const scrollTopSettleFrameRef = useRef<number | null>(null)
  const scrollTopSettleTimeoutRef = useRef<number | null>(null)
  const anchorFrameRef = useRef<number | null>(null)
  const anchorByFolderRef = useRef<Map<string, SelectionScrollAnchor>>(new Map())
  const previousFolderKeyRef = useRef<string>(folderKey)
  const previousLayoutKeyRef = useRef<string>(layoutKey)
  const [selectionScrollElement, setSelectionScrollElement] = useState<HTMLElement | null>(null)
  const [selectionChromeState, setSelectionChromeState] = useState<SelectionChromeState>({
    compact: false,
    showScrollTop: false,
  })
  const selectionChromeStateRef = useRef(selectionChromeState)
  const [compactMoreOpen, setCompactMoreOpen] = useState(false)

  const setSelectionScrollNode = useCallback((node: HTMLElement | null) => {
    selectionScrollRef.current = node
    setSelectionScrollElement((current) => (current === node ? current : node))
  }, [])

  const cancelScrollTopSettle = useCallback(() => {
    if (scrollTopSettleFrameRef.current !== null) {
      window.cancelAnimationFrame(scrollTopSettleFrameRef.current)
      scrollTopSettleFrameRef.current = null
    }
    if (scrollTopSettleTimeoutRef.current !== null) {
      window.clearTimeout(scrollTopSettleTimeoutRef.current)
      scrollTopSettleTimeoutRef.current = null
    }
    if (anchorFrameRef.current !== null) {
      window.cancelAnimationFrame(anchorFrameRef.current)
      anchorFrameRef.current = null
    }
  }, [])

  const syncChromeFromNode = useCallback((node: HTMLElement) => {
    const maxScroll = Math.max(0, node.scrollHeight - node.clientHeight)
    const scrollTop = node.scrollTop
    const progress = maxScroll > 0 ? scrollTop / maxScroll : 0
    const current = selectionChromeStateRef.current
    const compact = current.compact
      ? scrollTop > SELECTION_COMPACT_EXIT_SCROLL_PX
      : scrollTop > SELECTION_COMPACT_ENTER_SCROLL_PX
    const showScrollTop = current.showScrollTop
      ? progress > SELECTION_SCROLL_TOP_HIDE_PROGRESS &&
        scrollTop > SELECTION_SCROLL_TOP_HIDE_MAX_PX
      : progress > SELECTION_SCROLL_TOP_SHOW_PROGRESS &&
        scrollTop > SELECTION_SCROLL_TOP_SHOW_MIN_PX
    if (current.compact === compact && current.showScrollTop === showScrollTop) return
    const next = { compact, showScrollTop }
    selectionChromeStateRef.current = next
    setSelectionChromeState(next)
  }, [])

  const forceSelectionScrollTop = useCallback(
    (node: HTMLElement) => {
      cancelScrollTopSettle()
      node.scrollTo({ behavior: 'auto', left: 0, top: 0 })
      node.scrollTop = 0
      node.scrollLeft = 0
      const resetChrome = { compact: false, showScrollTop: false }
      selectionChromeStateRef.current = resetChrome
      setSelectionChromeState(resetChrome)
      if (folderKey) {
        anchorByFolderRef.current.set(folderKey, { photoId: null, relativeOffset: 0, scrollTop: 0 })
      }
    },
    [cancelScrollTopSettle, folderKey],
  )

  const restoreAnchorPhoto = useCallback(
    (photoId: string | null) => {
      const node = selectionScrollRef.current ?? selectionScrollElement
      if (!node || !photoId) return
      const saved = folderKey ? anchorByFolderRef.current.get(folderKey) : undefined
      let target: HTMLElement | null = null
      for (const candidate of node.querySelectorAll<HTMLElement>('[data-photo-id]')) {
        if (candidate.dataset.photoId === photoId) {
          target = candidate
          break
        }
      }
      if (!target) return
      const containerRect = node.getBoundingClientRect()
      const targetRect = target.getBoundingClientRect()
      const desiredOffset = saved?.photoId === photoId ? saved.relativeOffset : 24
      const delta = targetRect.top - containerRect.top - desiredOffset
      if (Math.abs(delta) > 2) {
        const nextTop = Math.max(0, node.scrollTop + delta)
        node.scrollTo({ behavior: 'auto', left: 0, top: nextTop })
        node.scrollTop = nextTop
        syncChromeFromNode(node)
      }
    },
    [folderKey, selectionScrollElement, syncChromeFromNode],
  )

  const scheduleRestoreAnchorPhoto = useCallback(
    (photoId: string | null) => {
      if (!photoId) return
      if (anchorFrameRef.current !== null) {
        window.cancelAnimationFrame(anchorFrameRef.current)
      }
      anchorFrameRef.current = window.requestAnimationFrame(() => {
        anchorFrameRef.current = null
        restoreAnchorPhoto(photoId)
      })
    },
    [restoreAnchorPhoto],
  )

  useEffect(() => cancelScrollTopSettle, [cancelScrollTopSettle])

  // 切换文件夹时保存离开文件夹的滚动锚点并恢复目标文件夹位置；
  // 同一文件夹内切换排序/视图时不强行归零，尽量保持锚点照片相对位置。
  useEffect(() => {
    const node = selectionScrollElement
    const prevFolder = previousFolderKeyRef.current
    const prevLayout = previousLayoutKeyRef.current
    if (prevFolder !== folderKey) {
      if (node && prevFolder) {
        anchorByFolderRef.current.set(prevFolder, captureVisiblePhotoAnchor(node))
      }
      previousFolderKeyRef.current = folderKey
      previousLayoutKeyRef.current = layoutKey
      if (!node) {
        const resetChrome = { compact: false, showScrollTop: false }
        selectionChromeStateRef.current = resetChrome
        setSelectionChromeState(resetChrome)
        return
      }
      const saved = folderKey ? anchorByFolderRef.current.get(folderKey) : undefined
      if (saved && saved.scrollTop > 0) {
        cancelScrollTopSettle()
        node.scrollTo({ behavior: 'auto', left: 0, top: saved.scrollTop })
        node.scrollTop = saved.scrollTop
        syncChromeFromNode(node)
        if (saved.photoId) {
          scheduleRestoreAnchorPhoto(saved.photoId)
        }
      } else {
        forceSelectionScrollTop(node)
      }
      return
    }

    if (prevLayout !== layoutKey) {
      previousLayoutKeyRef.current = layoutKey
      const saved = folderKey ? anchorByFolderRef.current.get(folderKey) : undefined
      if (node && saved?.photoId) {
        scheduleRestoreAnchorPhoto(saved.photoId)
      }
    }
  }, [
    cancelScrollTopSettle,
    folderKey,
    forceSelectionScrollTop,
    layoutKey,
    scheduleRestoreAnchorPhoto,
    selectionScrollElement,
    syncChromeFromNode,
  ])

  useEffect(() => {
    const node = selectionScrollElement
    if (!node) return undefined

    let frame = 0
    let anchorIdleTimer: number | null = null
    const captureAnchorOnIdle = () => {
      anchorIdleTimer = null
      if (folderKey) {
        anchorByFolderRef.current.set(folderKey, captureVisiblePhotoAnchor(node))
      }
    }
    const update = () => {
      frame = 0
      syncChromeFromNode(node)
      if (folderKey) {
        const existing = anchorByFolderRef.current.get(folderKey)
        if (existing) {
          existing.scrollTop = node.scrollTop
        } else {
          anchorByFolderRef.current.set(folderKey, {
            photoId: null,
            relativeOffset: 0,
            scrollTop: node.scrollTop,
          })
        }
        // Debounce DOM-reading anchor capture until scrolling settles so 60/120fps
        // scroll frames never trigger per-frame layout reflow (getBoundingClientRect).
        if (anchorIdleTimer !== null) window.clearTimeout(anchorIdleTimer)
        anchorIdleTimer = window.setTimeout(captureAnchorOnIdle, 180)
      }
    }

    const requestUpdate = () => {
      if (frame !== 0) return
      frame = window.requestAnimationFrame(update)
    }

    update()
    node.addEventListener('scroll', requestUpdate, { passive: true })
    return () => {
      if (frame !== 0) window.cancelAnimationFrame(frame)
      if (anchorIdleTimer !== null) window.clearTimeout(anchorIdleTimer)
      node.removeEventListener('scroll', requestUpdate)
    }
  }, [folderKey, selectionScrollElement, syncChromeFromNode])

  useEffect(() => {
    if (!selectionChromeState.compact) setCompactMoreOpen(false)
  }, [selectionChromeState.compact])

  useEffect(() => {
    if (!compactMoreOpen) return undefined
    const handlePointerDown = (event: PointerEvent) => {
      const target = event.target
      if (!(target instanceof Node)) return
      if (!compactMoreRef.current?.contains(target)) {
        setCompactMoreOpen(false)
      }
    }
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setCompactMoreOpen(false)
    }
    document.addEventListener('pointerdown', handlePointerDown)
    document.addEventListener('keydown', handleKeyDown)
    return () => {
      document.removeEventListener('pointerdown', handlePointerDown)
      document.removeEventListener('keydown', handleKeyDown)
    }
  }, [compactMoreOpen])

  const scrollSelectionToTop = useCallback(() => {
    const node = selectionScrollRef.current ?? selectionScrollElement
    if (!node) return
    cancelScrollTopSettle()
    const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches
    setCompactMoreOpen(false)
    if (reduceMotion || node.scrollTop <= SELECTION_SCROLL_TOP_EPSILON) {
      forceSelectionScrollTop(node)
      return
    }

    node.scrollTo({ behavior: 'smooth', left: 0, top: 0 })

    const startedAt = window.performance.now()
    const settle = () => {
      if (selectionScrollRef.current !== node) {
        cancelScrollTopSettle()
        return
      }
      const elapsed = window.performance.now() - startedAt
      if (
        node.scrollTop <= SELECTION_SCROLL_TOP_EPSILON ||
        elapsed >= SELECTION_SCROLL_TOP_SETTLE_MS
      ) {
        forceSelectionScrollTop(node)
        return
      }
      scrollTopSettleFrameRef.current = window.requestAnimationFrame(settle)
    }

    scrollTopSettleFrameRef.current = window.requestAnimationFrame(settle)
    scrollTopSettleTimeoutRef.current = window.setTimeout(() => {
      if (selectionScrollRef.current === node && node.scrollTop > SELECTION_SCROLL_TOP_EPSILON) {
        forceSelectionScrollTop(node)
      }
    }, SELECTION_SCROLL_TOP_SETTLE_MS + 80)
  }, [cancelScrollTopSettle, forceSelectionScrollTop, selectionScrollElement])

  return {
    selectionScrollElement,
    setSelectionScrollNode,
    compactMoreRef,
    selectionChromeState,
    compactMoreOpen,
    setCompactMoreOpen,
    scrollSelectionToTop,
    restoreAnchorPhoto: scheduleRestoreAnchorPhoto,
  }
}

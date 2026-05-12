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

export interface UseSelectionScrollStateResult {
  selectionScrollElement: HTMLElement | null
  setSelectionScrollNode: (node: HTMLElement | null) => void
  compactMoreRef: React.RefObject<HTMLDivElement | null>
  selectionChromeState: SelectionChromeState
  compactMoreOpen: boolean
  setCompactMoreOpen: (open: boolean) => void
  scrollSelectionToTop: () => void
}

export function useSelectionScrollState(
  selectionResetKey: string,
): UseSelectionScrollStateResult {
  const selectionScrollRef = useRef<HTMLElement | null>(null)
  const compactMoreRef = useRef<HTMLDivElement | null>(null)
  const scrollTopSettleFrameRef = useRef<number | null>(null)
  const scrollTopSettleTimeoutRef = useRef<number | null>(null)
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
    },
    [cancelScrollTopSettle],
  )

  useEffect(() => cancelScrollTopSettle, [cancelScrollTopSettle])

  useEffect(() => {
    if (selectionScrollElement) {
      forceSelectionScrollTop(selectionScrollElement)
      return
    }
    const resetChrome = { compact: false, showScrollTop: false }
    selectionChromeStateRef.current = resetChrome
    setSelectionChromeState(resetChrome)
  }, [forceSelectionScrollTop, selectionResetKey, selectionScrollElement])

  useEffect(() => {
    const node = selectionScrollElement
    if (!node) return undefined

    let frame = 0
    const update = () => {
      frame = 0
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
    }

    const requestUpdate = () => {
      if (frame !== 0) return
      frame = window.requestAnimationFrame(update)
    }

    update()
    node.addEventListener('scroll', requestUpdate, { passive: true })
    return () => {
      if (frame !== 0) window.cancelAnimationFrame(frame)
      node.removeEventListener('scroll', requestUpdate)
    }
  }, [selectionScrollElement])

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
  }
}

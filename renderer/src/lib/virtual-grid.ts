/**
 * 虚拟滚动 + 响应式网格的共用 hook / 工具 — 同时服务于选片网格 (VirtualizedPhotoGrid)
 * 和羽迹物种墙 (VirtualizedCollectionBoard)。
 */

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type RefObject,
} from 'react'

type ResponsiveGridLayout = {
  columns: number
  width: number
}

/** 容器宽度 / 最小列宽 / 间距 → 当前列数。ResizeObserver 跟踪容器尺寸变化。 */
export function useResponsiveGridLayout(
  containerElement: HTMLElement | null,
  minColumnWidth: number,
  gap: number,
): ResponsiveGridLayout {
  const [layout, setLayout] = useState<ResponsiveGridLayout>({
    columns: 1,
    width: minColumnWidth,
  })

  useLayoutEffect(() => {
    if (!containerElement) {
      setLayout((current) =>
        current.columns === 1 && current.width === minColumnWidth
          ? current
          : { columns: 1, width: minColumnWidth },
      )
      return undefined
    }

    let frame = 0
    const updateColumns = () => {
      const width = Math.max(minColumnWidth, containerElement.clientWidth)
      const nextColumns = Math.max(1, Math.floor((width + gap) / (minColumnWidth + gap)))
      setLayout((current) =>
        current.columns === nextColumns && current.width === width
          ? current
          : { columns: nextColumns, width },
      )
    }

    // rAF throttle:用户拖窗口大小时 ResizeObserver 每帧触发,合并到一个 rAF
    // 内更新避免一帧多次 setState 触发虚拟列表重测量。
    const scheduleUpdate = () => {
      if (frame !== 0) return
      frame = window.requestAnimationFrame(() => {
        frame = 0
        updateColumns()
      })
    }

    updateColumns()
    if (typeof ResizeObserver !== 'undefined') {
      const observer = new ResizeObserver(scheduleUpdate)
      observer.observe(containerElement)
      return () => {
        observer.disconnect()
        if (frame !== 0) window.cancelAnimationFrame(frame)
      }
    }

    window.addEventListener('resize', scheduleUpdate)
    return () => {
      window.removeEventListener('resize', scheduleUpdate)
      if (frame !== 0) window.cancelAnimationFrame(frame)
    }
  }, [containerElement, gap, minColumnWidth])

  return layout
}

/** 虚拟列表起始偏移 — react-virtual 需要知道 container 相对 scrollElement 的 top 偏移。 */
export function useVirtualScrollMargin(
  containerRef: RefObject<HTMLElement | null>,
  scrollElement: HTMLElement | null,
): number {
  const [scrollMargin, setScrollMargin] = useState(0)
  const scrollMarginRef = useRef(0)

  const updateScrollMargin = useCallback(() => {
    const container = containerRef.current
    if (!container || !scrollElement) {
      if (scrollMarginRef.current !== 0) {
        scrollMarginRef.current = 0
        setScrollMargin(0)
      }
      return
    }

    const scrollRect = scrollElement.getBoundingClientRect()
    const containerRect = container.getBoundingClientRect()
    const next = Math.max(0, containerRect.top - scrollRect.top + scrollElement.scrollTop)
    if (Math.abs(next - scrollMarginRef.current) < 0.5) return
    scrollMarginRef.current = next
    setScrollMargin(next)
  }, [containerRef, scrollElement])

  useLayoutEffect(() => {
    updateScrollMargin()
  })

  useEffect(() => {
    let frame = 0
    const scheduleUpdate = () => {
      if (frame !== 0) return
      frame = window.requestAnimationFrame(() => {
        frame = 0
        updateScrollMargin()
      })
    }
    updateScrollMargin()
    if (typeof ResizeObserver === 'undefined') {
      window.addEventListener('resize', scheduleUpdate)
      return () => {
        window.removeEventListener('resize', scheduleUpdate)
        if (frame !== 0) window.cancelAnimationFrame(frame)
      }
    }

    const observer = new ResizeObserver(scheduleUpdate)
    if (containerRef.current) observer.observe(containerRef.current)
    if (scrollElement) observer.observe(scrollElement)
    window.addEventListener('resize', scheduleUpdate)
    return () => {
      observer.disconnect()
      window.removeEventListener('resize', scheduleUpdate)
      if (frame !== 0) window.cancelAnimationFrame(frame)
    }
  }, [containerRef, scrollElement, updateScrollMargin])

  return scrollMargin
}

/** 把列数注入 CSS 变量,样式表用 grid-template-columns: repeat(var(--virtual-grid-columns), 1fr)。 */
export function virtualGridStyle(columns: number): CSSProperties {
  return { '--virtual-grid-columns': String(columns) } as CSSProperties
}

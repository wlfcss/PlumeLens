/**
 * 复核弹窗的单张图片舞台 — 显示完整原图或 IQA 裁切片段,叠加 bbox/pose/AF 覆盖层。
 *
 * Loupe 交互 (hold-to-zoom):
 *   按下 → 立即放大 + 锁定鼠标位置;移动 → 跟随平移;松开 → 立即还原。
 *   比 click-toggle 更快 — 鸟摄复核高频检查眼睛/羽毛细节,toggle 模式要点两次,
 *   累积下来明显更慢。锁定放大请用顶部 1.5×/2.5×/4× 倍率切换。
 *
 * 覆盖层坐标体系:
 *   - 完整图模式:bbox/pose / 原图尺寸 → 百分比
 *   - 裁切模式:先转换到 cropRect 局部坐标,再 / cropRect 尺寸
 */

import { Maximize2 } from 'lucide-react'
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from 'react'
import type { useTranslation } from 'react-i18next'

import type { AfOverlay, PhotoRecord } from '@/lib/mock-workspace'
import { cn } from '@/lib/utils'

export function ReviewImageStage({
  label,
  hint,
  previewSrc,
  fallbackGradient,
  aspect,
  imgW,
  imgH,
  bbox,
  pose,
  afOverlay,
  photoId,
  loupeEnabled,
  cropRect,
  onOpenFullscreen,
  onZoomScaleChange,
  showHeader = true,
  t,
  variant,
  zoomOptions,
  zoomScale,
}: {
  label: string
  hint: string
  previewSrc: string | null
  fallbackGradient: string
  aspect: number | null
  imgW: number | null
  imgH: number | null
  bbox: { x1: number; y1: number; x2: number; y2: number } | null
  pose: PhotoRecord['bestPose']
  afOverlay: AfOverlay | null
  photoId: string
  loupeEnabled: boolean
  cropRect: { x1: number; y1: number; x2: number; y2: number } | null
  onOpenFullscreen?: () => void
  onZoomScaleChange?: (scale: number) => void
  showHeader?: boolean
  t: ReturnType<typeof useTranslation>['t']
  variant: 'primary' | 'crop' | 'fullscreen'
  zoomOptions?: readonly number[]
  zoomScale: number
}) {
  const containerRef = useRef<HTMLDivElement | null>(null)
  const frameRef = useRef<HTMLDivElement | null>(null)
  const [frameSize, setFrameSize] = useState<{ width: number; height: number }>({
    width: 0,
    height: 0,
  })
  const [loupeActive, setLoupeActive] = useState(false)
  const [loupePos, setLoupePos] = useState<{ xPct: number; yPct: number }>({
    xPct: 50,
    yPct: 50,
  })
  const pointerStateRef = useRef<{
    pointerId: number
    moved: boolean
    startX: number
    startY: number
    wasActive: boolean
  } | null>(null)

  useEffect(() => {
    const element = frameRef.current
    if (!element) return

    const updateSize = () => {
      const rect = element.getBoundingClientRect()
      setFrameSize({
        width: rect.width,
        height: rect.height,
      })
    }

    updateSize()
    const observer = new ResizeObserver(updateSize)
    observer.observe(element)
    return () => observer.disconnect()
  }, [])

  useEffect(() => {
    setLoupeActive(false)
    setLoupePos({ xPct: 50, yPct: 50 })
    pointerStateRef.current = null
  }, [photoId])

  const updateLoupePosition = useCallback(
    (element: HTMLDivElement, clientX: number, clientY: number) => {
      const rect = element.getBoundingClientRect()
      const xPct = ((clientX - rect.left) / rect.width) * 100
      const yPct = ((clientY - rect.top) / rect.height) * 100
      setLoupePos({
        xPct: Math.max(0, Math.min(100, xPct)),
        yPct: Math.max(0, Math.min(100, yPct)),
      })
    },
    [],
  )

  // Hold-to-zoom 交互:pointerDown → 放大 + 锁定指针位置;pointerMove → 跟随平移;
  // pointerUp / pointerCancel → 立即还原。比之前的 click-toggle 更符合用户预期
  // ("按一下看清,松开就退") — 鸟摄复核高频检查眼睛/羽毛细节,toggle 模式要点两次,
  // 累积下来明显更慢。如果用户想锁定放大查看,可以用顶部 1.5×/2.5×/4× 倍率切换。
  const handlePointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (!loupeEnabled || !previewSrc) return
    e.preventDefault()
    pointerStateRef.current = {
      pointerId: e.pointerId,
      moved: false,
      startX: e.clientX,
      startY: e.clientY,
      wasActive: loupeActive,
    }
    updateLoupePosition(e.currentTarget, e.clientX, e.clientY)
    setLoupeActive(true)
    e.currentTarget.setPointerCapture(e.pointerId)
  }
  const handlePointerMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    const state = pointerStateRef.current
    if (!state || state.pointerId !== e.pointerId || !loupeActive) return
    if (Math.abs(e.clientX - state.startX) + Math.abs(e.clientY - state.startY) > 4) {
      state.moved = true
    }
    updateLoupePosition(e.currentTarget, e.clientX, e.clientY)
  }
  const handlePointerEnd = (e: ReactPointerEvent<HTMLDivElement>) => {
    const state = pointerStateRef.current
    if (state && state.pointerId === e.pointerId) {
      // 总是退出放大 — hold-to-zoom 语义。
      setLoupeActive(false)
    }
    pointerStateRef.current = null
    if (e.currentTarget.hasPointerCapture(e.pointerId)) {
      e.currentTarget.releasePointerCapture(e.pointerId)
    }
  }

  const stageAspect = useMemo<number>(() => {
    if (cropRect) {
      const cw = cropRect.x2 - cropRect.x1
      const ch = cropRect.y2 - cropRect.y1
      if (cw > 0 && ch > 0) return cw / ch
    }
    if (aspect && aspect > 0) return aspect
    if (imgW && imgH && imgW > 0 && imgH > 0) return imgW / imgH
    return 4 / 3
  }, [aspect, cropRect, imgH, imgW])

  const fittedSize = useMemo<CSSProperties>(() => {
    if (frameSize.width <= 0 || frameSize.height <= 0) {
      return { aspectRatio: stageAspect }
    }

    const frameAspect = frameSize.width / frameSize.height
    if (frameAspect > stageAspect) {
      const height = frameSize.height
      return {
        width: Math.max(1, Math.floor(height * stageAspect)),
        height: Math.max(1, Math.floor(height)),
      }
    }

    const width = frameSize.width
    return {
      width: Math.max(1, Math.floor(width)),
      height: Math.max(1, Math.floor(width / stageAspect)),
    }
  }, [frameSize.height, frameSize.width, stageAspect])

  // 算 background:裁切图等比放大显示 cropRect;否则按 contain(普通预览)或 loupe
  const cropStyle = useMemo<CSSProperties>(() => {
    if (!previewSrc) return {}
    if (cropRect && imgW && imgH) {
      // 显示 cropRect 内容:容器本身保持 cropRect 比例,背景只按一个轴等比缩放。
      const cw = cropRect.x2 - cropRect.x1
      const ch = cropRect.y2 - cropRect.y1
      if (cw <= 0 || ch <= 0) return {}
      const sizeX = (imgW / cw) * 100
      // background-position 百分比:(crop 中心 / (原图 - crop)) * 100
      const posX = imgW > cw ? ((cropRect.x1 + cw / 2 - cw / 2) / (imgW - cw)) * 100 : 50
      const posY = imgH > ch ? ((cropRect.y1 + ch / 2 - ch / 2) / (imgH - ch)) * 100 : 50
      return {
        backgroundImage: `url("${previewSrc}")`,
        backgroundPosition: `${posX}% ${posY}%`,
        backgroundSize: `${sizeX}% auto`,
        backgroundRepeat: 'no-repeat',
      }
    }
    if (loupeActive) {
      return {
        backgroundImage: `url("${previewSrc}")`,
        backgroundPosition: `${loupePos.xPct}% ${loupePos.yPct}%`,
        backgroundSize: `${zoomScale * 100}% auto`,
        backgroundRepeat: 'no-repeat',
      }
    }
    return {
      backgroundImage: `url("${previewSrc}")`,
      backgroundPosition: 'center',
      backgroundSize: 'contain',
      backgroundRepeat: 'no-repeat',
    }
  }, [previewSrc, cropRect, imgW, imgH, loupeActive, loupePos.xPct, loupePos.yPct, zoomScale])

  // 计算覆盖层在该 stage 上的相对百分比
  // - 完整图模式:直接 bbox/pose / 原图尺寸
  // - 裁切模式:先转换到 cropRect 局部坐标,再 / cropRect 尺寸
  const renderOverlays = (): ReactNode => {
    if (!imgW || !imgH) return null
    const toLocalRect = (
      x1: number,
      y1: number,
      x2: number,
      y2: number,
    ): { left: number; top: number; width: number; height: number } | null => {
      if (cropRect) {
        const cw = cropRect.x2 - cropRect.x1
        const ch = cropRect.y2 - cropRect.y1
        if (cw <= 0 || ch <= 0) return null
        const left = ((x1 - cropRect.x1) / cw) * 100
        const top = ((y1 - cropRect.y1) / ch) * 100
        const width = ((x2 - x1) / cw) * 100
        const height = ((y2 - y1) / ch) * 100
        // crop 之外的覆盖层不画
        if (left + width < 0 || left > 100 || top + height < 0 || top > 100) return null
        return { left, top, width, height }
      }
      return {
        left: (x1 / imgW) * 100,
        top: (y1 / imgH) * 100,
        width: ((x2 - x1) / imgW) * 100,
        height: ((y2 - y1) / imgH) * 100,
      }
    }
    const toLocalPoint = (x: number, y: number): { left: number; top: number } | null => {
      if (cropRect) {
        const cw = cropRect.x2 - cropRect.x1
        const ch = cropRect.y2 - cropRect.y1
        if (cw <= 0 || ch <= 0) return null
        const left = ((x - cropRect.x1) / cw) * 100
        const top = ((y - cropRect.y1) / ch) * 100
        if (left < -2 || left > 102 || top < -2 || top > 102) return null
        return { left, top }
      }
      // imgW/imgH 在 EXIF 损坏或后端 bug 下可能是 0,会算出 Infinity 渲染到 -Inf 像素位置。
      if (imgW <= 0 || imgH <= 0) return null
      return { left: (x / imgW) * 100, top: (y / imgH) * 100 }
    }

    const overlays: ReactNode[] = []
    // bbox(黄色高亮,IQA 裁切图上更显眼)
    if (bbox) {
      const r = toLocalRect(bbox.x1, bbox.y1, bbox.x2, bbox.y2)
      if (r) {
        overlays.push(
          <span
            className={cn('detect-box', cropRect && 'detect-box--accent')}
            key="bbox"
            style={{
              left: `${r.left}%`,
              top: `${r.top}%`,
              width: `${r.width}%`,
              height: `${r.height}%`,
            }}
          />,
        )
      }
    }
    // pose 关键点 — v2 模型 11 关键点(5 头 + 6 身)
    // 头部点保留原 .pose-point / .pose-point--eye 高亮样式(影响降档,核心地位)
    // 躯干点用 .pose-point--torso 弱化样式(信号丰富但视觉不抢主体)
    if (pose) {
      const headKeys = ['bill', 'crown', 'nape', 'left_eye', 'right_eye'] as const
      const torsoKeys = ['belly', 'breast', 'back', 'tail', 'left_wing', 'right_wing'] as const
      for (const key of headKeys) {
        const kp = pose[key]
        if (kp.confidence < 0.05) continue
        const p = toLocalPoint(kp.x, kp.y)
        if (!p) continue
        overlays.push(
          <span
            className={cn(
              'pose-point',
              (key === 'left_eye' || key === 'right_eye') && 'pose-point--eye',
            )}
            key={`pose-${key}`}
            style={{ left: `${p.left}%`, top: `${p.top}%` }}
            title={`${key}  ${(kp.confidence * 100).toFixed(0)}%`}
          />,
        )
      }
      for (const key of torsoKeys) {
        // 躯干点是 v2 新增 optional 字段,旧 cache 反序列化时为 undefined → 跳过
        const kp = pose[key]
        if (!kp || kp.confidence < 0.05) continue
        const p = toLocalPoint(kp.x, kp.y)
        if (!p) continue
        overlays.push(
          <span
            className="pose-point pose-point--torso"
            key={`pose-${key}`}
            style={{ left: `${p.left}%`, top: `${p.top}%` }}
            title={`${key}  ${(kp.confidence * 100).toFixed(0)}%`}
          />,
        )
      }
    }
    // AF 覆盖层:按 Canon 官方 AF area 语义两层渲染。
    // - 蓝色 .af-area 框 = 用户/相机指定的对焦区域(zone/whole_area/expanded)
    // - 底层 .af-point--passive: points 中"激活但未命中"的对焦点 — 灰白细边
    //   无光晕,密集排列也不会因 box-shadow 叠加产生"中心特别亮"的假象
    // - 顶层 .af-point--focused: 实际合焦命中的点 — 红色发光。多点合焦(zone 模式
    //   下常见 6+ 点同时命中)走 --focused-dense 弱光晕变体,叠加效应可控
    // - kind === 'point' (单点 AF) → 直接画一个大尺寸 focused
    if (afOverlay) {
      const areaBounds = afOverlay.kind !== 'point' ? afOverlay.bounds : undefined
      if (areaBounds) {
        const r = toLocalRect(areaBounds.x1, areaBounds.y1, areaBounds.x2, areaBounds.y2)
        if (r) {
          overlays.push(
            <span
              className={cn('af-area', `af-area--${afOverlay.kind}`)}
              key="af-area"
              style={{
                left: `${r.left}%`,
                top: `${r.top}%`,
                width: `${r.width}%`,
                height: `${r.height}%`,
              }}
              title={t('selection.review.afArea')}
            />,
          )
        }
      }

      const focused = afOverlay.focused_points ?? []
      const all = afOverlay.points ?? []
      // 用 index 作 key 区分 passive vs focused;legacy fallback 无 index 时用坐标
      const keyOf = (pt: { index?: number; x: number; y: number }): string =>
        pt.index !== undefined ? `i:${pt.index}` : `xy:${pt.x.toFixed(1)},${pt.y.toFixed(1)}`
      const focusedKeys = new Set(focused.map(keyOf))
      const passive = all.filter((pt) => !focusedKeys.has(keyOf(pt)))
      const isMini = afOverlay.kind !== 'point'
      // 多点合焦时用弱光晕变体,避免密集网格 box-shadow 叠加
      const focusedDense = focused.length >= 4

      // 底层:激活但未命中的对焦点(passive,无光晕)
      for (const [index, point] of passive.entries()) {
        const p = toLocalPoint(point.x, point.y)
        if (!p) continue
        overlays.push(
          <span
            className={cn('af-point', 'af-point--passive', isMini && 'af-point--mini')}
            key={`af-passive-${index}`}
            style={{ left: `${p.left}%`, top: `${p.top}%` }}
            title={t('selection.review.afAvailablePoint')}
          />,
        )
      }

      // 顶层:实际合焦命中的点(focused,红色发光)
      const focusedToDraw =
        focused.length > 0
          ? focused
          : passive.length > 0
            ? [] // 没合焦信息且有 passive → 不再 fallback 到 center,避免重复显示
            : [afOverlay.center] // 极端 fallback:三组都空,至少画中心
      for (const [index, point] of focusedToDraw.entries()) {
        const p = toLocalPoint(point.x, point.y)
        if (!p) continue
        overlays.push(
          <span
            className={cn(
              'af-point',
              focusedDense ? 'af-point--focused-dense' : 'af-point--focused',
              isMini && 'af-point--mini',
            )}
            key={`af-focused-${index}`}
            style={{ left: `${p.left}%`, top: `${p.top}%` }}
            title={
              afOverlay.kind === 'point'
                ? t('selection.review.afPoint')
                : t('selection.review.afFocusedPoint')
            }
          />,
        )
      }
    }
    return overlays
  }

  const zoomControls =
    loupeEnabled && previewSrc && zoomOptions && onZoomScaleChange ? (
      <div className="review-zoom-control" aria-label={t('selection.review.zoomLabel')}>
        {zoomOptions.map((option) => (
          <button
            aria-label={t('selection.review.zoomScale', { scale: option })}
            className={cn(option === zoomScale && 'review-zoom-control__item--active')}
            key={option}
            onClick={() => onZoomScaleChange(option)}
            type="button"
          >
            {option}×
          </button>
        ))}
      </div>
    ) : null

  return (
    <div
      className={cn(
        'review-stage__pane',
        variant === 'fullscreen' && 'review-stage__pane--fullscreen',
      )}
    >
      {showHeader ? (
        <div className="review-stage__head">
          <span className="review-stage__label">{label}</span>
          <span className="review-stage__tools">
            <span className="review-stage__hint">{hint}</span>
            {zoomControls}
            {onOpenFullscreen ? (
              <button
                aria-label={t('selection.review.fullscreen')}
                className="review-stage__fullscreen"
                onClick={onOpenFullscreen}
                type="button"
              >
                <Maximize2 className="h-3.5 w-3.5" />
              </button>
            ) : null}
          </span>
        </div>
      ) : null}
      <div
        className={cn(
          'review-image-frame',
          variant === 'fullscreen' && 'review-image-frame--fullscreen',
        )}
        ref={frameRef}
      >
        <div
          ref={containerRef}
          className={cn(
            'review-image',
            `review-image--${variant}`,
            loupeEnabled && previewSrc && 'review-image--loupe',
            loupeActive && 'review-image--loupe-active',
          )}
          style={{
            ...cropStyle,
            ...fittedSize,
            ...(previewSrc ? {} : { backgroundImage: fallbackGradient }),
          }}
          onPointerDown={handlePointerDown}
          onPointerMove={handlePointerMove}
          onPointerUp={handlePointerEnd}
          onPointerCancel={handlePointerEnd}
          onLostPointerCapture={() => {
            pointerStateRef.current = null
          }}
          data-photo-id={photoId}
        >
          {!loupeActive ? renderOverlays() : null}
        </div>
      </div>
    </div>
  )
}

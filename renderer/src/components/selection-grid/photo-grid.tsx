/**
 * 选片网格家族 — 选片页中部主区域,渲染分组照片网格 + 单张照片 tile + 连拍堆叠。
 *
 * 组件层级:
 *   PhotoGroupsList  (虚拟滚动 group rows)
 *     └─ VirtualizedPhotoGroupRow (单 group 行 + measureElement)
 *         └─ PhotoGroup (group 标题 + 分段网格)
 *             └─ PhotoSegmentGrid (分段渲染:堆叠态 / 展开态)
 *                 ├─ PhotoStackTile (堆叠态:整卡 focus + 数量徽标展开)
 *                 └─ PhotoTile (单张 tile)
 *
 *   VirtualizedPhotoGrid (flat 模式扁平虚拟滚动)
 *     └─ PhotoTile
 *
 * 历史:之前住在 App.tsx ~770 行,本次外迁。数据派生 helpers 一并搬到
 * @/lib/photo-grid-helpers,虚拟滚动 hooks 在 @/lib/virtual-grid。
 */

import { Images } from 'lucide-react'
import {
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react'
import type { useTranslation } from 'react-i18next'
import { useVirtualizer, type VirtualItem, type Virtualizer } from '@tanstack/react-virtual'

import { StatusDot } from '@/components/common/metric-cell'
import { StatusPill } from '@/components/common/status-pill'
import { ThumbnailImage, type ThumbnailLoadStatus } from '@/components/thumbnail-image'
import { gradeLabelKey } from '@/lib/i18n-keys'
import type { PhotoGroupRecord, PhotoRecord } from '@/lib/mock-workspace'
import {
  categoryTone,
  formatPhotoSpeciesDisplay,
  photoCategory,
  tileSpeciesSourceBadge,
} from '@/lib/photo-display'
import { effectivePhotoGrade, formatScore } from '@/lib/photo-helpers'
import {
  analysisErrorTooltip,
  analysisTone,
  bestPhotoForStack,
  buildPhotoSegments,
  categoryLabelKey,
  decisionTone,
  EMPTY_PHOTOS,
  EMPTY_SEGMENTS,
  EMPTY_STRING_ARRAY,
  PHOTO_GRID_GAP,
  PHOTO_GRID_MIN_COLUMN_WIDTH,
  PHOTO_GROUP_HEADER_ESTIMATED_HEIGHT,
  PHOTO_GROUP_ITEM_GAP,
  resolveExpandedSegmentIdsForSegments,
  visibleGroupTitle,
  visibleTileCountForSegments,
  type PhotoSegment,
  type SegmentExpansionOverrides,
  type StackCollapseControl,
} from '@/lib/photo-grid-helpers'
import { cn } from '@/lib/utils'
import {
  useResponsiveGridLayout,
  useVirtualScrollMargin,
  virtualGridStyle,
} from '@/lib/virtual-grid'

export function PhotoGroupsList({
  focusedPhotoId,
  groups,
  onFocusPhoto,
  onOpenReview,
  onThumbnailLoadStatus,
  scrollElement,
  t,
}: {
  focusedPhotoId: string | null
  groups: Array<{ group: PhotoGroupRecord; photos: PhotoRecord[] }>
  onFocusPhoto: (photoId: string | null) => void
  onOpenReview: (photoId: string) => void
  onThumbnailLoadStatus: (photoId: string, status: ThumbnailLoadStatus) => void
  scrollElement: HTMLElement | null
  t: ReturnType<typeof useTranslation>['t']
}) {
  const containerRef = useRef<HTMLDivElement | null>(null)
  const [containerElement, setContainerElement] = useState<HTMLDivElement | null>(null)
  const setContainerNode = useCallback((node: HTMLDivElement | null) => {
    containerRef.current = node
    setContainerElement(node)
  }, [])
  const [segmentExpansionOverrides, setSegmentExpansionOverrides] =
    useState<SegmentExpansionOverrides>({})
  const gridLayout = useResponsiveGridLayout(
    containerElement,
    PHOTO_GRID_MIN_COLUMN_WIDTH,
    PHOTO_GRID_GAP,
  )
  const columns = gridLayout.columns
  const scrollMargin = useVirtualScrollMargin(containerRef, scrollElement)
  const segmentsByGroup = useMemo(
    () => groups.map((entry) => buildPhotoSegments(entry.photos)),
    [groups],
  )
  const estimatedTileCountByGroup = useMemo(
    () =>
      groups.map((entry, index) => {
        const segments = segmentsByGroup[index] ?? EMPTY_SEGMENTS
        return visibleTileCountForSegments(
          segments,
          resolveExpandedSegmentIdsForSegments(segments, segmentExpansionOverrides[entry.group.id]),
        )
      }),
    [groups, segmentExpansionOverrides, segmentsByGroup],
  )
  const groupMeasurementSignature = useMemo(
    () =>
      groups
        .map((entry, index) => {
          const segments = segmentsByGroup[index] ?? EMPTY_SEGMENTS
          return `${entry.group.id}:${entry.photos.length}:${segments.map((segment) => segment.id).join(',')}`
        })
        .join('|'),
    [groups, segmentsByGroup],
  )
  const estimatedTileHeight = useMemo(() => {
    const tileWidth = Math.max(
      PHOTO_GRID_MIN_COLUMN_WIDTH,
      (gridLayout.width - PHOTO_GRID_GAP * (columns - 1)) / columns,
    )
    return Math.round(tileWidth * 0.75)
  }, [columns, gridLayout.width])
  const estimateGroupSize = useCallback(
    (index: number) => {
      const visibleTileCount = Math.max(1, estimatedTileCountByGroup[index] ?? 1)
      const rows = Math.max(1, Math.ceil(visibleTileCount / columns))
      return (
        PHOTO_GROUP_HEADER_ESTIMATED_HEIGHT +
        rows * estimatedTileHeight +
        Math.max(0, rows - 1) * PHOTO_GRID_GAP +
        PHOTO_GROUP_ITEM_GAP
      )
    },
    [columns, estimatedTileCountByGroup, estimatedTileHeight],
  )
  const virtualizer = useVirtualizer<HTMLElement, HTMLDivElement>({
    count: groups.length,
    getItemKey: (index) => groups[index]?.group.id ?? index,
    getScrollElement: () => scrollElement,
    estimateSize: estimateGroupSize,
    overscan: 4,
    scrollMargin,
  })
  const setExpandedSegmentOverride = useCallback((groupId: string, segmentIds: string[]) => {
    const nextIds = segmentIds.toSorted()
    setSegmentExpansionOverrides((current) => {
      const hasCurrentOverride = Object.prototype.hasOwnProperty.call(current, groupId)
      const currentIds = hasCurrentOverride ? current[groupId] : EMPTY_STRING_ARRAY
      if (
        hasCurrentOverride &&
        currentIds.length === nextIds.length &&
        currentIds.every((id, index) => id === nextIds[index])
      ) {
        return current
      }
      return { ...current, [groupId]: nextIds }
    })
  }, [])

  useLayoutEffect(() => {
    virtualizer.measure()
  }, [columns, estimatedTileHeight, groupMeasurementSignature, virtualizer])

  useEffect(() => {
    const groupIds = new Set(groups.map((entry) => entry.group.id))
    setSegmentExpansionOverrides((current) => {
      let changed = false
      const next: SegmentExpansionOverrides = {}
      for (const [groupId, ids] of Object.entries(current)) {
        if (!groupIds.has(groupId)) {
          changed = true
          continue
        }
        next[groupId] = ids
      }
      return changed ? next : current
    })
  }, [groups])

  if (groups.length === 0) return null

  return (
    <div className="photo-flow-virtual" ref={setContainerNode}>
      <div className="photo-flow-virtual__spacer" style={{ height: virtualizer.getTotalSize() }}>
        {virtualizer.getVirtualItems().map((virtualRow) => {
          const entry = groups[virtualRow.index]
          if (!entry) return null
          const segments = segmentsByGroup[virtualRow.index] ?? EMPTY_SEGMENTS
          return (
            <VirtualizedPhotoGroupRow
              entry={entry}
              expandedSegmentOverride={segmentExpansionOverrides[entry.group.id]}
              focusedPhotoId={focusedPhotoId}
              key={virtualRow.key}
              onExpandedSegmentIdsChange={setExpandedSegmentOverride}
              onFocusPhoto={onFocusPhoto}
              onOpenReview={onOpenReview}
              onThumbnailLoadStatus={onThumbnailLoadStatus}
              scrollMargin={scrollMargin}
              segments={segments}
              t={t}
              virtualizer={virtualizer}
              virtualRow={virtualRow}
            />
          )
        })}
      </div>
    </div>
  )
}

function VirtualizedPhotoGroupRow({
  entry,
  expandedSegmentOverride,
  focusedPhotoId,
  onExpandedSegmentIdsChange,
  onFocusPhoto,
  onOpenReview,
  onThumbnailLoadStatus,
  scrollMargin,
  segments,
  t,
  virtualizer,
  virtualRow,
}: {
  entry: { group: PhotoGroupRecord; photos: PhotoRecord[] }
  expandedSegmentOverride: string[] | undefined
  focusedPhotoId: string | null
  onExpandedSegmentIdsChange: (groupId: string, segmentIds: string[]) => void
  onFocusPhoto: (photoId: string | null) => void
  onOpenReview: (photoId: string) => void
  onThumbnailLoadStatus: (photoId: string, status: ThumbnailLoadStatus) => void
  scrollMargin: number
  segments: PhotoSegment[]
  t: ReturnType<typeof useTranslation>['t']
  virtualizer: Virtualizer<HTMLElement, HTMLDivElement>
  virtualRow: VirtualItem
}) {
  const rowRef = useRef<HTMLDivElement | null>(null)
  const measureFrameRef = useRef<number | null>(null)
  const measureTimeoutRef = useRef<number | null>(null)

  const cancelDeferredMeasure = useCallback(() => {
    if (measureFrameRef.current !== null) {
      window.cancelAnimationFrame(measureFrameRef.current)
      measureFrameRef.current = null
    }
    if (measureTimeoutRef.current !== null) {
      window.clearTimeout(measureTimeoutRef.current)
      measureTimeoutRef.current = null
    }
  }, [])

  const measureRow = useCallback(() => {
    const node = rowRef.current
    if (!node) return
    virtualizer.measureElement(node)
    cancelDeferredMeasure()
    measureFrameRef.current = window.requestAnimationFrame(() => {
      measureFrameRef.current = null
      if (rowRef.current) virtualizer.measureElement(rowRef.current)
    })
    measureTimeoutRef.current = window.setTimeout(() => {
      measureTimeoutRef.current = null
      if (rowRef.current) virtualizer.measureElement(rowRef.current)
    }, 120)
  }, [cancelDeferredMeasure, virtualizer])

  const setRowNode = useCallback(
    (node: HTMLDivElement | null) => {
      rowRef.current = node
      virtualizer.measureElement(node)
    },
    [virtualizer],
  )

  useEffect(() => cancelDeferredMeasure, [cancelDeferredMeasure])

  return (
    <div
      className="photo-flow-virtual__item"
      data-index={virtualRow.index}
      ref={setRowNode}
      style={{ transform: `translateY(${virtualRow.start - scrollMargin}px)` }}
    >
      <PhotoGroup
        expandedSegmentOverride={expandedSegmentOverride}
        focusedPhotoId={focusedPhotoId}
        group={entry.group}
        onExpandedSegmentIdsChange={onExpandedSegmentIdsChange}
        onLayoutChange={measureRow}
        onFocusPhoto={onFocusPhoto}
        onOpenReview={onOpenReview}
        onThumbnailLoadStatus={onThumbnailLoadStatus}
        photos={entry.photos}
        segments={segments}
        t={t}
      />
    </div>
  )
}

export function VirtualizedPhotoGrid({
  focusedPhotoId,
  onFocusPhoto,
  onOpenReview,
  onThumbnailLoadStatus,
  photos,
  scrollElement,
  t,
}: {
  focusedPhotoId: string | null
  onFocusPhoto: (photoId: string | null) => void
  onOpenReview: (photoId: string) => void
  onThumbnailLoadStatus: (photoId: string, status: ThumbnailLoadStatus) => void
  photos: PhotoRecord[]
  scrollElement: HTMLElement | null
  t: ReturnType<typeof useTranslation>['t']
}) {
  const containerRef = useRef<HTMLDivElement | null>(null)
  const [containerElement, setContainerElement] = useState<HTMLDivElement | null>(null)
  const setContainerNode = useCallback((node: HTMLDivElement | null) => {
    containerRef.current = node
    setContainerElement(node)
  }, [])
  const gridLayout = useResponsiveGridLayout(
    containerElement,
    PHOTO_GRID_MIN_COLUMN_WIDTH,
    PHOTO_GRID_GAP,
  )
  const columns = gridLayout.columns
  const scrollMargin = useVirtualScrollMargin(containerRef, scrollElement)
  const rows = useMemo(() => {
    const nextRows: PhotoRecord[][] = []
    for (let start = 0; start < photos.length; start += columns) {
      nextRows.push(photos.slice(start, start + columns))
    }
    return nextRows
  }, [columns, photos])
  const estimatedRowHeight = useMemo(() => {
    const tileWidth = Math.max(
      PHOTO_GRID_MIN_COLUMN_WIDTH,
      (gridLayout.width - PHOTO_GRID_GAP * (columns - 1)) / columns,
    )
    return Math.round(tileWidth * 0.75 + PHOTO_GRID_GAP)
  }, [columns, gridLayout.width])
  const virtualizer = useVirtualizer<HTMLElement, HTMLDivElement>({
    count: rows.length,
    getItemKey: (index) => rows[index]?.[0]?.id ?? index,
    getScrollElement: () => scrollElement,
    estimateSize: () => estimatedRowHeight,
    overscan: 5,
    scrollMargin,
  })

  useLayoutEffect(() => {
    virtualizer.measure()
  }, [columns, estimatedRowHeight, rows, virtualizer])

  if (photos.length === 0) return null

  return (
    <div className="photo-grid-virtual" ref={setContainerNode}>
      <div className="photo-grid-virtual__spacer" style={{ height: virtualizer.getTotalSize() }}>
        {virtualizer.getVirtualItems().map((virtualRow) => {
          const rowPhotos = rows[virtualRow.index] ?? EMPTY_PHOTOS
          return (
            <div
              className="photo-grid photo-grid--virtual-row"
              data-index={virtualRow.index}
              key={virtualRow.key}
              ref={virtualizer.measureElement}
              style={{
                ...virtualGridStyle(columns),
                transform: `translateY(${virtualRow.start - scrollMargin}px)`,
              }}
            >
              {rowPhotos.map((photo) => (
                <PhotoTile
                  focused={focusedPhotoId === photo.id}
                  key={photo.id}
                  onFocusPhoto={onFocusPhoto}
                  onOpenReview={onOpenReview}
                  onThumbnailLoadStatus={onThumbnailLoadStatus}
                  photo={photo}
                  t={t}
                />
              ))}
            </div>
          )
        })}
      </div>
    </div>
  )
}

function PhotoGroup({
  expandedSegmentOverride,
  focusedPhotoId,
  group,
  onExpandedSegmentIdsChange,
  onLayoutChange,
  onFocusPhoto,
  onOpenReview,
  onThumbnailLoadStatus,
  photos,
  segments,
  t,
}: {
  expandedSegmentOverride: string[] | undefined
  focusedPhotoId: string | null
  group: PhotoGroupRecord
  onExpandedSegmentIdsChange: (groupId: string, segmentIds: string[]) => void
  onLayoutChange: () => void
  onFocusPhoto: (photoId: string | null) => void
  onOpenReview: (photoId: string) => void
  onThumbnailLoadStatus: (photoId: string, status: ThumbnailLoadStatus) => void
  photos: PhotoRecord[]
  segments: PhotoSegment[]
  t: ReturnType<typeof useTranslation>['t']
}) {
  const expandedSegmentIds = useMemo(
    () => resolveExpandedSegmentIdsForSegments(segments, expandedSegmentOverride),
    [expandedSegmentOverride, segments],
  )
  const segmentSignature = useMemo(
    () => segments.map((segment) => segment.id).join('|'),
    [segments],
  )
  const bestPhoto = useMemo(() => bestPhotoForStack(photos), [photos])
  const bestScore = bestPhoto?.finalScore ?? null
  const title = useMemo(() => visibleGroupTitle(group, photos.length, t), [group, photos.length, t])
  const onLayoutChangeRef = useRef(onLayoutChange)
  const expandedSegmentKey = useMemo(
    () => Array.from(expandedSegmentIds).toSorted().join('|'),
    [expandedSegmentIds],
  )

  useLayoutEffect(() => {
    onLayoutChangeRef.current = onLayoutChange
  }, [onLayoutChange])

  useLayoutEffect(() => {
    onLayoutChangeRef.current()
  }, [expandedSegmentKey, group.id, segmentSignature])

  const expandStack = useCallback(
    (segment: PhotoSegment) => {
      if (expandedSegmentIds.has(segment.id)) return
      const next = new Set(expandedSegmentIds)
      next.add(segment.id)
      onExpandedSegmentIdsChange(group.id, Array.from(next))
    },
    [expandedSegmentIds, group.id, onExpandedSegmentIdsChange],
  )

  const collapseStack = useCallback(
    (segment: PhotoSegment) => {
      if (!expandedSegmentIds.has(segment.id)) return
      const next = new Set(expandedSegmentIds)
      next.delete(segment.id)
      onExpandedSegmentIdsChange(group.id, Array.from(next))
    },
    [expandedSegmentIds, group.id, onExpandedSegmentIdsChange],
  )

  return (
    <section className="photo-group">
      <div className="photo-group__header">
        <div>
          {/* "记录片" 这种 sceneTag SectionLabel 对每个 group 都是同一个固定值,
              没承载任何区分性信息,纯视觉噪音,删掉。如果未来有 sceneTag 实际多
              态(精彩瞬间 / 罕见物种 / 等),再回来加。 */}
          <h2 className="photo-group__title">
            <span className="photo-group__title-text">{title}</span>
            {group.containsNewSpecies ? (
              <span className="chip chip--new-species photo-group__new-species">
                {t('selection.quickFilters.new_species')}
              </span>
            ) : null}
          </h2>
          <p>
            {photos.length} {t('selection.group.photos')}
            {bestScore !== null
              ? ` · ${t('selection.group.bestScore')} ${formatScore(bestScore)}`
              : ''}
          </p>
        </div>
      </div>
      <PhotoSegmentGrid
        expandedSegmentIds={expandedSegmentIds}
        focusedPhotoId={focusedPhotoId}
        group={group}
        onCollapseSegment={collapseStack}
        onExpandSegment={expandStack}
        onFocusPhoto={onFocusPhoto}
        onOpenReview={onOpenReview}
        onThumbnailLoadStatus={onThumbnailLoadStatus}
        segments={segments}
        t={t}
      />
    </section>
  )
}

function PhotoSegmentGrid({
  expandedSegmentIds,
  focusedPhotoId,
  group,
  onExpandSegment,
  onCollapseSegment,
  onFocusPhoto,
  onOpenReview,
  onThumbnailLoadStatus,
  segments,
  t,
}: {
  expandedSegmentIds: Set<string>
  focusedPhotoId: string | null
  group: PhotoGroupRecord
  onExpandSegment: (segment: PhotoSegment) => void
  onCollapseSegment: (segment: PhotoSegment) => void
  onFocusPhoto: (photoId: string | null) => void
  onOpenReview: (photoId: string) => void
  onThumbnailLoadStatus: (photoId: string, status: ThumbnailLoadStatus) => void
  segments: PhotoSegment[]
  t: ReturnType<typeof useTranslation>['t']
}) {
  const renderTile = (photo: PhotoRecord, stackCollapse?: StackCollapseControl) => (
    <PhotoTile
      focused={focusedPhotoId === photo.id}
      key={photo.id}
      onFocusPhoto={onFocusPhoto}
      onOpenReview={onOpenReview}
      onThumbnailLoadStatus={onThumbnailLoadStatus}
      photo={photo}
      stackCollapse={stackCollapse}
      t={t}
    />
  )
  const hasStackSegments = segments.some((segment) => segment.photos.length > 1)
  const visibleSegments = hasStackSegments
    ? segments.filter((segment) => segment.photos.length > 1)
    : segments

  return (
    <div className="photo-grid">
      {visibleSegments.map((segment) => {
        if (!hasStackSegments) return segment.photos.map((photo) => renderTile(photo))

        const isStack = segment.photos.length > 1
        const expanded = expandedSegmentIds.has(segment.id)
        if (isStack && !expanded) {
          return (
            <PhotoStackTile
              focused={segment.photos.some((photo) => photo.id === focusedPhotoId)}
              group={group}
              key={segment.id}
              onExpandSegment={onExpandSegment}
              onFocusPhoto={onFocusPhoto}
              onOpenReview={onOpenReview}
              onThumbnailLoadStatus={onThumbnailLoadStatus}
              segment={segment}
              t={t}
            />
          )
        }

        return segment.photos.map((photo, index) =>
          renderTile(
            photo,
            isStack && expanded && index === 0
              ? {
                  count: segment.photos.length,
                  onCollapse: () => onCollapseSegment(segment),
                }
              : undefined,
          ),
        )
      })}
    </div>
  )
}

// memo:同一 viewport 内 segment/photo 引用稳定,避免滚动或 chrome 状态变化时重复
// 构造 tile 内的大块 JSX。
const PhotoStackTile = memo(function PhotoStackTile({
  focused,
  group,
  onExpandSegment,
  onFocusPhoto,
  onOpenReview,
  onThumbnailLoadStatus,
  segment,
  t,
}: {
  focused: boolean
  group: PhotoGroupRecord
  onExpandSegment: (segment: PhotoSegment) => void
  onFocusPhoto: (photoId: string | null) => void
  onOpenReview: (photoId: string) => void
  onThumbnailLoadStatus: (photoId: string, status: ThumbnailLoadStatus) => void
  segment: PhotoSegment
  t: ReturnType<typeof useTranslation>['t']
}) {
  const photo = segment.coverPhoto
  const photoCount = segment.photos.length
  const category = photoCategory(photo)
  const displaySpecies = group.primarySpecies ?? formatPhotoSpeciesDisplay(photo, t)
  const tileSourceBadge = tileSpeciesSourceBadge(photo, t)

  // 用 div+role="button" 而不是真 <button>,因为内部还要嵌一个真 button(数量
  // badge 触发展开)。HTML 不允许 button 嵌 button(React DEV 模式会 warn,且
  // 某些 a11y 工具栏会读错)。div+role+tabIndex+键盘事件 = 等价交互行为。
  const handleActivate = () => onFocusPhoto(photo.id)
  return (
    <article
      className={cn('photo-tile photo-tile--stack', focused && 'photo-tile--focused')}
      data-photo-id={photo.id}
    >
      <div
        aria-label={t('selection.group.stackAria', { count: photoCount, file: photo.fileName })}
        aria-keyshortcuts="Space"
        className="photo-preview photo-preview--stack"
        data-selection-review-shortcut="true"
        onClick={handleActivate}
        onDoubleClick={() => onOpenReview(photo.id)}
        onKeyDown={(event) => {
          if (event.key === 'Enter') {
            event.preventDefault()
            handleActivate()
            return
          }
          if (event.key === ' ' || event.key === 'Spacebar' || event.code === 'Space') {
            event.preventDefault()
            event.stopPropagation()
            onOpenReview(photo.id)
          }
        }}
        role="button"
        style={{ backgroundImage: photo.placeholderGradient ?? photo.previewGradient }}
        tabIndex={0}
      >
        <span className="photo-stack-pages" aria-hidden="true">
          <span style={{ backgroundImage: photo.previewGradient }} />
          <span style={{ backgroundImage: photo.previewGradient }} />
        </span>
        <ThumbnailImage
          alt={photo.fileName}
          className="photo-preview__image"
          onStatusChange={onThumbnailLoadStatus}
          photoId={photo.id}
          src={photo.thumbGridUrl}
        />
        <span className="photo-preview__top">
          <StatusPill label={t(categoryLabelKey(category))} tone={categoryTone(category)} />
        </span>
        {/* 真 button — 现在外层是 div+role,允许内嵌 button。stopPropagation
            阻止冒泡到外层 div onClick,展开操作不会再触发 focus。 */}
        <button
          aria-label={t('selection.group.expandAria', { count: photoCount })}
          className="photo-stack-action photo-stack-action--expand"
          onClick={(event) => {
            event.stopPropagation()
            event.preventDefault()
            onExpandSegment(segment)
          }}
          title={t('selection.group.expandTooltip', { count: photoCount })}
          type="button"
        >
          <Images className="h-3.5 w-3.5" />
          <span className="photo-stack-action__label">{t('selection.group.stackLabel')}</span>
          <span className="photo-stack-action__count">
            {t('selection.group.stackCount', { count: photoCount })}
          </span>
          <span className="photo-stack-action__hint">{t('common.expand')}</span>
        </button>
        <span className="photo-preview__bottom">
          <span>
            <strong className="photo-preview__species">
              <span>{displaySpecies}</span>
              {photo.isNewSpecies ? (
                <em className="species-source-inline species-source-inline--new">
                  {t('selection.quickFilters.new_species')}
                </em>
              ) : null}
              {tileSourceBadge ? (
                <em
                  className={cn(
                    'species-source-inline',
                    `species-source-inline--${tileSourceBadge.kind}`,
                  )}
                >
                  {t('selection.speciesSource.inline', { source: tileSourceBadge.label })}
                </em>
              ) : null}
            </strong>
            <small>{t('selection.group.stackHint')}</small>
          </span>
          <b>{formatScore(photo.finalScore)}</b>
        </span>
      </div>
    </article>
  )
})

const PhotoTile = memo(function PhotoTile({
  focused,
  onFocusPhoto,
  onOpenReview,
  onThumbnailLoadStatus,
  photo,
  stackCollapse,
  t,
}: {
  focused: boolean
  onFocusPhoto: (photoId: string | null) => void
  onOpenReview: (photoId: string) => void
  onThumbnailLoadStatus: (photoId: string, status: ThumbnailLoadStatus) => void
  photo: PhotoRecord
  stackCollapse?: StackCollapseControl
  t: ReturnType<typeof useTranslation>['t']
}) {
  const category = photoCategory(photo)
  const manual = photo.decision !== null
  // 物种文字 + 来源徽标都走 detection 维度聚合（多鸟图：白鹭 × 2 / 白鹭 + 苍鹭 /
  // 白鹭 等 N 种 / 部分待审）。单鸟图行为与之前一致。
  const displaySpecies = formatPhotoSpeciesDisplay(photo, t)
  const tileSourceBadge = tileSpeciesSourceBadge(photo, t)
  return (
    <article
      className={cn(
        'photo-tile',
        focused && 'photo-tile--focused',
        (photo.analysisStatus === 'pending' || photo.analysisStatus === 'running') &&
          'photo-tile--analyzing',
      )}
      data-photo-id={photo.id}
    >
      <button
        aria-keyshortcuts="Space"
        className="photo-preview"
        data-selection-review-shortcut="true"
        onClick={() => onFocusPhoto(photo.id)}
        onDoubleClick={() => onOpenReview(photo.id)}
        style={{ backgroundImage: photo.placeholderGradient ?? photo.previewGradient }}
        type="button"
      >
        <ThumbnailImage
          alt={photo.fileName}
          className="photo-preview__image"
          onStatusChange={onThumbnailLoadStatus}
          photoId={photo.id}
          src={photo.thumbGridUrl}
        />
        <span className="photo-preview__top">
          {photo.analysisStatus === 'failed' ? (
            <StatusPill
              label={t('selection.analysisStatus.failed')}
              title={analysisErrorTooltip(photo, t)}
              tone="accent"
            />
          ) : photo.analysisStatus === 'pending' || photo.analysisStatus === 'running' ? (
            <StatusPill
              label={t(`selection.analysisStatus.${photo.analysisStatus}`)}
              tone="muted"
            />
          ) : (
            <StatusPill label={t(categoryLabelKey(category))} tone={categoryTone(category)} />
          )}
          {photo.companionFormat ? (
            <StatusPill
              label={t('selection.companion.tile', { format: photo.companionFormat })}
              tone="muted"
            />
          ) : null}
        </span>
        <span className="photo-preview__bottom">
          <span>
            <strong className="photo-preview__species">
              <span>{displaySpecies}</span>
              {photo.isNewSpecies ? (
                <em className="species-source-inline species-source-inline--new">
                  {t('selection.quickFilters.new_species')}
                </em>
              ) : null}
              {tileSourceBadge ? (
                <em
                  className={cn(
                    'species-source-inline',
                    `species-source-inline--${tileSourceBadge.kind}`,
                  )}
                >
                  {t('selection.speciesSource.inline', { source: tileSourceBadge.label })}
                </em>
              ) : null}
            </strong>
            <small>{photo.fileName}</small>
          </span>
          <b>{formatScore(photo.finalScore)}</b>
        </span>
      </button>

      {stackCollapse ? (
        <button
          aria-label={t('selection.group.collapseAria', { count: stackCollapse.count })}
          className="photo-stack-action photo-stack-action--collapse"
          onClick={(event) => {
            event.stopPropagation()
            stackCollapse.onCollapse()
          }}
          title={t('selection.group.collapseTooltip', { count: stackCollapse.count })}
          type="button"
        >
          <Images className="h-3.5 w-3.5" />
          <span className="photo-stack-action__label">{t('selection.group.stackLabel')}</span>
          <span className="photo-stack-action__count">
            {t('selection.group.stackCount', { count: stackCollapse.count })}
          </span>
          <span className="photo-stack-action__hint">{t('common.collapse')}</span>
        </button>
      ) : null}

      <div className="photo-tile__meta">
        <span>
          <StatusDot tone={decisionTone(photo.decision)} />
          {manual
            ? `${t('selection.gradeSource.manual')}：${t(gradeLabelKey(effectivePhotoGrade(photo)))}`
            : `${t('selection.gradeSource.system')}：${t(categoryLabelKey(category))}`}
        </span>
        <span>
          <StatusDot tone={analysisTone(photo.analysisStatus)} />
          {t(`selection.analysisStatus.${photo.analysisStatus}`)}
        </span>
      </div>
    </article>
  )
})

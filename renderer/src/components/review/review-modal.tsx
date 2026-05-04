/**
 * 深度复核弹窗 + 子组件。
 *
 * - ReviewModal：弹窗框架（快捷键、覆盖层 toggle、左右分栏图片、右侧信息+操作）
 * - SpeciesOverrideEditor：人工鸟种修正编辑器（多鸟图按 detection 切换）
 * - ReviewImageStage：单张图片舞台（loupe 放大 / IQA 裁切预览 / bbox + pose + AF 覆盖层）
 * - ReviewFilmstrip：底部横向缩略图滚动条
 * - ScoreHeader / CompactStat / CompactKV / ExifPanel：复核专用紧凑信息子组件
 *
 * 公用 helpers / 公用小组件（IconButton / SectionLabel / TagCluster）目前
 * 反向 import 自 @/App，是从 App.tsx 拆分过程中的过渡状态；后续会迁到独立
 * lib / ui 模块反转 import 方向。
 */

import {
  Check,
  ChevronLeft,
  ChevronRight,
  Clock3,
  Search,
  Sparkles,
  Waypoints,
  X,
} from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import type { useTranslation } from 'react-i18next'

import { ThumbnailImage, type ThumbnailLoadStatus } from '@/components/thumbnail-image'
import {
  IconButton,
  SectionLabel,
  TagCluster,
  effectivePhotoGrade,
  effectiveSpeciesLatinName,
  effectiveSpeciesName,
  formatScore,
  gradeLabelKey,
  legacyAfPointToOverlay,
  photoReviewReason,
  speciesSourceBadge,
  speciesSourceDetail,
  speciesSourceKind,
  speciesSourceTone,
  type ReviewDetail,
} from '@/App'
import type { SpeciesOverrideBBox, SpeciesOverrideValue } from '@/lib/api-client'
import { computeIqaCropBox } from '@/lib/backend-adapter'
import type {
  AfOverlay,
  BirdDetectionRecord,
  PhotoRecord,
  SelectionDecision,
} from '@/lib/mock-workspace'
import { listAllSpecies } from '@/lib/species-wiki'
import { cn } from '@/lib/utils'

export function ReviewModal({
  detail,
  onAddToCompare,
  onClose,
  onSelectPhoto,
  onSetDecision,
  onSetSpeciesOverride,
  onThumbnailLoadStatus,
  photos,
  t,
}: {
  detail: ReviewDetail
  onAddToCompare: (photoId: string) => void
  onClose: () => void
  onSelectPhoto: (photoId: string) => void
  onSetDecision: (photoId: string, decision: SelectionDecision) => void
  onSetSpeciesOverride: (
    photoId: string,
    birdIndex: number,
    species: SpeciesOverrideValue | null,
    bbox?: SpeciesOverrideBBox | null,
  ) => void
  onThumbnailLoadStatus: (photoId: string, status: ThumbnailLoadStatus) => void
  photos: PhotoRecord[]
  t: ReturnType<typeof useTranslation>['t']
}) {
  const { photo, group } = detail
  // 覆盖层分工：检测框 / 对焦区域在原图上看全局位置；姿态点保留在 IQA 裁切图上看细节。
  const [showBbox, setShowBbox] = useState(true)
  const [showPose, setShowPose] = useState(false)
  const [showAfPoint, setShowAfPoint] = useState(true)

  const imgW = photo.imageWidth ?? null
  const imgH = photo.imageHeight ?? null
  const aspect = imgW && imgH && imgW > 0 && imgH > 0 ? imgW / imgH : null

  // Active bird index（多鸟图切换鸟时驱动 bbox / pose / IQA 裁切跟随变动）。
  // 默认值是 best detection 的 index；photo 切换时 reset。state 提升到 ReviewModal
  // 是因为 SpeciesOverrideEditor 改 activeIndex 后，左侧 ReviewImageStage 也要响应。
  // useMemo 依赖直接走 photo.birdDetections（稳定 prop ref），不走 `?? []` 派生值
  // — 派生 `[]` 每次 render 是新引用，会让 memo 永远 miss。
  const bestDetectionIndex = useMemo(() => {
    const dets = photo.birdDetections ?? []
    const best = dets.find((d) => d.isBest)
    return best?.index ?? dets[0]?.index ?? 0
  }, [photo.birdDetections])
  const [activeBirdIndex, setActiveBirdIndex] = useState<number>(bestDetectionIndex)
  useEffect(() => {
    setActiveBirdIndex(bestDetectionIndex)
  }, [photo.id, bestDetectionIndex])

  const activeBird = useMemo(
    () => (photo.birdDetections ?? []).find((d) => d.index === activeBirdIndex) ?? null,
    [photo.birdDetections, activeBirdIndex],
  )

  // bbox / pose 优先用 activeBird 的，fallback 到 photo-level 兼容老数据 / 单鸟无 detections 数组场景
  const bbox = activeBird?.bbox ?? photo.bestBbox ?? null
  const pose = activeBird?.pose ?? photo.bestPose ?? null
  // AF 覆盖层是 photo-level（机身只写一份 EXIF AFInfo，不分鸟），切换 activeBird 不影响。
  // Canon 官方语义中，单点 / 扩展 / Zone / Whole area 的呈现不同。
  // 新数据使用结构化 af_area；旧数据退回 legacy af_point。
  const afOverlay = photo.bestAfArea ?? legacyAfPointToOverlay(photo.bestAfPoint ?? null)

  const previewSrc = photo.thumbPreviewUrl ?? null
  const activeIndex = photos.findIndex((item) => item.id === photo.id)
  const canGoPrevious = activeIndex > 0
  const canGoNext = activeIndex >= 0 && activeIndex < photos.length - 1

  const selectRelativePhoto = useCallback(
    (offset: -1 | 1) => {
      if (activeIndex < 0) return
      const nextIndex = Math.max(0, Math.min(photos.length - 1, activeIndex + offset))
      const nextPhoto = photos[nextIndex]
      if (!nextPhoto || nextPhoto.id === photo.id) return
      onSelectPhoto(nextPhoto.id)
    },
    [activeIndex, onSelectPhoto, photo.id, photos],
  )

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      const target = event.target
      if (
        target instanceof HTMLInputElement ||
        target instanceof HTMLTextAreaElement ||
        target instanceof HTMLSelectElement ||
        (target instanceof HTMLElement && target.isContentEditable)
      ) {
        return
      }

      if (event.key === 'Escape') {
        event.preventDefault()
        onClose()
        return
      }
      if (event.key === 'ArrowLeft') {
        event.preventDefault()
        selectRelativePhoto(-1)
        return
      }
      if (event.key === 'ArrowRight') {
        event.preventDefault()
        selectRelativePhoto(1)
        return
      }
      if (event.metaKey || event.ctrlKey || event.altKey) return
      if (event.key === '1') {
        event.preventDefault()
        onSetDecision(photo.id, 'select')
        return
      }
      if (event.key === '2') {
        event.preventDefault()
        onSetDecision(photo.id, 'usable')
        return
      }
      if (event.key === '3') {
        event.preventDefault()
        onSetDecision(photo.id, 'record')
        return
      }
      if (event.key === '4') {
        event.preventDefault()
        onSetDecision(photo.id, 'reject')
        return
      }
      if (event.key.toLowerCase() === 'c') {
        event.preventDefault()
        onAddToCompare(photo.id)
      }
    }

    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [onAddToCompare, onClose, onSetDecision, photo.id, selectRelativePhoto])

  // IQA 裁切框（与后端 expand_for_iqa 一致：2.5× + 比例约束 + cap + shift）
  const iqaCrop = useMemo(() => {
    if (!bbox || !imgW || !imgH) return null
    return computeIqaCropBox(imgW, imgH, bbox)
  }, [bbox, imgW, imgH])

  return (
    <div
      className="overlay-backdrop"
      onPointerDown={(event) => {
        if (event.target === event.currentTarget) onClose()
      }}
    >
      <div className="review-panel" onPointerDown={(event) => event.stopPropagation()}>
        <div className="review-stage">
          <div className="modal-heading review-heading">
            <div>
              <SectionLabel label={t('selection.review.label')} />
              <h2>{photo.fileName}</h2>
            </div>
            <div className="review-heading__switcher">
              <IconButton
                ariaKeyShortcuts="ArrowLeft"
                disabled={!canGoPrevious}
                label={t('selection.review.previous')}
                onClick={() => selectRelativePhoto(-1)}
              >
                <ChevronLeft className="h-4 w-4" />
              </IconButton>
              <span className="review-heading__count">
                {activeIndex >= 0 ? activeIndex + 1 : 1}/{Math.max(photos.length, 1)}
              </span>
              <IconButton
                ariaKeyShortcuts="ArrowRight"
                disabled={!canGoNext}
                label={t('selection.review.next')}
                onClick={() => selectRelativePhoto(1)}
              >
                <ChevronRight className="h-4 w-4" />
              </IconButton>
              <IconButton
                ariaKeyShortcuts="Escape"
                className="review-panel__close"
                label={t('common.close')}
                onClick={onClose}
              >
                <X className="h-4 w-4" />
              </IconButton>
            </div>
          </div>

          {/* 覆盖层 toggle 行 */}
          <div className="review-toggles">
            <label className="review-toggle">
              <input
                type="checkbox"
                checked={showBbox}
                onChange={(e) => setShowBbox(e.target.checked)}
              />
              <span>{t('selection.review.toggleBbox')}</span>
            </label>
            <label className="review-toggle">
              <input
                type="checkbox"
                checked={showPose}
                onChange={(e) => setShowPose(e.target.checked)}
              />
              <span>{t('selection.review.togglePose')}</span>
            </label>
            <label className="review-toggle">
              <input
                type="checkbox"
                checked={showAfPoint}
                onChange={(e) => setShowAfPoint(e.target.checked)}
                disabled={afOverlay === null}
              />
              <span>
                {t('selection.review.toggleAfPoint')}
                {afOverlay === null ? t('selection.review.afPointUnknown') : ''}
              </span>
            </label>
          </div>

          <div className="review-stage__images">
            <ReviewImageStage
              label={t('selection.review.original')}
              hint={t('selection.review.originalHint')}
              previewSrc={previewSrc}
              fallbackGradient={photo.previewGradient}
              aspect={aspect}
              imgW={imgW}
              imgH={imgH}
              bbox={showBbox ? bbox : null}
              pose={null}
              afOverlay={showAfPoint ? afOverlay : null}
              photoId={photo.id}
              loupeEnabled
              cropRect={null}
              variant="primary"
            />
            <ReviewImageStage
              label={t('selection.review.iqaCrop')}
              hint={
                iqaCrop ? t('selection.review.cropHint') : t('selection.review.cropNeedsSubject')
              }
              previewSrc={previewSrc}
              fallbackGradient={photo.previewGradient}
              aspect={aspect}
              imgW={imgW}
              imgH={imgH}
              bbox={null}
              pose={showPose ? pose : null}
              afOverlay={null}
              photoId={photo.id}
              loupeEnabled={false}
              cropRect={iqaCrop}
              variant="crop"
            />
          </div>
        </div>

        <aside className="review-detail review-detail--compact">
          {/* 顶部：分数 + 物种 + 分级 */}
          <ScoreHeader
            photo={photo}
            activeBird={activeBird}
            totalBirds={photo.birdDetections?.length ?? 0}
            t={t}
          />

          {/* 关键指标紧凑网格 */}
          <div className="review-stats-grid">
            <CompactStat
              label={t('selection.metrics.semanticScore')}
              value={formatScore(photo.semanticScore)}
            />
            <CompactStat
              label={t('selection.metrics.technicalScore')}
              value={formatScore(photo.technicalScore)}
            />
            <CompactStat
              label={t('selection.metrics.head')}
              value={pose ? (pose.head_visible ? '✓' : '✗') : '--'}
              tone={pose ? (pose.head_visible ? 'ok' : 'warn') : 'muted'}
            />
            <CompactStat
              label={t('selection.metrics.eye')}
              value={pose ? (pose.eye_visible ? '✓' : '✗') : '--'}
              tone={pose ? (pose.eye_visible ? 'ok' : 'warn') : 'muted'}
            />
            <CompactStat
              label={t('selection.metrics.birdCount')}
              value={String(photo.birdCount ?? 0)}
            />
            <CompactStat
              label={t('selection.metrics.confidence')}
              value={bbox ? `${Math.round((bbox.confidence ?? 0) * 100)}%` : '--'}
            />
          </div>

          <CompactKV label={t('selection.metrics.scene')} value={group?.title ?? '--'} />

          {photo.companionFormat && photo.companionPath ? (
            <CompactKV
              label={t('selection.review.companion')}
              value={t('selection.review.companionValue', {
                format: photo.companionFormat,
                size: formatBytes(photo.companionSize ?? 0),
              })}
            />
          ) : null}

          <SpeciesOverrideEditor
            activeBirdIndex={activeBirdIndex}
            onSetActiveBirdIndex={setActiveBirdIndex}
            onSetSpeciesOverride={onSetSpeciesOverride}
            photo={photo}
            t={t}
          />

          <ExifPanel exif={photo.exif} t={t} />

          <p className="review-reason">{t(photoReviewReason(photo))}</p>
          <TagCluster photo={photo} t={t} />

          <div className="review-shortcuts" aria-label={t('selection.review.shortcutsLabel')}>
            <span>{t('selection.review.shortcuts.grade')}</span>
            <kbd>1</kbd>
            <b>{t('selection.actions.select')}</b>
            <kbd>2</kbd>
            <b>{t('selection.actions.usable')}</b>
            <kbd>3</kbd>
            <b>{t('selection.actions.record')}</b>
            <kbd>4</kbd>
            <b>{t('selection.actions.reject')}</b>
            <span>{t('selection.review.shortcuts.nav')}</span>
            <kbd>←</kbd>
            <kbd>→</kbd>
            <kbd>Esc</kbd>
          </div>

          <div className="inspector-actions inspector-actions--compact">
            <button
              className="button-primary"
              onClick={() => onSetDecision(photo.id, 'select')}
              type="button"
            >
              <Sparkles className="h-4 w-4" />
              {t('selection.actions.select')}
            </button>
            <button
              className="button-ghost"
              onClick={() => onSetDecision(photo.id, 'usable')}
              type="button"
            >
              <Check className="h-4 w-4" />
              {t('selection.actions.usable')}
            </button>
            <button
              className="button-ghost"
              onClick={() => onSetDecision(photo.id, 'record')}
              type="button"
            >
              <Clock3 className="h-4 w-4" />
              {t('selection.actions.record')}
            </button>
            <button
              className="button-danger"
              onClick={() => onSetDecision(photo.id, 'reject')}
              type="button"
            >
              <X className="h-4 w-4" />
              {t('selection.actions.reject')}
            </button>
            <button className="button-ghost" onClick={() => onAddToCompare(photo.id)} type="button">
              <Waypoints className="h-4 w-4" />
              {t('selection.actions.compare')}
            </button>
          </div>
        </aside>

        <ReviewFilmstrip
          activePhotoId={photo.id}
          onThumbnailLoadStatus={onThumbnailLoadStatus}
          onSelectPhoto={onSelectPhoto}
          photos={photos}
          t={t}
        />
      </div>
    </div>
  )
}

type SpeciesOption = ReturnType<typeof listAllSpecies>[number]

function SpeciesOverrideEditor({
  activeBirdIndex,
  onSetActiveBirdIndex,
  onSetSpeciesOverride,
  photo,
  t,
}: {
  activeBirdIndex: number
  onSetActiveBirdIndex: (index: number) => void
  onSetSpeciesOverride: (
    photoId: string,
    birdIndex: number,
    species: SpeciesOverrideValue | null,
    bbox?: SpeciesOverrideBBox | null,
  ) => void
  photo: PhotoRecord
  t: ReturnType<typeof useTranslation>['t']
}) {
  const birds = useMemo(() => {
    if (photo.birdDetections && photo.birdDetections.length > 0) {
      return photo.birdDetections
    }
    if (!photo.bestBbox) return []
    return [
      {
        index: 0,
        bbox: photo.bestBbox,
        speciesName: photo.speciesName,
        speciesLatinName: photo.speciesLatinName,
        speciesCandidates: photo.speciesCandidates,
        manualSpecies: Boolean(photo.manualSpecies),
        isBest: true,
      },
    ]
  }, [photo])
  // activeBirdIndex 由 ReviewModal 维护（提升后）— 切换鸟时左侧 bbox/pose/裁切跟随。
  // 本组件只负责 query 局部 state + 在 photo 切换时清空搜索框。
  const [query, setQuery] = useState('')
  const allSpecies = useMemo(() => listAllSpecies(), [])

  useEffect(() => {
    setQuery('')
  }, [photo.id])

  const activeBird = birds.find((bird) => bird.index === activeBirdIndex) ?? birds[0] ?? null
  const modelOptions = useMemo(() => {
    if (!activeBird) return []
    const byLatin = new Set<string>()
    const options: SpeciesOption[] = []
    for (const candidate of activeBird.speciesCandidates) {
      const latin = candidate.latinName
      if (!latin || byLatin.has(latin)) continue
      const option = allSpecies.find((item) => item.canonical_sci === latin)
      if (option) {
        options.push(option)
        byLatin.add(latin)
      }
    }
    return options
  }, [activeBird, allSpecies])

  const filteredOptions = useMemo(() => {
    const q = query.trim().toLowerCase()
    const source = q ? allSpecies : modelOptions.length > 0 ? modelOptions : allSpecies
    const filtered = q
      ? source.filter((item) => {
          const fields = [
            item.canonical_sci,
            item.canonical_zh,
            item.canonical_en,
            item.zh_title,
            item.en_title,
            item.family_zh,
            item.family_sci,
          ]
          return fields.some((field) => field?.toLowerCase().includes(q))
        })
      : source
    return filtered.slice(0, 8)
  }, [allSpecies, modelOptions, query])

  if (!activeBird) return null

  const currentName =
    activeBird.speciesName ??
    (activeBird.speciesCandidates[0]?.name || t('selection.photo.unidentified'))

  return (
    <div className="species-editor">
      <div className="species-editor__head">
        <SectionLabel label={t('selection.review.species')} />
        {activeBird.manualSpecies ? (
          <span className="species-editor__manual">{t('selection.speciesEditor.manual')}</span>
        ) : null}
      </div>

      {birds.length > 1 ? (
        <div className="species-editor__birds" role="tablist">
          {birds.map((bird) => (
            <button
              className={cn(
                'species-editor__bird',
                bird.index === activeBird.index && 'species-editor__bird--active',
              )}
              key={`${photo.id}-bird-${bird.index}`}
              onClick={() => onSetActiveBirdIndex(bird.index)}
              type="button"
            >
              {t('selection.speciesEditor.bird')} {bird.index + 1}
            </button>
          ))}
        </div>
      ) : null}

      <div className="species-editor__current">
        <strong>{currentName}</strong>
        <small>{activeBird.speciesLatinName ?? t('selection.speciesEditor.noLatin')}</small>
      </div>

      {/* 按 activeBird.speciesSource 判断（v6 detection-level）— 多鸟图混合可见性
          下，每个 detection 独立判断按钮显隐，不被 photo-level 一刀切。
          老数据 fallback：activeBird.speciesSource undefined 时退回 photo.speciesSource。 */}
      {(activeBird.speciesSource === 'model_unconfirmed' ||
        (activeBird.speciesSource === undefined &&
          photo.speciesSource === 'model_unconfirmed')) &&
      !activeBird.manualSpecies &&
      activeBird.speciesLatinName ? (
        <button
          className="species-editor__confirm"
          onClick={() =>
            onSetSpeciesOverride(
              photo.id,
              activeBird.index,
              {
                canonical_sci: activeBird.speciesLatinName!,
                canonical_zh: activeBird.speciesName ?? null,
                canonical_en: activeBird.speciesEnglishName ?? null,
              },
              activeBird.bbox
                ? {
                    x1: activeBird.bbox.x1,
                    y1: activeBird.bbox.y1,
                    x2: activeBird.bbox.x2,
                    y2: activeBird.bbox.y2,
                  }
                : null,
            )
          }
          title={t('selection.speciesEditor.confirmModelHint')}
          type="button"
        >
          <Check className="h-3.5 w-3.5" />
          {t('selection.speciesEditor.confirmModel')}
        </button>
      ) : null}

      <div className="species-editor__search">
        <Search className="h-3.5 w-3.5" />
        <input
          aria-label={t('selection.speciesEditor.search')}
          onChange={(event) => setQuery(event.target.value)}
          placeholder={t('selection.speciesEditor.search')}
          value={query}
        />
      </div>

      <div className="species-editor__options">
        {filteredOptions.map((option) => {
          const label = option.canonical_zh ?? option.canonical_en ?? option.canonical_sci
          const isCurrent = option.canonical_sci === activeBird.speciesLatinName
          return (
            <button
              className={cn(
                'species-editor__option',
                isCurrent && 'species-editor__option--active',
              )}
              key={`${photo.id}-${activeBird.index}-${option.canonical_sci}`}
              onClick={() => {
                onSetSpeciesOverride(
                  photo.id,
                  activeBird.index,
                  {
                    canonical_sci: option.canonical_sci,
                    canonical_zh: option.canonical_zh,
                    canonical_en: option.canonical_en,
                  },
                  activeBird.bbox
                    ? {
                        x1: activeBird.bbox.x1,
                        y1: activeBird.bbox.y1,
                        x2: activeBird.bbox.x2,
                        y2: activeBird.bbox.y2,
                      }
                    : null,
                )
                setQuery('')
              }}
              type="button"
            >
              <span>
                <strong>{label}</strong>
                <small>{option.canonical_sci}</small>
              </span>
              <b>
                {option.is_trained
                  ? t('selection.speciesEditor.auto')
                  : t('selection.speciesEditor.manualOnly')}
              </b>
            </button>
          )
        })}
      </div>

      <button
        className="species-editor__clear"
        disabled={!activeBird.manualSpecies}
        onClick={() =>
          onSetSpeciesOverride(
            photo.id,
            activeBird.index,
            null,
            activeBird.bbox
              ? {
                  x1: activeBird.bbox.x1,
                  y1: activeBird.bbox.y1,
                  x2: activeBird.bbox.x2,
                  y2: activeBird.bbox.y2,
                }
              : null,
          )
        }
        type="button"
      >
        {t('selection.speciesEditor.clear')}
      </button>
    </div>
  )
}

/**
 * 单独的图片舞台组件：
 * - cropRect 为 null → 显示完整原图（支持 loupe 按住放大）
 * - cropRect 给定 → 用 background-position/size 缩放出该区域（IQA 裁切预览，不做 loupe）
 *
 * Loupe 交互：
 *   mousedown 切到放大模式 → 跟随鼠标平移
 *   mouseup / mouseleave 还原
 *   放大倍数 = 2.5×（与 IQA expand 一致，方便对比）
 */
function ReviewImageStage({
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
  variant,
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
  variant: 'primary' | 'crop'
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
  const LOUPE_SCALE = 2.5

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

  const handlePointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!loupeEnabled || !previewSrc) return
    e.preventDefault()
    const rect = e.currentTarget.getBoundingClientRect()
    const xPct = ((e.clientX - rect.left) / rect.width) * 100
    const yPct = ((e.clientY - rect.top) / rect.height) * 100
    setLoupePos({ xPct, yPct })
    setLoupeActive(true)
    e.currentTarget.setPointerCapture(e.pointerId)
  }
  const handlePointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!loupeActive) return
    const rect = e.currentTarget.getBoundingClientRect()
    const xPct = ((e.clientX - rect.left) / rect.width) * 100
    const yPct = ((e.clientY - rect.top) / rect.height) * 100
    setLoupePos({
      xPct: Math.max(0, Math.min(100, xPct)),
      yPct: Math.max(0, Math.min(100, yPct)),
    })
  }
  const handlePointerEnd = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!loupeActive) return
    setLoupeActive(false)
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

  const fittedSize = useMemo<React.CSSProperties>(() => {
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

  // 算 background：裁切图等比放大显示 cropRect；否则按 contain（普通预览）或 loupe
  const cropStyle = useMemo<React.CSSProperties>(() => {
    if (!previewSrc) return {}
    if (cropRect && imgW && imgH) {
      // 显示 cropRect 内容：容器本身保持 cropRect 比例，背景只按一个轴等比缩放。
      const cw = cropRect.x2 - cropRect.x1
      const ch = cropRect.y2 - cropRect.y1
      if (cw <= 0 || ch <= 0) return {}
      const sizeX = (imgW / cw) * 100
      // background-position 百分比：(crop 中心 / (原图 - crop)) * 100
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
        backgroundSize: `${LOUPE_SCALE * 100}% auto`,
        backgroundRepeat: 'no-repeat',
      }
    }
    return {
      backgroundImage: `url("${previewSrc}")`,
      backgroundPosition: 'center',
      backgroundSize: 'contain',
      backgroundRepeat: 'no-repeat',
    }
  }, [previewSrc, cropRect, imgW, imgH, loupeActive, loupePos.xPct, loupePos.yPct])

  // 计算覆盖层在该 stage 上的相对百分比
  // - 完整图模式：直接 bbox/pose / 原图尺寸
  // - 裁切模式：先转换到 cropRect 局部坐标，再 / cropRect 尺寸
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
      return { left: (x / imgW) * 100, top: (y / imgH) * 100 }
    }

    const overlays: ReactNode[] = []
    // bbox（黄色高亮，IQA 裁切图上更显眼）
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
    // pose 关键点
    if (pose) {
      const keys = ['bill', 'crown', 'nape', 'left_eye', 'right_eye'] as const
      for (const key of keys) {
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
    }
    // AF 覆盖层：按 Canon 官方 AF area 语义渲染。
    // point = 单点；expanded/zone/whole_area = 区域框 + 实际合焦点。
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
              title="对焦区域"
            />,
          )
        }
      }

      const focusPoints =
        afOverlay.focused_points && afOverlay.focused_points.length > 0
          ? afOverlay.focused_points
          : afOverlay.points && afOverlay.points.length > 0
            ? afOverlay.points
            : [afOverlay.center]

      for (const [index, point] of focusPoints.entries()) {
        const p = toLocalPoint(point.x, point.y)
        if (!p) continue
        overlays.push(
          <span
            className={cn('af-point', afOverlay.kind !== 'point' && 'af-point--mini')}
            key={`af-point-${index}`}
            style={{ left: `${p.left}%`, top: `${p.top}%` }}
            title={afOverlay.kind === 'point' ? '对焦点' : '合焦点'}
          />,
        )
      }
    }
    return overlays
  }

  return (
    <div className="review-stage__pane">
      <div className="review-stage__head">
        <span className="review-stage__label">{label}</span>
        <span className="review-stage__hint">{hint}</span>
      </div>
      <div className="review-image-frame" ref={frameRef}>
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
          onLostPointerCapture={() => setLoupeActive(false)}
          data-photo-id={photoId}
        >
          {!loupeActive ? renderOverlays() : null}
        </div>
      </div>
    </div>
  )
}

function ReviewFilmstrip({
  activePhotoId,
  onThumbnailLoadStatus,
  onSelectPhoto,
  photos,
  t,
}: {
  activePhotoId: string
  onThumbnailLoadStatus: (photoId: string, status: ThumbnailLoadStatus) => void
  onSelectPhoto: (photoId: string) => void
  photos: PhotoRecord[]
  t: ReturnType<typeof useTranslation>['t']
}) {
  const activeButtonRef = useRef<HTMLButtonElement | null>(null)

  useEffect(() => {
    activeButtonRef.current?.scrollIntoView({
      behavior: 'smooth',
      block: 'nearest',
      inline: 'center',
    })
  }, [activePhotoId])

  return (
    <footer className="review-filmstrip" aria-label={t('selection.review.filmstripLabel')}>
      <div className="review-filmstrip__track selection-scroll">
        {photos.map((item) => (
          <button
            aria-current={item.id === activePhotoId ? 'true' : undefined}
            className={cn(
              'review-filmstrip__item',
              item.id === activePhotoId && 'review-filmstrip__item--active',
            )}
            key={item.id}
            onClick={() => onSelectPhoto(item.id)}
            ref={item.id === activePhotoId ? activeButtonRef : null}
            style={{ backgroundImage: item.placeholderGradient ?? item.previewGradient }}
            type="button"
          >
            <ThumbnailImage
              alt={item.fileName}
              className="review-filmstrip__image"
              onStatusChange={onThumbnailLoadStatus}
              photoId={item.id}
              src={item.thumbGridUrl}
            />
            <span className="review-filmstrip__shade" />
            <span className="review-filmstrip__meta">
              <strong>{formatScore(item.finalScore)}</strong>
              <small>{item.fileName}</small>
            </span>
          </button>
        ))}
      </div>
    </footer>
  )
}

/** 顶部：大字号分数 + 分级胶囊 + 物种名（颜色按 grade 区分）。
 * 多鸟图深度复核切换鸟时，分数/档位 photo-level 不变，但物种/来源徽标跟随 activeBird。 */
function ScoreHeader({
  photo,
  activeBird,
  totalBirds,
  t,
}: {
  photo: PhotoRecord
  activeBird: BirdDetectionRecord | null
  totalBirds: number
  t: ReturnType<typeof useTranslation>['t']
}) {
  const grade = effectivePhotoGrade(photo)
  const score = photo.finalScore
  // 物种 / 来源 优先 activeBird，fallback photo-level（单鸟图 / 老数据）
  const sourceDetail = speciesSourceDetail(photo, t, activeBird)
  const sourceBadge = speciesSourceBadge(photo, t, activeBird)
  const sourceKind = speciesSourceKind(photo, activeBird)
  const speciesName =
    activeBird?.speciesName ??
    effectiveSpeciesName(photo) ??
    t('selection.photo.unidentified')
  const speciesLatinName = activeBird?.speciesLatinName ?? effectiveSpeciesLatinName(photo)
  // 多鸟图：当前鸟的提示（克制小字，section-label 同级语义）
  const showBirdHint = totalBirds >= 2 && activeBird != null
  return (
    <div className={cn('score-header', `score-header--${grade}`)}>
      {showBirdHint ? (
        <div className="score-header__bird-hint">
          {t('selection.review.activeBirdHint', {
            current: activeBird!.index + 1,
            total: totalBirds,
          })}
        </div>
      ) : null}
      <div className="score-header__score">
        <strong>{formatScore(score)}</strong>
        <span className={cn('grade-pill', `grade-pill--${grade}`)}>{t(gradeLabelKey(grade))}</span>
      </div>
      <div className="score-header__species">
        <span>{speciesName}</span>
        {sourceBadge && sourceKind ? (
          <em className={cn('species-source-inline', `species-source-inline--${sourceKind}`)}>
            {t('selection.speciesSource.inline', { source: sourceBadge })}
          </em>
        ) : null}
        {speciesLatinName ? <em>{speciesLatinName}</em> : null}
      </div>
      {sourceDetail ? (
        <div
          className={cn(
            'score-header__source',
            `score-header__source--${speciesSourceTone(photo, activeBird)}`,
          )}
        >
          {sourceDetail}
        </div>
      ) : null}
    </div>
  )
}

/** 紧凑指标格：1 行 label + value，颜色 tone */
function CompactStat({
  label,
  value,
  tone,
}: {
  label: string
  value: string
  tone?: 'ok' | 'warn' | 'muted'
}) {
  return (
    <div className={cn('compact-stat', tone && `compact-stat--${tone}`)}>
      <span className="compact-stat__label">{label}</span>
      <span className="compact-stat__value">{value}</span>
    </div>
  )
}

/** 字节数 → 人读字符串(MB / GB)。RAW 文件常 30-100 MB,误差 ±0.1 可接受。 */
function formatBytes(bytes: number): string {
  if (bytes <= 0) return '--'
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`
}

/** 紧凑 key-value：单行，标签灰、值白 */
function CompactKV({ label, value }: { label: string; value: string }) {
  return (
    <div className="compact-kv">
      <span className="compact-kv__label">{label}</span>
      <span className="compact-kv__value">{value}</span>
    </div>
  )
}

/** EXIF 信息面板（相机 / 镜头 / 曝光参数） */
function ExifPanel({
  exif,
  t,
}: {
  exif?: Record<string, unknown> | null
  t: ReturnType<typeof useTranslation>['t']
}) {
  if (!exif) return null

  // 格式化辅助
  const fmt = (key: string): string => {
    const v = exif[key]
    if (v === null || v === undefined || v === '') return '--'
    return String(v)
  }
  const fmtShutter = (): string => {
    const t = exif['ExposureTime']
    if (typeof t !== 'number' || t <= 0) return '--'
    if (t >= 1) return `${t.toFixed(1)} s`
    return `1/${Math.round(1 / t)} s`
  }
  const fmtAperture = (): string => {
    const f = exif['FNumber']
    if (typeof f !== 'number' || f <= 0) return '--'
    return `f/${f.toFixed(1)}`
  }
  const fmtFocal = (): string => {
    const f = exif['FocalLength']
    if (typeof f !== 'number' || f <= 0) return '--'
    return `${Math.round(f)} mm`
  }
  const fmtIso = (): string => {
    const v = exif['ISOSpeedRatings']
    if (v === null || v === undefined) return '--'
    if (typeof v === 'number') return `ISO ${v}`
    return `ISO ${v}`
  }

  // Canon 等品牌的 Model 字段已经包含厂商名（"Canon EOS R5m2"），
  // 直接拼 "Make Model" 会出现 "Canon Canon EOS R5m2" 这种重复。
  // 检测：Model 是否以 Make 开头（不区分大小写）→ 是则只用 Model。
  const camera = (() => {
    const make = fmt('Make')
    const model = fmt('Model')
    const safeMake = make === '--' ? '' : make
    const safeModel = model === '--' ? '' : model
    if (!safeMake && !safeModel) return '--'
    if (!safeMake) return safeModel
    if (!safeModel) return safeMake
    if (safeModel.toLowerCase().startsWith(safeMake.toLowerCase())) {
      return safeModel
    }
    return `${safeMake} ${safeModel}`
  })()
  const lens = fmt('LensModel')
  const dt = fmt('DateTimeOriginal') !== '--' ? fmt('DateTimeOriginal') : fmt('DateTime')

  return (
    <div className="exif-panel">
      <SectionLabel label="EXIF" />
      {/* 曝光参数：4 列横排，重点突出 */}
      <div className="exif-exposure">
        <div className="exif-exposure__cell">
          <span className="exif-exposure__label">{t('selection.exif.shutter')}</span>
          <span className="exif-exposure__value">{fmtShutter()}</span>
        </div>
        <div className="exif-exposure__cell">
          <span className="exif-exposure__label">{t('selection.exif.aperture')}</span>
          <span className="exif-exposure__value">{fmtAperture()}</span>
        </div>
        <div className="exif-exposure__cell">
          <span className="exif-exposure__label">ISO</span>
          <span className="exif-exposure__value">{fmtIso()}</span>
        </div>
        <div className="exif-exposure__cell">
          <span className="exif-exposure__label">{t('selection.exif.focalLength')}</span>
          <span className="exif-exposure__value">{fmtFocal()}</span>
        </div>
      </div>
      {/* 机身/镜头/时间：紧凑单行 */}
      <div className="exif-meta">
        <CompactKV label={t('selection.exif.camera')} value={camera} />
        <CompactKV label={t('selection.exif.lens')} value={lens} />
        <CompactKV label={t('selection.exif.time')} value={dt} />
      </div>
    </div>
  )
}

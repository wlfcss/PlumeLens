/**
 * 深度复核弹窗 + 子组件。
 *
 * - ReviewModal：弹窗框架（快捷键、覆盖层 toggle、左右分栏图片、右侧信息+操作）
 * - SpeciesOverrideEditor：人工鸟种修正编辑器（多鸟图按 detection 切换）
 * - ReviewImageStage：单张图片舞台（loupe 放大 / IQA 裁切预览 / bbox + pose + AF 覆盖层）
 * - ReviewFilmstrip：底部横向缩略图滚动条
 * - ScoreHeader / CompactStat / CompactKV / ExifPanel：复核专用紧凑信息子组件
 *
 * 公用 helpers / 小组件已经下沉到 components/common 与 lib/*,避免 review 子树
 * 反向依赖 App.tsx。
 */

import {
  Check,
  ChevronLeft,
  ChevronRight,
  Clock3,
  Columns2,
  Images,
  Sparkles,
  X,
} from 'lucide-react'
import { useVirtualizer } from '@tanstack/react-virtual'
import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from 'react'
import type { useTranslation } from 'react-i18next'

import { IconButton } from '@/components/common/icon-button'
import { SectionLabel } from '@/components/common/section-label'
import { TagCluster } from '@/components/common/tag-cluster'
import { ThumbnailImage, type ThumbnailLoadStatus } from '@/components/thumbnail-image'
import { SpeciesNameAction } from '@/components/species/species-detail-popover'
import { formatBytes } from '@/lib/format-bytes'
import type { SpeciesOverrideBBox, SpeciesOverrideValue } from '@/lib/api-client'
import { computeIqaCropBox } from '@/lib/backend-adapter'
import { gradeLabelKey } from '@/lib/i18n-keys'
import type {
  BirdDetectionRecord,
  PhotoGrade,
  PhotoRecord,
  SelectionDecision,
} from '@/lib/workspace-types'
import {
  effectivePhotoGrade,
  effectiveSpeciesLatinName,
  effectiveSpeciesName,
  formatScore,
  legacyAfPointToOverlay,
  type ReviewDetail,
} from '@/lib/photo-helpers'
import {
  bestPhotoForStack,
  comparePhotosByScoreDesc,
  rankPhotoInGroup,
} from '@/lib/photo-grid-helpers'
import { describePhotoGradeExplanation } from '@/lib/review-grade-explanation'
import {
  speciesSourceBadge,
  speciesSourceDetail,
  speciesSourceKind,
  speciesSourceTone,
} from '@/lib/species-source'
import { cn } from '@/lib/utils'
import { ReviewImageStage, type SyncLoupeState } from './review-image-stage'
import { SpeciesOverrideEditor } from './species-override-editor'
import { useModalDialog } from '@/hooks/use-modal-dialog'
import { usePhotoReview } from '@/hooks/use-photo-review'

const REVIEW_ZOOM_OPTIONS = [1.5, 2.5, 4] as const
const DEFAULT_REVIEW_ZOOM = 2.5
const SEQUENCE_RAIL_MAX_DOTS = 64
const REVIEW_FILMSTRIP_ITEM_WIDTH = 110
const REVIEW_FILMSTRIP_ITEM_GAP = 7
const REVIEW_FILMSTRIP_ITEM_ESTIMATE = REVIEW_FILMSTRIP_ITEM_WIDTH + REVIEW_FILMSTRIP_ITEM_GAP

// HUD 反馈用 — 键盘 1/2/3/4 评级时在舞台角落 flash 一下确认动作生效。
// nonce 用于强制重 mount,同键连按时重新触发动画。
type HudFlashState = { grade: PhotoGrade; nonce: number; photoId: string } | null

export type ReviewSaveFeedback = {
  photoId: string
  requestId: number
  status: 'saving' | 'saved' | 'error'
  grade?: PhotoGrade
  message?: string
}

const GRADE_HUD_TONE: Record<PhotoGrade, 'success' | 'warning' | 'neutral' | 'accent'> = {
  select: 'success',
  usable: 'neutral',
  record: 'warning',
  reject: 'accent',
}

const GRADE_HUD_KEY: Record<PhotoGrade, '1' | '2' | '3' | '4'> = {
  select: '1',
  usable: '2',
  record: '3',
  reject: '4',
}

function hasOpenPopover(): boolean {
  try {
    return Boolean(document.querySelector(':popover-open'))
  } catch {
    return false
  }
}

export function ReviewModal({
  saveError,
  saving,
  saveFeedback,
  onDismissError,
  outsideSelection = false,
  sequenceTotalCount = null,
  detail,
  groupPhotos,
  onClose,
  onSelectPhoto,
  onSetDecision,
  onSetSpeciesOverride,
  onThumbnailLoadStatus,
  photos,
  t,
}: {
  saveError?: string | null
  saving?: boolean
  saveFeedback?: ReviewSaveFeedback | null
  onDismissError?: () => void
  outsideSelection?: boolean
  sequenceTotalCount?: number | null
  detail: ReviewDetail
  groupPhotos: PhotoRecord[]
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
  const { group } = detail
  const review = usePhotoReview(detail.photo, t)
  const photo = review.photo ?? detail.photo
  const detailsReady = Boolean(review.photo)
  const dialogRef = useModalDialog()
  // 覆盖层分工：检测框 / 对焦区域在原图上看全局位置；姿态点保留在 IQA 裁切图上看细节。
  const [showBbox, setShowBbox] = useState(true)
  const [showPose, setShowPose] = useState(false)
  const [showAfPoint, setShowAfPoint] = useState(true)
  const [zoomScale, setZoomScale] = useState<number>(DEFAULT_REVIEW_ZOOM)
  const [fullscreenOpen, setFullscreenOpen] = useState(false)
  const [compareOpen, setCompareOpen] = useState(false)
  const [comparePhotoId, setComparePhotoId] = useState<string | null>(null)
  const [compareFocus, setCompareFocus] = useState<'a' | 'b'>('a')
  const [syncLoupe, setSyncLoupe] = useState<SyncLoupeState>({ active: false, xPct: 50, yPct: 50 })
  const [hudFlash, setHudFlash] = useState<HudFlashState>(null)
  const hudTimerRef = useRef<number | null>(null)

  const flashHud = useCallback((grade: PhotoGrade, targetPhotoId: string) => {
    if (hudTimerRef.current !== null) {
      window.clearTimeout(hudTimerRef.current)
    }
    setHudFlash({ grade, nonce: Date.now(), photoId: targetPhotoId })
    hudTimerRef.current = window.setTimeout(() => {
      setHudFlash(null)
      hudTimerRef.current = null
    }, 700)
  }, [])

  useEffect(() => {
    return () => {
      if (hudTimerRef.current !== null) {
        window.clearTimeout(hudTimerRef.current)
      }
    }
  }, [])

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
  }, [photo.id, photo.inputRevision, bestDetectionIndex])

  const activeBird = useMemo(
    () => (photo.birdDetections ?? []).find((d) => d.index === activeBirdIndex) ?? null,
    [photo.birdDetections, activeBirdIndex],
  )

  // bbox / pose 优先用 activeBird 的，fallback 到 photo-level 兼容老数据 / 单鸟无 detections 数组场景
  const bbox = activeBird?.bbox ?? photo.bestBbox ?? null
  const pose = activeBird?.pose ?? photo.bestPose ?? null
  const hasBirdSubject = Boolean(activeBird || bbox || photo.birdCount > 0)
  // AF 覆盖层是 photo-level（机身只写一份 EXIF AFInfo，不分鸟），切换 activeBird 不影响。
  // Canon 官方语义中，单点 / 扩展 / Zone / Whole area 的呈现不同。
  // 新数据使用结构化 af_area；旧数据退回 legacy af_point。
  const afOverlay = detailsReady
    ? (photo.bestAfArea ?? legacyAfPointToOverlay(photo.bestAfPoint ?? null))
    : null

  const previewSrc = photo.thumbPreviewUrl ?? null
  const photoIndexById = useMemo(
    () => new Map(photos.map((item, index) => [item.id, index] as const)),
    [photos],
  )
  const activeIndex = photoIndexById.get(photo.id) ?? -1
  const reviewGroupPhotos = !outsideSelection && groupPhotos.length > 0 ? groupPhotos : [photo]
  const reviewGroupOrderById = useMemo(
    () => new Map(reviewGroupPhotos.map((item, index) => [item.id, index] as const)),
    [reviewGroupPhotos],
  )
  const isSequence = reviewGroupPhotos.length > 1
  const sequenceFiltered =
    !outsideSelection &&
    sequenceTotalCount !== null &&
    sequenceTotalCount > reviewGroupPhotos.length
  const sequenceIndex = reviewGroupOrderById.get(photo.id) ?? -1
  const sequenceDisplayIndex = sequenceIndex >= 0 ? sequenceIndex + 1 : 1
  const sequenceBestPhoto = useMemo(() => bestPhotoForStack(reviewGroupPhotos), [reviewGroupPhotos])
  const sequenceBestIndex = sequenceBestPhoto
    ? (reviewGroupOrderById.get(sequenceBestPhoto.id) ?? -1)
    : -1
  const sequenceRailDots = useMemo(
    () => buildSequenceRailDots(reviewGroupPhotos.length, sequenceIndex, sequenceBestIndex),
    [reviewGroupPhotos.length, sequenceBestIndex, sequenceIndex],
  )
  const sequenceRank = useMemo(() => {
    if (!isSequence) return null
    return rankPhotoInGroup(reviewGroupPhotos, photo.id)
  }, [isSequence, photo.id, reviewGroupPhotos])
  const sequenceSummaryLabel = outsideSelection
    ? t('selection.review.sequenceOutside')
    : isSequence
      ? sequenceFiltered
        ? t('selection.review.sequenceFilteredLabel')
        : t('selection.review.sequenceLabel')
      : sequenceFiltered
        ? t('selection.review.sequenceFilteredSingle', { total: sequenceTotalCount })
        : t('selection.review.sequenceSingle')
  const sequenceDetailValue = outsideSelection
    ? t('selection.review.sequenceOutsideValue')
    : isSequence
      ? sequenceFiltered
        ? t('selection.review.sequenceFilteredValue', {
            count: reviewGroupPhotos.length,
            total: sequenceTotalCount,
            rank: sequenceRank ?? '--',
            score: formatScore(sequenceBestPhoto?.finalScore),
          })
        : t('selection.review.sequenceValue', {
            count: reviewGroupPhotos.length,
            rank: sequenceRank ?? '--',
            score: formatScore(sequenceBestPhoto?.finalScore),
          })
      : sequenceFiltered
        ? t('selection.review.sequenceFilteredSingleValue', { total: sequenceTotalCount })
        : t('selection.review.sequenceSingleValue')
  // 同组两帧 A/B 对照：仅当前照片处于有效连拍段（≥2 张且未移出筛选）时可用。
  const compareCandidates = useMemo(
    () => reviewGroupPhotos.filter((item) => item.id !== photo.id),
    [photo.id, reviewGroupPhotos],
  )
  const defaultComparePhoto = useMemo(() => {
    if (compareCandidates.length === 0) return null
    if (sequenceBestPhoto && sequenceBestPhoto.id !== photo.id) return sequenceBestPhoto
    return compareCandidates.toSorted(comparePhotosByScoreDesc)[0] ?? compareCandidates[0] ?? null
  }, [compareCandidates, photo.id, sequenceBestPhoto])
  const comparePhoto = useMemo(() => {
    if (!compareOpen || !isSequence || outsideSelection) return null
    if (comparePhotoId) {
      const explicit = compareCandidates.find((item) => item.id === comparePhotoId)
      if (explicit) return explicit
    }
    return defaultComparePhoto
  }, [
    compareCandidates,
    compareOpen,
    comparePhotoId,
    defaultComparePhoto,
    isSequence,
    outsideSelection,
  ])
  const compareActive = compareOpen && comparePhoto !== null
  const compareTargetPhoto = compareActive && compareFocus === 'b' ? comparePhoto : photo
  const comparePhotoRank = useMemo(
    () => (comparePhoto ? rankPhotoInGroup(reviewGroupPhotos, comparePhoto.id) : null),
    [comparePhoto, reviewGroupPhotos],
  )
  const compareCandidateIndex = useMemo(
    () => (comparePhoto ? compareCandidates.findIndex((item) => item.id === comparePhoto.id) : -1),
    [compareCandidates, comparePhoto],
  )
  const gradeExplanation = useMemo(
    () => describePhotoGradeExplanation(photo, pose, t),
    [photo, pose, t],
  )

  useEffect(() => {
    if (!isSequence || outsideSelection) {
      setCompareOpen(false)
      setCompareFocus('a')
      setSyncLoupe({ active: false, xPct: 50, yPct: 50 })
    }
  }, [isSequence, outsideSelection])

  useEffect(() => {
    setSyncLoupe((current) => (current.active ? { ...current, active: false } : current))
  }, [photo.id, comparePhoto?.id])

  const stepComparePhoto = useCallback(
    (offset: -1 | 1) => {
      if (compareCandidates.length === 0) return
      const currentIdx = compareCandidateIndex >= 0 ? compareCandidateIndex : 0
      const nextIdx = (currentIdx + offset + compareCandidates.length) % compareCandidates.length
      setComparePhotoId(compareCandidates[nextIdx]?.id ?? null)
    },
    [compareCandidateIndex, compareCandidates],
  )

  const toggleCompareMode = useCallback(() => {
    if (!isSequence || outsideSelection || compareCandidates.length === 0) return
    setCompareOpen((open) => {
      const next = !open
      if (!next) {
        setCompareFocus('a')
        setSyncLoupe({ active: false, xPct: 50, yPct: 50 })
      } else if (!comparePhotoId || !compareCandidates.some((item) => item.id === comparePhotoId)) {
        setComparePhotoId(defaultComparePhoto?.id ?? null)
      }
      return next
    })
  }, [compareCandidates, comparePhotoId, defaultComparePhoto?.id, isSequence, outsideSelection])

  // 深度复核是“当前筛选照片流”的审片器，连拍只提供上下文提示。
  // 左右键 / 顶部切换 / 底部胶片条必须能跨出当前连拍堆叠继续审片。
  const navigationPhotos = photos
  const navigationIndex = activeIndex
  const canGoPrevious = navigationIndex > 0
  const canGoNext = navigationIndex >= 0 && navigationIndex < navigationPhotos.length - 1

  const selectRelativePhoto = useCallback(
    (offset: -1 | 1) => {
      if (navigationIndex < 0) return
      const nextIndex = Math.max(0, Math.min(navigationPhotos.length - 1, navigationIndex + offset))
      const nextPhoto = navigationPhotos[nextIndex]
      if (!nextPhoto || nextPhoto.id === photo.id) return
      onSelectPhoto(nextPhoto.id)
    },
    [navigationIndex, navigationPhotos, onSelectPhoto, photo.id],
  )

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || hasOpenPopover()) return
      if (
        event.target instanceof Node &&
        event.target !== document.body &&
        event.target !== document.documentElement &&
        !dialogRef.current?.contains(event.target)
      ) {
        return
      }
      const target = event.target
      if (
        target instanceof HTMLInputElement ||
        target instanceof HTMLTextAreaElement ||
        target instanceof HTMLSelectElement ||
        (target instanceof HTMLElement && target.isContentEditable)
      ) {
        return
      }

      if (fullscreenOpen) {
        if (event.key === 'Escape') {
          event.preventDefault()
          setFullscreenOpen(false)
        }
        return
      }

      if (compareActive && event.key === 'Escape') {
        event.preventDefault()
        setCompareOpen(false)
        setCompareFocus('a')
        setSyncLoupe({ active: false, xPct: 50, yPct: 50 })
        return
      }

      if (event.key === 'ArrowLeft') {
        event.preventDefault()
        if (compareActive && compareFocus === 'b') stepComparePhoto(-1)
        else selectRelativePhoto(-1)
        return
      }
      if (event.key === 'ArrowRight') {
        event.preventDefault()
        if (compareActive && compareFocus === 'b') stepComparePhoto(1)
        else selectRelativePhoto(1)
        return
      }
      if (event.metaKey || event.ctrlKey || event.altKey) return
      if (event.key === 'c' || event.key === 'C') {
        if (isSequence && !outsideSelection) {
          event.preventDefault()
          toggleCompareMode()
        }
        return
      }
      if (compareActive && (event.key === 'a' || event.key === 'A')) {
        event.preventDefault()
        setCompareFocus('a')
        return
      }
      if (compareActive && (event.key === 'b' || event.key === 'B')) {
        event.preventDefault()
        setCompareFocus('b')
        return
      }
      const gradeByKey: Record<string, PhotoGrade> = {
        '1': 'select',
        '2': 'usable',
        '3': 'record',
        '4': 'reject',
      }
      const grade = gradeByKey[event.key]
      if (grade) {
        event.preventDefault()
        onSetDecision(compareTargetPhoto.id, grade)
        flashHud(grade, compareTargetPhoto.id)
        return
      }
    }

    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [
    compareActive,
    compareFocus,
    compareTargetPhoto.id,
    flashHud,
    fullscreenOpen,
    isSequence,
    onClose,
    onSetDecision,
    outsideSelection,
    selectRelativePhoto,
    stepComparePhoto,
    toggleCompareMode,
  ])

  const activeFeedback = useMemo(() => {
    if (saveFeedback !== undefined) {
      return saveFeedback && saveFeedback.photoId === compareTargetPhoto.id ? saveFeedback : null
    }
    if (saveError) {
      return {
        photoId: compareTargetPhoto.id,
        requestId: 0,
        status: 'error' as const,
        message: saveError,
      }
    }
    if (saving) {
      return { photoId: compareTargetPhoto.id, requestId: 0, status: 'saving' as const }
    }
    return null
  }, [compareTargetPhoto.id, saveError, saveFeedback, saving])

  const handleFilmstripSelectPhoto = useCallback(
    (selectedId: string) => {
      if (
        compareActive &&
        compareFocus === 'b' &&
        selectedId !== photo.id &&
        reviewGroupOrderById.has(selectedId)
      ) {
        setComparePhotoId(selectedId)
        return
      }
      onSelectPhoto(selectedId)
    },
    [compareActive, compareFocus, onSelectPhoto, photo.id, reviewGroupOrderById],
  )

  // IQA 裁切框（与后端 expand_for_iqa 一致：2.5× + 比例约束 + cap + shift）
  const iqaCrop = useMemo(() => {
    if (!bbox || !imgW || !imgH) return null
    return computeIqaCropBox(imgW, imgH, bbox)
  }, [bbox, imgW, imgH])

  return (
    <dialog
      ref={dialogRef}
      aria-label={t('selection.review.title')}
      onCancel={(event) => {
        event.preventDefault()
        if (fullscreenOpen) setFullscreenOpen(false)
        else if (compareActive) {
          setCompareOpen(false)
          setCompareFocus('a')
          setSyncLoupe({ active: false, xPct: 50, yPct: 50 })
        } else onClose()
      }}
      className="overlay-backdrop"
      onPointerDown={(event) => {
        if (event.target === event.currentTarget) onClose()
      }}
    >
      <div className="review-panel" onPointerDown={(event) => event.stopPropagation()}>
        {activeFeedback?.status === 'error' ? (
          <div className="review-save-feedback" role="alert">
            <span>{activeFeedback.message ?? saveError}</span>
            <button type="button" className="button-ghost button-compact" onClick={onDismissError}>
              {t('common.close')}
            </button>
          </div>
        ) : activeFeedback?.status === 'saving' ? (
          <div className="review-save-feedback" role="status">
            {t('selection.saving')}
          </div>
        ) : activeFeedback?.status === 'saved' ? (
          <div className="review-save-feedback review-save-feedback--saved" role="status">
            {activeFeedback.grade
              ? t('selection.savedGrade', { grade: t(gradeLabelKey(activeFeedback.grade)) })
              : t('selection.saved')}
          </div>
        ) : null}
        {outsideSelection ? (
          <div className="review-scope-notice" role="status">
            {t('selection.speciesFilter.outsideSelection')}
          </div>
        ) : null}
        <div className="review-stage">
          {hudFlash && hudFlash.photoId === compareTargetPhoto.id ? (
            <div
              aria-hidden="true"
              className={cn(
                'review-grade-hud',
                `review-grade-hud--${GRADE_HUD_TONE[hudFlash.grade]}`,
              )}
              key={hudFlash.nonce}
            >
              <span className="review-grade-hud__key">{GRADE_HUD_KEY[hudFlash.grade]}</span>
              <span className="review-grade-hud__label">{t(gradeLabelKey(hudFlash.grade))}</span>
            </div>
          ) : null}
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

          <div
            className={cn(
              'review-sequence',
              isSequence ? 'review-sequence--stack' : 'review-sequence--single',
            )}
          >
            <div className="review-sequence__summary">
              <span className="review-sequence__glyph" aria-hidden="true">
                <Images className="h-3.5 w-3.5" />
              </span>
              <span className="review-sequence__label">{sequenceSummaryLabel}</span>
              {isSequence ? (
                <strong>
                  {t('selection.review.sequencePosition', {
                    count: reviewGroupPhotos.length,
                    index: sequenceDisplayIndex,
                  })}
                </strong>
              ) : null}
            </div>
            {isSequence ? (
              <div className="review-sequence__rail" aria-hidden="true">
                {sequenceRailDots.map((dotIndex, visualIndex) => (
                  <i
                    className={cn(
                      dotIndex === sequenceIndex && 'is-current',
                      dotIndex === sequenceBestIndex && 'is-best',
                    )}
                    key={`${dotIndex}-${visualIndex}`}
                  />
                ))}
              </div>
            ) : null}
            <div className="review-sequence__meta">
              {isSequence && sequenceRank !== null ? (
                <span>{t('selection.review.sequenceRankShort', { rank: sequenceRank })}</span>
              ) : null}
              {isSequence && sequenceBestPhoto?.id === photo.id ? (
                <b>{t('selection.review.sequenceBest')}</b>
              ) : null}
              {isSequence && !outsideSelection ? (
                <button
                  aria-keyshortcuts="c"
                  aria-pressed={compareActive}
                  className={cn(
                    'button-ghost button-compact review-compare-toggle',
                    compareActive && 'is-active',
                  )}
                  onClick={toggleCompareMode}
                  type="button"
                >
                  <Columns2 className="h-3.5 w-3.5" />
                  {t(
                    compareActive ? 'selection.review.compareExit' : 'selection.review.compareOpen',
                  )}
                </button>
              ) : null}
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
                disabled={!detailsReady || compareActive}
              />
              <span>{t('selection.review.togglePose')}</span>
            </label>
            <label className="review-toggle">
              <input
                type="checkbox"
                checked={showAfPoint}
                onChange={(e) => setShowAfPoint(e.target.checked)}
                disabled={afOverlay === null || compareActive}
              />
              <span>
                {t('selection.review.toggleAfPoint')}
                {detailsReady && afOverlay === null ? t('selection.review.afPointUnknown') : ''}
              </span>
            </label>
          </div>

          {compareActive && comparePhoto ? (
            <div className="review-stage__images review-stage__images--compare">
              <div
                className={cn(
                  'review-compare-pane',
                  compareFocus === 'a' && 'review-compare-pane--focused',
                )}
                data-compare-pane="a"
                onClick={() => setCompareFocus('a')}
              >
                <div className="review-compare-pane__bar">
                  <button
                    aria-pressed={compareFocus === 'a'}
                    className="review-compare-pane__badge"
                    onClick={() => setCompareFocus('a')}
                    type="button"
                  >
                    A
                  </button>
                  <strong className="review-compare-pane__name">{photo.fileName}</strong>
                  <span className="review-compare-pane__meta">
                    {t(gradeLabelKey(effectivePhotoGrade(photo)))} · {formatScore(photo.finalScore)}
                    {sequenceRank !== null ? ` · #${sequenceRank}` : ''}
                  </span>
                </div>
                <ReviewImageStage
                  label={t('selection.review.comparePaneLabel', {
                    slot: 'A',
                    scale: zoomScale,
                  })}
                  hint={t('selection.review.compareSyncHint')}
                  previewSrc={previewSrc}
                  fallbackGradient={photo.previewGradient}
                  aspect={aspect}
                  imgW={imgW}
                  imgH={imgH}
                  bbox={showBbox ? bbox : null}
                  pose={null}
                  afOverlay={null}
                  photoId={photo.id}
                  loupeEnabled
                  cropRect={null}
                  onZoomScaleChange={setZoomScale}
                  syncLoupe={syncLoupe}
                  onSyncLoupeChange={setSyncLoupe}
                  t={t}
                  variant="primary"
                  zoomOptions={REVIEW_ZOOM_OPTIONS}
                  zoomScale={zoomScale}
                />
              </div>

              <div
                className={cn(
                  'review-compare-pane',
                  compareFocus === 'b' && 'review-compare-pane--focused',
                )}
                data-compare-pane="b"
                onClick={() => setCompareFocus('b')}
              >
                <div className="review-compare-pane__bar">
                  <button
                    aria-pressed={compareFocus === 'b'}
                    className="review-compare-pane__badge"
                    onClick={() => setCompareFocus('b')}
                    type="button"
                  >
                    B
                  </button>
                  <strong className="review-compare-pane__name">{comparePhoto.fileName}</strong>
                  <span className="review-compare-pane__meta">
                    {t(gradeLabelKey(effectivePhotoGrade(comparePhoto)))} ·{' '}
                    {formatScore(comparePhoto.finalScore)}
                    {comparePhotoRank !== null ? ` · #${comparePhotoRank}` : ''}
                  </span>
                  {compareCandidates.length > 1 ? (
                    <div
                      className="review-compare-pane__stepper"
                      onClick={(event) => event.stopPropagation()}
                    >
                      <IconButton
                        label={t('selection.review.comparePrevB')}
                        onClick={() => {
                          setCompareFocus('b')
                          stepComparePhoto(-1)
                        }}
                      >
                        <ChevronLeft className="h-3.5 w-3.5" />
                      </IconButton>
                      <IconButton
                        label={t('selection.review.compareNextB')}
                        onClick={() => {
                          setCompareFocus('b')
                          stepComparePhoto(1)
                        }}
                      >
                        <ChevronRight className="h-3.5 w-3.5" />
                      </IconButton>
                    </div>
                  ) : null}
                </div>
                <ReviewImageStage
                  label={t('selection.review.comparePaneLabel', {
                    slot: 'B',
                    scale: zoomScale,
                  })}
                  hint={t('selection.review.compareSyncHint')}
                  previewSrc={comparePhoto.thumbPreviewUrl ?? comparePhoto.thumbGridUrl ?? null}
                  fallbackGradient={comparePhoto.previewGradient}
                  aspect={
                    comparePhoto.imageWidth && comparePhoto.imageHeight
                      ? comparePhoto.imageWidth / comparePhoto.imageHeight
                      : null
                  }
                  imgW={comparePhoto.imageWidth ?? null}
                  imgH={comparePhoto.imageHeight ?? null}
                  bbox={showBbox ? (comparePhoto.bestBbox ?? null) : null}
                  pose={null}
                  afOverlay={null}
                  photoId={comparePhoto.id}
                  loupeEnabled
                  cropRect={null}
                  onZoomScaleChange={setZoomScale}
                  syncLoupe={syncLoupe}
                  onSyncLoupeChange={setSyncLoupe}
                  t={t}
                  variant="primary"
                  zoomOptions={REVIEW_ZOOM_OPTIONS}
                  zoomScale={zoomScale}
                />
              </div>
            </div>
          ) : (
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
                onOpenFullscreen={() => setFullscreenOpen(true)}
                onZoomScaleChange={setZoomScale}
                t={t}
                variant="primary"
                zoomOptions={REVIEW_ZOOM_OPTIONS}
                zoomScale={zoomScale}
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
                pose={detailsReady && showPose ? pose : null}
                afOverlay={null}
                photoId={photo.id}
                loupeEnabled={false}
                cropRect={iqaCrop}
                t={t}
                variant="crop"
                zoomScale={zoomScale}
              />
            </div>
          )}
        </div>

        <aside className="review-detail review-detail--compact">
          <div className="review-detail__body">
            {review.loading ? (
              <div className="review-detail__notice" role="status">
                {t('selection.review.loadingDetails')}
              </div>
            ) : review.error ? (
              <div className="review-detail__notice" role="alert">
                <span>
                  {t(
                    review.revisionChanged
                      ? 'selection.review.detailsChanged'
                      : 'selection.review.detailsFailed',
                  )}
                </span>
                <button
                  type="button"
                  className="button-ghost button-compact"
                  onClick={review.onRetry}
                >
                  {t('common.retry')}
                </button>
              </div>
            ) : null}
            {/* 顶部：分数 + 物种 + 分级 */}
            <ScoreHeader
              photo={photo}
              activeBird={activeBird}
              totalBirds={photo.birdDetections?.length ?? 0}
              t={t}
            />
            <div className="review-grade-explain" data-explain-kind={gradeExplanation.kind}>
              <span>{gradeExplanation.summary}</span>
              {gradeExplanation.detail ? <small>{gradeExplanation.detail}</small> : null}
            </div>

            {/* 关键指标 3 列 — head/eye 移到 PoseChipsRow,birdCount 移除(单鸟图永远 1,
                多鸟图由 SpeciesOverrideEditor bird tabs 表达,这里冗余)。 */}
            <div className="review-stats-grid review-stats-grid--cols-3">
              <CompactStat
                label={t('selection.metrics.semanticScore')}
                value={formatScore(photo.semanticScore)}
              />
              <CompactStat
                label={t('selection.metrics.technicalScore')}
                value={formatScore(photo.technicalScore)}
              />
              <CompactStat
                label={t('selection.metrics.confidence')}
                value={bbox ? `${Math.round((bbox.confidence ?? 0) * 100)}%` : '--'}
              />
            </div>

            {/* 姿态/标签语义紧凑组:5 项 visibility chip + 姿态提示 + 主体条件 tags 紧跟。
                老结构里 TagCluster 被 EXIF 拆到底部,语义脱节;主体条件本身就是 pose
                派生(见 backend-adapter derivePoseTags),归位到 pose 组。
                只要有鸟主体就展示此组;pose=null 时显示"暂无结果",避免右栏信息随机消失。 */}
            {hasBirdSubject ? (
              <>
                <PoseChipsRow pose={pose} t={t} />
                {(() => {
                  const { text, isFlying } = formatPostureLabel(pose, t)
                  return (
                    <CompactKV
                      label={t('selection.metrics.posture')}
                      value={
                        isFlying ? `${text} · ${t('selection.review.posture.flyBoost')}` : text
                      }
                      emphasis={isFlying}
                    />
                  )
                })()}
              </>
            ) : null}

            <TagCluster photo={photo} t={t} />

            <SpeciesOverrideEditor
              activeBirdIndex={activeBirdIndex}
              detailsReady={detailsReady}
              onSetActiveBirdIndex={setActiveBirdIndex}
              onSetSpeciesOverride={onSetSpeciesOverride}
              photo={photo}
              t={t}
            />

            <CompactKV label={t('selection.metrics.scene')} value={group?.title ?? '--'} />

            <CompactKV label={t('selection.review.sequenceLabel')} value={sequenceDetailValue} />

            {photo.companionFormat && photo.companionPath ? (
              <CompactKV
                label={t('selection.review.companion')}
                value={t('selection.review.companionValue', {
                  format: photo.companionFormat,
                  size: formatBytes(photo.companionSize ?? 0),
                })}
              />
            ) : null}

            {detailsReady ? <ExifPanel exif={photo.exif} location={photo} t={t} /> : null}

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
          </div>

          <div className="review-detail__footer">
            {compareActive && comparePhoto ? (
              <div className="review-compare-target-hint">
                {t('selection.review.compareTargetHint', {
                  slot: compareFocus.toUpperCase(),
                  file: compareTargetPhoto.fileName,
                })}
              </div>
            ) : null}
            <div className="inspector-actions inspector-actions--compact">
              <button
                className="button-primary"
                onClick={() => {
                  onSetDecision(compareTargetPhoto.id, 'select')
                  flashHud('select', compareTargetPhoto.id)
                }}
                type="button"
              >
                <Sparkles className="h-4 w-4" />
                {t('selection.actions.select')}
              </button>
              <button
                className="button-ghost"
                onClick={() => {
                  onSetDecision(compareTargetPhoto.id, 'usable')
                  flashHud('usable', compareTargetPhoto.id)
                }}
                type="button"
              >
                <Check className="h-4 w-4" />
                {t('selection.actions.usable')}
              </button>
              <button
                className="button-ghost"
                onClick={() => {
                  onSetDecision(compareTargetPhoto.id, 'record')
                  flashHud('record', compareTargetPhoto.id)
                }}
                type="button"
              >
                <Clock3 className="h-4 w-4" />
                {t('selection.actions.record')}
              </button>
              <button
                className="button-danger"
                onClick={() => {
                  onSetDecision(compareTargetPhoto.id, 'reject')
                  flashHud('reject', compareTargetPhoto.id)
                }}
                type="button"
              >
                <X className="h-4 w-4" />
                {t('selection.actions.reject')}
              </button>
            </div>
          </div>
        </aside>

        <ReviewFilmstrip
          activePhotoIndex={activeIndex}
          activePhotoId={photo.id}
          bestGroupPhotoId={sequenceBestPhoto?.id ?? null}
          groupPhotoOrderById={reviewGroupOrderById}
          onThumbnailLoadStatus={onThumbnailLoadStatus}
          onSelectPhoto={handleFilmstripSelectPhoto}
          photos={photos}
          sequenceCount={reviewGroupPhotos.length}
          t={t}
        />

        {fullscreenOpen ? (
          <ReviewFullscreenViewer
            aspect={aspect}
            fallbackGradient={photo.previewGradient}
            fileName={photo.fileName}
            imgH={imgH}
            imgW={imgW}
            onClose={() => setFullscreenOpen(false)}
            onZoomScaleChange={setZoomScale}
            previewSrc={previewSrc}
            t={t}
            zoomOptions={REVIEW_ZOOM_OPTIONS}
            zoomScale={zoomScale}
          />
        ) : null}
      </div>
    </dialog>
  )
}

function ReviewFullscreenViewer({
  aspect,
  fallbackGradient,
  fileName,
  imgH,
  imgW,
  onClose,
  onZoomScaleChange,
  previewSrc,
  t,
  zoomOptions,
  zoomScale,
}: {
  aspect: number | null
  fallbackGradient: string
  fileName: string
  imgH: number | null
  imgW: number | null
  onClose: () => void
  onZoomScaleChange: (scale: number) => void
  previewSrc: string | null
  t: ReturnType<typeof useTranslation>['t']
  zoomOptions: readonly number[]
  zoomScale: number
}) {
  return (
    <div
      className="review-fullscreen"
      onPointerDown={(event) => {
        if (event.target === event.currentTarget) onClose()
      }}
    >
      <div className="review-fullscreen__bar">
        <div className="review-fullscreen__title">
          <span>{t('selection.review.fullscreen')}</span>
          <strong>{fileName}</strong>
        </div>
        <div className="review-fullscreen__actions">
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
          <IconButton ariaKeyShortcuts="Escape" label={t('common.close')} onClick={onClose}>
            <X className="h-4 w-4" />
          </IconButton>
        </div>
      </div>
      <ReviewImageStage
        afOverlay={null}
        aspect={aspect}
        bbox={null}
        cropRect={null}
        fallbackGradient={fallbackGradient}
        hint={t('selection.review.fullscreenHint')}
        imgH={imgH}
        imgW={imgW}
        label={fileName}
        loupeEnabled
        photoId={`fullscreen-${fileName}`}
        pose={null}
        previewSrc={previewSrc}
        showHeader={false}
        t={t}
        variant="fullscreen"
        zoomScale={zoomScale}
      />
    </div>
  )
}

function buildSequenceRailDots(count: number, currentIndex: number, bestIndex: number): number[] {
  if (count <= 0) return []
  if (count <= SEQUENCE_RAIL_MAX_DOTS) return Array.from({ length: count }, (_, index) => index)
  const dots = new Set<number>()
  if (currentIndex >= 0 && currentIndex < count) dots.add(currentIndex)
  if (bestIndex >= 0 && bestIndex < count) dots.add(bestIndex)
  for (let index = 0; index < SEQUENCE_RAIL_MAX_DOTS; index += 1) {
    dots.add(Math.round((index * (count - 1)) / (SEQUENCE_RAIL_MAX_DOTS - 1)))
  }
  return Array.from(dots).toSorted((left, right) => left - right)
}

function ReviewFilmstrip({
  activePhotoIndex,
  activePhotoId,
  bestGroupPhotoId,
  groupPhotoOrderById,
  onThumbnailLoadStatus,
  onSelectPhoto,
  photos,
  sequenceCount,
  t,
}: {
  activePhotoIndex: number
  activePhotoId: string
  bestGroupPhotoId: string | null
  groupPhotoOrderById: Map<string, number>
  onThumbnailLoadStatus: (photoId: string, status: ThumbnailLoadStatus) => void
  onSelectPhoto: (photoId: string) => void
  photos: PhotoRecord[]
  sequenceCount: number
  t: ReturnType<typeof useTranslation>['t']
}) {
  const trackRef = useRef<HTMLDivElement | null>(null)
  const hasSequence = sequenceCount > 1
  const virtualizer = useVirtualizer({
    count: photos.length,
    estimateSize: () => REVIEW_FILMSTRIP_ITEM_ESTIMATE,
    getScrollElement: () => trackRef.current,
    horizontal: true,
    overscan: 12,
  })

  useEffect(() => {
    if (activePhotoIndex < 0) return
    virtualizer.scrollToIndex(activePhotoIndex, { align: 'center' })
  }, [activePhotoIndex, virtualizer])

  return (
    <footer className="review-filmstrip" aria-label={t('selection.review.filmstripLabel')}>
      <div className="review-filmstrip__track selection-scroll" ref={trackRef}>
        <div className="review-filmstrip__spacer" style={{ width: virtualizer.getTotalSize() }}>
          {virtualizer.getVirtualItems().map((virtualItem) => {
            const item = photos[virtualItem.index]
            if (!item) return null
            const groupIndex = groupPhotoOrderById.get(item.id)
            const isSequencePhoto = hasSequence && groupIndex !== undefined
            const itemStyle: CSSProperties & { '--film-x': string } = {
              '--film-x': `${virtualItem.start}px`,
              backgroundImage: item.placeholderGradient ?? item.previewGradient,
            }
            return (
              <button
                aria-current={item.id === activePhotoId ? 'true' : undefined}
                className={cn(
                  'review-filmstrip__item',
                  item.id === activePhotoId && 'review-filmstrip__item--active',
                  isSequencePhoto && 'review-filmstrip__item--sequence',
                  isSequencePhoto && groupIndex === 0 && 'review-filmstrip__item--sequence-start',
                  isSequencePhoto &&
                    groupIndex === sequenceCount - 1 &&
                    'review-filmstrip__item--sequence-end',
                  !isSequencePhoto &&
                    sequenceCount > 1 &&
                    'review-filmstrip__item--outside-sequence',
                  hasSequence &&
                    item.id === bestGroupPhotoId &&
                    'review-filmstrip__item--sequence-best',
                )}
                key={item.id}
                onClick={() => onSelectPhoto(item.id)}
                style={itemStyle}
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
                {isSequencePhoto ? (
                  <span
                    className={cn(
                      'review-filmstrip__sequence-cue',
                      item.id === activePhotoId && 'review-filmstrip__sequence-cue--active',
                    )}
                  >
                    {item.id === activePhotoId
                      ? t('selection.review.filmstripSequenceIndex', {
                          count: sequenceCount,
                          index: groupIndex + 1,
                        })
                      : null}
                  </span>
                ) : null}
                {hasSequence && item.id === bestGroupPhotoId ? (
                  <span
                    aria-label={t('selection.review.sequenceBest')}
                    className="review-filmstrip__best"
                  />
                ) : null}
                <span className="review-filmstrip__meta">
                  <strong>{formatScore(item.finalScore)}</strong>
                  <small>{item.fileName}</small>
                </span>
              </button>
            )
          })}
        </div>
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
    activeBird?.speciesName ?? effectiveSpeciesName(photo) ?? t('selection.photo.unidentified')
  const speciesLatinName = activeBird?.speciesLatinName ?? effectiveSpeciesLatinName(photo)
  const speciesIdentity = {
    englishName: activeBird?.speciesEnglishName ?? photo.speciesEnglishName ?? null,
    latinName: speciesLatinName,
    name: activeBird?.speciesName ?? effectiveSpeciesName(photo),
  }
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
        <SpeciesNameAction identity={speciesIdentity} t={t}>
          {speciesName}
        </SpeciesNameAction>
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

/** 紧凑 key-value：单行，标签灰、值白；emphasis=true 时值高亮(用于飞版升档提示)。 */
function CompactKV({
  label,
  value,
  emphasis = false,
}: {
  label: string
  value: string
  emphasis?: boolean
}) {
  return (
    <div className={cn('compact-kv', emphasis && 'compact-kv--emphasis')}>
      <span className="compact-kv__label">{label}</span>
      <span className="compact-kv__value">{value}</span>
    </div>
  )
}

/**
 * 姿态可见性 chip 行 — head / eye / body / wings / tail 五项。
 * head/eye 影响降档(核心地位)但不再独占 stats-grid 卡片;与 body/wings/tail
 * 同属 visibility 维度,统一在 chip 行展示更紧凑(详见 PoseChipsRow 内联说明)。
 */
function PoseChipsRow({
  pose,
  t,
}: {
  pose: PhotoRecord['bestPose']
  t: ReturnType<typeof useTranslation>['t']
}) {
  if (!pose) {
    return (
      <div className="review-pose-chips review-pose-chips--missing">
        <span className="review-pose-chips__label">{t('selection.metrics.bodyParts')}</span>
        <span className="review-pose-chips__chip review-pose-chips__chip--muted">
          {t('selection.review.visibility.noResult')}
        </span>
      </div>
    )
  }

  // 三态:true=明确可见(ok),false=明确不可见(warn),undefined=暂无字段结果(muted)。
  // pipeline_version bump 后旧 cache 自动失效重分析,但用户首次升级窗口期会有混合状态。
  // 不能简单 ?? false,会让"暂无结果"显示成警告色误导用户。
  // head/eye 也并入这里 — 之前在 review-stats-grid 占独立卡片,信息密度浪费;
  // 与 body/wings/tail 同 visibility 维度,统一展示更紧凑。
  const items: Array<{ key: string; label: string; visible: boolean | undefined }> = [
    { key: 'head', label: t('selection.metrics.head'), visible: pose?.head_visible },
    { key: 'eye', label: t('selection.metrics.eye'), visible: pose?.eye_visible },
    { key: 'body', label: t('selection.metrics.body'), visible: pose?.body_visible },
    { key: 'wings', label: t('selection.metrics.wings'), visible: pose?.wings_visible },
    { key: 'tail', label: t('selection.metrics.tail'), visible: pose?.tail_visible },
  ]
  return (
    <div className="review-pose-chips">
      <span className="review-pose-chips__label">{t('selection.metrics.bodyParts')}</span>
      {items.map((it) => {
        const tone = it.visible === true ? 'ok' : it.visible === false ? 'warn' : 'muted'
        const symbol = it.visible === true ? '✓' : it.visible === false ? '✗' : '–'
        return (
          <span
            key={it.key}
            className={cn('review-pose-chips__chip', `review-pose-chips__chip--${tone}`)}
          >
            {it.label} {symbol}
          </span>
        )
      })}
    </div>
  )
}

/**
 * 把 pose 的 view_angle / facing / posture 三个字段拼成一行人话文案。
 * 例:
 *   - "飞行 · 侧面朝左"
 *   - "停栖 · 正面"
 *   - "停栖"(view_angle 未识别时省略)
 *   - "—"(三项都 unknown)
 */
function formatPostureLabel(
  pose: PhotoRecord['bestPose'],
  t: ReturnType<typeof useTranslation>['t'],
): { text: string; isFlying: boolean } {
  if (!pose) return { text: t('selection.review.posture.noResult'), isFlying: false }
  const posture = pose.posture ?? 'unknown'
  const viewAngle = pose.view_angle ?? 'unknown'
  const facing = pose.facing ?? 'unknown'

  const postureText =
    posture === 'flying'
      ? t('selection.review.posture.flying')
      : posture === 'perched'
        ? t('selection.review.posture.perched')
        : null

  let viewText: string | null = null
  if (viewAngle === 'side' && (facing === 'left' || facing === 'right')) {
    viewText = `${t('selection.review.viewAngle.side')}${t(`selection.review.facing.${facing}`)}`
  } else if (viewAngle === 'frontal' || viewAngle === 'back' || viewAngle === 'side') {
    viewText = t(`selection.review.viewAngle.${viewAngle}`)
  }

  const parts = [postureText, viewText].filter((p): p is string => Boolean(p))
  return {
    text: parts.length > 0 ? parts.join(' · ') : t('selection.review.posture.unknown'),
    isFlying: posture === 'flying',
  }
}

/** EXIF 信息面板（相机 / 镜头 / 曝光参数） */
function ExifPanel({
  exif,
  location,
  t,
}: {
  exif?: Record<string, unknown> | null
  location: Pick<PhotoRecord, 'country' | 'province' | 'city' | 'district' | 'place'>
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
  const gps = extractGpsCoords(exif)

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
        {gps ? <GpsRows gps={gps} location={location} t={t} /> : null}
      </div>
    </div>
  )
}

function formatPersistedPlace(
  location: Pick<PhotoRecord, 'country' | 'province' | 'city' | 'district' | 'place'>,
): string | null {
  // 去掉 province/country — 国内用户大概率本国拍鸟,省名重复且占空间。
  // 只显示 place(POI/街道) · district(区/县) · city(市) 三级足够定位。
  // 直辖市 city == province 时 city 被显示,达到一样效果。
  const parts = [location.place, location.district, location.city]
    .map((value) => value?.trim())
    .filter((value): value is string => Boolean(value))
  const unique = parts.filter((value, index) => parts.indexOf(value) === index)
  return unique.length > 0 ? unique.join(' · ') : null
}

function appleMapsUrl(gps: { lat: number; lon: number }): string {
  const url = new URL('https://maps.apple.com/')
  url.searchParams.set('ll', `${gps.lat},${gps.lon}`)
  url.searchParams.set('q', `${gps.lat.toFixed(5)},${gps.lon.toFixed(5)}`)
  url.searchParams.set('z', '16')
  return url.toString()
}

/** GPS 行:坐标(可点 Apple Maps) + 后台 backfill 持久化地名 */
function GpsRows({
  gps,
  location,
  t,
}: {
  gps: { lat: number; lon: number; alt: number | null }
  location: Pick<PhotoRecord, 'country' | 'province' | 'city' | 'district' | 'place'>
  t: ReturnType<typeof useTranslation>['t']
}) {
  const place = formatPersistedPlace(location)
  const mapsUrl = appleMapsUrl(gps)
  return (
    <>
      <div className="compact-kv">
        <span className="compact-kv__label">{t('selection.exif.location')}</span>
        <a
          className="compact-kv__value compact-kv__value--link"
          href={mapsUrl}
          onClick={(event) => {
            const opener = window.plumelens?.openExternalUrl
            if (!opener) return
            event.preventDefault()
            void opener(mapsUrl)
          }}
          rel="noopener noreferrer"
          target="_blank"
          title={t('selection.exif.openInMaps')}
        >
          {formatGpsCoords(gps)}
        </a>
      </div>
      {place ? (
        <div className="compact-kv compact-kv--multiline">
          <span className="compact-kv__label">{t('selection.exif.place')}</span>
          <span className="compact-kv__value compact-kv__value--multiline">{place}</span>
        </div>
      ) : null}
    </>
  )
}

/** 从 EXIF 抽 GPS 坐标。返回十进制度(WGS84),不可解析返回 null。 */
function extractGpsCoords(
  exif: Record<string, unknown>,
): { lat: number; lon: number; alt: number | null } | null {
  // 后端 scanner._extract_exif 把 GPSInfo 子目录展开为 dict (含 GPSLatitudeRef/
  // GPSLatitude/GPSLongitudeRef/GPSLongitude/GPSAltitude...);GPSLatitude 是 [度,分,秒]
  // 三元组(都是 number)。
  const gps = exif['GPSInfo']
  if (!gps || typeof gps !== 'object') return null
  const g = gps as Record<string, unknown>
  const lat = gpsCoordinateToDecimal(
    mappingValue(g, 'GPSLatitude', '2'),
    mappingValue(g, 'GPSLatitudeRef', '1'),
  )
  const lon = gpsCoordinateToDecimal(
    mappingValue(g, 'GPSLongitude', '4'),
    mappingValue(g, 'GPSLongitudeRef', '3'),
  )
  if (lat === null || lon === null) return null
  let alt: number | null = null
  const a = scalarToNumber(mappingValue(g, 'GPSAltitude', '6'))
  if (a !== null) {
    // GPSAltitudeRef: 0 = 海平面以上,1 = 海平面以下(很罕见)
    alt = scalarToNumber(mappingValue(g, 'GPSAltitudeRef', '5')) === 1 ? -a : a
  }
  return { lat, lon, alt }
}

function mappingValue(mapping: Record<string, unknown>, ...keys: string[]): unknown {
  for (const key of keys) {
    if (Object.hasOwn(mapping, key)) return mapping[key]
  }
  return null
}

function scalarToNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string') {
    const parsed = Number(value.trim())
    return Number.isFinite(parsed) ? parsed : null
  }
  if (Array.isArray(value) && value.length === 2) {
    const numerator = scalarToNumber(value[0])
    const denominator = scalarToNumber(value[1])
    if (numerator === null || denominator === null || denominator === 0) return null
    return numerator / denominator
  }
  if (value && typeof value === 'object') {
    const rational = value as Record<string, unknown>
    const numerator = scalarToNumber(rational['numerator'])
    const denominator = scalarToNumber(rational['denominator'])
    if (numerator === null || denominator === null || denominator === 0) return null
    return numerator / denominator
  }
  return null
}

function gpsCoordinateToDecimal(dms: unknown, ref: unknown): number | null {
  if (!Array.isArray(dms) || dms.length < 3) return null
  const [d, m, s] = dms
  const degree = scalarToNumber(d)
  const minute = scalarToNumber(m)
  const second = scalarToNumber(s)
  if (degree === null || minute === null || second === null) return null
  let value = degree + minute / 60 + second / 3600
  if (!Number.isFinite(value)) return null
  // S(South) / W(West) → 负值
  const refText =
    typeof ref === 'string'
      ? ref.trim().toUpperCase()
      : String(ref ?? '')
          .trim()
          .toUpperCase()
  if (refText === 'S' || refText === 'W') value = -value
  if (!['N', 'E', 'S', 'W'].includes(refText)) return null
  return value
}

function formatGpsCoords(gps: { lat: number; lon: number; alt: number | null }): string {
  const latStr = `${Math.abs(gps.lat).toFixed(5)}°${gps.lat >= 0 ? 'N' : 'S'}`
  const lonStr = `${Math.abs(gps.lon).toFixed(5)}°${gps.lon >= 0 ? 'E' : 'W'}`
  if (gps.alt !== null) {
    return `${latStr}, ${lonStr} · ${Math.round(gps.alt)} m`
  }
  return `${latStr}, ${lonStr}`
}

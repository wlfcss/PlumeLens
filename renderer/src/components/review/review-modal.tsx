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
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Clock3,
  Images,
  Maximize2,
  Search,
  Sparkles,
  X,
} from 'lucide-react'
import { useVirtualizer } from '@tanstack/react-virtual'
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from 'react'
import type { useTranslation } from 'react-i18next'

import { ThumbnailImage, type ThumbnailLoadStatus } from '@/components/thumbnail-image'
import {
  IconButton,
  SectionLabel,
  SpeciesNameAction,
  TagCluster,
  effectivePhotoGrade,
  effectiveSpeciesLatinName,
  effectiveSpeciesName,
  formatScore,
  gradeLabelKey,
  legacyAfPointToOverlay,
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
  PhotoGrade,
  PhotoRecord,
  SelectionDecision,
} from '@/lib/mock-workspace'
import { listAllSpecies } from '@/lib/species-wiki'
import { cn } from '@/lib/utils'

const REVIEW_ZOOM_OPTIONS = [1.5, 2.5, 4] as const
const DEFAULT_REVIEW_ZOOM = 2.5
const SEQUENCE_RAIL_MAX_DOTS = 64
const REVIEW_FILMSTRIP_ITEM_WIDTH = 110
const REVIEW_FILMSTRIP_ITEM_GAP = 7
const REVIEW_FILMSTRIP_ITEM_ESTIMATE = REVIEW_FILMSTRIP_ITEM_WIDTH + REVIEW_FILMSTRIP_ITEM_GAP

// HUD 反馈用 — 键盘 1/2/3/4 评级时在舞台角落 flash 一下确认动作生效。
// nonce 用于强制重 mount,同键连按时重新触发动画。
type HudFlashState = { grade: PhotoGrade; nonce: number } | null

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

export function ReviewModal({
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
  const { photo, group } = detail
  // 覆盖层分工：检测框 / 对焦区域在原图上看全局位置；姿态点保留在 IQA 裁切图上看细节。
  const [showBbox, setShowBbox] = useState(true)
  const [showPose, setShowPose] = useState(false)
  const [showAfPoint, setShowAfPoint] = useState(true)
  const [zoomScale, setZoomScale] = useState<number>(DEFAULT_REVIEW_ZOOM)
  const [fullscreenOpen, setFullscreenOpen] = useState(false)
  const [hudFlash, setHudFlash] = useState<HudFlashState>(null)
  const hudTimerRef = useRef<number | null>(null)

  const flashHud = useCallback((grade: PhotoGrade) => {
    if (hudTimerRef.current !== null) {
      window.clearTimeout(hudTimerRef.current)
    }
    setHudFlash({ grade, nonce: Date.now() })
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
  }, [photo.id, bestDetectionIndex])

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
  const afOverlay = photo.bestAfArea ?? legacyAfPointToOverlay(photo.bestAfPoint ?? null)

  const previewSrc = photo.thumbPreviewUrl ?? null
  const photoIndexById = useMemo(
    () => new Map(photos.map((item, index) => [item.id, index] as const)),
    [photos],
  )
  const activeIndex = photoIndexById.get(photo.id) ?? -1
  const reviewGroupPhotos = groupPhotos.length > 0 ? groupPhotos : [photo]
  const reviewGroupOrderById = useMemo(
    () => new Map(reviewGroupPhotos.map((item, index) => [item.id, index] as const)),
    [reviewGroupPhotos],
  )
  const isSequence = reviewGroupPhotos.length > 1
  const sequenceIndex = reviewGroupOrderById.get(photo.id) ?? -1
  const sequenceDisplayIndex = sequenceIndex >= 0 ? sequenceIndex + 1 : 1
  const sequenceBestPhoto = useMemo(
    () => bestReviewGroupPhoto(reviewGroupPhotos),
    [reviewGroupPhotos],
  )
  const sequenceBestIndex = sequenceBestPhoto
    ? (reviewGroupOrderById.get(sequenceBestPhoto.id) ?? -1)
    : -1
  const sequenceRailDots = useMemo(
    () => buildSequenceRailDots(reviewGroupPhotos.length, sequenceIndex, sequenceBestIndex),
    [reviewGroupPhotos.length, sequenceBestIndex, sequenceIndex],
  )
  const sequenceRank = useMemo(() => {
    if (!isSequence) return null
    return rankReviewGroupPhoto(reviewGroupPhotos, photo.id, sequenceIndex)
  }, [isSequence, photo.id, reviewGroupPhotos, sequenceIndex])
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
      const gradeByKey: Record<string, PhotoGrade> = {
        '1': 'select',
        '2': 'usable',
        '3': 'record',
        '4': 'reject',
      }
      const grade = gradeByKey[event.key]
      if (grade) {
        event.preventDefault()
        onSetDecision(photo.id, grade)
        flashHud(grade)
        return
      }
    }

    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [flashHud, fullscreenOpen, onClose, onSetDecision, photo.id, selectRelativePhoto])

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
          {hudFlash ? (
            <div
              aria-hidden="true"
              className={cn(
                'review-grade-hud',
                `review-grade-hud--${GRADE_HUD_TONE[hudFlash.grade]}`,
              )}
              key={hudFlash.nonce}
            >
              <span className="review-grade-hud__key">{GRADE_HUD_KEY[hudFlash.grade]}</span>
              <span className="review-grade-hud__label">
                {t(gradeLabelKey(hudFlash.grade))}
              </span>
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
              <span className="review-sequence__label">
                {isSequence
                  ? t('selection.review.sequenceLabel')
                  : t('selection.review.sequenceSingle')}
              </span>
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
              pose={showPose ? pose : null}
              afOverlay={null}
              photoId={photo.id}
              loupeEnabled={false}
              cropRect={iqaCrop}
              t={t}
              variant="crop"
              zoomScale={zoomScale}
            />
          </div>
        </div>

        <aside className="review-detail review-detail--compact">
          <div className="review-detail__body">
            {/* 顶部：分数 + 物种 + 分级 */}
            <ScoreHeader
              photo={photo}
              activeBird={activeBird}
              totalBirds={photo.birdDetections?.length ?? 0}
              t={t}
            />

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
              onSetActiveBirdIndex={setActiveBirdIndex}
              onSetSpeciesOverride={onSetSpeciesOverride}
              photo={photo}
              t={t}
            />

            <CompactKV label={t('selection.metrics.scene')} value={group?.title ?? '--'} />

            <CompactKV
              label={t('selection.review.sequenceLabel')}
              value={
                isSequence
                  ? t('selection.review.sequenceValue', {
                      count: reviewGroupPhotos.length,
                      rank: sequenceRank ?? '--',
                      score: formatScore(sequenceBestPhoto?.finalScore),
                    })
                  : t('selection.review.sequenceSingleValue')
              }
            />

            {photo.companionFormat && photo.companionPath ? (
              <CompactKV
                label={t('selection.review.companion')}
                value={t('selection.review.companionValue', {
                  format: photo.companionFormat,
                  size: formatBytes(photo.companionSize ?? 0),
                })}
              />
            ) : null}

            <ExifPanel exif={photo.exif} location={photo} t={t} />

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
            </div>
          </div>
        </aside>

        <ReviewFilmstrip
          activePhotoIndex={activeIndex}
          activePhotoId={photo.id}
          bestGroupPhotoId={sequenceBestPhoto?.id ?? null}
          groupPhotoOrderById={reviewGroupOrderById}
          onThumbnailLoadStatus={onThumbnailLoadStatus}
          onSelectPhoto={onSelectPhoto}
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
  // 默认折叠 — 用户大部分照片不需要改物种,折叠让信息密度降下来;点击当前物种行
  // 切换展开。photo 切换时不重置 expanded(用户可能正在批量审核物种,展开状态
  // 在多张间持续 OK)。
  const [expanded, setExpanded] = useState(false)
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
  const activeSpeciesSource = activeBird.speciesSource ?? photo.speciesSource
  const needsSpeciesReview =
    activeSpeciesSource === 'model_unconfirmed' && !activeBird.manualSpecies

  return (
    <div className={cn('species-editor', expanded && 'species-editor--expanded')}>
      <div className="species-editor__head">
        <SectionLabel label={t('selection.review.species')} />
        {activeBird.manualSpecies ? (
          <span className="species-editor__manual">{t('selection.speciesEditor.manual')}</span>
        ) : null}
      </div>

      {/* 多鸟图 bird tabs 在折叠头里 — 不展开就能切鸟,看不同 detection 的物种。
          切鸟按钮 stopPropagation 阻止冒泡到外层折叠 toggle。 */}
      {birds.length > 1 ? (
        <div className="species-editor__birds" role="tablist">
          {birds.map((bird) => (
            <button
              className={cn(
                'species-editor__bird',
                bird.index === activeBird.index && 'species-editor__bird--active',
              )}
              key={`${photo.id}-bird-${bird.index}`}
              onClick={(event) => {
                event.stopPropagation()
                onSetActiveBirdIndex(bird.index)
              }}
              type="button"
            >
              {t('selection.speciesEditor.bird')} {bird.index + 1}
            </button>
          ))}
        </div>
      ) : null}

      {/* 当前物种单行 + 展开切换 button — 默认折叠状态只展示这一行;
          点击切换 expanded。 */}
      <button
        aria-expanded={expanded}
        className="species-editor__current species-editor__current--toggle"
        onClick={() => setExpanded((v) => !v)}
        type="button"
      >
        <span>
          <strong>{currentName}</strong>
          <small>{activeBird.speciesLatinName ?? t('selection.speciesEditor.noLatin')}</small>
        </span>
        <ChevronDown
          aria-hidden="true"
          className={cn('species-editor__chevron', expanded && 'species-editor__chevron--open')}
        />
      </button>
      {needsSpeciesReview ? (
        <div className="species-editor__review-note" role="note">
          {t(
            expanded
              ? 'selection.speciesEditor.reviewHintExpanded'
              : 'selection.speciesEditor.reviewHintCollapsed',
          )}
        </div>
      ) : null}

      {/* 折叠状态:以上头部 + 当前物种行就够;展开才显示候选/搜索/清除。
          按 activeBird.speciesSource 判断（v6 detection-level）— 多鸟图混合可见性
          下，每个 detection 独立判断按钮显隐，不被 photo-level 一刀切。 */}
      {expanded ? (
        <>
          {needsSpeciesReview && activeBird.speciesLatinName ? (
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
        </>
      ) : null}
    </div>
  )
}

/**
 * 单独的图片舞台组件：
 * - cropRect 为 null → 显示完整原图（支持按住放大 + 拖动平移）
 * - cropRect 给定 → 用 background-position/size 缩放出该区域（IQA 裁切预览，不做 loupe）
 *
 * Loupe 交互(hold-to-zoom):
 *   按下 → 立即放大 + 锁定鼠标位置;移动 → 跟随平移;松开 → 立即还原。
 *   要锁定放大查看请用顶部 1.5×/2.5×/4× 倍率切换。
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
  const handlePointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
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
  const handlePointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const state = pointerStateRef.current
    if (!state || state.pointerId !== e.pointerId || !loupeActive) return
    if (Math.abs(e.clientX - state.startX) + Math.abs(e.clientY - state.startY) > 4) {
      state.moved = true
    }
    updateLoupePosition(e.currentTarget, e.clientX, e.clientY)
  }
  const handlePointerEnd = (e: React.PointerEvent<HTMLDivElement>) => {
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
      // imgW/imgH 在 EXIF 损坏或后端 bug 下可能是 0,会算出 Infinity 渲染到 -Inf 像素位置。
      if (imgW <= 0 || imgH <= 0) return null
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
    // AF 覆盖层：按 Canon 官方 AF area 语义两层渲染。
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

function bestReviewGroupPhoto(photos: PhotoRecord[]): PhotoRecord | null {
  let best: PhotoRecord | null = null
  for (const photo of photos) {
    if (!best) {
      best = photo
      continue
    }
    const diff = (photo.finalScore ?? -1) - (best.finalScore ?? -1)
    if (diff > 0 || (diff === 0 && photo.shotAt.localeCompare(best.shotAt) < 0)) best = photo
  }
  return best
}

function rankReviewGroupPhoto(
  photos: PhotoRecord[],
  activePhotoId: string,
  activeSequenceIndex: number,
): number | null {
  const activePhoto = activeSequenceIndex >= 0 ? (photos[activeSequenceIndex] ?? null) : null
  if (!activePhoto || activePhoto.id !== activePhotoId) return null
  const activeScore = activePhoto.finalScore ?? -1
  let rank = 1

  for (let index = 0; index < photos.length; index += 1) {
    if (index === activeSequenceIndex) continue
    const score = photos[index]?.finalScore ?? -1
    if (score > activeScore || (score === activeScore && index < activeSequenceIndex)) rank += 1
  }
  return rank
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

/** 字节数 → 人读字符串(MB / GB)。RAW 文件常 30-100 MB,误差 ±0.1 可接受。 */
function formatBytes(bytes: number): string {
  if (bytes <= 0) return '--'
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`
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

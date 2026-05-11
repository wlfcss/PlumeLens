/**
 * 选片页右侧 Inspector 面板 — 单照片场景显示详情/评级/外部编辑器入口,
 * 无选中照片场景显示文件夹"拍摄报告" (ShootingReportPanel)。
 *
 * 历史:之前住在 App.tsx,本次随 helpers/common/export/species 子树外迁后
 * 独立成模块。依赖的"photo display"派生 helpers (gradeTone /
 * tileSpeciesSourceBadge / formatPhotoSpeciesDisplay / getArchiveSpeciesEntries
 * 等)统一住在 @/lib/photo-display,避免本文件反向 import @/App。
 */

import {
  BadgePlus,
  Brush,
  CalendarDays,
  Camera,
  Check,
  Clock3,
  Sparkles,
  TrendingUp,
  Trophy,
  Wand2,
  X,
} from 'lucide-react'
import { useEffect, useMemo, useState, type ReactNode } from 'react'
import type { useTranslation } from 'react-i18next'

import { SectionLabel } from '@/components/common/section-label'
import { SpeciesNameAction } from '@/components/species/species-detail-popover'
import { gradeLabelKey, problemTagKey } from '@/lib/i18n-keys'
import type {
  FolderRecord,
  PhotoGroupRecord,
  PhotoRecord,
  SelectionDecision,
} from '@/lib/mock-workspace'
import {
  effectivePhotoGrade,
  effectiveSpeciesLatinName,
  effectiveSpeciesName,
  formatScore,
  type FolderSummary,
} from '@/lib/photo-helpers'
import {
  formatPhotoSpeciesDisplay,
  getArchiveSpeciesEntries,
  gradeTone,
  tileSpeciesSourceBadge,
} from '@/lib/photo-display'
import {
  speciesSourceBadge,
  speciesSourceKind,
  type DetectionLike,
} from '@/lib/species-source'
import { cn } from '@/lib/utils'

function useExternalEditors(): { topaz: string | null; photoshop: string | null } {
  const [editors, setEditors] = useState<{ topaz: string | null; photoshop: string | null }>({
    topaz: null,
    photoshop: null,
  })
  useEffect(() => {
    let cancelled = false
    void window.plumelens?.listEditors?.().then((result) => {
      if (cancelled) return
      setEditors(result)
    })
    return () => {
      cancelled = true
    }
  }, [])
  return editors
}

/** 编辑入口:Topaz / Photoshop "用 X 打开"。优先 RAW 同伴,无 RAW 用主文件。 */
function ExternalEditorActions({
  photo,
  sourceMissing,
  t,
}: {
  photo: PhotoRecord
  sourceMissing: boolean
  t: ReturnType<typeof useTranslation>['t']
}) {
  const editors = useExternalEditors()
  const [editorError, setEditorError] = useState<string | null>(null)
  // 优先 RAW 同伴(用户编辑通常想要原始数据);无 RAW 时用主 entry(JPG)
  const targetPath = photo.companionPath ?? photo.filePath ?? null
  useEffect(() => {
    setEditorError(null)
  }, [photo.id, targetPath])
  if (!targetPath) return null
  if (!editors.topaz && !editors.photoshop) return null

  const openIn = async (tool: 'topaz' | 'photoshop') => {
    setEditorError(null)
    if (sourceMissing) {
      setEditorError(t('selection.editor.error.source_missing'))
      return
    }
    const opener = window.plumelens?.openInEditor
    if (!opener) {
      setEditorError(t('selection.editor.error.spawn_failed'))
      return
    }
    try {
      const result = await opener(tool, targetPath)
      if (!result.ok) {
        setEditorError(t(`selection.editor.error.${result.reason}`))
      }
    } catch {
      setEditorError(t('selection.editor.error.spawn_failed'))
    }
  }
  const targetLabel = photo.companionPath
    ? t('selection.editor.targetRaw', { format: photo.companionFormat ?? 'RAW' })
    : t('selection.editor.targetMain')
  const disabledTitle = sourceMissing ? t('selection.editor.error.source_missing') : undefined
  return (
    <div className="inspector-editors">
      <span className="inspector-editors__hint">
        {t('selection.editor.label')} · {targetLabel}
      </span>
      <div className="inspector-editors__row">
        {editors.topaz ? (
          <button
            className="button-ghost button-compact"
            disabled={sourceMissing}
            onClick={() => void openIn('topaz')}
            title={disabledTitle ?? editors.topaz}
            type="button"
          >
            <Wand2 className="h-4 w-4" />
            {t('selection.editor.openInTopaz')}
          </button>
        ) : null}
        {editors.photoshop ? (
          <button
            className="button-ghost button-compact"
            disabled={sourceMissing}
            onClick={() => void openIn('photoshop')}
            title={disabledTitle ?? editors.photoshop}
            type="button"
          >
            <Brush className="h-4 w-4" />
            {t('selection.editor.openInPhotoshop')}
          </button>
        ) : null}
      </div>
      {editorError ? (
        <span className="inspector-editors__error" role="alert">
          {editorError}
        </span>
      ) : null}
    </div>
  )
}

function bestDetectionForInspector(photo: PhotoRecord): DetectionLike | null {
  const detections = photo.birdDetections ?? []
  return detections.find((d) => d.isBest) ?? detections[0] ?? null
}

function confidenceLabel(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return '--'
  const percent = value > 1 ? value : value * 100
  return `${percent >= 10 ? percent.toFixed(0) : percent.toFixed(1)}%`
}

function cleanExifString(value: unknown): string | null {
  if (typeof value === 'string') {
    const trimmed = value.trim()
    return trimmed.length > 0 ? trimmed : null
  }
  if (typeof value === 'number' && Number.isFinite(value)) return String(value)
  return null
}

function exifNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string') {
    const parsed = Number(value.trim())
    return Number.isFinite(parsed) ? parsed : null
  }
  return null
}

function formatShutterFromExif(exif: Record<string, unknown> | null | undefined): string {
  const raw = cleanExifString(exif?.ExposureTime)
  const value = exifNumber(exif?.ExposureTime)
  if (value === null || value <= 0) return raw ?? '--'
  if (value >= 1) return `${Number.isInteger(value) ? value.toFixed(0) : value.toFixed(1)} s`
  return `1/${Math.round(1 / value)} s`
}

function formatApertureFromExif(exif: Record<string, unknown> | null | undefined): string {
  const raw = cleanExifString(exif?.FNumber)
  const value = exifNumber(exif?.FNumber)
  if (value === null || value <= 0) return raw ?? '--'
  return `f/${value.toFixed(1)}`
}

function formatFocalFromExif(exif: Record<string, unknown> | null | undefined): string {
  const raw = cleanExifString(exif?.FocalLength)
  const value = exifNumber(exif?.FocalLength)
  if (value === null || value <= 0) return raw ?? '--'
  return `${Math.round(value)} mm`
}

function formatIsoFromExif(exif: Record<string, unknown> | null | undefined): string {
  const value = exif?.ISOSpeedRatings ?? exif?.PhotographicSensitivity ?? exif?.ISO
  if (value === null || value === undefined || value === '') return '--'
  if (Array.isArray(value)) {
    const first = value.find((item) => item !== null && item !== undefined && item !== '')
    return first === undefined ? '--' : `ISO ${String(first)}`
  }
  return `ISO ${String(value)}`
}

function formatInspectorPostureLabel(
  pose: PhotoRecord['bestPose'],
  t: ReturnType<typeof useTranslation>['t'],
): string {
  if (!pose) return t('selection.review.posture.noResult')
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

  const parts = [postureText, viewText].filter((part): part is string => Boolean(part))
  return parts.length > 0 ? parts.join(' · ') : t('selection.review.posture.unknown')
}

function InspectorSummaryCard({ children, title }: { children: ReactNode; title: string }) {
  return (
    <section className="inspector-summary-card">
      <h3>{title}</h3>
      {children}
    </section>
  )
}

function formatInspectorExposureLine(photo: PhotoRecord): string | null {
  const values = [
    formatShutterFromExif(photo.exif),
    formatApertureFromExif(photo.exif),
    formatIsoFromExif(photo.exif),
    formatFocalFromExif(photo.exif),
  ].filter((value) => value !== '--')
  return values.length > 0 ? values.join(' · ') : null
}

function InspectorHero({
  photo,
  t,
}: {
  photo: PhotoRecord
  t: ReturnType<typeof useTranslation>['t']
}) {
  const grade = effectivePhotoGrade(photo)
  const sourceLabel = photo.decision
    ? t('selection.gradeSource.manual')
    : t('selection.gradeSource.system')
  const exposureLine = formatInspectorExposureLine(photo)
  return (
    <div className="inspector-hero">
      <div className="inspector-hero__top">
        <div className="inspector-hero__score">
          <span>{t('selection.inspector.score')}</span>
          <strong>{formatScore(photo.finalScore)}</strong>
        </div>
        <span className={cn('inspector-grade-pill', `inspector-grade-pill--${gradeTone(grade)}`)}>
          {t(gradeLabelKey(grade))}
        </span>
      </div>
      <div className="inspector-hero__meta">
        <span title={photo.fileName}>{photo.fileName}</span>
        <em>{t('selection.inspector.gradeSource', { source: sourceLabel })}</em>
      </div>
      {exposureLine ? <p className="inspector-hero__capture">{exposureLine}</p> : null}
    </div>
  )
}

function InspectorSpeciesSection({
  bestDetection,
  photo,
  t,
}: {
  bestDetection: DetectionLike | null
  photo: PhotoRecord
  t: ReturnType<typeof useTranslation>['t']
}) {
  const tileSourceBadge = tileSpeciesSourceBadge(photo, t)
  const detectionBadgeLabel = speciesSourceBadge(photo, t, bestDetection)
  const detectionBadgeKind = speciesSourceKind(photo, bestDetection)
  const sourceBadge =
    tileSourceBadge ??
    (detectionBadgeLabel && detectionBadgeKind
      ? { kind: detectionBadgeKind, label: detectionBadgeLabel }
      : null)
  const candidates =
    bestDetection?.speciesCandidates && bestDetection.speciesCandidates.length > 0
      ? bestDetection.speciesCandidates
      : photo.speciesCandidates
  const latinName = effectiveSpeciesLatinName(photo)
  const speciesIdentity = {
    englishName: bestDetection?.speciesEnglishName ?? photo.speciesEnglishName ?? null,
    latinName: bestDetection?.speciesLatinName ?? latinName,
    name: bestDetection?.speciesName ?? effectiveSpeciesName(photo),
  }
  const primaryCandidate = candidates[0] ?? null

  return (
    <InspectorSummaryCard title={t('selection.inspector.speciesSection')}>
      <div className="inspector-species">
        <div className="inspector-species__identity">
          <strong>
            <SpeciesNameAction identity={speciesIdentity} t={t}>
              {formatPhotoSpeciesDisplay(photo, t)}
            </SpeciesNameAction>
          </strong>
          {sourceBadge ? (
            <em
              className={cn('species-source-inline', `species-source-inline--${sourceBadge.kind}`)}
            >
              {sourceBadge.label}
            </em>
          ) : null}
        </div>
        {latinName ? <span className="inspector-species__latin">{latinName}</span> : null}
        {primaryCandidate ? (
          <div className="inspector-species__signals">
            <span>
              {t('selection.inspector.topCandidate', {
                confidence: confidenceLabel(primaryCandidate.confidence),
              })}
            </span>
          </div>
        ) : null}
      </div>
    </InspectorSummaryCard>
  )
}

function formatInspectorVisibilitySummary(
  pose: PhotoRecord['bestPose'],
  t: ReturnType<typeof useTranslation>['t'],
): string {
  if (!pose) return t('selection.inspector.visibilitySummary.pending')
  const criticalParts = [
    { label: t('selection.metrics.head'), visible: pose.head_visible },
    { label: t('selection.metrics.eye'), visible: pose.eye_visible },
    { label: t('selection.metrics.body'), visible: pose.body_visible },
  ]
  const missing = criticalParts.filter((item) => item.visible === false).map((item) => item.label)
  if (missing.length > 0) {
    return t('selection.inspector.visibilitySummary.missing', { items: missing.join(' / ') })
  }
  if (criticalParts.every((item) => item.visible === true)) {
    return t('selection.inspector.visibilitySummary.clean')
  }
  return t('selection.inspector.visibilitySummary.pending')
}

function InspectorSubjectSection({
  bestDetection,
  photo,
  t,
}: {
  bestDetection: DetectionLike | null
  photo: PhotoRecord
  t: ReturnType<typeof useTranslation>['t']
}) {
  const pose = bestDetection?.pose ?? photo.bestPose ?? null
  const focusTags = photo.problemTags.slice(0, 2)

  return (
    <InspectorSummaryCard title={t('selection.inspector.subjectSection')}>
      <div className="inspector-subject">
        <div className="inspector-subject__posture">
          <strong>{formatInspectorPostureLabel(pose, t)}</strong>
          <span>{formatInspectorVisibilitySummary(pose, t)}</span>
          {pose?.posture_confidence ? <em>{confidenceLabel(pose.posture_confidence)}</em> : null}
        </div>
        {focusTags.length > 0 ? (
          <div className="inspector-focus-tags">
            {focusTags.map((tag) => (
              <span key={tag}>{t(problemTagKey(tag))}</span>
            ))}
          </div>
        ) : null}
      </div>
    </InspectorSummaryCard>
  )
}

type ShootingSpeciesStat = {
  key: string
  bestScore: number | null
  bestPhoto: PhotoRecord | null
  count: number
  latinName: string | null
  name: string
}

type ShootingRecordStat = ShootingSpeciesStat & {
  previousBestScore: number
  deltaScore: number
}

function formatShootingReportDateRange(
  photos: PhotoRecord[],
  t: ReturnType<typeof useTranslation>['t'],
) {
  const times = photos
    .map((photo) => Date.parse(photo.shotAt))
    .filter((value) => Number.isFinite(value))
    .toSorted((left, right) => left - right)
  if (times.length === 0) return t('selection.report.unknownTimeRange')
  const first = new Date(times[0])
  const last = new Date(times[times.length - 1])
  const format = (date: Date) =>
    `${date.toLocaleDateString(t('selection.dateLocale'), {
      month: '2-digit',
      day: '2-digit',
    })} ${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`
  if (first.toDateString() === last.toDateString()) {
    return `${format(first)}-${String(last.getHours()).padStart(2, '0')}:${String(last.getMinutes()).padStart(2, '0')}`
  }
  return `${format(first)} - ${format(last)}`
}

function buildShootingSpeciesStats(photos: PhotoRecord[]): ShootingSpeciesStat[] {
  const stats = new Map<string, ShootingSpeciesStat>()
  for (const photo of photos) {
    for (const entry of getArchiveSpeciesEntries(photo)) {
      const current = stats.get(entry.key)
      if (current) {
        current.count += 1
        if ((photo.finalScore ?? -1) > (current.bestScore ?? -1)) {
          current.bestScore = photo.finalScore
          current.bestPhoto = photo
        }
        continue
      }
      stats.set(entry.key, {
        key: entry.key,
        bestScore: photo.finalScore,
        bestPhoto: photo,
        count: 1,
        latinName: entry.latinName,
        name: entry.name,
      })
    }
  }
  return Array.from(stats.values()).toSorted((left, right) => {
    if (right.count !== left.count) return right.count - left.count
    return (right.bestScore ?? -1) - (left.bestScore ?? -1)
  })
}

function bestScoreBySpeciesForPhotos(photos: PhotoRecord[]): Map<string, number> {
  const best = new Map<string, number>()
  for (const photo of photos) {
    if (photo.finalScore === null) continue
    for (const entry of getArchiveSpeciesEntries(photo)) {
      const current = best.get(entry.key)
      if (current === undefined || photo.finalScore > current) {
        best.set(entry.key, photo.finalScore)
      }
    }
  }
  return best
}

function averageScoreForPhotos(photos: PhotoRecord[]): number | null {
  const scores = photos
    .map((photo) => photo.finalScore)
    .filter((score): score is number => score !== null && Number.isFinite(score))
  if (scores.length === 0) return null
  return scores.reduce((sum, score) => sum + score, 0) / scores.length
}

function ShootingReportMetric({
  icon,
  label,
  value,
}: {
  icon: ReactNode
  label: string
  value: string
}) {
  return (
    <div className="shooting-report-metric">
      <span className="shooting-report-metric__icon">{icon}</span>
      <div>
        <span>{label}</span>
        <strong>{value}</strong>
      </div>
    </div>
  )
}

function ShootingAchievementCard({
  icon,
  item,
  meta,
  scoreLabel,
  tone,
}: {
  icon: ReactNode
  item: ShootingSpeciesStat
  meta: string
  scoreLabel: string
  tone: 'new' | 'record'
}) {
  return (
    <div className={cn('shooting-achievement-card', `shooting-achievement-card--${tone}`)}>
      <span className="shooting-achievement-card__icon">{icon}</span>
      <div className="shooting-achievement-card__body">
        <strong>{item.name}</strong>
        <span>{meta}</span>
      </div>
      <div className="shooting-achievement-card__score">
        <small>{scoreLabel}</small>
        <b>{formatScore(item.bestScore)}</b>
      </div>
    </div>
  )
}

function ShootingReportPanel({
  allPhotos,
  folder,
  groups,
  photos,
  summary,
  t,
}: {
  allPhotos: PhotoRecord[]
  folder: FolderRecord
  groups: PhotoGroupRecord[]
  photos: PhotoRecord[]
  summary: FolderSummary
  t: ReturnType<typeof useTranslation>['t']
}) {
  const speciesStats = useMemo(() => buildShootingSpeciesStats(photos), [photos])
  const averageScore = useMemo(() => averageScoreForPhotos(photos), [photos])
  const historicalSpeciesKeys = useMemo(() => {
    const keys = new Set<string>()
    for (const photo of allPhotos) {
      if (photo.folderId === folder.id) continue
      for (const entry of getArchiveSpeciesEntries(photo)) keys.add(entry.key)
    }
    return keys
  }, [allPhotos, folder.id])
  const newSpeciesStats = useMemo(() => {
    return speciesStats.filter((item) => !historicalSpeciesKeys.has(item.key)).slice(0, 6)
  }, [historicalSpeciesKeys, speciesStats])
  const refreshedStats = useMemo<ShootingRecordStat[]>(() => {
    const previousBest = bestScoreBySpeciesForPhotos(
      allPhotos.filter((photo) => photo.folderId !== folder.id),
    )
    return speciesStats
      .flatMap((item) => {
        const previousBestScore = previousBest.get(item.key)
        if (previousBestScore === undefined) return []
        const currentBestScore = item.bestScore
        if (currentBestScore === null || currentBestScore <= previousBestScore + 0.0001) {
          return []
        }
        return [
          {
            ...item,
            previousBestScore,
            deltaScore: currentBestScore - previousBestScore,
          },
        ]
      })
      .toSorted((left, right) => right.deltaScore - left.deltaScore)
      .slice(0, 4)
  }, [allPhotos, folder.id, speciesStats])
  const keepCount =
    summary.gradeCounts.select + summary.gradeCounts.usable + summary.gradeCounts.record
  const reportText = useMemo(() => {
    if (photos.length === 0) return t('selection.report.emptySummary')
    const base = t('selection.report.summary', {
      average: formatScore(averageScore),
      birdPhotos: summary.birdPhotoCount,
      keep: keepCount,
      photos: photos.length,
      timeRange: formatShootingReportDateRange(photos, t),
    })
    let achievements = t('selection.report.noAchievementSummary')
    if (newSpeciesStats.length > 0 && refreshedStats.length > 0) {
      achievements = t('selection.report.achievementSummaryCombined', {
        newSpecies: newSpeciesStats.length,
        refreshed: refreshedStats.length,
      })
    } else if (newSpeciesStats.length > 0) {
      achievements = t('selection.report.achievementSummaryNewOnly', {
        newSpecies: newSpeciesStats.length,
      })
    } else if (refreshedStats.length > 0) {
      achievements = t('selection.report.achievementSummaryRefreshOnly', {
        refreshed: refreshedStats.length,
      })
    }
    return `${base}${achievements}`
  }, [averageScore, keepCount, newSpeciesStats.length, photos, refreshedStats.length, summary, t])

  return (
    <div className="shooting-report" data-testid="shooting-report">
      <div className="shooting-report__hero">
        <div>
          <SectionLabel label={t('selection.report.label')} />
          <h2>{t('selection.report.title')}</h2>
          <p>{reportText}</p>
        </div>
        <span className="shooting-report__hero-icon">
          <Trophy className="h-5 w-5" />
        </span>
      </div>

      <div className="shooting-report__metrics">
        <ShootingReportMetric
          icon={<CalendarDays className="h-3.5 w-3.5" />}
          label={t('selection.report.shootingWindow')}
          value={formatShootingReportDateRange(photos, t)}
        />
        <ShootingReportMetric
          icon={<Camera className="h-3.5 w-3.5" />}
          label={t('selection.report.photoCount')}
          value={t('selection.report.photoCountValue', { count: photos.length })}
        />
        <ShootingReportMetric
          icon={<Sparkles className="h-3.5 w-3.5" />}
          label={t('selection.report.averageScore')}
          value={formatScore(averageScore)}
        />
        <ShootingReportMetric
          icon={<Check className="h-3.5 w-3.5" />}
          label={t('selection.report.keepFrames')}
          value={t('selection.report.photoCountValue', { count: keepCount })}
        />
      </div>

      <div className="shooting-report__section shooting-report__section--new">
        <div className="shooting-report__section-head">
          <BadgePlus className="h-4 w-4" />
          <h3>{t('selection.report.newSpecies')}</h3>
        </div>
        {newSpeciesStats.length > 0 ? (
          <div className="shooting-achievement-list">
            {newSpeciesStats.map((item) => (
              <ShootingAchievementCard
                icon={<Sparkles className="h-4 w-4" />}
                item={item}
                key={item.key}
                meta={t('selection.report.speciesAchievementMeta', {
                  count: item.count,
                  file: item.bestPhoto?.fileName ?? '--',
                })}
                scoreLabel={t('selection.report.highestScore')}
                tone="new"
              />
            ))}
          </div>
        ) : (
          <p>{t('selection.report.noNewSpecies')}</p>
        )}
      </div>

      {refreshedStats.length > 0 ? (
        <div className="shooting-report__section shooting-report__section--record">
          <div className="shooting-report__section-head">
            <TrendingUp className="h-4 w-4" />
            <h3>{t('selection.report.refreshedSpecies')}</h3>
          </div>
          <div className="shooting-achievement-list">
            {refreshedStats.map((item) => (
              <ShootingAchievementCard
                icon={<Trophy className="h-4 w-4" />}
                item={item}
                key={item.key}
                meta={t('selection.report.refreshedSpeciesMeta', {
                  delta: `+${(item.deltaScore * 100).toFixed(1)}`,
                  previous: formatScore(item.previousBestScore),
                })}
                scoreLabel={t('selection.report.newHighScore')}
                tone="record"
              />
            ))}
          </div>
        </div>
      ) : null}

      <div className="shooting-report__footnote">
        {t('selection.report.contextLine', {
          scenes: groups.length,
          species: speciesStats.length,
        })}
      </div>
    </div>
  )
}

export function InspectorPanel({
  allPhotos,
  folder,
  folderGroups,
  folderPhotos,
  folderSummary,
  onOpenReview,
  onSetDecision,
  photo,
  setFocusedPhotoId,
  sourceMissing,
  t,
}: {
  allPhotos: PhotoRecord[]
  folder: FolderRecord
  folderGroups: PhotoGroupRecord[]
  folderPhotos: PhotoRecord[]
  folderSummary: FolderSummary
  onOpenReview: (photoId: string) => void
  onSetDecision: (photoId: string, decision: SelectionDecision) => void
  photo: PhotoRecord | null
  setFocusedPhotoId: (photoId: string | null) => void
  sourceMissing: boolean
  t: ReturnType<typeof useTranslation>['t']
}) {
  const bestDetection = photo ? bestDetectionForInspector(photo) : null
  return (
    <aside className="inspector selection-scroll">
      <SectionLabel label={t('selection.inspector.label')} />
      {photo ? (
        <div className="inspector__content">
          <div className="inspector__body selection-scroll">
            <div className="inspector-preview" style={{ backgroundImage: photo.previewGradient }} />
            <InspectorHero photo={photo} t={t} />
            <InspectorSpeciesSection bestDetection={bestDetection} photo={photo} t={t} />
            <InspectorSubjectSection bestDetection={bestDetection} photo={photo} t={t} />
            <ExternalEditorActions photo={photo} sourceMissing={sourceMissing} t={t} />
          </div>
          <div className="inspector-actions" aria-label={t('selection.actions.label')}>
            <div className="inspector-actions__grades">
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
            <div className="inspector-actions__secondary">
              <button className="text-button" onClick={() => onOpenReview(photo.id)} type="button">
                {t('selection.review.label')}
              </button>
              <button className="text-button" onClick={() => setFocusedPhotoId(null)} type="button">
                {t('selection.inspector.clear')}
              </button>
            </div>
          </div>
        </div>
      ) : (
        <ShootingReportPanel
          allPhotos={allPhotos}
          folder={folder}
          groups={folderGroups}
          photos={folderPhotos}
          summary={folderSummary}
          t={t}
        />
      )}
    </aside>
  )
}

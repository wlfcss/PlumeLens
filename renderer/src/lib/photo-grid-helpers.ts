/**
 * 选片网格家族的数据派生 helpers — 连拍堆叠分段(burst segment)算法、
 * 排序、group 标题文案、tile 辅助 helpers。
 *
 * 历史:之前住在 App.tsx,本次抽出与 photo grid components 一同迁出。
 *
 * 关键算法:连拍分段 buildPhotoSegments
 *   按 shotTime asc 排序后逐对判断是否切段:
 *   - 语义边界(物种不同 + bbox 不连续 / 鸟数 0↔非0):切
 *   - 时间间隔 > HARD_GAP (12s):切
 *   - 时间间隔 > RAPID_GAP (1.2s) + (鸟数变化或强几何断点):切
 *   - 时间间隔 > SOFT_GAP (3s) 且主体连续性弱:切
 */

import type { useTranslation } from 'react-i18next'

import type {
  AnalysisStatus,
  PhotoGrade,
  PhotoGroupRecord,
  PhotoRecord,
  SelectionDecision,
} from '@/lib/mock-workspace'
import { gradeLabelKey } from '@/lib/i18n-keys'
import {
  effectivePhotoGrade,
  effectiveSpeciesLatinName,
  effectiveSpeciesName,
  type Tone,
} from '@/lib/photo-helpers'
import type { PhotoCategory } from '@/lib/photo-display'

// 网格基础尺寸(单 tile 最小列宽 + 列间距)
export const PHOTO_GRID_MIN_COLUMN_WIDTH = 260
export const PHOTO_GRID_GAP = 18
export const PHOTO_GROUP_HEADER_ESTIMATED_HEIGHT = 72
export const PHOTO_GROUP_ITEM_GAP = 30

// 连拍堆叠时间窗(ms)
const BURST_SEGMENT_RAPID_GAP_MS = 1_200
const BURST_SEGMENT_SOFT_GAP_MS = 3_000
const BURST_SEGMENT_HARD_GAP_MS = 12_000

// 档位优先级:精选(3) > 可用(2) > 记录(1) > 淘汰(0)
const GRADE_RANK: Record<PhotoGrade, number> = {
  select: 3,
  usable: 2,
  record: 1,
  reject: 0,
}

export type PhotoSegment = {
  id: string
  photos: PhotoRecord[]
  coverPhoto: PhotoRecord
}

export type SegmentExpansionOverrides = Record<string, string[]>

export type StackCollapseControl = {
  count: number
  onCollapse: () => void
}

type NormalizedBBox = {
  x1: number
  y1: number
  x2: number
  y2: number
}

type BBoxContinuity = {
  centerDistance: number
  iou: number
  sizeRatio: number
}

export type SortMode = 'score' | 'shot_at' | 'name'

export const EMPTY_PHOTOS: PhotoRecord[] = []
export const EMPTY_SEGMENTS: PhotoSegment[] = []
export const EMPTY_STRING_ARRAY: string[] = []

function photoShotMs(photo: PhotoRecord): number | null {
  const ts = Date.parse(photo.shotAt)
  return Number.isFinite(ts) ? ts : null
}

export function comparePhotosByShotTimeAsc(left: PhotoRecord, right: PhotoRecord): number {
  const leftTs = photoShotMs(left)
  const rightTs = photoShotMs(right)
  if (leftTs !== null && rightTs !== null && leftTs !== rightTs) return leftTs - rightTs
  if (leftTs !== null && rightTs === null) return -1
  if (leftTs === null && rightTs !== null) return 1
  return left.fileName.localeCompare(right.fileName)
}

function comparePhotosByShotTimeDesc(left: PhotoRecord, right: PhotoRecord): number {
  const leftTs = photoShotMs(left)
  const rightTs = photoShotMs(right)
  if (leftTs !== null && rightTs !== null && leftTs !== rightTs) return rightTs - leftTs
  if (leftTs !== null && rightTs === null) return -1
  if (leftTs === null && rightTs !== null) return 1
  return left.fileName.localeCompare(right.fileName)
}

export function comparePhotosByScoreDesc(left: PhotoRecord, right: PhotoRecord): number {
  // 综合评分（默认）：先按档位降序（精选 → 可用 → 记录 → 淘汰），
  // 同档内按 quality_score 降序。
  const gradeDiff = GRADE_RANK[effectivePhotoGrade(right)] - GRADE_RANK[effectivePhotoGrade(left)]
  if (gradeDiff !== 0) return gradeDiff
  const scoreDiff = (right.finalScore ?? -1) - (left.finalScore ?? -1)
  if (scoreDiff !== 0) return scoreDiff
  return comparePhotosByShotTimeDesc(left, right)
}

function comparePhotosBySort(left: PhotoRecord, right: PhotoRecord, sortBy: SortMode): number {
  if (sortBy === 'name') {
    const nameDiff = left.fileName.localeCompare(right.fileName)
    if (nameDiff !== 0) return nameDiff
    return comparePhotosByShotTimeAsc(left, right)
  }
  if (sortBy === 'shot_at') return comparePhotosByShotTimeDesc(left, right)
  return comparePhotosByScoreDesc(left, right)
}

export function sortPhotos(photos: PhotoRecord[], sortBy: SortMode): PhotoRecord[] {
  return photos.toSorted((left, right) => comparePhotosBySort(left, right, sortBy))
}

export function bestPhotoForStack(photos: PhotoRecord[]): PhotoRecord | null {
  let best: PhotoRecord | null = null
  for (const photo of photos) {
    if (!best) {
      best = photo
      continue
    }
    if (comparePhotosByScoreDesc(photo, best) < 0) best = photo
  }
  return best
}

function normalizedBestBBox(photo: PhotoRecord): NormalizedBBox | null {
  const bbox = photo.bestBbox
  if (
    bbox &&
    photo.imageWidth &&
    photo.imageHeight &&
    photo.imageWidth > 0 &&
    photo.imageHeight > 0
  ) {
    return {
      x1: bbox.x1 / photo.imageWidth,
      y1: bbox.y1 / photo.imageHeight,
      x2: bbox.x2 / photo.imageWidth,
      y2: bbox.y2 / photo.imageHeight,
    }
  }

  const box = photo.boxes[0]
  if (!box) return null
  return {
    x1: box.x / 100,
    y1: box.y / 100,
    x2: (box.x + box.w) / 100,
    y2: (box.y + box.h) / 100,
  }
}

function bboxArea(box: NormalizedBBox): number {
  return Math.max(0, box.x2 - box.x1) * Math.max(0, box.y2 - box.y1)
}

function bboxContinuity(leftPhoto: PhotoRecord, rightPhoto: PhotoRecord): BBoxContinuity | null {
  const left = normalizedBestBBox(leftPhoto)
  const right = normalizedBestBBox(rightPhoto)
  if (!left || !right) return null

  const interX1 = Math.max(left.x1, right.x1)
  const interY1 = Math.max(left.y1, right.y1)
  const interX2 = Math.min(left.x2, right.x2)
  const interY2 = Math.min(left.y2, right.y2)
  const interArea = Math.max(0, interX2 - interX1) * Math.max(0, interY2 - interY1)
  const leftArea = bboxArea(left)
  const rightArea = bboxArea(right)
  const union = leftArea + rightArea - interArea
  const leftCx = (left.x1 + left.x2) / 2
  const leftCy = (left.y1 + left.y2) / 2
  const rightCx = (right.x1 + right.x2) / 2
  const rightCy = (right.y1 + right.y2) / 2
  const centerDistance = Math.hypot(leftCx - rightCx, leftCy - rightCy) / Math.SQRT2
  const minArea = Math.max(0.0001, Math.min(leftArea, rightArea))
  const maxArea = Math.max(leftArea, rightArea)

  return {
    centerDistance,
    iou: union > 0 ? interArea / union : 0,
    sizeRatio: maxArea / minArea,
  }
}

function segmentSpeciesKey(photo: PhotoRecord): string | null {
  if ((photo.birdCount ?? 0) <= 0) return 'no-bird'
  const latin = effectiveSpeciesLatinName(photo)
  if (latin) return `latin:${latin}`
  const name = effectiveSpeciesName(photo)
  return name ? `name:${name}` : null
}

function hasSemanticSegmentBreak(left: PhotoRecord, right: PhotoRecord): boolean {
  const leftHasBird = (left.birdCount ?? 0) > 0
  const rightHasBird = (right.birdCount ?? 0) > 0
  if (leftHasBird !== rightHasBird) return true

  const leftSpecies = segmentSpeciesKey(left)
  const rightSpecies = segmentSpeciesKey(right)
  if (
    leftSpecies &&
    rightSpecies &&
    leftSpecies !== 'no-bird' &&
    rightSpecies !== 'no-bird' &&
    leftSpecies !== rightSpecies
  ) {
    const continuity = bboxContinuity(left, right)
    // 同一主体在相邻帧 bbox 高度重合时，物种差异通常是模型候选抖动
    // （如"寿带/印度寿带/待审"），不应把同一连拍堆叠切碎。
    if (continuity && (continuity.iou >= 0.35 || continuity.centerDistance <= 0.08)) {
      return false
    }
    return true
  }
  return false
}

function hasStrongGeometryBreak(left: PhotoRecord, right: PhotoRecord): boolean {
  const continuity = bboxContinuity(left, right)
  if (!continuity) return false
  return (
    (continuity.iou < 0.03 && continuity.centerDistance > 0.3) ||
    (continuity.centerDistance > 0.28 && continuity.sizeRatio > 2.4)
  )
}

function hasWeakSubjectContinuity(left: PhotoRecord, right: PhotoRecord): boolean {
  const leftSpecies = segmentSpeciesKey(left)
  const rightSpecies = segmentSpeciesKey(right)
  if (leftSpecies && leftSpecies === rightSpecies) return true

  const continuity = bboxContinuity(left, right)
  if (!continuity) return false
  return continuity.iou >= 0.08 || (continuity.centerDistance <= 0.22 && continuity.sizeRatio <= 2)
}

function shouldSplitPhotoSegment(previous: PhotoRecord, current: PhotoRecord): boolean {
  const previousTs = photoShotMs(previous)
  const currentTs = photoShotMs(current)
  const gap = previousTs !== null && currentTs !== null ? Math.max(0, currentTs - previousTs) : null

  if (hasSemanticSegmentBreak(previous, current)) return true
  if (gap !== null && gap > BURST_SEGMENT_HARD_GAP_MS) return true

  const birdCountDelta = Math.abs((previous.birdCount ?? 0) - (current.birdCount ?? 0))
  if (
    gap !== null &&
    gap > BURST_SEGMENT_RAPID_GAP_MS &&
    (birdCountDelta >= 1 || hasStrongGeometryBreak(previous, current))
  ) {
    return true
  }

  if (
    gap !== null &&
    gap > BURST_SEGMENT_SOFT_GAP_MS &&
    !hasWeakSubjectContinuity(previous, current)
  ) {
    return true
  }

  return false
}

function createPhotoSegment(photos: PhotoRecord[], index: number): PhotoSegment | null {
  if (photos.length === 0) return null
  const first = photos[0]
  const last = photos[photos.length - 1] ?? first
  const coverPhoto = bestPhotoForStack(photos) ?? first
  return {
    id: `${first.groupId}:${first.id}:${last.id}:${photos.length}:${index}`,
    photos,
    coverPhoto,
  }
}

export function buildPhotoSegments(photos: PhotoRecord[]): PhotoSegment[] {
  if (photos.length === 0) return []
  const ordered = photos.toSorted(comparePhotosByShotTimeAsc)
  const segments: PhotoSegment[] = []
  let current: PhotoRecord[] = []
  let previous: PhotoRecord | null = null

  for (const photo of ordered) {
    const shouldSplit =
      current.length > 0 && previous !== null && shouldSplitPhotoSegment(previous, photo)

    if (shouldSplit) {
      const segment = createPhotoSegment(current, segments.length)
      if (segment) segments.push(segment)
      current = []
    }

    current.push(photo)
    previous = photo
  }

  const tail = createPhotoSegment(current, segments.length)
  if (tail) segments.push(tail)
  return segments
}

function defaultExpandedSegmentIdsForSegments(segments: PhotoSegment[]): Set<string> {
  const stackSegments = segments.filter((segment) => segment.photos.length > 1)
  return stackSegments.length === 1 ? new Set([stackSegments[0].id]) : new Set()
}

export function resolveExpandedSegmentIdsForSegments(
  segments: PhotoSegment[],
  override: string[] | undefined,
): Set<string> {
  const validIds = new Set(segments.map((segment) => segment.id))
  const source = override ?? Array.from(defaultExpandedSegmentIdsForSegments(segments))
  return new Set(source.filter((id) => validIds.has(id)))
}

export function visibleTileCountForSegments(
  segments: PhotoSegment[],
  expandedSegmentIds: Set<string>,
) {
  const stackSegments = segments.filter((segment) => segment.photos.length > 1)
  if (stackSegments.length === 0) {
    return segments.reduce((count, segment) => count + segment.photos.length, 0)
  }
  return stackSegments.reduce(
    (count, segment) => count + (expandedSegmentIds.has(segment.id) ? segment.photos.length : 1),
    0,
  )
}

function formatGroupClock(value: string | null | undefined): string | null {
  if (!value) return null
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return null
  const hh = String(date.getHours()).padStart(2, '0')
  const mm = String(date.getMinutes()).padStart(2, '0')
  return `${hh}:${mm}`
}

function parseGroupTitleTime(title: string): string | null {
  return title.match(/\b(\d{1,2}:\d{2})\b/)?.[1] ?? null
}

function parseGroupTitleScene(title: string): number | null {
  const match = title.match(/(?:场景|Scene)\s*#(\d+)/i)
  if (!match?.[1]) return null
  const scene = Number.parseInt(match[1], 10)
  return Number.isFinite(scene) ? scene : null
}

function groupSpanSeconds(group: PhotoGroupRecord): number | null {
  if (!group.startAt || !group.endAt) return null
  const start = Date.parse(group.startAt)
  const end = Date.parse(group.endAt)
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return null
  return Math.round((end - start) / 1000)
}

export function visibleGroupTitle(
  group: PhotoGroupRecord,
  visiblePhotoCount: number,
  t: ReturnType<typeof useTranslation>['t'],
): string {
  const time = formatGroupClock(group.startAt) ?? parseGroupTitleTime(group.title) ?? '--:--'
  const originalPhotoCount = group.originalPhotoCount ?? visiblePhotoCount
  const sceneNumber = group.sceneNumber ?? parseGroupTitleScene(group.title)

  if (sceneNumber === null) {
    if (visiblePhotoCount === 1 && originalPhotoCount <= 1) {
      return t('selection.group.pendingTitle', { time })
    }
    return t('selection.group.pendingCountTitle', { count: visiblePhotoCount, time })
  }

  if (visiblePhotoCount === 1 && originalPhotoCount <= 1) {
    return t('selection.group.singleTitle', { scene: sceneNumber, time })
  }

  const spanSec = groupSpanSeconds(group)
  if (spanSec !== null && spanSec >= 60 && visiblePhotoCount === originalPhotoCount) {
    return t('selection.group.durationTitle', {
      count: visiblePhotoCount,
      minutes: Math.round(spanSec / 60),
      scene: sceneNumber,
      time,
    })
  }

  return t('selection.group.countTitle', {
    count: visiblePhotoCount,
    scene: sceneNumber,
    time,
  })
}

export function decisionTone(decision: SelectionDecision): Tone {
  if (decision === 'select' || decision === 'usable') return 'success'
  if (decision === 'record') return 'warning'
  if (decision === 'reject') return 'accent'
  return 'muted'
}

export function analysisTone(status: AnalysisStatus): Tone {
  if (status === 'done') return 'success'
  if (status === 'running') return 'warning'
  if (status === 'failed') return 'accent'
  return 'neutral'
}

/** 把后端 analysisErrorCode 翻译成本地化 tooltip;没匹配上的 code 退回到原始
 *  英文 error message;啥都没有时退回到通用"分析失败"文案。 */
export function analysisErrorTooltip(
  photo: PhotoRecord,
  t: ReturnType<typeof useTranslation>['t'],
): string | undefined {
  const code = photo.analysisErrorCode
  if (code) {
    const key = `selection.analysisError.${code}`
    const translated = t(key)
    // i18next 没找到 key 会原样返回 key 字符串 — 此时 fallback 到 raw error
    if (translated !== key) return translated
  }
  if (photo.analysisError) return photo.analysisError
  return t('selection.analysisError.unknown')
}

export function categoryLabelKey(category: PhotoCategory) {
  return category === 'no_bird' ? 'selection.quickFilters.no_bird' : gradeLabelKey(category)
}

/** 复核连拍照片顺序 — 内部按段落构造,堆叠段在同段内被一起展开。 */
export function buildReviewPhotoOrderForGroup(photos: PhotoRecord[]): PhotoRecord[] {
  const segments = buildPhotoSegments(photos)
  const hasStackSegments = segments.some((segment) => segment.photos.length > 1)
  const visibleSegments = hasStackSegments
    ? segments.filter((segment) => segment.photos.length > 1)
    : segments
  return visibleSegments.flatMap((segment) => segment.photos)
}

export function buildReviewPhotoOrderForGroupedEntries(
  entries: Array<{ group: PhotoGroupRecord; photos: PhotoRecord[] }>,
): PhotoRecord[] {
  return entries.flatMap((entry) => buildReviewPhotoOrderForGroup(entry.photos))
}

export function buildGroupStartMsMap(
  photos: Array<Pick<PhotoRecord, 'groupId' | 'shotAt'>>,
): Map<string, number> {
  const starts = new Map<string, number>()
  for (const photo of photos) {
    const ts = Date.parse(photo.shotAt)
    if (!Number.isFinite(ts)) continue
    const current = starts.get(photo.groupId)
    if (current === undefined || ts < current) {
      starts.set(photo.groupId, ts)
    }
  }
  return starts
}

export function compareGroupStartDesc(
  left: { group: PhotoGroupRecord; photos: PhotoRecord[] },
  right: { group: PhotoGroupRecord; photos: PhotoRecord[] },
  groupStartMs: Map<string, number>,
): number {
  const leftStart = groupStartMs.get(left.group.id) ?? Number.NEGATIVE_INFINITY
  const rightStart = groupStartMs.get(right.group.id) ?? Number.NEGATIVE_INFINITY
  if (leftStart !== rightStart) return rightStart - leftStart
  return left.group.id.localeCompare(right.group.id)
}

/** 用于复核连拍照片同段筛选 — 按 photo.id → 所属段所有 photos 反查表。 */
export function buildReviewSegmentPhotosByPhotoId(
  photos: PhotoRecord[],
): Map<string, PhotoRecord[]> {
  const groups = new Map<string, PhotoRecord[]>()
  for (const photo of photos) {
    const key = `${photo.folderId} ${photo.groupId}`
    const groupPhotos = groups.get(key)
    if (groupPhotos) {
      groupPhotos.push(photo)
    } else {
      groups.set(key, [photo])
    }
  }

  const segmentsByPhotoId = new Map<string, PhotoRecord[]>()
  for (const groupPhotos of groups.values()) {
    const segments = buildPhotoSegments(groupPhotos)

    for (const segment of segments) {
      if (segment.photos.length <= 1) continue
      for (const photo of segment.photos) {
        segmentsByPhotoId.set(photo.id, segment.photos)
      }
    }
  }
  return segmentsByPhotoId
}

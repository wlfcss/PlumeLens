import {
  Aperture,
  ArrowLeft,
  ArrowRight,
  Brush,
  Check,
  Clock3,
  Download,
  Feather,
  FolderOpen,
  FolderSearch2,
  Images,
  LibraryBig,
  PencilLine,
  RefreshCw,
  Search,
  Settings2,
  Shield,
  Sparkles,
  Trophy,
  Wand2,
  X,
} from 'lucide-react'
import {
  Suspense,
  lazy,
  startTransition,
  useCallback,
  useDeferredValue,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
  type RefObject,
} from 'react'
import { useTranslation } from 'react-i18next'
import { useVirtualizer } from '@tanstack/react-virtual'

import { EngineStatusBanner } from '@/components/engine-status-banner'
import { ReviewModal } from '@/components/review/review-modal'
import { SettingsModal } from '@/components/settings-modal'
import { ThumbnailImage, type ThumbnailLoadStatus } from '@/components/thumbnail-image'
import { useAnalysisProgress, useStartBatch } from '@/hooks/use-analysis'
import { useBackendHealth } from '@/hooks/use-backend'
import { useSetDecision, useSetSpeciesOverride } from '@/hooks/use-decisions'
import {
  LIBRARY_DETAIL_KEY,
  useAllLibraryDetails,
  useBuildPhotoThumbnail,
  useImportLibrary,
  useLibraries,
  useLibraryDetail,
  useLibraryEvents,
  useRelinkLibrary,
  useUpdateLibrary,
} from '@/hooks/use-library'
import { useQueryClient } from '@tanstack/react-query'
import { buildFragmentFromDetail } from '@/lib/backend-adapter'
import type {
  AnalysisProgressEvent,
  DecisionValue,
  ExportLibraryResponse,
  LibraryDetail,
  SpeciesOverrideBBox,
  SpeciesOverrideValue,
} from '@/lib/api-client'
import { api } from '@/lib/api-client'

type AnalysisProgressEventLite = AnalysisProgressEvent
import {
  getSpeciesWiki,
  listAllSpecies,
  normalizeSpeciesAlias,
  resolveSpeciesCanonicalSci,
} from '@/lib/species-wiki'
import type {
  AfOverlay,
  AnalysisStatus,
  ArchiveTab,
  AppRoute,
  FolderRecord,
  FolderStatus,
  PhotoGrade,
  PhotoGroupRecord,
  PhotoRecord,
  ProblemTagId,
  PoseTagId,
  SceneTagId,
  SelectionDecision,
  SpeciesRecord,
  WorkspaceSnapshot,
} from '@/lib/mock-workspace'
import { createImportedFolder } from '@/lib/mock-workspace'
import { cn } from '@/lib/utils'
import { useShallow, useUIStore, type QuickFilter, type ViewMode } from '@/stores/ui-store'
import { subscribeEngineStatus, useEngineStore } from '@/stores/engine-store'

const PHOTO_GRID_MIN_COLUMN_WIDTH = 260
const PHOTO_GRID_GAP = 18
const PHOTO_GROUP_ESTIMATED_HEIGHT = 460
const BURST_SEGMENT_RAPID_GAP_MS = 1_200
const BURST_SEGMENT_SOFT_GAP_MS = 3_000
const BURST_SEGMENT_HARD_GAP_MS = 12_000
const COLLECTION_GRID_MIN_COLUMN_WIDTH = 150
const COLLECTION_GRID_GAP = 8
const COLLECTION_HEADING_ESTIMATED_HEIGHT = 52
const COLLECTION_CARD_ROW_ESTIMATED_HEIGHT = 204

const ArchiveGeoMap = lazy(() =>
  import('@/components/archive-geo-map').then((module) => ({ default: module.ArchiveGeoMap })),
)

type Tone = 'neutral' | 'warning' | 'accent' | 'success' | 'muted'
type SortMode = 'score' | 'shot_at' | 'name'
type PhotoCategory = PhotoGrade | 'no_bird'
type ExportLayout = 'merged' | 'by_grade'
type ExportContentMode = 'files' | 'files_xmp' | 'xmp_only'

type PhotoSegment = {
  id: string
  photos: PhotoRecord[]
  coverPhoto: PhotoRecord
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

type FolderSummary = {
  newSpeciesCount: number
  birdPhotoCount: number
  noBirdCount: number
  speciesCount: number
  gradeCounts: Record<PhotoGrade, number>
}

type ExportSourceSnapshot = {
  folder: FolderRecord
  photos: PhotoRecord[]
  summary: FolderSummary
}

type ExportSession = {
  id: string
  folderId: string
  initialSource: ExportSourceSnapshot
}

type ResponsiveGridLayout = {
  columns: number
  width: number
}

type CollectionVirtualRow =
  | {
      type: 'heading'
      group: SpeciesCollectionGroup
      litCount: number
      firstGroup: boolean
    }
  | {
      type: 'cards'
      groupId: SpeciesCollectionGroupId
      species: SpeciesRecord[]
    }

type ExportOptionsSnapshot = {
  grades: PhotoGrade[]
  min: number | null
  max: number | null
  layout: ExportLayout
  contentMode: ExportContentMode
  targetDir: string
}

type FolderContextMenuState = {
  folder: FolderRecord
  x: number
  y: number
} | null

const FOLDER_CONTEXT_MENU_WIDTH = 188
const FOLDER_CONTEXT_MENU_HEIGHT = 88

const EMPTY_PHOTOS: PhotoRecord[] = []
const EMPTY_SPECIES: SpeciesRecord[] = []
const EMPTY_FOLDER_SUMMARY: FolderSummary = {
  newSpeciesCount: 0,
  birdPhotoCount: 0,
  noBirdCount: 0,
  speciesCount: 0,
  gradeCounts: { reject: 0, record: 0, usable: 0, select: 0 },
}

export type ReviewDetail = {
  photo: PhotoRecord
  group: PhotoGroupRecord | null
}

const routeIcons: Record<AppRoute, typeof Aperture> = {
  start: Aperture,
  selection: Sparkles,
  archive: LibraryBig,
}

const THUMBNAIL_REPAIR_COOLDOWN_MS = 30_000
const THUMBNAIL_REPAIR_MAX_CONCURRENT = 4
// 可见卡片已经分析完成但 thumb_grid 仍为空时,把它当作交互优先补图任务。
// 仍先给 query/SSE 一个很短窗口,避免和后台 thumbnail batch 完全撞车。
const THUMBNAIL_MISSING_REPAIR_DELAY_MS = 600

const quickFilters: QuickFilter[] = ['select', 'usable', 'record', 'reject', 'no_bird']

const archiveTabs: ArchiveTab[] = ['species', 'map']
type SpeciesCollectionFilter = 'all' | 'collected' | SpeciesCollectionGroupId
const viewModes: ViewMode[] = ['grouped', 'flat']
const sortModes: SortMode[] = ['score', 'shot_at', 'name']
const speciesCatalog = listAllSpecies()

type SpeciesCatalogItem = (typeof speciesCatalog)[number]
type SpeciesCollectionGroupId =
  | 'protected1'
  | 'protected2'
  | 'threatened'
  | 'regular'
  | 'modelExtra'
type SpeciesCollectionGroup = {
  id: SpeciesCollectionGroupId
  litCount: number
  species: SpeciesRecord[]
}
const speciesCollectionGroupOrder: SpeciesCollectionGroupId[] = [
  'protected1',
  'protected2',
  'threatened',
  'regular',
  'modelExtra',
]
const archiveEligibleGrades = new Set<PhotoGrade>(['select', 'usable', 'record'])
const unknownSpeciesAliases = new Set(['未识别物种', 'unidentified', 'unknown species', 'unknown'])
export type ArchiveSpeciesEntry = {
  key: string
  name: string
  latinName: string
  englishName: string | null
}
type MapRegionId =
  | 'northeast'
  | 'north'
  | 'east'
  | 'central'
  | 'south'
  | 'southwest'
  | 'northwest'
  | 'qinghaiTibet'

export interface ArchiveMapPin {
  id: string
  speciesId: string
  speciesName: string
  latinName: string
  regionId: MapRegionId
  regionLabelKey: string
  x: number
  y: number
  photos: PhotoRecord[]
  source: 'gps'
}

export function formatScore(score: number | null | undefined): string {
  if (score === null || score === undefined || !Number.isFinite(score)) return '--'
  return (score * 100).toFixed(1)
}

const birdGlyphPattern = [
  '........................',
  '...............11.......',
  '.............111111.....',
  '............11111111....',
  '...........111....111...',
  '..........111..33..11...',
  '..........111.3223.1112.',
  '.........1111..33..1112.',
  '........111111.....11...',
  '.......111.111.....11...',
  '.......111..11.....11...',
  '......111...11....111...',
  '.....111...111....111...',
  '....111....111...111....',
  '....111...111...111.....',
  '...111111111111111......',
  '..111111111111111.......',
  '.11111111111111.........',
  '.111.....11..11.........',
  '.........11..11.........',
  '........................',
] as const
const birdGlyphRows = birdGlyphPattern.length
const birdGlyphColumns = birdGlyphPattern[0].length
const birdGlyphCornerRadius = 5

function isInsideRoundedGlyphFrame(rowIndex: number, columnIndex: number): boolean {
  const radius = birdGlyphCornerRadius
  const x = columnIndex + 0.5
  const y = rowIndex + 0.5
  const width = birdGlyphColumns
  const height = birdGlyphRows

  if (x >= radius && x <= width - radius) return true
  if (y >= radius && y <= height - radius) return true

  const cornerX = x < radius ? radius : width - radius
  const cornerY = y < radius ? radius : height - radius
  return Math.hypot(x - cornerX, y - cornerY) <= radius
}

function matchesQuery(parts: Array<string | null | undefined>, query: string): boolean {
  const normalized = query.trim().toLowerCase()
  if (!normalized) return true
  return parts.some((part) => part?.toLowerCase().includes(normalized))
}

function formatRatio(current: number, total: number): string {
  return `${current}/${total}`
}

function useResponsiveGridLayout(
  containerRef: RefObject<HTMLElement | null>,
  minColumnWidth: number,
  gap: number,
): ResponsiveGridLayout {
  const [layout, setLayout] = useState<ResponsiveGridLayout>({
    columns: 1,
    width: minColumnWidth,
  })

  useEffect(() => {
    const element = containerRef.current
    if (!element) return undefined

    const updateColumns = () => {
      const width = Math.max(minColumnWidth, element.clientWidth)
      const nextColumns = Math.max(1, Math.floor((width + gap) / (minColumnWidth + gap)))
      setLayout((current) =>
        current.columns === nextColumns && current.width === width
          ? current
          : { columns: nextColumns, width },
      )
    }

    updateColumns()
    if (typeof ResizeObserver !== 'undefined') {
      const observer = new ResizeObserver(updateColumns)
      observer.observe(element)
      return () => observer.disconnect()
    }

    window.addEventListener('resize', updateColumns)
    return () => window.removeEventListener('resize', updateColumns)
  }, [containerRef, gap, minColumnWidth])

  return layout
}

function virtualGridStyle(columns: number): CSSProperties {
  return { '--virtual-grid-columns': String(columns) } as CSSProperties
}

export function isPlainSpaceKey(event: KeyboardEvent): boolean {
  return (
    (event.key === ' ' || event.key === 'Spacebar' || event.code === 'Space') &&
    !event.metaKey &&
    !event.ctrlKey &&
    !event.altKey &&
    !event.shiftKey
  )
}

export function shouldIgnoreSelectionReviewShortcutTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false
  if (target.closest('[data-selection-review-shortcut="true"]')) return false
  if (target.isContentEditable) return true
  return (
    target.closest(
      'input, textarea, select, button, a, [role="button"], [contenteditable="true"]',
    ) !== null
  )
}

function buildFolderSummary(photos: PhotoRecord[]): FolderSummary {
  return photos.reduce<FolderSummary>(
    (acc, photo) => {
      const category = photoCategory(photo)
      if (category !== 'no_bird') acc.gradeCounts[category] += 1
      if (photo.isNewSpecies) acc.newSpeciesCount += 1
      if (photo.birdCount > 0) acc.birdPhotoCount += 1
      if (photo.birdCount === 0) acc.noBirdCount += 1
      return acc
    },
    {
      newSpeciesCount: 0,
      birdPhotoCount: 0,
      noBirdCount: 0,
      speciesCount: new Set(
        photos.flatMap((photo) => (photo.speciesName ? [photo.speciesName] : [])),
      ).size,
      gradeCounts: { reject: 0, record: 0, usable: 0, select: 0 },
    },
  )
}

export function effectivePhotoGrade(photo: PhotoRecord): PhotoGrade {
  return photo.decision ?? photo.grade
}

function photoCategory(photo: PhotoRecord): PhotoCategory {
  if (photo.decision) return photo.decision
  return photo.birdCount === 0 ? 'no_bird' : photo.grade
}

export function isArchiveEligiblePhoto(photo: PhotoRecord): boolean {
  return (
    photo.analysisStatus === 'done' &&
    photo.birdCount > 0 &&
    archiveEligibleGrades.has(effectivePhotoGrade(photo))
  )
}

function normalizeArchiveSpeciesEntry(input: {
  englishName?: string | null
  latinName?: string | null
  name?: string | null
}): ArchiveSpeciesEntry | null {
  const resolvedNameLatinName = resolveSpeciesCanonicalSci(input.name)
  const resolvedEnglishLatinName = resolveSpeciesCanonicalSci(input.englishName)
  const resolvedLatinName =
    resolveSpeciesCanonicalSci(input.latinName) ?? resolvedNameLatinName ?? resolvedEnglishLatinName
  const fallbackLatinName = input.latinName?.trim() ?? ''
  const normalizedName = normalizeSpeciesAlias(input.name)
  const isUnknownName = normalizedName ? unknownSpeciesAliases.has(normalizedName) : false
  if (!resolvedLatinName && !fallbackLatinName && (!normalizedName || isUnknownName)) return null

  const latinName = resolvedLatinName ?? fallbackLatinName
  const key = latinName ? `sci:${latinName}` : `name:${normalizedName}`
  const wiki = latinName ? getSpeciesWiki(latinName) : undefined
  const name = wiki?.canonical_zh ?? input.name ?? latinName
  return {
    key,
    name,
    latinName,
    englishName: wiki?.canonical_en ?? input.englishName ?? null,
  }
}

export function getArchiveSpeciesEntries(photo: PhotoRecord): ArchiveSpeciesEntry[] {
  if (!isArchiveEligiblePhoto(photo)) return []
  const rawEntries: Array<{
    englishName?: string | null
    latinName?: string | null
    name?: string | null
  }> = []

  // 优先：按 detection 维度聚合（v6 backend schema：每个 detection 独立 speciesSource）。
  // 多鸟图混合可见性的关键 — head 可见的 detection 进羽迹，head 不可见的不进，
  // 不再被 photo-level 一刀切。
  const detections = photo.birdDetections ?? []
  const detectionsHaveSource = detections.some((d) => d.speciesSource !== undefined)
  if (detectionsHaveSource) {
    for (const detection of detections) {
      const source = detection.speciesSource
      // model_unconfirmed / conflict / none / undefined-with-no-species → 跳过
      if (source === 'model_unconfirmed' || source === 'conflict' || source === 'none') continue
      if (source === undefined && !detection.manualSpecies) continue
      rawEntries.push({
        name: detection.speciesName,
        latinName: detection.speciesLatinName,
        englishName: detection.speciesEnglishName,
      })
    }
  } else {
    // 老数据 fallback（v5 之前没有 detection.speciesSource）— 按 photo-level 走老逻辑
    const manualEntries: typeof rawEntries = []
    for (const detection of detections) {
      if (!detection.manualSpecies) continue
      manualEntries.push({
        name: detection.speciesName,
        latinName: detection.speciesLatinName,
        englishName: detection.speciesEnglishName,
      })
    }
    if (manualEntries.length > 0) {
      rawEntries.push(...manualEntries)
    } else if (photo.manualSpecies || photo.speciesSource === 'manual') {
      rawEntries.push({
        name: photo.speciesName,
        latinName: photo.speciesLatinName,
        englishName: photo.speciesEnglishName,
      })
    } else if (photo.speciesSource === 'model_unconfirmed') {
      // head 不可见 → 不进羽迹（与新逻辑一致）
    } else if (photo.speciesSource === 'group_consensus') {
      rawEntries.push({
        name: photo.groupSpeciesName ?? photo.speciesName,
        latinName: photo.groupSpeciesLatinName ?? photo.speciesLatinName,
        englishName: photo.speciesEnglishName,
      })
    } else {
      rawEntries.push({
        name: photo.modelSpeciesName ?? photo.speciesName,
        latinName: photo.modelSpeciesLatinName ?? photo.speciesLatinName,
        englishName: photo.speciesEnglishName,
      })
    }
  }

  const seen = new Set<string>()
  const entries: ArchiveSpeciesEntry[] = []
  for (const rawEntry of rawEntries) {
    const entry = normalizeArchiveSpeciesEntry(rawEntry)
    if (!entry || seen.has(entry.key)) continue
    seen.add(entry.key)
    entries.push(entry)
  }
  return entries
}

function archivePhotoSearchParts(photo: PhotoRecord): Array<string | null | undefined> {
  return [
    photo.fileName,
    photo.speciesName,
    photo.speciesLatinName,
    photo.speciesEnglishName,
    photo.caption,
    ...getArchiveSpeciesEntries(photo).flatMap((entry) => [
      entry.name,
      entry.latinName,
      entry.englishName,
    ]),
  ]
}

function filterPhotoByQuickFilters(photo: PhotoRecord, filters: QuickFilter[]): boolean {
  if (photo.analysisStatus !== 'done') return true
  // 空 filter = "未应用任何过滤" = 显示全部(行业惯例 + 用户取消所有 chip 的直觉)。
  // 旧实现 `return false` 让"全清 chip"变成"全部隐藏",对用户语义反转。
  if (filters.length === 0) return true
  return filters.includes(photoCategory(photo))
}

// 档位优先级：精选(3) > 可用(2) > 记录(1) > 淘汰(0)
const GRADE_RANK: Record<PhotoGrade, number> = {
  select: 3,
  usable: 2,
  record: 1,
  reject: 0,
}

function sortPhotos(photos: PhotoRecord[], sortBy: SortMode): PhotoRecord[] {
  return photos.toSorted((left, right) => {
    if (sortBy === 'name') return left.fileName.localeCompare(right.fileName)
    if (sortBy === 'shot_at') return right.shotAt.localeCompare(left.shotAt)
    // 综合评分（默认）：先按档位降序（精选 → 可用 → 记录 → 淘汰），
    // 同档内按 quality_score 降序
    const gradeDiff = GRADE_RANK[effectivePhotoGrade(right)] - GRADE_RANK[effectivePhotoGrade(left)]
    if (gradeDiff !== 0) return gradeDiff
    return (right.finalScore ?? -1) - (left.finalScore ?? -1)
  })
}

function bestPhotoForStack(photos: PhotoRecord[]): PhotoRecord | null {
  let best: PhotoRecord | null = null
  for (const photo of photos) {
    if (!best) {
      best = photo
      continue
    }
    const scoreDiff = (photo.finalScore ?? -1) - (best.finalScore ?? -1)
    if (scoreDiff > 0) {
      best = photo
      continue
    }
    if (scoreDiff === 0 && photo.shotAt.localeCompare(best.shotAt) < 0) best = photo
  }
  return best
}

function photoShotMs(photo: PhotoRecord): number | null {
  const ts = Date.parse(photo.shotAt)
  return Number.isFinite(ts) ? ts : null
}

function comparePhotosByShotTimeAsc(left: PhotoRecord, right: PhotoRecord): number {
  const leftTs = photoShotMs(left)
  const rightTs = photoShotMs(right)
  if (leftTs !== null && rightTs !== null && leftTs !== rightTs) return leftTs - rightTs
  if (leftTs !== null && rightTs === null) return -1
  if (leftTs === null && rightTs !== null) return 1
  return left.fileName.localeCompare(right.fileName)
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

function hasAccumulatedGeometryBreak(anchor: PhotoRecord, current: PhotoRecord): boolean {
  const continuity = bboxContinuity(anchor, current)
  if (!continuity) return false
  return (
    (continuity.iou < 0.04 && continuity.centerDistance > 0.24) ||
    (continuity.centerDistance > 0.22 && continuity.sizeRatio > 1.8)
  )
}

function shouldSplitPhotoSegment(
  anchor: PhotoRecord,
  previous: PhotoRecord,
  current: PhotoRecord,
): boolean {
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

  if (anchor.id !== previous.id && hasAccumulatedGeometryBreak(anchor, current)) return true

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

function buildPhotoSegments(photos: PhotoRecord[]): PhotoSegment[] {
  if (photos.length === 0) return []
  const ordered = photos.toSorted(comparePhotosByShotTimeAsc)
  const segments: PhotoSegment[] = []
  let current: PhotoRecord[] = []
  let previous: PhotoRecord | null = null
  let anchor: PhotoRecord | null = null

  for (const photo of ordered) {
    const shouldSplit =
      current.length > 0 &&
      previous !== null &&
      anchor !== null &&
      shouldSplitPhotoSegment(anchor, previous, photo)

    if (shouldSplit) {
      const segment = createPhotoSegment(current, segments.length)
      if (segment) segments.push(segment)
      current = []
      anchor = null
    }

    current.push(photo)
    if (anchor === null) anchor = photo
    previous = photo
  }

  const tail = createPhotoSegment(current, segments.length)
  if (tail) segments.push(tail)
  return segments
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

function visibleGroupTitle(
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

function reviewGroupKey(folderId: string, groupId: string): string {
  return `${folderId}\u0000${groupId}`
}

function buildReviewSegmentPhotosByPhotoId(photos: PhotoRecord[]): Map<string, PhotoRecord[]> {
  const groups = new Map<string, PhotoRecord[]>()
  for (const photo of photos) {
    const key = reviewGroupKey(photo.folderId, photo.groupId)
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
    if (segments.length <= 1) continue

    for (const segment of segments) {
      for (const photo of segment.photos) {
        segmentsByPhotoId.set(photo.id, segment.photos)
      }
    }
  }
  return segmentsByPhotoId
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

function statusTone(status: FolderStatus): Tone {
  if (status === 'ready') return 'success'
  if (status === 'path_missing' || status === 'error') return 'accent'
  if (status === 'analyzing_partial' || status === 'scanning' || status === 'hashing')
    return 'warning'
  return 'neutral'
}

function gradeTone(grade: PhotoGrade): Tone {
  if (grade === 'select') return 'success'
  if (grade === 'record') return 'warning'
  if (grade === 'reject') return 'accent'
  return 'neutral'
}

function categoryTone(category: PhotoCategory): Tone {
  if (category === 'no_bird') return 'muted'
  return gradeTone(category)
}

// Source helpers 接收可选 detection — 多鸟图深度复核切鸟时，ScoreHeader 会
// 把 activeBird 传进来；其他场景（PhotoTile、CompareModal）按 photo-level。
type DetectionLike = NonNullable<PhotoRecord['birdDetections']>[number]

function resolveSourceFor(
  photo: PhotoRecord,
  detection?: DetectionLike | null,
): { source: PhotoRecord['speciesSource']; manualSpecies: boolean } {
  if (detection) {
    return {
      source: detection.speciesSource,
      manualSpecies: detection.manualSpecies,
    }
  }
  return {
    source: photo.speciesSource,
    manualSpecies: photo.manualSpecies ?? false,
  }
}

export function speciesSourceTone(photo: PhotoRecord, detection?: DetectionLike | null): Tone {
  const { source, manualSpecies } = resolveSourceFor(photo, detection)
  if (source === 'group_consensus') return 'success'
  if (photo.speciesConflict || source === 'conflict') return 'warning'
  if (source === 'model_unconfirmed') return 'warning'
  if (source === 'manual' || manualSpecies) return 'accent'
  return 'muted'
}

export function speciesSourceKind(
  photo: PhotoRecord,
  detection?: DetectionLike | null,
): 'conflict' | 'correction' | 'manual' | 'unconfirmed' | null {
  const { source, manualSpecies } = resolveSourceFor(photo, detection)
  if (source === 'group_consensus') return 'correction'
  if (photo.speciesConflict || source === 'conflict') return 'conflict'
  if (source === 'model_unconfirmed') return 'unconfirmed'
  if (source === 'manual' || manualSpecies) return 'manual'
  return null
}

export function speciesSourceBadge(
  photo: PhotoRecord,
  t: ReturnType<typeof useTranslation>['t'],
  detection?: DetectionLike | null,
): string | null {
  const { source, manualSpecies } = resolveSourceFor(photo, detection)
  if (source === 'group_consensus') {
    return t('selection.speciesSource.groupConsensus')
  }
  if (photo.speciesConflict || source === 'conflict') {
    return t('selection.speciesSource.conflict')
  }
  if (source === 'model_unconfirmed') {
    return t('selection.speciesSource.unconfirmed')
  }
  if (source === 'manual' || manualSpecies) {
    return t('selection.speciesSource.manual')
  }
  return null
}

export function effectiveSpeciesName(photo: PhotoRecord): string | null {
  if (photo.manualSpecies || photo.speciesSource === 'manual') return photo.speciesName
  if (photo.speciesSource === 'group_consensus') return photo.groupSpeciesName ?? photo.speciesName
  if (photo.speciesSource === 'model') return photo.modelSpeciesName ?? photo.speciesName
  // model_unconfirmed: 仍展示模型识别物种（但 UI 会带"待审"徽标）
  if (photo.speciesSource === 'model_unconfirmed') return photo.speciesName
  return photo.speciesName
}

export function effectiveSpeciesLatinName(photo: PhotoRecord): string | null {
  if (photo.manualSpecies || photo.speciesSource === 'manual') return photo.speciesLatinName
  if (photo.speciesSource === 'group_consensus') {
    return photo.groupSpeciesLatinName ?? photo.speciesLatinName
  }
  if (photo.speciesSource === 'model') return photo.modelSpeciesLatinName ?? photo.speciesLatinName
  // model_unconfirmed: 仍展示模型识别拉丁名（带"待审"徽标）
  if (photo.speciesSource === 'model_unconfirmed') return photo.speciesLatinName
  return photo.speciesLatinName
}

export function speciesSourceDetail(
  photo: PhotoRecord,
  t: ReturnType<typeof useTranslation>['t'],
  detection?: DetectionLike | null,
): string | null {
  const { source, manualSpecies } = resolveSourceFor(photo, detection)
  const support =
    photo.groupSpeciesSupport !== null &&
    photo.groupSpeciesSupport !== undefined &&
    photo.groupSpeciesEvidence !== null &&
    photo.groupSpeciesEvidence !== undefined
      ? `${photo.groupSpeciesSupport}/${photo.groupSpeciesEvidence}`
      : '--'
  const raw = photo.modelSpeciesName
  const effective = effectiveSpeciesName(photo)

  if (source === 'group_consensus') {
    if (raw && raw !== effective) {
      return t('selection.speciesSource.groupConsensusWithRaw', { species: raw, support })
    }
    return t('selection.speciesSource.groupConsensusDetail', { support })
  }
  if (photo.speciesConflict || source === 'conflict') {
    return t('selection.speciesSource.conflictDetail')
  }
  if (source === 'model_unconfirmed') {
    return t('selection.speciesSource.unconfirmedDetail')
  }
  if (source === 'manual' || manualSpecies) {
    return t('selection.speciesSource.manualDetail')
  }
  return null
}

// 多鸟图按 detection 维度聚合的物种摘要 — tile / 物种照片浏览统一
// 使用，避免 photo.speciesName（best 那只）淹没其他鸟的物种信息。
//
// 仅聚合"已可信"的 detection（manual / model / group_consensus）；
// model_unconfirmed / conflict / none 单独标在 hasUnconfirmed / hasConflict
// 字段上，UI 决定是否在 tile 用"部分待审"/"存疑"徽标提示。
export interface SpeciesSummaryEntry {
  name: string | null
  latinName: string | null
  englishName: string | null
  count: number
  isBest: boolean
}

export interface SpeciesSummary {
  confirmedEntries: SpeciesSummaryEntry[]
  hasUnconfirmed: boolean
  hasConflict: boolean
  /** 老数据 fallback 标志：detections 全无 speciesSource 字段 → 落回 photo-level */
  fromPhotoLevelFallback: boolean
}

export function effectiveSpeciesSummary(photo: PhotoRecord): SpeciesSummary {
  const detections = photo.birdDetections ?? []
  const detectionsHaveSource = detections.some((d) => d.speciesSource !== undefined)
  if (!detectionsHaveSource) {
    return {
      confirmedEntries: [],
      hasUnconfirmed: false,
      hasConflict: false,
      fromPhotoLevelFallback: true,
    }
  }
  const map = new Map<string, SpeciesSummaryEntry>()
  let hasUnconfirmed = false
  let hasConflict = false
  for (const d of detections) {
    const source = d.speciesSource
    if (source === 'model_unconfirmed') {
      hasUnconfirmed = true
      continue
    }
    if (source === 'conflict') {
      hasConflict = true
      continue
    }
    if (source === 'none' || !d.speciesName) continue
    const key = d.speciesLatinName ?? d.speciesName ?? ''
    if (!key) continue
    const existing = map.get(key)
    if (existing) {
      existing.count += 1
      if (d.isBest) existing.isBest = true
    } else {
      map.set(key, {
        name: d.speciesName,
        latinName: d.speciesLatinName ?? null,
        englishName: d.speciesEnglishName ?? null,
        count: 1,
        isBest: d.isBest,
      })
    }
  }
  const confirmedEntries = [...map.values()].sort((a, b) => {
    if (a.isBest && !b.isBest) return -1
    if (!a.isBest && b.isBest) return 1
    return b.count - a.count
  })
  return {
    confirmedEntries,
    hasUnconfirmed,
    hasConflict,
    fromPhotoLevelFallback: false,
  }
}

// 选片 tile / 物种照片浏览统一用的物种文本格式化函数。
// 把 effectiveSpeciesSummary 的纯数据 + photo 状态 + i18n 拼成可显示字符串。
export function formatPhotoSpeciesDisplay(
  photo: PhotoRecord,
  t: ReturnType<typeof useTranslation>['t'],
): string {
  if (photo.analysisStatus === 'pending') return t('selection.analysisStatus.pending')
  if (photo.analysisStatus === 'running') return t('selection.analysisStatus.running')
  if (photo.analysisStatus === 'failed') return t('selection.analysisStatus.failed')
  if (photo.birdCount === 0) return t('selection.photo.noBird')

  const summary = effectiveSpeciesSummary(photo)
  if (summary.fromPhotoLevelFallback) {
    return effectiveSpeciesName(photo) ?? t('selection.photo.unidentified')
  }
  const entries = summary.confirmedEntries
  if (entries.length === 0) {
    // 全 unconfirmed / conflict / none → 仍展示模型识别物种（待审标在外面 source badge）
    return effectiveSpeciesName(photo) ?? t('selection.photo.unidentified')
  }
  if (entries.length === 1) {
    const e = entries[0]
    return e.count > 1
      ? t('selection.photo.speciesTimes', { name: e.name ?? '', count: e.count })
      : (e.name ?? t('selection.photo.unidentified'))
  }
  if (entries.length === 2) {
    return t('selection.photo.speciesPlus', {
      a: entries[0].name ?? '',
      b: entries[1].name ?? '',
    })
  }
  return t('selection.photo.speciesEtc', {
    name: entries[0].name ?? '',
    count: entries.length,
  })
}

// 多鸟图 tile 来源徽标策略：
// - 全部 detection source 一致 → 走 photo-level（不变）
// - 多源混合且包含 unconfirmed → "部分待审"（warning 色，复用 unconfirmed CSS）
// - 多源混合不含 unconfirmed → 取最高优先级 source 的 badge（manual > group_consensus > model）
// 单鸟图直接走 photo-level。
export function tileSpeciesSourceBadge(
  photo: PhotoRecord,
  t: ReturnType<typeof useTranslation>['t'],
): { label: string; kind: 'conflict' | 'correction' | 'manual' | 'unconfirmed' } | null {
  const summary = effectiveSpeciesSummary(photo)
  if (summary.fromPhotoLevelFallback) {
    const label = speciesSourceBadge(photo, t)
    const kind = speciesSourceKind(photo)
    return label && kind ? { label, kind } : null
  }
  // 多源混合且有 unconfirmed → 部分待审
  if (summary.hasUnconfirmed && summary.confirmedEntries.length > 0) {
    return {
      label: t('selection.speciesSource.partialUnconfirmed'),
      kind: 'unconfirmed',
    }
  }
  // 否则走 photo-level（best detection 决定的）
  const label = speciesSourceBadge(photo, t)
  const kind = speciesSourceKind(photo)
  return label && kind ? { label, kind } : null
}

function decisionTone(decision: SelectionDecision): Tone {
  if (decision === 'select' || decision === 'usable') return 'success'
  if (decision === 'record') return 'warning'
  if (decision === 'reject') return 'accent'
  return 'muted'
}

/** 把后端 analysisErrorCode 翻译成本地化 tooltip;没匹配上的 code 退回到原始
 *  英文 error message;啥都没有时退回到通用"分析失败"文案。 */
function analysisErrorTooltip(
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

function analysisTone(status: AnalysisStatus): Tone {
  if (status === 'done') return 'success'
  if (status === 'running') return 'warning'
  if (status === 'failed') return 'accent'
  return 'neutral'
}

function statusLabelKey(status: FolderStatus) {
  return `selection.folderStatus.${status}` as const
}

export function gradeLabelKey(grade: PhotoGrade) {
  return `selection.grade.${grade}` as const
}

function categoryLabelKey(category: PhotoCategory) {
  return category === 'no_bird' ? 'selection.quickFilters.no_bird' : gradeLabelKey(category)
}

function poseTagKey(tag: PoseTagId) {
  return `selection.poseTags.${tag}` as const
}

function problemTagKey(tag: ProblemTagId) {
  return `selection.problemTags.${tag}` as const
}

function sceneTagKey(tag: SceneTagId) {
  return `selection.sceneTags.${tag}` as const
}

function routeLabelKey(route: AppRoute) {
  return `nav.${route}` as const
}

function archiveTabLabelKey(tab: ArchiveTab) {
  return `archive.tabs.${tab}` as const
}

function viewModeKey(mode: ViewMode) {
  return `selection.viewModes.${mode}` as const
}

function sortLabelKey(sort: SortMode) {
  return `selection.sort.${sort}` as const
}

function quickFilterLabelKey(filter: QuickFilter) {
  return `selection.quickFilters.${filter}` as const
}

function mergeWorkspace(current: WorkspaceSnapshot, patch: WorkspaceSnapshot): WorkspaceSnapshot {
  return {
    folders: [...patch.folders, ...current.folders],
    groups: [...patch.groups, ...current.groups],
    photos: [...patch.photos, ...current.photos],
    species: current.species,
  }
}

export function photoReviewReason(photo: PhotoRecord): string {
  if (photo.decision) return 'selection.reviewReasons.manualOverride'
  if (photo.problemTags.includes('no_bird')) return 'selection.reviewReasons.no_bird'
  if (photo.isNewSpecies) return 'selection.reviewReasons.new_species'
  if (effectivePhotoGrade(photo) === 'select') return 'selection.reviewReasons.top_pick'
  if (photo.problemTags.length > 0) return 'selection.reviewReasons.has_issues'
  return 'selection.reviewReasons.candidate'
}

export function legacyAfPointToOverlay(point: { x: number; y: number } | null): AfOverlay | null {
  if (!point) return null
  return {
    kind: 'point',
    source: 'legacy',
    center: point,
    points: [{ ...point, in_focus: true, selected: true }],
    focused_points: [{ ...point, in_focus: true, selected: true }],
    selected_points: [{ ...point, in_focus: true, selected: true }],
    focused_count: 1,
    selected_count: 1,
    point_count: 1,
  }
}

function stableHue(input: string): number {
  let hue = 0
  for (let i = 0; i < input.length; i++) hue = (hue * 31 + input.charCodeAt(i)) >>> 0
  return hue % 360
}

function hashStableValue(seed: number, value: unknown): number {
  let text: string
  if (value === null || value === undefined) {
    text = ''
  } else if (typeof value === 'string') {
    text = value
  } else {
    try {
      text = JSON.stringify(value) ?? ''
    } catch {
      text = String(value)
    }
  }

  let hash = seed >>> 0
  for (let i = 0; i < text.length; i += 1) {
    hash = Math.imul(hash ^ text.charCodeAt(i), 16777619) >>> 0
  }
  return Math.imul(hash ^ 31, 16777619) >>> 0
}

function libraryDetailContentHash(detail: LibraryDetail): string {
  let hash = 2166136261
  for (const photo of detail.photos) {
    hash = hashStableValue(hash, photo.id)
    hash = hashStableValue(hash, photo.pipeline_version)
    hash = hashStableValue(hash, photo.grade)
    hash = hashStableValue(hash, photo.quality_score)
    hash = hashStableValue(hash, photo.bird_count)
    hash = hashStableValue(hash, photo.species)
    hash = hashStableValue(hash, photo.species_latin)
    hash = hashStableValue(hash, photo.species_source)
    hash = hashStableValue(hash, photo.model_species)
    hash = hashStableValue(hash, photo.model_species_latin)
    hash = hashStableValue(hash, photo.group_species)
    hash = hashStableValue(hash, photo.group_species_latin)
    hash = hashStableValue(hash, photo.group_species_confidence)
    hash = hashStableValue(hash, photo.decision)
    hash = hashStableValue(hash, photo.thumb_grid)
    hash = hashStableValue(hash, photo.thumb_preview)
    hash = hashStableValue(hash, photo.scene_id)
    hash = hashStableValue(hash, photo.exif)
    hash = hashStableValue(hash, photo.best_detection)
    hash = hashStableValue(hash, photo.detections)
  }
  return hash.toString(36)
}

function speciesRecordId(latinName: string, fallbackName = ''): string {
  const seed = latinName.trim() || fallbackName.trim() || 'unknown'
  return `species-${seed.toLowerCase().replace(/[^a-z0-9\u4e00-\u9fa5]+/g, '-')}`
}

function speciesDisplayName(item: SpeciesCatalogItem): string {
  return item.canonical_zh ?? item.zh_title ?? item.canonical_en ?? item.canonical_sci
}

function speciesCollectionGroupId(
  species: Pick<SpeciesRecord, 'protectLevel' | 'iucn' | 'inChinaV12'>,
): SpeciesCollectionGroupId {
  if (species.inChinaV12 === false) return 'modelExtra'
  const protect = species.protectLevel ?? ''
  const iucn = (species.iucn ?? '').toUpperCase()
  if (protect.includes('一级')) return 'protected1'
  if (protect.includes('二级')) return 'protected2'
  if (['NT', 'VU', 'EN', 'CR'].includes(iucn)) return 'threatened'
  return 'regular'
}

function speciesCollectionGroupRank(groupId: SpeciesCollectionGroupId): number {
  return speciesCollectionGroupOrder.indexOf(groupId)
}

function speciesCollectionGroupTone(groupId: SpeciesCollectionGroupId): Tone {
  if (groupId === 'protected1' || groupId === 'threatened') return 'accent'
  if (groupId === 'protected2') return 'warning'
  if (groupId === 'modelExtra') return 'muted'
  return 'neutral'
}

function speciesSortValue(species: SpeciesRecord): string {
  return `${species.name}|${species.latinName}`
}

export function buildSpeciesCollectionGroups(
  speciesRecords: SpeciesRecord[],
): SpeciesCollectionGroup[] {
  const groups = new Map<SpeciesCollectionGroupId, SpeciesRecord[]>()
  for (const species of speciesRecords) {
    const groupId = speciesCollectionGroupId(species)
    groups.set(groupId, [...(groups.get(groupId) ?? []), species])
  }

  return speciesCollectionGroupOrder.flatMap((id) => {
    const species = groups.get(id)
    if (!species || species.length === 0) return []
    return [
      {
        id,
        litCount: species.filter((item) => item.collected).length,
        species: species.toSorted((left, right) => {
          if (Boolean(left.collected) !== Boolean(right.collected)) {
            return left.collected ? -1 : 1
          }
          const scoreDiff = (right.bestScore ?? -1) - (left.bestScore ?? -1)
          if (scoreDiff !== 0) return scoreDiff
          return speciesSortValue(left).localeCompare(speciesSortValue(right), 'zh-Hans-CN')
        }),
      },
    ]
  })
}

function cssImageUrl(url: string): string {
  return `url("${url.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}")`
}

function speciesArtworkStyle(imageUrl: string | null | undefined, fallbackGradient: string) {
  return {
    '--species-artwork-bg': imageUrl ? cssImageUrl(imageUrl) : fallbackGradient,
  } as CSSProperties
}

type SpeciesArtworkAspect = 'unknown' | 'landscape' | 'portrait' | 'square'

const speciesArtworkAspectCache = new Map<string, SpeciesArtworkAspect>()

function classifySpeciesArtworkAspect(width: number, height: number): SpeciesArtworkAspect {
  if (width <= 0 || height <= 0) return 'unknown'
  const aspect = width / height
  if (aspect >= 1.18) return 'landscape'
  if (aspect <= 0.82) return 'portrait'
  return 'square'
}

function useSpeciesArtworkAspect(imageUrl: string | null | undefined): SpeciesArtworkAspect {
  const [aspect, setAspect] = useState<SpeciesArtworkAspect>(() => {
    if (!imageUrl) return 'unknown'
    return speciesArtworkAspectCache.get(imageUrl) ?? 'unknown'
  })

  useEffect(() => {
    if (!imageUrl) {
      setAspect('unknown')
      return
    }
    const cached = speciesArtworkAspectCache.get(imageUrl)
    if (cached) {
      setAspect(cached)
      return
    }
    setAspect('unknown')

    let cancelled = false
    const image = new Image()
    image.onload = () => {
      if (cancelled) return
      const next = classifySpeciesArtworkAspect(image.naturalWidth, image.naturalHeight)
      speciesArtworkAspectCache.set(imageUrl, next)
      setAspect(next)
    }
    image.onerror = () => {
      if (!cancelled) setAspect('unknown')
    }
    image.src = imageUrl

    return () => {
      cancelled = true
    }
  }, [imageUrl])

  return aspect
}

export function deriveSpeciesRecords(workspace: WorkspaceSnapshot): SpeciesRecord[] {
  const capturedGroups = new Map<
    string,
    {
      name: string
      latinName: string
      englishName: string | null
      photos: PhotoRecord[]
      bestScore: number
      firstSeenAt: string
      lastSeenAt: string
    }
  >()
  const aliasToGroupKey = new Map<string, string>()

  const bindAlias = (alias: string | null | undefined, key: string) => {
    const normalized = normalizeSpeciesAlias(alias)
    if (normalized) aliasToGroupKey.set(normalized, key)
  }

  for (const photo of workspace.photos) {
    for (const entry of getArchiveSpeciesEntries(photo)) {
      const groupKey = entry.key
      const score = photo.finalScore ?? 0
      const existing = capturedGroups.get(groupKey)
      if (existing) {
        if (!existing.photos.some((item) => item.id === photo.id)) {
          existing.photos.push(photo)
        }
        if (score > existing.bestScore) existing.bestScore = score
        if (photo.shotAt < existing.firstSeenAt) existing.firstSeenAt = photo.shotAt
        if (photo.shotAt > existing.lastSeenAt) existing.lastSeenAt = photo.shotAt
      } else {
        capturedGroups.set(groupKey, {
          name: entry.name,
          latinName: entry.latinName,
          englishName: entry.englishName,
          photos: [photo],
          bestScore: score,
          firstSeenAt: photo.shotAt,
          lastSeenAt: photo.shotAt,
        })
      }
      bindAlias(entry.latinName, groupKey)
      bindAlias(entry.name, groupKey)
      bindAlias(entry.englishName, groupKey)
    }
  }

  const matchedGroupKeys = new Set<string>()
  const resolveCaptured = (item: SpeciesCatalogItem) => {
    const canonical = normalizeSpeciesAlias(item.canonical_sci)
    const canonicalGroupKey = canonical ? aliasToGroupKey.get(canonical) : null
    if (canonicalGroupKey && !matchedGroupKeys.has(canonicalGroupKey)) {
      matchedGroupKeys.add(canonicalGroupKey)
      return capturedGroups.get(canonicalGroupKey) ?? null
    }

    const aliases = [item.canonical_zh, item.canonical_en]
    for (const alias of aliases) {
      const normalized = normalizeSpeciesAlias(alias)
      const groupKey = normalized ? aliasToGroupKey.get(normalized) : null
      if (groupKey && !matchedGroupKeys.has(groupKey)) {
        matchedGroupKeys.add(groupKey)
        return capturedGroups.get(groupKey) ?? null
      }
    }
    return null
  }

  const catalogRecords: SpeciesRecord[] = speciesCatalog.map((item) => {
    const captured = resolveCaptured(item)
    const hue = stableHue(item.canonical_sci)
    return {
      id: speciesRecordId(item.canonical_sci),
      name: speciesDisplayName(item),
      latinName: item.canonical_sci,
      englishName: item.canonical_en,
      coverGradient: `linear-gradient(135deg, hsl(${hue}, 45%, 32%), hsl(${(hue + 40) % 360}, 38%, 16%))`,
      imageUrl: item.image_url,
      photoCount: captured?.photos.length ?? 0,
      firstSeenAt: captured?.firstSeenAt ?? '',
      lastSeenAt: captured?.lastSeenAt ?? '',
      bestScore: captured?.bestScore ?? null,
      newSightings: 0,
      regions: [],
      summary: item.zh_extract ?? item.en_extract ?? '',
      collected: Boolean(captured),
      protectLevel: item.protect_level,
      iucn: item.iucn,
      familyName: item.family_zh ?? item.family_sci,
      isTrained: item.is_trained,
      inChinaV12: item.in_china_v12,
      catalogSource: item.in_china_v12 ? 'china_v12' : 'model_extra',
    }
  })

  const uncataloguedRecords: SpeciesRecord[] = Array.from(capturedGroups.entries())
    .filter(([key]) => !matchedGroupKeys.has(key))
    .map(([key, captured]) => {
      const hue = stableHue(key)
      return {
        id: speciesRecordId(captured.latinName, captured.name),
        name: captured.name,
        latinName: captured.latinName,
        englishName: captured.englishName,
        coverGradient: `linear-gradient(135deg, hsl(${hue}, 45%, 32%), hsl(${(hue + 40) % 360}, 38%, 16%))`,
        imageUrl: null,
        photoCount: captured.photos.length,
        firstSeenAt: captured.firstSeenAt,
        lastSeenAt: captured.lastSeenAt,
        bestScore: captured.bestScore,
        newSightings: 0,
        regions: [],
        summary: '',
        collected: true,
        protectLevel: null,
        iucn: null,
        familyName: null,
        isTrained: true,
        inChinaV12: false,
        catalogSource: 'uncatalogued',
      }
    })

  return [...catalogRecords, ...uncataloguedRecords].toSorted((left, right) => {
    const groupDiff =
      speciesCollectionGroupRank(speciesCollectionGroupId(left)) -
      speciesCollectionGroupRank(speciesCollectionGroupId(right))
    if (groupDiff !== 0) return groupDiff
    if (Boolean(left.collected) !== Boolean(right.collected)) {
      return left.collected ? -1 : 1
    }
    return speciesSortValue(left).localeCompare(speciesSortValue(right), 'zh-Hans-CN')
  })
}

function folderHasActiveTasks(status: FolderStatus): boolean {
  return ['scanning', 'hashing', 'analyzing_partial', 'updating', 'exporting'].includes(status)
}

const chinaMapRegions: Array<{
  id: MapRegionId
  labelKey: string
  x: number
  y: number
  keywords: string[]
}> = [
  {
    id: 'northeast',
    labelKey: 'archive.map.regions.northeast',
    x: 78,
    y: 19,
    keywords: ['东北', '辽宁', '吉林', '黑龙江', '沈阳', '长春', '哈尔滨'],
  },
  {
    id: 'north',
    labelKey: 'archive.map.regions.north',
    x: 57,
    y: 31,
    keywords: ['华北', '北京', '天津', '河北', '山西', '山东', '内蒙古'],
  },
  {
    id: 'east',
    labelKey: 'archive.map.regions.east',
    x: 67,
    y: 51,
    keywords: [
      '华东',
      '上海',
      '江苏',
      '浙江',
      '安徽',
      '江西',
      '杭州',
      '南京',
      '苏州',
      '崇明',
      '南汇',
    ],
  },
  {
    id: 'central',
    labelKey: 'archive.map.regions.central',
    x: 55,
    y: 55,
    keywords: ['华中', '河南', '湖北', '湖南', '武汉', '长沙', '郑州'],
  },
  {
    id: 'south',
    labelKey: 'archive.map.regions.south',
    x: 61,
    y: 73,
    keywords: ['华南', '广东', '广西', '福建', '海南', '香港', '澳门', '广州', '深圳', '厦门'],
  },
  {
    id: 'southwest',
    labelKey: 'archive.map.regions.southwest',
    x: 42,
    y: 67,
    keywords: ['西南', '四川', '重庆', '贵州', '云南', '成都', '昆明', '贵阳'],
  },
  {
    id: 'northwest',
    labelKey: 'archive.map.regions.northwest',
    x: 32,
    y: 36,
    keywords: ['西北', '新疆', '甘肃', '宁夏', '陕西', '西安', '兰州', '银川', '乌鲁木齐'],
  },
  {
    id: 'qinghaiTibet',
    labelKey: 'archive.map.regions.qinghaiTibet',
    x: 28,
    y: 60,
    keywords: ['青藏', '西藏', '青海', '拉萨', '西宁'],
  },
]

const chinaMapRegionById = new Map<MapRegionId, (typeof chinaMapRegions)[number]>(
  chinaMapRegions.map((region) => [region.id, region] as const),
)

function gpsScalarToNumber(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null
  if (typeof value === 'string' && value.trim()) {
    const parsed = Number(value)
    return Number.isFinite(parsed) ? parsed : null
  }
  if (Array.isArray(value) && value.length === 2) {
    const numerator = gpsScalarToNumber(value[0])
    const denominator = gpsScalarToNumber(value[1])
    if (numerator !== null && denominator !== null && denominator !== 0) {
      return numerator / denominator
    }
  }
  if (typeof value === 'object' && value !== null) {
    const rational = value as { numerator?: unknown; denominator?: unknown }
    const numerator = gpsScalarToNumber(rational.numerator)
    const denominator = gpsScalarToNumber(rational.denominator)
    if (numerator !== null && denominator !== null && denominator !== 0) {
      return numerator / denominator
    }
  }
  return null
}

function gpsPartToDecimal(value: unknown): number | null {
  if (Array.isArray(value) && value.length >= 3) {
    const degree = gpsScalarToNumber(value[0])
    const minute = gpsScalarToNumber(value[1])
    const second = gpsScalarToNumber(value[2])
    if (degree !== null && minute !== null && second !== null) {
      return degree + minute / 60 + second / 3600
    }
  }
  return gpsScalarToNumber(value)
}

function gpsCoordinateToDecimal(value: unknown, ref: unknown): number | null {
  const decimal = gpsPartToDecimal(value)
  if (decimal === null) return null
  const direction = String(ref ?? '').toUpperCase()
  return direction === 'S' || direction === 'W' ? -decimal : decimal
}

export function extractPhotoGps(
  exif: Record<string, unknown> | null | undefined,
): { lat: number; lon: number } | null {
  if (!exif) return null
  const gpsInfo =
    typeof exif.GPSInfo === 'object' && exif.GPSInfo !== null
      ? (exif.GPSInfo as Record<string, unknown>)
      : exif
  const lat = gpsCoordinateToDecimal(
    gpsInfo.GPSLatitude ?? gpsInfo['GPSLatitude'] ?? gpsInfo['2'],
    gpsInfo.GPSLatitudeRef ?? gpsInfo['GPSLatitudeRef'] ?? gpsInfo['1'],
  )
  const lon = gpsCoordinateToDecimal(
    gpsInfo.GPSLongitude ?? gpsInfo['GPSLongitude'] ?? gpsInfo['4'],
    gpsInfo.GPSLongitudeRef ?? gpsInfo['GPSLongitudeRef'] ?? gpsInfo['3'],
  )
  if (lat === null || lon === null) return null
  return { lat, lon }
}

function gpsToChinaMapPoint(lat: number, lon: number): { x: number; y: number } | null {
  if (lat < 15 || lat > 56 || lon < 70 || lon > 140) return null
  return {
    x: Math.min(94, Math.max(6, ((lon - 70) / 70) * 100)),
    y: Math.min(94, Math.max(6, ((56 - lat) / 41) * 100)),
  }
}

function regionIdFromGps(lat: number, lon: number): MapRegionId {
  if (lat >= 42 && lon >= 115) return 'northeast'
  if (lat >= 34 && lon >= 110 && lon < 123) return 'north'
  if (lon >= 116 && lat >= 25 && lat < 34) return 'east'
  if (lat < 25 && lon >= 105) return 'south'
  if (lon < 100 && lat < 34) return 'qinghaiTibet'
  if (lon < 110 && lat >= 34) return 'northwest'
  if (lon < 110 && lat < 34) return 'southwest'
  return 'central'
}

function photoMatchesSpecies(photo: PhotoRecord, species: SpeciesRecord): boolean {
  return getArchiveSpeciesEntries(photo).some((entry) => {
    if (entry.latinName && species.latinName) return entry.latinName === species.latinName
    return entry.name === species.name
  })
}

export function buildArchiveMapPins(
  photos: PhotoRecord[],
  speciesRecords: SpeciesRecord[],
): ArchiveMapPin[] {
  const speciesByLatin = new Map(speciesRecords.map((species) => [species.latinName, species]))
  const speciesByName = new Map(speciesRecords.map((species) => [species.name, species]))
  const pins = new Map<string, ArchiveMapPin>()

  for (const photo of photos) {
    const gps = extractPhotoGps(photo.exif)
    if (!gps) continue
    const gpsPoint = gpsToChinaMapPoint(gps.lat, gps.lon)
    if (!gpsPoint) continue
    const regionId = regionIdFromGps(gps.lat, gps.lon)
    const region = chinaMapRegionById.get(regionId)
    if (!region) continue
    for (const entry of getArchiveSpeciesEntries(photo)) {
      const species =
        (entry.latinName ? speciesByLatin.get(entry.latinName) : null) ??
        (entry.name ? speciesByName.get(entry.name) : null)
      const speciesId = species?.id ?? speciesRecordId(entry.latinName, entry.name)
      const speciesName = species?.name ?? entry.name
      const latinName = species?.latinName ?? entry.latinName
      const coordinateKey = `${gps.lat.toFixed(2)}:${gps.lon.toFixed(2)}`
      const jitter = ((stableHue(`${speciesId}-${coordinateKey}`) % 9) - 4) * 1.3
      const baseX = gpsPoint.x
      const baseY = gpsPoint.y
      const x = Math.min(94, Math.max(6, baseX + jitter))
      const y = Math.min(
        94,
        Math.max(6, baseY + ((stableHue(`${coordinateKey}-${speciesId}`) % 7) - 3) * 1.1),
      )
      const pinKey = `${coordinateKey}:${speciesId}`
      const existing = pins.get(pinKey)
      if (existing) {
        if (!existing.photos.some((item) => item.id === photo.id)) {
          existing.photos.push(photo)
        }
      } else {
        pins.set(pinKey, {
          id: pinKey,
          speciesId,
          speciesName,
          latinName,
          regionId,
          regionLabelKey: region.labelKey,
          x,
          y,
          photos: [photo],
          source: 'gps',
        })
      }
    }
  }

  return Array.from(pins.values()).toSorted((left, right) => {
    if (left.photos.length !== right.photos.length) return right.photos.length - left.photos.length
    return left.speciesName.localeCompare(right.speciesName, 'zh-Hans-CN')
  })
}

export default function App() {
  const { t } = useTranslation()
  const { data: backendData, isReady, isError } = useBackendHealth()
  const engineState = useEngineStore((s) => s.state)
  const appInteractive =
    (engineState === 'ready' || engineState === 'degraded') &&
    isReady &&
    Boolean(backendData?.pipeline.ready)
  // 起手用空 workspace，避免 useLibraries 还没 fetch 完时闪现 mock 数据。
  // useLibraries effect 拿到真数据后会注入；fetch 失败的 fallback 在 handleChooseFolder 里。
  const [workspace, setWorkspace] = useState<WorkspaceSnapshot>(() => ({
    folders: [],
    groups: [],
    photos: [],
    species: [],
  }))
  const [exportSessions, setExportSessions] = useState<ExportSession[]>([])
  const [folderContextMenu, setFolderContextMenu] = useState<FolderContextMenuState>(null)
  const [relinkingFolderId, setRelinkingFolderId] = useState<string | null>(null)

  const {
    route,
    archiveTab,
    activeFolderId,
    activeSpeciesId,
    activeQuickFilters,
    activeSort,
    viewMode,
    searchQuery,
    focusedPhotoId,
    reviewPhotoId,
    setRoute,
    setArchiveTab,
    setActiveFolderId,
    setActiveSpeciesId,
    setActiveQuickFilter,
    setActiveSort,
    setViewMode,
    setSearchQuery,
    setFocusedPhotoId,
    setReviewPhotoId,
    setSettingsOpen,
  } = useUIStore(
    useShallow((state) => ({
      route: state.route,
      archiveTab: state.archiveTab,
      activeFolderId: state.activeFolderId,
      activeSpeciesId: state.activeSpeciesId,
      activeQuickFilters: state.activeQuickFilters,
      activeSort: state.activeSort,
      viewMode: state.viewMode,
      searchQuery: state.searchQuery,
      focusedPhotoId: state.focusedPhotoId,
      reviewPhotoId: state.reviewPhotoId,
      setRoute: state.setRoute,
      setArchiveTab: state.setArchiveTab,
      setActiveFolderId: state.setActiveFolderId,
      setActiveSpeciesId: state.setActiveSpeciesId,
      setActiveQuickFilter: state.setActiveQuickFilter,
      setActiveSort: state.setActiveSort,
      setViewMode: state.setViewMode,
      setSearchQuery: state.setSearchQuery,
      setFocusedPhotoId: state.setFocusedPhotoId,
      setReviewPhotoId: state.setReviewPhotoId,
      setSettingsOpen: state.setSettingsOpen,
    })),
  )

  const deferredSearch = useDeferredValue(searchQuery)
  const shouldLoadArchiveWorkspace = route === 'archive'
  const speciesRecords = useMemo(
    () => (shouldLoadArchiveWorkspace ? deriveSpeciesRecords(workspace) : EMPTY_SPECIES),
    [shouldLoadArchiveWorkspace, workspace],
  )

  // TODO: Replace mock workspace mutations with backend API + TanStack Query mutations
  // once scan, decision, and export endpoints are wired.
  useEffect(() => {
    if (workspace.folders.length === 0) {
      if (activeFolderId !== null) setActiveFolderId(null)
      return
    }
    if (!activeFolderId || !workspace.folders.some((folder) => folder.id === activeFolderId)) {
      setActiveFolderId(workspace.folders[0]?.id ?? null)
    }
  }, [activeFolderId, setActiveFolderId, workspace.folders])

  const visibleFolders = workspace.folders.filter((folder) =>
    matchesQuery([folder.displayName, folder.parentPath, folder.rootPath], deferredSearch),
  )
  const openFolderContextMenu = useCallback(
    (folder: FolderRecord, event: ReactMouseEvent<HTMLElement>) => {
      event.preventDefault()
      event.stopPropagation()
      const maxX = window.innerWidth - FOLDER_CONTEXT_MENU_WIDTH - 8
      const maxY = window.innerHeight - FOLDER_CONTEXT_MENU_HEIGHT - 8
      setFolderContextMenu({
        folder,
        x: Math.max(8, Math.min(event.clientX, maxX)),
        y: Math.max(8, Math.min(event.clientY, maxY)),
      })
    },
    [],
  )
  const closeFolderContextMenu = useCallback(() => setFolderContextMenu(null), [])
  const openFolderInFinder = useCallback(async (folder: FolderRecord) => {
    setFolderContextMenu(null)
    try {
      const result = await window.plumelens?.openPathInFinder?.(folder.rootPath)
      if (result && !result.ok) {
        console.warn('Failed to open folder in Finder:', result.reason)
      }
    } catch (err) {
      console.warn('Failed to open folder in Finder:', err)
    }
  }, [])
  const photosByFolder = useMemo(() => {
    const byFolder = new Map<string, PhotoRecord[]>()
    for (const photo of workspace.photos) {
      const bucket = byFolder.get(photo.folderId)
      if (bucket) bucket.push(photo)
      else byFolder.set(photo.folderId, [photo])
    }
    return byFolder
  }, [workspace.photos])
  const summariesByFolder = useMemo(() => {
    const byFolder = new Map<string, FolderSummary>()
    for (const [folderId, photos] of photosByFolder) {
      byFolder.set(folderId, buildFolderSummary(photos))
    }
    return byFolder
  }, [photosByFolder])
  const activeFolder =
    workspace.folders.find((folder) => folder.id === activeFolderId) ?? visibleFolders[0] ?? null
  const activeSourceMissing = activeFolder?.status === 'path_missing'
  const activeFolderPhotos = activeFolder
    ? (photosByFolder.get(activeFolder.id) ?? EMPTY_PHOTOS)
    : EMPTY_PHOTOS
  const activeFolderSummary = activeFolder
    ? (summariesByFolder.get(activeFolder.id) ?? EMPTY_FOLDER_SUMMARY)
    : EMPTY_FOLDER_SUMMARY
  const openExportForActiveFolder = useCallback(() => {
    if (!activeFolder || activeFolder.status === 'path_missing') return
    setExportSessions((current) => [
      ...current,
      {
        id: `${activeFolder.id}-${Date.now()}-${Math.random().toString(36).slice(2)}`,
        folderId: activeFolder.id,
        initialSource: {
          folder: activeFolder,
          photos: activeFolderPhotos,
          summary: activeFolderSummary,
        },
      },
    ])
  }, [activeFolder, activeFolderPhotos, activeFolderSummary])
  const closeExportSession = useCallback((sessionId: string) => {
    setExportSessions((current) => current.filter((session) => session.id !== sessionId))
  }, [])
  const getExportSource = useCallback(
    (session: ExportSession): ExportSourceSnapshot => {
      const folder =
        workspace.folders.find((item) => item.id === session.folderId) ??
        session.initialSource.folder
      const folderStillExists = workspace.folders.some((item) => item.id === session.folderId)
      if (!folderStillExists) {
        return session.initialSource
      }
      const folderPhotos = photosByFolder.get(session.folderId) ?? EMPTY_PHOTOS
      return {
        folder,
        photos: folderPhotos,
        summary: summariesByFolder.get(session.folderId) ?? EMPTY_FOLDER_SUMMARY,
      }
    },
    [photosByFolder, summariesByFolder, workspace.folders],
  )
  const filteredSelectionPhotos = useMemo(
    () =>
      sortPhotos(
        activeFolderPhotos.filter(
          (photo) =>
            filterPhotoByQuickFilters(photo, activeQuickFilters) &&
            matchesQuery([photo.fileName, photo.speciesName, photo.caption], deferredSearch),
        ),
        activeSort,
      ),
    [activeFolderPhotos, activeQuickFilters, activeSort, deferredSearch],
  )
  const groupStartMs = useMemo(() => buildGroupStartMsMap(activeFolderPhotos), [activeFolderPhotos])

  const folderGroups = useMemo(() => {
    const photosByGroup = new Map<string, PhotoRecord[]>()
    for (const photo of filteredSelectionPhotos) {
      const bucket = photosByGroup.get(photo.groupId)
      if (bucket) bucket.push(photo)
      else photosByGroup.set(photo.groupId, [photo])
    }
    return workspace.groups
      .filter((group) => group.folderId === activeFolder?.id)
      .map((group) => ({
        group,
        photos: photosByGroup.get(group.id) ?? EMPTY_PHOTOS,
      }))
      .filter((entry) => entry.photos.length > 0)
      .toSorted((left, right) => {
        // 组视图始终按组起始拍摄时间倒序；不复用 entry.photos[0]，
        // 避免组内照片排序/筛选改变组与组之间的位置。
        const leftStart = groupStartMs.get(left.group.id) ?? Number.NEGATIVE_INFINITY
        const rightStart = groupStartMs.get(right.group.id) ?? Number.NEGATIVE_INFINITY
        if (leftStart !== rightStart) return rightStart - leftStart
        return left.group.id.localeCompare(right.group.id)
      })
  }, [activeFolder?.id, filteredSelectionPhotos, groupStartMs, workspace.groups])

  const flatSelectionPhotos = useMemo(
    () =>
      viewMode === 'flat' ? filteredSelectionPhotos : folderGroups.flatMap((entry) => entry.photos),
    [filteredSelectionPhotos, folderGroups, viewMode],
  )

  const photoById = useMemo(
    () => new Map(workspace.photos.map((photo) => [photo.id, photo])),
    [workspace.photos],
  )
  const groupById = useMemo(
    () => new Map(workspace.groups.map((group) => [group.id, group])),
    [workspace.groups],
  )
  const focusedPhoto = focusedPhotoId ? (photoById.get(focusedPhotoId) ?? null) : null
  const reviewPhoto = reviewPhotoId ? (photoById.get(reviewPhotoId) ?? null) : null
  const reviewGroup = reviewPhoto?.groupId ? (groupById.get(reviewPhoto.groupId) ?? null) : null
  const activeSpecies = useMemo(
    () =>
      speciesRecords.find((species) => species.id === activeSpeciesId) ??
      speciesRecords.find((species) => species.collected) ??
      speciesRecords[0] ??
      null,
    [activeSpeciesId, speciesRecords],
  )

  useEffect(() => {
    if (!shouldLoadArchiveWorkspace) return
    if (speciesRecords.length === 0) {
      if (activeSpeciesId !== null) setActiveSpeciesId(null)
      return
    }
    if (!activeSpeciesId || !speciesRecords.some((species) => species.id === activeSpeciesId)) {
      setActiveSpeciesId(
        speciesRecords.find((species) => species.collected)?.id ?? speciesRecords[0]?.id ?? null,
      )
    }
  }, [activeSpeciesId, setActiveSpeciesId, shouldLoadArchiveWorkspace, speciesRecords])

  const archivePhotos = useMemo(() => {
    if (!shouldLoadArchiveWorkspace) return EMPTY_PHOTOS
    return sortPhotos(
      workspace.photos.filter(
        (photo) =>
          isArchiveEligiblePhoto(photo) &&
          matchesQuery(archivePhotoSearchParts(photo), deferredSearch),
      ),
      'score',
    )
  }, [deferredSearch, shouldLoadArchiveWorkspace, workspace.photos])
  const archiveSpecies = useMemo(() => {
    if (!shouldLoadArchiveWorkspace) return EMPTY_SPECIES
    return speciesRecords.filter((species) =>
      matchesQuery([species.name, species.latinName, species.summary], deferredSearch),
    )
  }, [deferredSearch, shouldLoadArchiveWorkspace, speciesRecords])
  const reviewPhotos = useMemo(() => {
    if (!reviewPhoto) return []
    const source = route === 'archive' ? archivePhotos : flatSelectionPhotos
    if (source.some((photo) => photo.id === reviewPhoto.id)) return source
    return [reviewPhoto, ...source.filter((photo) => photo.id !== reviewPhoto.id)]
  }, [archivePhotos, flatSelectionPhotos, reviewPhoto, route])
  const reviewSegmentPhotosByPhotoId = useMemo(
    () => buildReviewSegmentPhotosByPhotoId(reviewPhotos),
    [reviewPhotos],
  )
  const reviewGroupPhotos = useMemo(() => {
    if (!reviewPhoto) return EMPTY_PHOTOS
    return reviewSegmentPhotosByPhotoId.get(reviewPhoto.id) ?? EMPTY_PHOTOS
  }, [reviewSegmentPhotosByPhotoId, reviewPhoto])

  const { data: realLibraries } = useLibraries()
  const allLibraryIds = useMemo(() => (realLibraries ?? []).map((l) => l.id), [realLibraries])
  const allDetails = useAllLibraryDetails(allLibraryIds, shouldLoadArchiveWorkspace)
  const { data: activeDetail } = useLibraryDetail(activeFolderId)
  useLibraryEvents(activeFolderId, Boolean(activeFolderId))
  const importLibrary = useImportLibrary()
  const { mutateAsync: updateLibraryDisplayName } = useUpdateLibrary()
  const { mutateAsync: relinkLibrary } = useRelinkLibrary()
  const startBatch = useStartBatch()
  const { mutate: rebuildPhotoThumbnail } = useBuildPhotoThumbnail(activeFolderId)
  const queryClient = useQueryClient()
  const thumbnailRepairingRef = useRef(new Set<string>())
  const thumbnailRepairQueueRef = useRef<string[]>([])
  const thumbnailRepairActiveCountRef = useRef(0)
  const thumbnailLastRepairAtRef = useRef(new Map<string, number>())
  // 'missing' 状态下的短延迟 timer — 给 invalidate 一个机会拿到 stale 但已写入的
  // thumb_grid；仍 missing 就补当前可见照片,不要等后台全库队列扫到它。
  const thumbnailMissingTimersRef = useRef(new Map<string, number>())
  // photos ref 给 handleThumbnailLoadStatus 在 'missing' 状态下查 photo.analysisStatus，
  // 用 ref 而不是 useCallback 依赖，避免 photos 变化导致 callback 频繁重建。
  const photosForRepairRef = useRef(workspace.photos)
  photosForRepairRef.current = workspace.photos
  // unmount 时清掉所有待执行的缩略图修复任务
  useEffect(() => {
    const timers = thumbnailMissingTimersRef.current
    return () => {
      for (const id of timers.values()) window.clearTimeout(id)
      timers.clear()
      thumbnailRepairQueueRef.current = []
      thumbnailRepairingRef.current.clear()
      thumbnailRepairActiveCountRef.current = 0
    }
  }, [])

  const drainThumbnailRepairQueue = useCallback(() => {
    while (thumbnailRepairActiveCountRef.current < THUMBNAIL_REPAIR_MAX_CONCURRENT) {
      const nextPhotoId = thumbnailRepairQueueRef.current.shift()
      if (!nextPhotoId) return

      const currentPhoto = photosForRepairRef.current.find((photo) => photo.id === nextPhotoId)
      if (currentPhoto?.thumbGridUrl || !thumbnailRepairingRef.current.has(nextPhotoId)) {
        thumbnailRepairingRef.current.delete(nextPhotoId)
        continue
      }

      thumbnailRepairActiveCountRef.current += 1
      rebuildPhotoThumbnail(nextPhotoId, {
        onSettled: () => {
          thumbnailRepairActiveCountRef.current = Math.max(
            0,
            thumbnailRepairActiveCountRef.current - 1,
          )
          thumbnailRepairingRef.current.delete(nextPhotoId)
          drainThumbnailRepairQueue()
        },
      })
    }
  }, [rebuildPhotoThumbnail])

  // 引擎状态订阅 — 只在 App mount 时挂一次,IPC 推送通过 zustand store 全局可见。
  useEffect(() => {
    const unsubscribe = subscribeEngineStatus()
    return unsubscribe
  }, [])

  // SSE 重连 key：startBatch 成功后 bump，强制 useAnalysisProgress 重建连接。
  // 应对 SSE idle close（v0.1.0 后端 bug）/ 网络抖动 / 老连接卡住等场景，
  // 确保用户点「开始分析」后立刻能看到 pending 数变化。
  const [sseRestartKey, setSseRestartKey] = useState(0)
  // engine 重启后端口可能变 — engineStore 在 'ready' 事件时也 bump 一次,两边相加。
  const engineSseKey = useEngineStore((s) => s.sseRestartKey)
  const progressEvent = useAnalysisProgress(
    activeFolderId,
    Boolean(activeFolderId),
    sseRestartKey + engineSseKey,
  )
  const setDecisionMutation = useSetDecision(activeFolderId)
  const setSpeciesOverrideMutation = useSetSpeciesOverride(activeFolderId)

  const handleThumbnailLoadStatus = useCallback(
    (photoId: string, status: ThumbnailLoadStatus) => {
      if (status === 'loaded') {
        thumbnailRepairingRef.current.delete(photoId)
        thumbnailRepairQueueRef.current = thumbnailRepairQueueRef.current.filter(
          (queuedPhotoId) => queuedPhotoId !== photoId,
        )
        // 已恢复 → 清掉等待中的 grace timer
        const timer = thumbnailMissingTimersRef.current.get(photoId)
        if (timer !== undefined) {
          window.clearTimeout(timer)
          thumbnailMissingTimersRef.current.delete(photoId)
        }
        return
      }
      if (status === 'loading') return

      const enqueueBackendRebuild = () => {
        if (thumbnailRepairingRef.current.has(photoId)) return
        const now = Date.now()
        const lastRepairAt = thumbnailLastRepairAtRef.current.get(photoId) ?? 0
        if (now - lastRepairAt < THUMBNAIL_REPAIR_COOLDOWN_MS) return
        thumbnailRepairingRef.current.add(photoId)
        thumbnailLastRepairAtRef.current.set(photoId, now)
        thumbnailRepairQueueRef.current.push(photoId)
        drainThumbnailRepairQueue()
      }

      // 'missing'：photo.thumbGridUrl=null 时 ThumbnailImage 上报。
      // 实际场景中通常是 SSE 事件丢失导致前端 stale（DB 已写入 thumb_grid），
      // 优先 invalidate query 试着拿最新值；短延迟后仍 missing 就按可见图优先 rebuild。
      // 仅在 photo 已分析完成（或分析失败）时视为异常 — 分析中 thumb 还没跑完是正常的。
      if (status === 'missing') {
        const photo = photosForRepairRef.current.find((p) => p.id === photoId)
        if (!photo) return
        if (photo.analysisStatus !== 'done' && photo.analysisStatus !== 'failed') return
        if (thumbnailMissingTimersRef.current.has(photoId)) return
        // Step 1: 立刻 invalidate library_detail（免费）
        if (activeFolderId) {
          queryClient.invalidateQueries({ queryKey: LIBRARY_DETAIL_KEY(activeFolderId) })
        }
        // Step 2: 很短延迟后如果仍 missing，调 backend rebuild
        const timerId = window.setTimeout(() => {
          thumbnailMissingTimersRef.current.delete(photoId)
          const refreshed = photosForRepairRef.current.find((p) => p.id === photoId)
          if (refreshed?.thumbGridUrl) return // 已通过 invalidate 恢复
          enqueueBackendRebuild()
        }, THUMBNAIL_MISSING_REPAIR_DELAY_MS)
        thumbnailMissingTimersRef.current.set(photoId, timerId)
        return
      }

      // 'error'：图片 URL 有但加载 404 / 解码失败 → 立即 rebuild
      enqueueBackendRebuild()
    },
    [activeFolderId, drainThumbnailRepairQueue, queryClient],
  )

  // 后端 library 列表就绪时：用真 folders 替换 mock seeds，
  // 同时**清空 mock photos/groups/species**（避免 archive 页 / 物种墙混入"池鹭/翠鸟"等假数据）。
  // useLibraryDetail 后续会按需注入每个 folder 的真 photos。
  useEffect(() => {
    // 后端列表 fetch 完成（哪怕空数组）就用真数据替换。空数组也要清掉 mock seeds，
    // 否则全新安装时"最近文件夹"会显示崇明东滩/南汇嘴这种假数据。
    if (!realLibraries) return
    const realFolderIds = new Set(realLibraries.map((l) => l.id))
    setWorkspace((current) => ({
      folders: realLibraries.map((lib) => ({
        id: lib.id,
        displayName: lib.display_name,
        parentPath: lib.parent_path,
        rootPath: lib.root_path,
        status: lib.status,
        totalCount: lib.total_count,
        analyzedCount: lib.analyzed_count,
        recursive: lib.recursive,
        lastOpenedAt: lib.last_opened_at,
        lastScannedAt: lib.last_scanned_at ?? lib.last_opened_at,
        lastAnalyzedAt: lib.last_analyzed_at,
      })),
      // 只保留真 folder 的 photos/groups（mock seeds 的 folderId 不在真集合里 → 被剔除）
      photos: current.photos.filter((p) => realFolderIds.has(p.folderId)),
      groups: current.groups.filter((g) => realFolderIds.has(g.folderId)),
      // 物种列表清空 — deriveSpeciesRecords 会从真 photos 聚合
      species: [],
    }))
  }, [realLibraries])

  // useAllLibraryDetails 每次 render 返回新数组引用，但内容大多数时候没变。
  // 用稳定字符串 key 描述"内容是否真变化"，再用 useMemo 把派生 fragments 引用绑定到这个 key。
  const allDetailsKey = useMemo(
    () =>
      allDetails
        .map(
          (d) =>
            `${d.library.id}:${d.library.display_name}:${d.library.status}:${d.library.last_scanned_at ?? ''}:${d.library.last_analyzed_at ?? ''}:${d.photos.length}:${d.library.analyzed_count}:${libraryDetailContentHash(d)}`,
        )
        .join('|'),
    [allDetails],
  )
  // 所有 library 的详情就绪后，把真照片注入 workspace（archive 页跨 library 聚合需要）。
  // useAllLibraryDetails 每次 render 返回新数组引用 → 用 allDetailsKey（稳定字符串）作为
  // useEffect 唯一依赖，allDetails 通过闭包读最新值。避免引用变化触发死循环。
  useEffect(() => {
    if (allDetails.length === 0) return
    const fragments = allDetails.map((detail) => buildFragmentFromDetail(detail, t))
    const realFolderIdsInDetails = new Set(fragments.map((f) => f.folder.id))
    setWorkspace((current) => ({
      folders: current.folders.map((f) => {
        const updated = fragments.find((fr) => fr.folder.id === f.id)
        return updated ? updated.folder : f
      }),
      photos: [
        ...current.photos.filter((p) => !realFolderIdsInDetails.has(p.folderId)),
        ...fragments.flatMap((f) => f.photos),
      ],
      groups: [
        ...current.groups.filter((g) => !realFolderIdsInDetails.has(g.folderId)),
        ...fragments.flatMap((f) => f.groups),
      ],
      species: [],
    }))
  }, [allDetailsKey, t])

  // 单 library detail 就绪（active folder 切换时优先级更高，立即注入）
  useEffect(() => {
    if (!activeDetail) return
    const fragment = buildFragmentFromDetail(activeDetail, t)
    setWorkspace((current) => ({
      ...current,
      folders: current.folders.map((f) => (f.id === fragment.folder.id ? fragment.folder : f)),
      photos: [
        ...current.photos.filter((p) => p.folderId !== fragment.folder.id),
        ...fragment.photos,
      ],
      groups: [
        ...current.groups.filter((g) => g.folderId !== fragment.folder.id),
        ...fragment.groups,
      ],
    }))
  }, [activeDetail, t])

  async function handleChooseFolder() {
    const path = await window.plumelens?.openFolder?.()
    if (!path) return

    // 先切到 selection 路由，给用户即时视觉反馈
    startTransition(() => {
      setRoute('selection')
      setViewMode('grouped')
    })

    // 调用真后端 import；成功后用返回的 library_id 作为 activeFolderId
    // → useLibraryDetail 自动拉详情 → useEffect 把真 photos 注入 workspace
    try {
      const lib = await importLibrary.mutateAsync({ root_path: path })
      setActiveFolderId(lib.id)
    } catch (err) {
      console.warn('Library import to backend failed:', err)
      // 后端不可用时降级到 mock，避免空白屏
      const imported = createImportedFolder(path)
      setWorkspace((current) => mergeWorkspace(current, imported))
      setActiveFolderId(imported.folders[0]?.id ?? null)
    }
  }

  const handleRenameFolder = useCallback(
    async (folderId: string, displayName: string) => {
      const updated = await updateLibraryDisplayName({ libraryId: folderId, displayName })
      setWorkspace((current) => ({
        ...current,
        folders: current.folders.map((folder) =>
          folder.id === updated.id ? { ...folder, displayName: updated.display_name } : folder,
        ),
      }))
    },
    [updateLibraryDisplayName],
  )

  const handleRelinkFolder = useCallback(
    async (folderId: string) => {
      const path = await window.plumelens?.openFolder?.()
      if (!path) return
      setRelinkingFolderId(folderId)
      try {
        const response = await relinkLibrary({ libraryId: folderId, rootPath: path })
        const updated = response.library
        setWorkspace((current) => ({
          ...current,
          folders: current.folders.map((folder) =>
            folder.id === updated.id
              ? {
                  ...folder,
                  parentPath: updated.parent_path,
                  rootPath: updated.root_path,
                  status: updated.status,
                  totalCount: updated.total_count,
                  analyzedCount: updated.analyzed_count,
                  recursive: updated.recursive,
                  lastOpenedAt: updated.last_opened_at,
                  lastScannedAt: updated.last_scanned_at ?? updated.last_opened_at,
                  lastAnalyzedAt: updated.last_analyzed_at,
                }
              : folder,
          ),
        }))
        void queryClient.refetchQueries({ queryKey: LIBRARY_DETAIL_KEY(folderId), type: 'active' })
      } catch (err) {
        console.warn('Failed to relink library source folder:', err)
        throw err
      } finally {
        setRelinkingFolderId(null)
      }
    },
    [queryClient, relinkLibrary],
  )

  async function handleStartAnalysis() {
    if (!activeFolderId || activeSourceMissing) return
    try {
      await startBatch.mutateAsync({ libraryId: activeFolderId })
      // bump key 让 useAnalysisProgress 重建 SSE 连接（如果上一个 idle 死了）
      setSseRestartKey((k) => k + 1)
    } catch (err) {
      console.error('Failed to start batch analysis:', err)
    }
  }

  function handleNavigate(nextRoute: AppRoute) {
    startTransition(() => {
      setRoute(nextRoute)
      if (nextRoute === 'selection' && activeFolder) {
        setActiveFolderId(activeFolder.id)
      }
    })
  }

  function handleSelectFolder(folderId: string) {
    startTransition(() => {
      setRoute('selection')
      setActiveFolderId(folderId)
    })
  }

  function handleSetDecision(photoId: string, decision: SelectionDecision) {
    // 乐观更新本地 state（即时反馈）
    startTransition(() => {
      setWorkspace((current) => ({
        ...current,
        photos: current.photos.map((photo) =>
          photo.id === photoId ? { ...photo, decision } : photo,
        ),
      }))
      setFocusedPhotoId(photoId)
    })
    // 异步落库（后端不可用时保持 mock 体验）
    setDecisionMutation.mutate(
      { photoId, decision: decision as DecisionValue },
      {
        onError: (err) => {
          // 仅记录 — 乐观 UI 不回滚，下次 refetch 会纠正
          console.warn('Failed to persist decision:', err)
        },
      },
    )
  }

  function handleSetSpeciesOverride(
    photoId: string,
    birdIndex: number,
    species: SpeciesOverrideValue | null,
    bbox?: SpeciesOverrideBBox | null,
  ) {
    const displayName =
      species?.canonical_zh ?? species?.canonical_en ?? species?.canonical_sci ?? null
    startTransition(() => {
      setWorkspace((current) => ({
        ...current,
        photos: current.photos.map((photo) => {
          if (photo.id !== photoId) return photo
          const detections = (photo.birdDetections ?? []).map((bird) =>
            bird.index === birdIndex
              ? {
                  ...bird,
                  speciesName: displayName,
                  speciesLatinName: species?.canonical_sci ?? null,
                  speciesEnglishName: species?.canonical_en ?? null,
                  manualSpecies: species !== null,
                }
              : bird,
          )
          const isBest = detections.find((bird) => bird.index === birdIndex)?.isBest ?? false
          return {
            ...photo,
            birdDetections: detections,
            ...(isBest
              ? {
                  speciesName: displayName,
                  speciesLatinName: species?.canonical_sci ?? null,
                  speciesEnglishName: species?.canonical_en ?? null,
                  manualSpecies: species !== null,
                }
              : {}),
          }
        }),
      }))
      setFocusedPhotoId(photoId)
    })

    setSpeciesOverrideMutation.mutate(
      { photoId, birdIndex, species, bbox: bbox ?? null },
      {
        onError: (err) => {
          console.warn('Failed to persist species override:', err)
        },
      },
    )
  }

  function handleOpenReview(photoId: string) {
    startTransition(() => {
      setFocusedPhotoId(photoId)
      setReviewPhotoId(photoId)
    })
  }

  useEffect(() => {
    if (route !== 'selection' || reviewPhotoId !== null) return
    if (!focusedPhotoId || !flatSelectionPhotos.some((photo) => photo.id === focusedPhotoId)) return

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || !isPlainSpaceKey(event)) return
      if (shouldIgnoreSelectionReviewShortcutTarget(event.target)) return
      event.preventDefault()
      handleOpenReview(focusedPhotoId)
    }

    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [flatSelectionPhotos, focusedPhotoId, reviewPhotoId, route])

  return (
    <AppShell
      onNavigate={handleNavigate}
      onOpenExport={openExportForActiveFolder}
      onOpenSettings={() => setSettingsOpen(true)}
      onSearchChange={setSearchQuery}
      route={route}
      searchQuery={searchQuery}
      t={t}
      controlsDisabled={!appInteractive}
      exportDisabled={Boolean(activeSourceMissing)}
    >
      {route === 'selection' ? (
        <SelectionScreen
          activeFolder={activeFolder}
          activeFolderSummary={activeFolderSummary}
          activeQuickFilters={activeQuickFilters}
          activeSort={activeSort}
          analysisStarting={startBatch.isPending}
          filteredGroups={folderGroups}
          flatPhotos={flatSelectionPhotos}
          focusedPhoto={focusedPhoto}
          focusedPhotoId={focusedPhotoId}
          folderPhotos={activeFolderPhotos}
          folders={visibleFolders}
          onThumbnailLoadStatus={handleThumbnailLoadStatus}
          onOpenFolderContextMenu={openFolderContextMenu}
          onOpenExport={openExportForActiveFolder}
          onOpenReview={handleOpenReview}
          onRelinkFolder={handleRelinkFolder}
          onRenameFolder={handleRenameFolder}
          onSelectFolder={handleSelectFolder}
          onSetDecision={handleSetDecision}
          onStartAnalysis={handleStartAnalysis}
          progressEvent={progressEvent}
          relinkingFolderId={relinkingFolderId}
          setActiveQuickFilter={setActiveQuickFilter}
          setActiveSort={setActiveSort}
          setFocusedPhotoId={setFocusedPhotoId}
          setRoute={setRoute}
          setViewMode={setViewMode}
          t={t}
          viewMode={viewMode}
          workspace={workspace}
        />
      ) : route === 'archive' ? (
        <ArchiveScreen
          activeSpecies={activeSpecies}
          archivePhotos={archivePhotos}
          archiveSpecies={archiveSpecies}
          archiveTab={archiveTab}
          onOpenReview={handleOpenReview}
          onSelectSpecies={setActiveSpeciesId}
          onSetArchiveTab={setArchiveTab}
          t={t}
        />
      ) : (
        <StartScreen
          backendData={backendData}
          folders={visibleFolders}
          isError={isError}
          isReady={isReady}
          onChooseFolder={handleChooseFolder}
          onContinueLatest={() => handleNavigate('selection')}
          onOpenFolderContextMenu={openFolderContextMenu}
          onOpenFolder={handleSelectFolder}
          t={t}
        />
      )}

      {reviewPhoto ? (
        <ReviewModal
          detail={{ photo: reviewPhoto, group: reviewGroup }}
          groupPhotos={reviewGroupPhotos}
          onClose={() => setReviewPhotoId(null)}
          onSelectPhoto={handleOpenReview}
          onSetDecision={handleSetDecision}
          onSetSpeciesOverride={handleSetSpeciesOverride}
          onThumbnailLoadStatus={handleThumbnailLoadStatus}
          photos={reviewPhotos}
          t={t}
        />
      ) : null}

      {exportSessions.length > 0 ? (
        <div className="export-session-stack">
          {exportSessions.map((session) => (
            <ExportDrawer
              key={session.id}
              onClose={() => closeExportSession(session.id)}
              source={getExportSource(session)}
              t={t}
            />
          ))}
        </div>
      ) : null}

      <FolderContextMenu
        menu={folderContextMenu}
        onClose={closeFolderContextMenu}
        onOpenFolder={openFolderInFinder}
        onRelinkFolder={handleRelinkFolder}
        t={t}
      />
    </AppShell>
  )
}

function FolderContextMenu({
  menu,
  onClose,
  onOpenFolder,
  onRelinkFolder,
  t,
}: {
  menu: FolderContextMenuState
  onClose: () => void
  onOpenFolder: (folder: FolderRecord) => void
  onRelinkFolder: (folderId: string) => Promise<void>
  t: ReturnType<typeof useTranslation>['t']
}) {
  useEffect(() => {
    if (!menu) return

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose()
    }
    const handleClick = () => onClose()
    const handleScroll = () => onClose()

    window.addEventListener('keydown', handleKeyDown)
    window.addEventListener('click', handleClick)
    window.addEventListener('scroll', handleScroll, true)
    return () => {
      window.removeEventListener('keydown', handleKeyDown)
      window.removeEventListener('click', handleClick)
      window.removeEventListener('scroll', handleScroll, true)
    }
  }, [menu, onClose])

  if (!menu) return null

  return (
    <div
      className="folder-context-menu"
      onContextMenu={(event) => event.preventDefault()}
      onMouseDown={(event) => event.stopPropagation()}
      role="menu"
      style={{ left: menu.x, top: menu.y }}
      aria-label={t('selection.folderMenu.label')}
    >
      <button onClick={() => onOpenFolder(menu.folder)} role="menuitem" type="button">
        <FolderOpen className="h-4 w-4" />
        <span>{t('selection.folderMenu.openInFinder')}</span>
      </button>
      {menu.folder.status === 'path_missing' ? (
        <button
          onClick={(event) => {
            event.stopPropagation()
            onClose()
            void onRelinkFolder(menu.folder.id).catch((err) => {
              console.warn('Failed to relink library source folder:', err)
            })
          }}
          role="menuitem"
          type="button"
        >
          <FolderSearch2 className="h-4 w-4" />
          <span>{t('selection.sourceMissing.relinkAction')}</span>
        </button>
      ) : null}
    </div>
  )
}

function AppShell({
  children,
  controlsDisabled,
  exportDisabled,
  onNavigate,
  onOpenExport,
  onOpenSettings,
  onSearchChange,
  route,
  searchQuery,
  t,
}: {
  children: ReactNode
  controlsDisabled: boolean
  exportDisabled: boolean
  onNavigate: (route: AppRoute) => void
  onOpenExport: () => void
  onOpenSettings: () => void
  onSearchChange: (value: string) => void
  route: AppRoute
  searchQuery: string
  t: ReturnType<typeof useTranslation>['t']
}) {
  const disabledTitle = controlsDisabled ? t('nav.loadingDisabled') : undefined
  const exportDisabledTitle = exportDisabled
    ? t('selection.sourceMissing.exportDisabled')
    : undefined
  return (
    <div className="app-shell">
      <header className="command-bar">
        <button
          className="brand-mark"
          disabled={controlsDisabled}
          onClick={() => onNavigate('start')}
          title={disabledTitle}
          type="button"
        >
          <span className="brand-mark__icon">
            <Feather className="h-4 w-4" />
          </span>
          <span className="brand-mark__copy">
            <span>{t('app.title')}</span>
            <span>{t('app.tagline')}</span>
          </span>
        </button>

        <nav className="route-switcher" aria-label={t('nav.primary')}>
          {(['start', 'selection', 'archive'] as AppRoute[]).map((item) => {
            const Icon = routeIcons[item]
            return (
              <button
                className={cn(
                  'route-switcher__item',
                  route === item && 'route-switcher__item--active',
                )}
                disabled={controlsDisabled}
                key={item}
                onClick={() => onNavigate(item)}
                title={disabledTitle}
                type="button"
              >
                <Icon className="h-4 w-4" />
                <span>{t(routeLabelKey(item))}</span>
              </button>
            )
          })}
        </nav>

        <div className="command-actions">
          <label
            className={cn('search-pill', controlsDisabled && 'search-pill--disabled')}
            title={disabledTitle}
          >
            <Search className="h-4 w-4" />
            <input
              onChange={(event) => onSearchChange(event.target.value)}
              disabled={controlsDisabled}
              placeholder={t('nav.search')}
              value={searchQuery}
            />
          </label>
          <IconButton
            disabled={controlsDisabled || exportDisabled}
            label={t('common.export')}
            onClick={onOpenExport}
            title={disabledTitle ?? exportDisabledTitle}
          >
            <Download className="h-4 w-4" />
          </IconButton>
          <IconButton
            disabled={controlsDisabled}
            label={t('common.settings')}
            onClick={onOpenSettings}
          >
            <Settings2 className="h-4 w-4" />
          </IconButton>
          {/* 引擎状态在左下角 status bar 已有完整展示，此处不重复 */}
        </div>
      </header>

      <EngineStatusBanner />
      <div className="app-body">{children}</div>
      <SettingsModal />
    </div>
  )
}

function StartScreen({
  backendData,
  folders,
  isError,
  isReady,
  onChooseFolder,
  onContinueLatest,
  onOpenFolderContextMenu,
  onOpenFolder,
  t,
}: {
  backendData: ReturnType<typeof useBackendHealth>['data']
  folders: FolderRecord[]
  isError: boolean
  isReady: boolean
  onChooseFolder: () => void
  onContinueLatest: () => void
  onOpenFolderContextMenu: (folder: FolderRecord, event: ReactMouseEvent<HTMLElement>) => void
  onOpenFolder: (folderId: string) => void
  t: ReturnType<typeof useTranslation>['t']
}) {
  const recentFolders = folders.toSorted((left, right) =>
    right.lastOpenedAt.localeCompare(left.lastOpenedAt),
  )
  const hasRecentFolders = recentFolders.length > 0

  return (
    <main
      className={cn(
        'start-screen selection-scroll',
        !hasRecentFolders && 'start-screen--empty-history',
      )}
    >
      <section className="start-hero">
        <div className="start-copy">
          <div className="eyebrow-row">
            <StatusDot tone="accent" />
            <span>{t('start.kicker')}</span>
          </div>
          <h1>
            {t('start.title')
              .split('\n')
              .map((line) => (
                <span key={line}>{line}</span>
              ))}
          </h1>
          <p>{t('start.subtitle')}</p>
          <div className="action-row">
            <button className="button-primary" onClick={onChooseFolder} type="button">
              <FolderSearch2 className="h-4 w-4" />
              {t('start.primaryAction')}
            </button>
            <button
              className="button-ghost"
              disabled={!hasRecentFolders}
              onClick={onContinueLatest}
              type="button"
            >
              <ArrowRight className="h-4 w-4" />
              {t('start.secondaryAction')}
            </button>
          </div>
        </div>

        <BirdGlyph />
      </section>

      {hasRecentFolders ? (
        <section className="start-workbench">
          <div className="start-list">
            <div className="start-list__heading">
              <h2>{t('start.recentFolders')}</h2>
              <span>{`${recentFolders.length} ${t('start.entries')}`}</span>
            </div>
            <div className="folder-stack">
              {recentFolders.slice(0, 3).map((folder) => (
                <button
                  className="folder-line"
                  key={folder.id}
                  onContextMenu={(event) => onOpenFolderContextMenu(folder, event)}
                  onClick={() => onOpenFolder(folder.id)}
                  type="button"
                >
                  <span>
                    <strong>{folder.displayName}</strong>
                    <small>{folder.parentPath}</small>
                  </span>
                  <span className="folder-line__status">
                    <StatusDot tone={statusTone(folder.status)} />
                    <span>{t(statusLabelKey(folder.status))}</span>
                  </span>
                </button>
              ))}
            </div>
          </div>
        </section>
      ) : null}
      <EnginePanel backendData={backendData} isError={isError} isReady={isReady} t={t} />
    </main>
  )
}

type BackendHealthData = ReturnType<typeof useBackendHealth>['data']
type PipelineModels = NonNullable<BackendHealthData>['pipeline']['models']
type PipelineModelState = PipelineModels[string]
type PipelineDevice = 'cpu' | 'gpu' | 'mps' | 'mixed' | 'unknown'
type PipelineRuntime = {
  device: PipelineDevice
  deviceLabelKey: string
  providerLabel: string
}

type PipelineStatusItemModel = {
  key: string
  label: string
  loading: boolean
  runtime: PipelineRuntime | null
  tone: Tone
  value: string
}

export function pipelineRuntimeFromProvider(provider?: string | null): PipelineRuntime {
  const normalized = provider?.toLowerCase() ?? ''

  if (!normalized) {
    return {
      device: 'unknown',
      deviceLabelKey: 'start.device.detecting',
      providerLabel: '--',
    }
  }

  if (normalized.includes('mps')) {
    return {
      device: 'mps',
      deviceLabelKey: 'start.device.mps',
      providerLabel: 'MPS',
    }
  }

  if (normalized.includes('cuda')) {
    return {
      device: 'gpu',
      deviceLabelKey: 'start.device.gpu',
      providerLabel: 'CUDA',
    }
  }

  if (normalized.includes('coreml')) {
    return {
      device: 'gpu',
      deviceLabelKey: 'start.device.gpu',
      providerLabel: 'CoreML',
    }
  }

  if (normalized.includes('cpu')) {
    return {
      device: 'cpu',
      deviceLabelKey: 'start.device.cpu',
      providerLabel: normalized.includes('torch') ? 'Torch CPU' : 'CPU',
    }
  }

  return {
    device: 'unknown',
    deviceLabelKey: 'start.device.unknown',
    providerLabel: provider ?? '--',
  }
}

function mergePipelineRuntimes(models: Array<PipelineModelState | undefined>): PipelineRuntime {
  const runtimes = models
    .filter((model): model is PipelineModelState => Boolean(model?.provider))
    .map((model) => pipelineRuntimeFromProvider(model.provider))

  if (runtimes.length === 0) {
    return pipelineRuntimeFromProvider()
  }

  const providerLabels = Array.from(new Set(runtimes.map((runtime) => runtime.providerLabel)))
  const devices = Array.from(new Set(runtimes.map((runtime) => runtime.device)))
  const device = devices.length === 1 ? devices[0] : 'mixed'

  return {
    device,
    deviceLabelKey: device === 'mixed' ? 'start.device.mixed' : runtimes[0].deviceLabelKey,
    providerLabel: providerLabels.join(' + '),
  }
}

function getPipelineModel(models: PipelineModels | undefined, key: string) {
  return models?.[key]
}

function runtimeSummaryLabel(
  items: PipelineStatusItemModel[],
  t: ReturnType<typeof useTranslation>['t'],
) {
  const providers = Array.from(
    new Set(
      items
        .map((item) => item.runtime?.providerLabel)
        .filter((label): label is string => Boolean(label && label !== '--')),
    ),
  )

  return providers.length > 0 ? providers.join(' · ') : t('start.runtime.localOnly')
}

function EnginePanel({
  backendData,
  isError,
  isReady,
  t,
}: {
  backendData: BackendHealthData
  isError: boolean
  isReady: boolean
  t: ReturnType<typeof useTranslation>['t']
}) {
  const pipeline = backendData?.pipeline
  const models = pipeline?.models
  const isInitializing = !backendData && !isError
  const isPipelineReady = Boolean(pipeline?.ready)
  const statusToneValue: Tone = isError ? 'accent' : isPipelineReady ? 'success' : 'warning'
  const yoloModel = getPipelineModel(models, 'yolo')
  const poseModel = getPipelineModel(models, 'bird_visibility')
  const clipiqaModel = getPipelineModel(models, 'clipiqa')
  const hyperiqaModel = getPipelineModel(models, 'hyperiqa')
  const speciesModel = getPipelineModel(models, 'dinov3_species_v4')

  const modelValue = useCallback(
    (loaded: boolean) => {
      if (isError) return t('start.status.error')
      if (isInitializing) return t('start.status.loading')
      return loaded ? t('start.status.ready') : t('start.status.pending')
    },
    [isError, isInitializing, t],
  )

  const modelTone = useCallback(
    (loaded: boolean): Tone => {
      if (isError) return 'accent'
      if (isInitializing) return 'warning'
      return loaded ? 'success' : 'warning'
    },
    [isError, isInitializing],
  )

  const detectorReady = Boolean(yoloModel?.loaded || pipeline?.ready)
  const qualityReady = Boolean(
    pipeline?.quality_available || (clipiqaModel?.loaded && hyperiqaModel?.loaded),
  )
  const poseReady = Boolean(pipeline?.pose_available || poseModel?.loaded)
  const speciesReady = Boolean(pipeline?.species_available || speciesModel?.loaded)

  const pipelineItems = useMemo(
    () =>
      [
        {
          key: 'engine',
          label: t('start.status.engine'),
          loading: isInitializing,
          runtime: null,
          tone: statusToneValue,
          value: isError
            ? t('start.status.error')
            : isReady
              ? isPipelineReady
                ? t('start.status.ready')
                : t('start.status.loading')
              : t('start.status.loading'),
        },
        {
          key: 'detector',
          label: t('start.status.detector'),
          loading: isInitializing,
          runtime: pipelineRuntimeFromProvider(yoloModel?.provider),
          tone: modelTone(detectorReady),
          value: modelValue(detectorReady),
        },
        {
          key: 'quality',
          label: t('start.status.quality'),
          loading: isInitializing,
          runtime: mergePipelineRuntimes([clipiqaModel, hyperiqaModel]),
          tone: modelTone(qualityReady),
          value: modelValue(qualityReady),
        },
        {
          key: 'pose',
          label: t('start.status.pose'),
          loading: isInitializing,
          runtime: pipelineRuntimeFromProvider(poseModel?.provider),
          tone: modelTone(poseReady),
          value: modelValue(poseReady),
        },
        {
          key: 'species',
          label: t('start.status.species'),
          loading: isInitializing,
          runtime: pipelineRuntimeFromProvider(speciesModel?.provider),
          tone: modelTone(speciesReady),
          value: modelValue(speciesReady),
        },
      ] satisfies PipelineStatusItemModel[],
    [
      clipiqaModel,
      detectorReady,
      hyperiqaModel,
      isError,
      isInitializing,
      isPipelineReady,
      isReady,
      modelTone,
      modelValue,
      poseModel,
      poseReady,
      qualityReady,
      speciesModel,
      speciesReady,
      statusToneValue,
      t,
      yoloModel,
    ],
  )

  const summaryValue = isError
    ? t('status.error')
    : isPipelineReady
      ? t('status.connected')
      : t('start.status.loading')
  const runtimeNote = isError
    ? t('start.runtime.unavailable')
    : isInitializing
      ? t('start.runtime.initializing')
      : runtimeSummaryLabel(pipelineItems, t)

  return (
    <aside className={cn('pipeline-bar', isInitializing && 'pipeline-bar--loading')}>
      <div className="pipeline-bar__summary">
        <StatusDot tone={statusToneValue} />
        <span>{t('start.pipelineState')}</span>
        <strong>{summaryValue}</strong>
        {isInitializing ? (
          <span className="pipeline-bar__loader" aria-hidden="true">
            <i />
            <i />
            <i />
          </span>
        ) : null}
      </div>

      <div className="pipeline-bar__items">
        {pipelineItems.map((item) => (
          <PipelineStatusItem
            key={item.label}
            label={item.label}
            tone={item.tone}
            t={t}
            value={item.value}
            loading={item.loading}
            runtime={item.runtime}
          />
        ))}
      </div>

      <div className="pipeline-bar__note">{runtimeNote}</div>
    </aside>
  )
}

function PipelineStatusItem({
  label,
  loading,
  runtime,
  t,
  tone,
  value,
}: {
  label: string
  loading: boolean
  runtime: PipelineRuntime | null
  t: ReturnType<typeof useTranslation>['t']
  tone: Tone
  value: string
}) {
  return (
    <div className={cn('pipeline-bar__item', loading && 'pipeline-bar__item--loading')}>
      <small>{label}</small>
      <strong>{value}</strong>
      {runtime ? (
        <span
          className={cn('pipeline-device', `pipeline-device--${runtime.device}`)}
          title={runtime.providerLabel}
        >
          {t(runtime.deviceLabelKey)}
        </span>
      ) : null}
      <StatusDot tone={tone} />
    </div>
  )
}

function BirdGlyph() {
  return (
    <div className="start-glyph-bird" aria-hidden="true">
      {birdGlyphPattern.flatMap((row, rowIndex) =>
        [...row].map((cell, columnIndex) => (
          <i
            className={cn(
              cell !== '.' && 'is-lit',
              cell === '2' && 'is-bright',
              cell === '3' && 'is-eye-falloff',
              !isInsideRoundedGlyphFrame(rowIndex, columnIndex) && 'is-outside-frame',
            )}
            key={`bird-glyph-${rowIndex}-${columnIndex}`}
            style={{ animationDelay: `${(rowIndex + columnIndex) * 42}ms` }}
          />
        )),
      )}
    </div>
  )
}

function SelectionScreen({
  activeFolder,
  activeFolderSummary,
  activeQuickFilters,
  activeSort,
  analysisStarting,
  filteredGroups,
  flatPhotos,
  focusedPhoto,
  focusedPhotoId,
  folderPhotos,
  folders,
  onOpenExport,
  onOpenFolderContextMenu,
  onOpenReview,
  onRelinkFolder,
  onRenameFolder,
  onSelectFolder,
  onSetDecision,
  onStartAnalysis,
  onThumbnailLoadStatus,
  progressEvent,
  relinkingFolderId,
  setActiveQuickFilter,
  setActiveSort,
  setFocusedPhotoId,
  setRoute,
  setViewMode,
  t,
  viewMode,
  workspace,
}: {
  activeFolder: FolderRecord | null
  activeFolderSummary: FolderSummary
  activeQuickFilters: QuickFilter[]
  activeSort: SortMode
  analysisStarting: boolean
  filteredGroups: Array<{ group: PhotoGroupRecord; photos: PhotoRecord[] }>
  flatPhotos: PhotoRecord[]
  focusedPhoto: PhotoRecord | null
  focusedPhotoId: string | null
  folderPhotos: PhotoRecord[]
  folders: FolderRecord[]
  onOpenExport: () => void
  onOpenFolderContextMenu: (folder: FolderRecord, event: ReactMouseEvent<HTMLElement>) => void
  onOpenReview: (photoId: string) => void
  onRelinkFolder: (folderId: string) => Promise<void>
  onRenameFolder: (folderId: string, displayName: string) => Promise<void>
  onSelectFolder: (folderId: string) => void
  onSetDecision: (photoId: string, decision: SelectionDecision) => void
  onStartAnalysis: () => void
  onThumbnailLoadStatus: (photoId: string, status: ThumbnailLoadStatus) => void
  progressEvent: AnalysisProgressEventLite | null
  relinkingFolderId: string | null
  setActiveQuickFilter: (filter: QuickFilter) => void
  setActiveSort: (sort: SortMode) => void
  setFocusedPhotoId: (photoId: string | null) => void
  setRoute: (route: AppRoute) => void
  setViewMode: (mode: ViewMode) => void
  t: ReturnType<typeof useTranslation>['t']
  viewMode: ViewMode
  workspace: WorkspaceSnapshot
}) {
  const selectionScrollRef = useRef<HTMLElement | null>(null)
  const [selectionScrollElement, setSelectionScrollElement] = useState<HTMLElement | null>(null)
  const setSelectionScrollNode = useCallback((node: HTMLElement | null) => {
    selectionScrollRef.current = node
    setSelectionScrollElement((current) => (current === node ? current : node))
  }, [])
  const selectionFilterKey = `${activeFolder?.id ?? ''}:${viewMode}:${activeSort}:${activeQuickFilters.join(',')}`

  useEffect(() => {
    selectionScrollElement?.scrollTo({ top: 0 })
  }, [selectionFilterKey, selectionScrollElement])

  if (!activeFolder) {
    return (
      <main className="empty-screen">
        <div>
          <FolderOpen className="h-8 w-8" />
          <h1>{t('selection.empty.title')}</h1>
          <p>{t('selection.empty.body')}</p>
          <button className="button-primary" onClick={() => setRoute('start')} type="button">
            {t('selection.empty.action')}
          </button>
        </div>
      </main>
    )
  }

  return (
    <main className="selection-screen">
      <FolderRail
        activeFolderId={activeFolder.id}
        folders={folders}
        onOpenFolderContextMenu={onOpenFolderContextMenu}
        onSelectFolder={onSelectFolder}
        t={t}
        workspace={workspace}
      />

      <section className="selection-main selection-scroll" ref={setSelectionScrollNode}>
        <FolderTopline
          activeFolder={activeFolder}
          analysisStarting={analysisStarting}
          onOpenExport={onOpenExport}
          onRelinkFolder={onRelinkFolder}
          onRenameFolder={onRenameFolder}
          onStartAnalysis={onStartAnalysis}
          progressEvent={progressEvent}
          relinking={relinkingFolderId === activeFolder.id}
          t={t}
        />
        <MetricStrip photos={folderPhotos} summary={activeFolderSummary} t={t} />
        <SelectionControls
          activeQuickFilters={activeQuickFilters}
          activeSort={activeSort}
          setActiveQuickFilter={setActiveQuickFilter}
          setActiveSort={setActiveSort}
          setViewMode={setViewMode}
          t={t}
          viewMode={viewMode}
        />

        <div className="photo-flow">
          {viewMode === 'grouped' ? (
            <VirtualizedPhotoGroups
              focusedPhotoId={focusedPhotoId}
              groups={filteredGroups}
              onFocusPhoto={setFocusedPhotoId}
              onOpenReview={onOpenReview}
              onThumbnailLoadStatus={onThumbnailLoadStatus}
              scrollElement={selectionScrollElement}
              t={t}
            />
          ) : (
            <VirtualizedPhotoGrid
              focusedPhotoId={focusedPhotoId}
              onFocusPhoto={setFocusedPhotoId}
              onOpenReview={onOpenReview}
              onThumbnailLoadStatus={onThumbnailLoadStatus}
              photos={flatPhotos}
              scrollElement={selectionScrollElement}
              t={t}
            />
          )}
        </div>
      </section>

      <InspectorPanel
        onOpenReview={onOpenReview}
        onSetDecision={onSetDecision}
        photo={focusedPhoto}
        setFocusedPhotoId={setFocusedPhotoId}
        sourceMissing={activeFolder.status === 'path_missing'}
        t={t}
      />

      <BackgroundTaskBar activeFolder={activeFolder} t={t} />
    </main>
  )
}

function FolderRail({
  activeFolderId,
  folders,
  onOpenFolderContextMenu,
  onSelectFolder,
  t,
  workspace,
}: {
  activeFolderId: string | null
  folders: FolderRecord[]
  onOpenFolderContextMenu: (folder: FolderRecord, event: ReactMouseEvent<HTMLElement>) => void
  onSelectFolder: (folderId: string) => void
  t: ReturnType<typeof useTranslation>['t']
  workspace: WorkspaceSnapshot
}) {
  const sections: Array<{ key: string; titleKey: string; statuses: FolderStatus[] }> = [
    {
      key: 'in_progress',
      titleKey: 'selection.sidebar.inProgress',
      statuses: ['scanning', 'hashing', 'analyzing_partial', 'updating', 'exporting'],
    },
    { key: 'recent', titleKey: 'selection.sidebar.recent', statuses: ['ready'] },
    {
      key: 'missing',
      titleKey: 'selection.sidebar.pathMissing',
      statuses: ['path_missing', 'error'],
    },
  ]
  const selectCountByFolderId = useMemo(() => {
    const counts = new Map<string, number>()
    for (const photo of workspace.photos) {
      if (photoCategory(photo) !== 'select') continue
      counts.set(photo.folderId, (counts.get(photo.folderId) ?? 0) + 1)
    }
    return counts
  }, [workspace.photos])

  return (
    <aside className="folder-rail selection-scroll">
      <div className="rail-title">
        <SectionLabel label={t('selection.sidebar.label')} />
        <h2>{t('selection.sidebar.title')}</h2>
      </div>
      {sections.map((section) => {
        const sectionFolders = folders.filter((folder) => section.statuses.includes(folder.status))
        if (sectionFolders.length === 0) return null
        return (
          <section className="rail-section" key={section.key}>
            <SectionLabel label={t(section.titleKey)} />
            {sectionFolders.map((folder) => {
              return (
                <button
                  className={cn(
                    'folder-rail-item',
                    folder.id === activeFolderId && 'folder-rail-item--active',
                  )}
                  key={folder.id}
                  onContextMenu={(event) => onOpenFolderContextMenu(folder, event)}
                  onClick={() => onSelectFolder(folder.id)}
                  type="button"
                >
                  <span className="folder-rail-item__main">
                    <strong>{folder.displayName}</strong>
                    <small>{folder.parentPath}</small>
                  </span>
                  <span className="folder-rail-item__meta">
                    <StatusDot tone={statusTone(folder.status)} />
                    <span>{formatRatio(folder.analyzedCount, folder.totalCount)}</span>
                    {folder.status === 'path_missing' ? (
                      <span>{t('selection.sourceMissing.short')}</span>
                    ) : null}
                    <span>{selectCountByFolderId.get(folder.id) ?? 0}</span>
                  </span>
                </button>
              )
            })}
          </section>
        )
      })}
    </aside>
  )
}

function FolderTopline({
  activeFolder,
  analysisStarting,
  onOpenExport,
  onRelinkFolder,
  onRenameFolder,
  onStartAnalysis,
  progressEvent,
  relinking,
  t,
}: {
  activeFolder: FolderRecord
  analysisStarting: boolean
  onOpenExport: () => void
  onRelinkFolder: (folderId: string) => Promise<void>
  onRenameFolder: (folderId: string, displayName: string) => Promise<void>
  onStartAnalysis: () => void
  progressEvent: AnalysisProgressEventLite | null
  relinking: boolean
  t: ReturnType<typeof useTranslation>['t']
}) {
  const [aliasDraft, setAliasDraft] = useState(activeFolder.displayName)
  const [aliasEditing, setAliasEditing] = useState(false)
  const [aliasSaving, setAliasSaving] = useState(false)
  const [aliasError, setAliasError] = useState<string | null>(null)
  // 是否正在跑：pending/processing 还有任务
  const running = progressEvent ? progressEvent.pending + progressEvent.processing > 0 : false
  const hasProgress = progressEvent !== null && progressEvent.total > 0
  const ratio = hasProgress
    ? Math.min(1, progressEvent.completed / Math.max(progressEvent.total, 1))
    : 0
  const progressLabel = hasProgress ? `${progressEvent.completed} / ${progressEvent.total}` : null
  const sourceMissing = activeFolder.status === 'path_missing'
  const sourceDisabledTitle = sourceMissing
    ? t('selection.sourceMissing.disabledTooltip')
    : undefined
  const [relinkError, setRelinkError] = useState<string | null>(null)
  useEffect(() => {
    if (!aliasEditing) {
      setAliasDraft(activeFolder.displayName)
      setAliasError(null)
    }
  }, [activeFolder.displayName, activeFolder.id, aliasEditing])

  useEffect(() => {
    setRelinkError(null)
  }, [activeFolder.id, activeFolder.status])

  const startAliasEditing = () => {
    setAliasDraft(activeFolder.displayName)
    setAliasError(null)
    setAliasEditing(true)
  }

  const cancelAliasEditing = () => {
    setAliasDraft(activeFolder.displayName)
    setAliasError(null)
    setAliasEditing(false)
  }

  const submitAlias = async () => {
    const trimmed = aliasDraft.trim()
    if (!trimmed) {
      setAliasError(t('selection.folderHeader.aliasEmpty'))
      return
    }
    if (trimmed === activeFolder.displayName) {
      setAliasEditing(false)
      return
    }
    setAliasSaving(true)
    setAliasError(null)
    try {
      await onRenameFolder(activeFolder.id, trimmed)
      setAliasEditing(false)
    } catch (err) {
      console.warn('Failed to update library display name:', err)
      setAliasError(t('selection.folderHeader.aliasFailed'))
    } finally {
      setAliasSaving(false)
    }
  }

  const submitRelink = async () => {
    setRelinkError(null)
    try {
      await onRelinkFolder(activeFolder.id)
    } catch {
      setRelinkError(t('selection.sourceMissing.relinkFailed'))
    }
  }

  return (
    <header className="folder-topline">
      <div className="folder-heading-main">
        <SectionLabel label={t('selection.currentFolder')} />
        {aliasEditing ? (
          <form
            className="folder-alias-form"
            onSubmit={(event) => {
              event.preventDefault()
              void submitAlias()
            }}
          >
            <input
              aria-invalid={Boolean(aliasError)}
              aria-label={t('selection.folderHeader.alias')}
              autoFocus
              className="folder-alias-input"
              disabled={aliasSaving}
              maxLength={120}
              onChange={(event) => setAliasDraft(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Escape') {
                  event.preventDefault()
                  cancelAliasEditing()
                }
              }}
              placeholder={t('selection.folderHeader.aliasPlaceholder')}
              value={aliasDraft}
            />
            <button
              aria-label={t('selection.folderHeader.saveAlias')}
              className="icon-button folder-alias-button"
              disabled={aliasSaving}
              type="submit"
            >
              {aliasSaving ? (
                <RefreshCw className="h-4 w-4 animate-spin" />
              ) : (
                <Check className="h-4 w-4" />
              )}
            </button>
            <button
              aria-label={t('selection.folderHeader.cancelAlias')}
              className="icon-button folder-alias-button"
              disabled={aliasSaving}
              onClick={cancelAliasEditing}
              type="button"
            >
              <X className="h-4 w-4" />
            </button>
          </form>
        ) : (
          <div className="folder-title-row">
            <h1>{activeFolder.displayName}</h1>
            <button
              aria-label={t('selection.folderHeader.editAlias')}
              className="icon-button folder-alias-button"
              onClick={startAliasEditing}
              title={t('selection.folderHeader.editAlias')}
              type="button"
            >
              <PencilLine className="h-4 w-4" />
            </button>
          </div>
        )}
        {aliasError ? (
          <span className="folder-alias-error" role="alert">
            {aliasError}
          </span>
        ) : null}
        <p>{activeFolder.rootPath}</p>
        {sourceMissing ? (
          <div className="source-link-warning" role="status">
            <span>
              <strong>{t('selection.sourceMissing.title')}</strong>
              <small>{relinkError ?? t('selection.sourceMissing.body')}</small>
            </span>
            <button
              className="button-ghost button-compact"
              disabled={relinking}
              onClick={() => void submitRelink()}
              type="button"
            >
              {relinking ? (
                <RefreshCw className="h-4 w-4 animate-spin" />
              ) : (
                <FolderSearch2 className="h-4 w-4" />
              )}
              {relinking
                ? t('selection.sourceMissing.relinking')
                : t('selection.sourceMissing.relinkAction')}
            </button>
          </div>
        ) : null}
      </div>
      <div className="folder-actions">
        <span className="folder-status">
          <StatusDot tone={statusTone(activeFolder.status)} />
          {t(statusLabelKey(activeFolder.status))}
        </span>
        {hasProgress ? (
          <span
            className="folder-status"
            style={{ minWidth: 120, justifyContent: 'flex-end' }}
            aria-label="analysis-progress"
          >
            <span className="text-[11px] text-white/60">
              {running
                ? t('selection.folderHeader.analyzingProgress', { progress: progressLabel })
                : t('selection.folderHeader.analyzedProgress', { progress: progressLabel })}
            </span>
          </span>
        ) : null}
        <button
          className="button-primary button-compact"
          disabled={analysisStarting || running || sourceMissing}
          onClick={onStartAnalysis}
          title={sourceDisabledTitle}
          type="button"
        >
          <Sparkles className="h-4 w-4" />
          {running
            ? t('selection.folderHeader.analyzingPercent', { percent: Math.round(ratio * 100) })
            : analysisStarting
              ? t('selection.folderHeader.starting')
              : t('selection.folderHeader.startAnalysis')}
        </button>
        <button
          className="button-ghost button-compact"
          disabled={sourceMissing}
          onClick={onOpenExport}
          title={sourceDisabledTitle}
          type="button"
        >
          <Download className="h-4 w-4" />
          {t('common.export')}
        </button>
        <button
          className="button-ghost button-compact"
          disabled={sourceMissing}
          title={sourceDisabledTitle}
          type="button"
        >
          <RefreshCw className="h-4 w-4" />
          {activeFolder.status === 'ready'
            ? t('selection.folderHeader.update')
            : t('selection.folderHeader.resume')}
        </button>
      </div>
    </header>
  )
}

function MetricStrip({
  photos,
  summary,
  t,
}: {
  photos: PhotoRecord[]
  summary: FolderSummary
  t: ReturnType<typeof useTranslation>['t']
}) {
  return (
    <section className="metric-strip">
      <MetricCell label={t('selection.metrics.totalPhotos')} value={photos.length} />
      <MetricCell
        label={t('selection.metrics.birdPhotos')}
        tone="success"
        value={summary.birdPhotoCount}
      />
      <MetricCell
        label={t('selection.metrics.selectPhotos')}
        tone="success"
        value={summary.gradeCounts.select}
      />
      <MetricCell label={t('selection.metrics.usablePhotos')} value={summary.gradeCounts.usable} />
      <MetricCell
        label={t('selection.metrics.recordPhotos')}
        tone="warning"
        value={summary.gradeCounts.record}
      />
      <MetricCell
        label={t('selection.metrics.rejectCount')}
        tone="accent"
        value={summary.gradeCounts.reject}
      />
    </section>
  )
}

function SelectionControls({
  activeQuickFilters,
  activeSort,
  setActiveQuickFilter,
  setActiveSort,
  setViewMode,
  t,
  viewMode,
}: {
  activeQuickFilters: QuickFilter[]
  activeSort: SortMode
  setActiveQuickFilter: (filter: QuickFilter) => void
  setActiveSort: (sort: SortMode) => void
  setViewMode: (mode: ViewMode) => void
  t: ReturnType<typeof useTranslation>['t']
  viewMode: ViewMode
}) {
  return (
    <section className="selection-controls">
      <div className="filter-row">
        {quickFilters.map((filter) => (
          <button
            className={cn('chip', activeQuickFilters.includes(filter) && 'chip--active')}
            key={filter}
            onClick={() => setActiveQuickFilter(filter)}
            type="button"
          >
            {t(quickFilterLabelKey(filter))}
          </button>
        ))}
      </div>
      <div className="control-row">
        <div className="mini-segment">
          {sortModes.map((sort) => (
            <button
              className={cn(activeSort === sort && 'is-active')}
              key={sort}
              onClick={() => setActiveSort(sort)}
              type="button"
            >
              {t(sortLabelKey(sort))}
            </button>
          ))}
        </div>
        <div className="mini-segment">
          {viewModes.map((mode) => (
            <button
              className={cn(viewMode === mode && 'is-active')}
              key={mode}
              onClick={() => setViewMode(mode)}
              type="button"
            >
              {t(viewModeKey(mode))}
            </button>
          ))}
        </div>
      </div>
    </section>
  )
}

function VirtualizedPhotoGroups({
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
  const virtualizer = useVirtualizer({
    count: groups.length,
    getScrollElement: () => scrollElement,
    estimateSize: () => PHOTO_GROUP_ESTIMATED_HEIGHT,
    overscan: 3,
  })

  if (groups.length === 0) return null

  return (
    <div className="photo-flow-virtual" style={{ height: virtualizer.getTotalSize() }}>
      {virtualizer.getVirtualItems().map((virtualRow) => {
        const entry = groups[virtualRow.index]
        if (!entry) return null
        return (
          <div
            className="photo-flow-virtual__item"
            data-index={virtualRow.index}
            key={entry.group.id}
            ref={virtualizer.measureElement}
            style={{ transform: `translateY(${virtualRow.start}px)` }}
          >
            <PhotoGroup
              focusedPhotoId={focusedPhotoId}
              group={entry.group}
              onFocusPhoto={onFocusPhoto}
              onOpenReview={onOpenReview}
              onThumbnailLoadStatus={onThumbnailLoadStatus}
              photos={entry.photos}
              t={t}
            />
          </div>
        )
      })}
    </div>
  )
}

function VirtualizedPhotoGrid({
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
  const gridLayout = useResponsiveGridLayout(
    containerRef,
    PHOTO_GRID_MIN_COLUMN_WIDTH,
    PHOTO_GRID_GAP,
  )
  const columns = gridLayout.columns
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
    return Math.round(tileWidth * 0.75 + 54 + PHOTO_GRID_GAP)
  }, [columns, gridLayout.width])
  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollElement,
    estimateSize: () => estimatedRowHeight,
    overscan: 5,
  })

  if (photos.length === 0) return null

  return (
    <div className="photo-grid-virtual" ref={containerRef}>
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
                transform: `translateY(${virtualRow.start}px)`,
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
  focusedPhotoId,
  group,
  onFocusPhoto,
  onOpenReview,
  onThumbnailLoadStatus,
  photos,
  t,
}: {
  focusedPhotoId: string | null
  group: PhotoGroupRecord
  onFocusPhoto: (photoId: string | null) => void
  onOpenReview: (photoId: string) => void
  onThumbnailLoadStatus: (photoId: string, status: ThumbnailLoadStatus) => void
  photos: PhotoRecord[]
  t: ReturnType<typeof useTranslation>['t']
}) {
  const groupRef = useRef<HTMLElement | null>(null)
  const [expandedSegmentIds, setExpandedSegmentIds] = useState<Set<string>>(() => new Set())
  const segments = useMemo(() => buildPhotoSegments(photos), [photos])
  const segmentSignature = useMemo(
    () => segments.map((segment) => segment.id).join('|'),
    [segments],
  )
  const bestPhoto = useMemo(() => bestPhotoForStack(photos), [photos])
  const bestScore = bestPhoto?.finalScore ?? null
  const title = useMemo(() => visibleGroupTitle(group, photos.length, t), [group, photos.length, t])
  const hasExpandedStacks = segments.some(
    (segment) => segment.photos.length > 1 && expandedSegmentIds.has(segment.id),
  )

  useEffect(() => {
    setExpandedSegmentIds(new Set())
  }, [group.id, segmentSignature])

  const expandStack = useCallback((segment: PhotoSegment, anchor: HTMLElement) => {
    const scroller = anchor.closest('.selection-scroll')
    const anchorTop = anchor.getBoundingClientRect().top
    const coverPhotoId = segment.coverPhoto.id
    const groupNode = groupRef.current

    setExpandedSegmentIds((current) => {
      if (current.has(segment.id)) return current
      const next = new Set(current)
      next.add(segment.id)
      return next
    })

    if (!(scroller instanceof HTMLElement) || !coverPhotoId || !groupNode) return

    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        const coverTile =
          Array.from(groupNode.querySelectorAll<HTMLElement>('[data-photo-id]')).find(
            (node) => node.dataset.photoId === coverPhotoId,
          ) ?? groupNode
        const delta = coverTile.getBoundingClientRect().top - anchorTop
        if (Math.abs(delta) > 0.5) scroller.scrollTop += delta
      })
    })
  }, [])

  return (
    <section className="photo-group" ref={groupRef}>
      <div className="photo-group__header">
        <div>
          <SectionLabel label={t(sceneTagKey(group.sceneTag))} />
          <h2>{title}</h2>
          <p>
            {photos.length} {t('selection.group.photos')}
            {bestScore !== null
              ? ` · ${t('selection.group.bestScore')} ${formatScore(bestScore)}`
              : ''}
          </p>
        </div>
        <div className="photo-group__actions">
          {hasExpandedStacks ? (
            <button
              className="text-button"
              onClick={() => setExpandedSegmentIds(new Set())}
              type="button"
            >
              {t('selection.group.collapseStack')}
            </button>
          ) : null}
          {group.containsNewSpecies ? (
            <span className="chip chip--accent">{t('selection.quickFilters.new_species')}</span>
          ) : null}
        </div>
      </div>
      <PhotoSegmentGrid
        expandedSegmentIds={expandedSegmentIds}
        focusedPhotoId={focusedPhotoId}
        group={group}
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
  onFocusPhoto,
  onOpenReview,
  onThumbnailLoadStatus,
  segments,
  t,
}: {
  expandedSegmentIds: Set<string>
  focusedPhotoId: string | null
  group: PhotoGroupRecord
  onExpandSegment: (segment: PhotoSegment, anchor: HTMLElement) => void
  onFocusPhoto: (photoId: string | null) => void
  onOpenReview: (photoId: string) => void
  onThumbnailLoadStatus: (photoId: string, status: ThumbnailLoadStatus) => void
  segments: PhotoSegment[]
  t: ReturnType<typeof useTranslation>['t']
}) {
  const renderTile = (photo: PhotoRecord) => (
    <PhotoTile
      focused={focusedPhotoId === photo.id}
      key={photo.id}
      onFocusPhoto={onFocusPhoto}
      onOpenReview={onOpenReview}
      onThumbnailLoadStatus={onThumbnailLoadStatus}
      photo={photo}
      t={t}
    />
  )
  const shouldFlatten = segments.length <= 1

  return (
    <div className="photo-grid">
      {segments.map((segment) => {
        if (shouldFlatten) return segment.photos.map(renderTile)

        const isStack = segment.photos.length > 1
        const expanded = expandedSegmentIds.has(segment.id)
        if (isStack && !expanded) {
          return (
            <PhotoStackTile
              focused={segment.photos.some((photo) => photo.id === focusedPhotoId)}
              group={group}
              key={segment.id}
              onExpand={(anchor) => onExpandSegment(segment, anchor)}
              onFocusPhoto={onFocusPhoto}
              onThumbnailLoadStatus={onThumbnailLoadStatus}
              photo={segment.coverPhoto}
              photoCount={segment.photos.length}
              t={t}
            />
          )
        }

        return segment.photos.map(renderTile)
      })}
    </div>
  )
}

function PhotoStackTile({
  focused,
  group,
  onExpand,
  onFocusPhoto,
  onThumbnailLoadStatus,
  photoCount,
  photo,
  t,
}: {
  focused: boolean
  group: PhotoGroupRecord
  onExpand: (anchor: HTMLElement) => void
  onFocusPhoto: (photoId: string | null) => void
  onThumbnailLoadStatus: (photoId: string, status: ThumbnailLoadStatus) => void
  photoCount: number
  photo: PhotoRecord
  t: ReturnType<typeof useTranslation>['t']
}) {
  const category = photoCategory(photo)
  const displaySpecies = group.primarySpecies ?? formatPhotoSpeciesDisplay(photo, t)

  return (
    <article
      className={cn('photo-tile photo-tile--stack', focused && 'photo-tile--focused')}
      data-photo-id={photo.id}
    >
      <button
        aria-expanded="false"
        aria-label={t('selection.group.stackAria', { count: photoCount, file: photo.fileName })}
        className="photo-preview photo-preview--stack"
        data-selection-review-shortcut="true"
        onClick={(event) => {
          onFocusPhoto(photo.id)
          onExpand(event.currentTarget)
        }}
        style={{ backgroundImage: photo.placeholderGradient ?? photo.previewGradient }}
        type="button"
      >
        <span className="photo-stack-pages" aria-hidden="true">
          <span />
          <span />
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
        <span className="photo-stack-badge">
          <Images className="h-3.5 w-3.5" />
          <span>{t('selection.group.stackCount', { count: photoCount })}</span>
        </span>
        <span className="photo-preview__bottom">
          <span>
            <strong className="photo-preview__species">
              <span>{displaySpecies}</span>
            </strong>
            <small>{t('selection.group.stackHint')}</small>
          </span>
          <b>{formatScore(photo.finalScore)}</b>
        </span>
      </button>
    </article>
  )
}

function PhotoTile({
  focused,
  onFocusPhoto,
  onOpenReview,
  onThumbnailLoadStatus,
  photo,
  t,
}: {
  focused: boolean
  onFocusPhoto: (photoId: string | null) => void
  onOpenReview: (photoId: string) => void
  onThumbnailLoadStatus: (photoId: string, status: ThumbnailLoadStatus) => void
  photo: PhotoRecord
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
          {photo.isNewSpecies ? (
            <StatusPill label={t('selection.quickFilters.new_species')} tone="accent" />
          ) : null}
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
}

/** 启动期外部编辑器探测 — IPC 调一次缓存,UI 据此显示/隐藏对应按钮。 */
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

function InspectorPanel({
  onOpenReview,
  onSetDecision,
  photo,
  setFocusedPhotoId,
  sourceMissing,
  t,
}: {
  onOpenReview: (photoId: string) => void
  onSetDecision: (photoId: string, decision: SelectionDecision) => void
  photo: PhotoRecord | null
  setFocusedPhotoId: (photoId: string | null) => void
  sourceMissing: boolean
  t: ReturnType<typeof useTranslation>['t']
}) {
  const tileSourceBadge = photo ? tileSpeciesSourceBadge(photo, t) : null
  return (
    <aside className="inspector selection-scroll">
      <SectionLabel label={t('selection.inspector.label')} />
      {photo ? (
        <div className="inspector__content">
          <div className="inspector-preview" style={{ backgroundImage: photo.previewGradient }} />
          <div className="score-block">
            <span>{t('selection.inspector.score')}</span>
            <strong>{formatScore(photo.finalScore)}</strong>
            <small className="score-block__species">
              <span>{formatPhotoSpeciesDisplay(photo, t)}</span>
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
            </small>
            {speciesSourceDetail(photo, t) ? (
              <em className="score-block__source">{speciesSourceDetail(photo, t)}</em>
            ) : null}
          </div>
          <div className="stat-stack">
            <StatRow
              label={t('selection.metrics.semanticScore')}
              value={formatScore(photo.semanticScore)}
            />
            <StatRow
              label={t('selection.metrics.technicalScore')}
              value={formatScore(photo.technicalScore)}
            />
            <StatRow
              label={t('selection.metrics.poseScore')}
              value={formatScore(photo.poseScore)}
            />
            <StatRow label={t('selection.metrics.birdCount')} value={photo.birdCount} />
          </div>
          <TagCluster photo={photo} t={t} />
          <ExternalEditorActions photo={photo} sourceMissing={sourceMissing} t={t} />
          <div className="inspector-actions">
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
            <button className="text-button" onClick={() => onOpenReview(photo.id)} type="button">
              {t('selection.review.label')}
            </button>
            <button className="text-button" onClick={() => setFocusedPhotoId(null)} type="button">
              {t('selection.inspector.clear')}
            </button>
          </div>
        </div>
      ) : (
        <div className="inspector-empty">
          <h2>{t('selection.inspector.idleTitle')}</h2>
          <p>{t('selection.inspector.idleBody')}</p>
        </div>
      )}
    </aside>
  )
}

function CollectionSpeciesCard({
  active,
  onSelectSpecies,
  species,
  t,
}: {
  active: boolean
  onSelectSpecies: (speciesId: string | null) => void
  species: SpeciesRecord
  t: ReturnType<typeof useTranslation>['t']
}) {
  return (
    <button
      className={cn(
        'collection-card',
        species.collected ? 'collection-card--lit' : 'collection-card--locked',
        !species.imageUrl && 'collection-card--empty-art',
        active && 'collection-card--active',
      )}
      onClick={() => onSelectSpecies(species.id)}
      style={speciesArtworkStyle(species.imageUrl, species.coverGradient)}
      type="button"
    >
      <span className="collection-card__signal">
        {species.collected ? <Trophy className="h-3.5 w-3.5" /> : <span aria-hidden="true" />}
        {species.collected ? t('archive.collection.collected') : t('archive.collection.locked')}
      </span>
      <strong>{species.name}</strong>
      <small>{species.latinName}</small>
      <span className="collection-card__meta">
        <span>{species.familyName ?? t('archive.collection.unknownFamily')}</span>
        <b>
          {species.collected
            ? t('archive.collection.photoCount', { count: species.photoCount })
            : species.catalogSource === 'model_extra'
              ? t('archive.collection.modelExtraBadge')
              : (species.protectLevel ?? species.iucn ?? '--')}
        </b>
      </span>
    </button>
  )
}

function VirtualizedCollectionBoard({
  activeSpeciesId,
  groups,
  onSelectSpecies,
  scrollRef,
  t,
}: {
  activeSpeciesId: string | null
  groups: SpeciesCollectionGroup[]
  onSelectSpecies: (speciesId: string | null) => void
  scrollRef: RefObject<HTMLElement | null>
  t: ReturnType<typeof useTranslation>['t']
}) {
  const containerRef = useRef<HTMLDivElement | null>(null)
  const gridLayout = useResponsiveGridLayout(
    containerRef,
    COLLECTION_GRID_MIN_COLUMN_WIDTH,
    COLLECTION_GRID_GAP,
  )
  const columns = gridLayout.columns
  const rows = useMemo<CollectionVirtualRow[]>(() => {
    const nextRows: CollectionVirtualRow[] = []
    groups.forEach((group, groupIndex) => {
      nextRows.push({
        type: 'heading',
        group,
        litCount: group.litCount,
        firstGroup: groupIndex === 0,
      })
      for (let start = 0; start < group.species.length; start += columns) {
        nextRows.push({
          type: 'cards',
          groupId: group.id,
          species: group.species.slice(start, start + columns),
        })
      }
    })
    return nextRows
  }, [columns, groups])
  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: (index) =>
      rows[index]?.type === 'heading'
        ? COLLECTION_HEADING_ESTIMATED_HEIGHT
        : COLLECTION_CARD_ROW_ESTIMATED_HEIGHT,
    overscan: 7,
  })

  if (groups.length === 0) return null

  return (
    <div className="collection-virtual-board" ref={containerRef}>
      <div
        className="collection-virtual-board__spacer"
        style={{ height: virtualizer.getTotalSize() }}
      >
        {virtualizer.getVirtualItems().map((virtualRow) => {
          const row = rows[virtualRow.index]
          if (!row) return null
          return (
            <div
              className={cn(
                'collection-virtual-row',
                row.type === 'heading' && 'collection-virtual-row--heading',
                row.type === 'heading' && row.firstGroup && 'collection-virtual-row--first',
              )}
              data-index={virtualRow.index}
              key={virtualRow.key}
              ref={virtualizer.measureElement}
              style={{ transform: `translateY(${virtualRow.start}px)` }}
            >
              {row.type === 'heading' ? (
                <div className="collection-section__heading">
                  <span>
                    <Shield className="h-4 w-4" />
                    {t(`archive.collection.groups.${row.group.id}`)}
                  </span>
                  <small>{formatRatio(row.litCount, row.group.species.length)}</small>
                </div>
              ) : (
                <div
                  className="collection-grid collection-grid--virtual-row"
                  style={virtualGridStyle(columns)}
                >
                  {row.species.map((species) => (
                    <CollectionSpeciesCard
                      active={activeSpeciesId === species.id}
                      key={species.id}
                      onSelectSpecies={onSelectSpecies}
                      species={species}
                      t={t}
                    />
                  ))}
                </div>
              )}
            </div>
          )
        })}
      </div>
    </div>
  )
}

function ArchiveScreen({
  activeSpecies,
  archivePhotos,
  archiveSpecies,
  archiveTab,
  onOpenReview,
  onSelectSpecies,
  onSetArchiveTab,
  t,
}: {
  activeSpecies: SpeciesRecord | null
  archivePhotos: PhotoRecord[]
  archiveSpecies: SpeciesRecord[]
  archiveTab: ArchiveTab
  onOpenReview: (photoId: string) => void
  onSelectSpecies: (speciesId: string | null) => void
  onSetArchiveTab: (tab: ArchiveTab) => void
  t: ReturnType<typeof useTranslation>['t']
}) {
  const archiveScrollRef = useRef<HTMLElement | null>(null)
  const [collectionFilter, setCollectionFilter] = useState<SpeciesCollectionFilter>('all')
  const [speciesPhotosOpen, setSpeciesPhotosOpen] = useState(false)
  const activeSpeciesWiki = useMemo(
    () => (activeSpecies ? getSpeciesWiki(activeSpecies.latinName) : null),
    [activeSpecies?.latinName],
  )
  const activeSpeciesImageUrl = activeSpeciesWiki?.image_url ?? null
  const activeSpeciesArtworkAspect = useSpeciesArtworkAspect(activeSpeciesImageUrl)
  const collectedSpeciesCount = archiveSpecies.filter((species) => species.collected).length
  const collectionGroupStats = useMemo(() => {
    return buildSpeciesCollectionGroups(archiveSpecies)
  }, [archiveSpecies])
  const archiveMetricFilters = useMemo(
    () => [
      {
        id: 'collected' as const,
        label: t('archive.summary.collected'),
        signal: t('archive.summarySignals.collected'),
        tone: 'success' as Tone,
        value: collectedSpeciesCount,
      },
      {
        id: 'all' as const,
        label: t('archive.summary.species'),
        signal: t('archive.summarySignals.species'),
        tone: 'neutral' as Tone,
        value: archiveSpecies.length,
      },
      ...collectionGroupStats.map((group) => ({
        id: group.id,
        label: t(`archive.collection.groups.${group.id}`),
        signal: t(`archive.summarySignals.${group.id}`),
        tone: speciesCollectionGroupTone(group.id),
        value: formatRatio(group.litCount, group.species.length),
      })),
    ],
    [archiveSpecies.length, collectedSpeciesCount, collectionGroupStats, t],
  )
  const activeSpeciesPhotos = useMemo(() => {
    if (!activeSpecies) return []
    return archivePhotos.filter((photo) => photoMatchesSpecies(photo, activeSpecies))
  }, [activeSpecies, archivePhotos])
  useEffect(() => {
    setSpeciesPhotosOpen(false)
  }, [activeSpecies?.id])
  const filteredArchiveSpecies = useMemo(() => {
    if (collectionFilter === 'collected') {
      return archiveSpecies.filter((species) => species.collected)
    }
    if (collectionFilter !== 'all') {
      return archiveSpecies.filter(
        (species) => speciesCollectionGroupId(species) === collectionFilter,
      )
    }
    return archiveSpecies
  }, [archiveSpecies, collectionFilter])
  const collectionGroups = useMemo(() => {
    return buildSpeciesCollectionGroups(filteredArchiveSpecies)
  }, [filteredArchiveSpecies])
  useEffect(() => {
    archiveScrollRef.current?.scrollTo({ top: 0 })
  }, [archiveTab, collectionFilter])

  return (
    <main
      className={cn(
        'archive-screen selection-scroll',
        archiveTab === 'map' && 'archive-screen--map',
      )}
      ref={archiveScrollRef}
    >
      <section className={cn('archive-main', archiveTab === 'map' && 'archive-main--map')}>
        <div className="archive-heading">
          <div>
            <SectionLabel label={t('archive.label')} />
            <h1>{t('archive.title')}</h1>
          </div>
          <div className="mini-segment">
            {archiveTabs.map((tab) => (
              <button
                className={cn(archiveTab === tab && 'is-active')}
                key={tab}
                onClick={() => onSetArchiveTab(tab)}
                type="button"
              >
                {t(archiveTabLabelKey(tab))}
              </button>
            ))}
          </div>
        </div>

        {archiveTab === 'species' ? (
          <section className="metric-strip metric-strip--archive">
            {archiveMetricFilters.map((item) => (
              <ArchiveMetricCell
                active={collectionFilter === item.id}
                filterId={item.id}
                key={item.id}
                label={item.label}
                onClick={() => setCollectionFilter(item.id)}
                signal={item.signal}
                t={t}
                tone={item.tone}
                value={item.value}
              />
            ))}
          </section>
        ) : null}

        {archiveTab === 'species' ? (
          <div className="collection-board">
            <VirtualizedCollectionBoard
              activeSpeciesId={activeSpecies?.id ?? null}
              groups={collectionGroups}
              onSelectSpecies={onSelectSpecies}
              scrollRef={archiveScrollRef}
              t={t}
            />
            {collectionGroups.length === 0 ? (
              <p className="collection-empty">{t('archive.collection.empty')}</p>
            ) : null}
          </div>
        ) : (
          <div className="archive-map-layout archive-map-layout--echarts">
            <section className="china-map-card">
              <div className="china-map-card__heading">
                <div>
                  <SectionLabel label={t('archive.map.label')} />
                  <h2>{t('archive.map.title')}</h2>
                </div>
              </div>
              <Suspense
                fallback={
                  <div className="archive-map-empty">{t('archive.geo.loadingProvince')}</div>
                }
              >
                <ArchiveGeoMap onOpenPhoto={onOpenReview} />
              </Suspense>
            </section>
          </div>
        )}
      </section>

      {archiveTab === 'species' ? (
        <aside
          className={cn(
            'archive-detail',
            activeSpecies && 'archive-detail--species',
            activeSpecies && `archive-detail--art-${activeSpeciesArtworkAspect}`,
            activeSpecies && !activeSpeciesImageUrl && 'archive-detail--empty',
          )}
          style={
            activeSpecies
              ? speciesArtworkStyle(activeSpeciesImageUrl, activeSpecies.coverGradient)
              : undefined
          }
        >
          {activeSpecies ? (
            (() => {
              const wiki = activeSpeciesWiki
              const extract = wiki?.zh_extract ?? t('archive.detail.noChineseExtract')
              const sourceUrl = wiki?.zh_url ?? null
              return (
                <div className="archive-detail__content">
                  <div className="archive-detail__heading">
                    <SectionLabel label={t('archive.detail.label')} />
                    <h2>{activeSpecies.name}</h2>
                    <small>{activeSpecies.latinName}</small>
                    <StatusPill
                      label={
                        activeSpecies.collected
                          ? t('archive.collection.collected')
                          : t('archive.collection.locked')
                      }
                      tone={activeSpecies.collected ? 'success' : 'muted'}
                    />
                  </div>
                  <div className="archive-detail__body">
                    <p className="archive-detail__extract">{extract}</p>
                    {sourceUrl ? (
                      <a
                        className="archive-detail__source"
                        href={sourceUrl}
                        target="_blank"
                        rel="noreferrer"
                      >
                        {t('archive.detail.source')}
                      </a>
                    ) : null}
                    <div className="stat-stack">
                      <StatRow
                        label={t('archive.species.photoCount')}
                        onValueClick={
                          activeSpeciesPhotos.length > 0
                            ? () => setSpeciesPhotosOpen(true)
                            : undefined
                        }
                        valueAriaLabel={t('archive.species.openPhotos', {
                          count: activeSpeciesPhotos.length,
                          species: activeSpecies.name,
                        })}
                        value={activeSpecies.photoCount}
                      />
                      <StatRow
                        label={t('archive.species.firstSeen')}
                        value={
                          activeSpecies.firstSeenAt ? activeSpecies.firstSeenAt.slice(0, 10) : '--'
                        }
                      />
                      <StatRow
                        label={t('archive.species.lastSeen')}
                        value={
                          activeSpecies.lastSeenAt ? activeSpecies.lastSeenAt.slice(0, 10) : '--'
                        }
                      />
                      <StatRow
                        label={t('archive.species.bestScore')}
                        value={formatScore(activeSpecies.bestScore)}
                      />
                      <StatRow
                        label={t('archive.species.rarity')}
                        value={activeSpecies.protectLevel ?? activeSpecies.iucn ?? '--'}
                      />
                    </div>
                  </div>
                </div>
              )
            })()
          ) : (
            <div className="archive-detail__empty">
              <SectionLabel label={t('archive.detail.label')} />
              <p>{t('archive.detail.empty')}</p>
            </div>
          )}
        </aside>
      ) : null}
      {speciesPhotosOpen && activeSpecies ? (
        <SpeciesPhotosModal
          onClose={() => setSpeciesPhotosOpen(false)}
          onOpenReview={onOpenReview}
          photos={activeSpeciesPhotos}
          species={activeSpecies}
          t={t}
        />
      ) : null}
    </main>
  )
}

function SpeciesPhotosModal({
  onClose,
  onOpenReview,
  photos,
  species,
  t,
}: {
  onClose: () => void
  onOpenReview: (photoId: string) => void
  photos: PhotoRecord[]
  species: SpeciesRecord
  t: ReturnType<typeof useTranslation>['t']
}) {
  const [selectedPhotoId, setSelectedPhotoId] = useState<string | null>(photos[0]?.id ?? null)

  useEffect(() => {
    setSelectedPhotoId(photos[0]?.id ?? null)
  }, [photos])

  const selectedPhoto = photos.find((photo) => photo.id === selectedPhotoId) ?? photos[0] ?? null

  return (
    <div className="overlay-backdrop">
      <div className="species-photo-panel">
        <div className="modal-heading">
          <div>
            <SectionLabel label={t('archive.photos.label')} />
            <h2>{species.name}</h2>
            <small>
              {species.latinName} · {t('archive.photos.count', { count: photos.length })}
            </small>
          </div>
          <div className="action-row">
            {selectedPhoto ? (
              <button
                className="button-ghost button-compact"
                onClick={() => onOpenReview(selectedPhoto.id)}
                type="button"
              >
                {t('archive.photos.openReview')}
              </button>
            ) : null}
            <IconButton label={t('common.close')} onClick={onClose}>
              <X className="h-4 w-4" />
            </IconButton>
          </div>
        </div>

        {selectedPhoto ? (
          <div className="species-photo-browser">
            <section className="species-photo-browser__preview">
              <div
                className="species-photo-browser__image"
                style={{
                  backgroundImage:
                    selectedPhoto.placeholderGradient ?? selectedPhoto.previewGradient,
                }}
              >
                <ThumbnailImage
                  alt={selectedPhoto.fileName}
                  className="species-photo-browser__preview-img"
                  src={selectedPhoto.thumbPreviewUrl ?? selectedPhoto.thumbGridUrl}
                />
              </div>
              <div className="species-photo-browser__meta">
                <div>
                  <strong>{selectedPhoto.fileName}</strong>
                  <small>{selectedPhoto.shotAt.replace('T', ' ').slice(0, 16)}</small>
                </div>
                <b>{formatScore(selectedPhoto.finalScore)}</b>
              </div>
            </section>
            <section className="species-photo-browser__rail selection-scroll">
              {photos.map((photo) => (
                <button
                  className={cn(
                    'species-photo-thumb',
                    photo.id === selectedPhoto.id && 'species-photo-thumb--active',
                  )}
                  key={photo.id}
                  onClick={() => setSelectedPhotoId(photo.id)}
                  style={{ backgroundImage: photo.placeholderGradient ?? photo.previewGradient }}
                  type="button"
                >
                  <ThumbnailImage
                    alt={photo.fileName}
                    className="species-photo-thumb__image"
                    src={photo.thumbGridUrl}
                  />
                  <span>
                    <strong>{formatScore(photo.finalScore)}</strong>
                    <small>{photo.fileName}</small>
                  </span>
                </button>
              ))}
            </section>
          </div>
        ) : (
          <p className="archive-map-empty">{t('archive.photos.empty')}</p>
        )}
      </div>
    </div>
  )
}

function ExportDrawer({
  onClose,
  source,
  t,
}: {
  onClose: () => void
  source: ExportSourceSnapshot
  t: ReturnType<typeof useTranslation>['t']
}) {
  const [grades, setGrades] = useState<PhotoGrade[]>(['select', 'usable', 'record'])
  const [minScore, setMinScore] = useState('')
  const [maxScore, setMaxScore] = useState('')
  const [layout, setLayout] = useState<ExportLayout>('merged')
  const [contentMode, setContentMode] = useState<ExportContentMode>('files_xmp')
  const [targetDir, setTargetDir] = useState('')
  const [collapsed, setCollapsed] = useState(false)
  const [status, setStatus] = useState<'idle' | 'running' | 'success' | 'error'>('idle')
  const [result, setResult] = useState<ExportLibraryResponse | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [lockedSource, setLockedSource] = useState<ExportSourceSnapshot | null>(null)
  const [lockedOptions, setLockedOptions] = useState<ExportOptionsSnapshot | null>(null)

  const sourceFolder = lockedSource?.folder ?? source.folder
  const sourcePhotos = lockedSource?.photos ?? source.photos
  const sourceSummary = lockedSource?.summary ?? source.summary
  const sourceMissing = sourceFolder?.status === 'path_missing'

  const min = minScore.trim() === '' ? null : Number(minScore)
  const max = maxScore.trim() === '' ? null : Number(maxScore)
  const activeOptions = lockedOptions ?? { grades, min, max, layout, contentMode, targetDir }
  const controlsLocked = lockedOptions !== null
  const exportPhotos = useMemo(() => {
    const activeGrades = new Set(activeOptions.grades)
    return sourcePhotos.filter((photo) => {
      if (!activeGrades.has(effectivePhotoGrade(photo))) return false
      const score = photo.finalScore === null ? null : photo.finalScore * 100
      if (
        score !== null &&
        activeOptions.min !== null &&
        Number.isFinite(activeOptions.min) &&
        score < activeOptions.min
      ) {
        return false
      }
      if (
        score !== null &&
        activeOptions.max !== null &&
        Number.isFinite(activeOptions.max) &&
        score > activeOptions.max
      ) {
        return false
      }
      return true
    })
  }, [activeOptions.grades, activeOptions.max, activeOptions.min, sourcePhotos])

  const toggleGrade = (grade: PhotoGrade) => {
    setGrades((current) =>
      current.includes(grade) ? current.filter((item) => item !== grade) : [...current, grade],
    )
  }

  const chooseTargetDir = async () => {
    if (controlsLocked) return
    const selected = await window.plumelens?.selectExportDirectory?.()
    if (selected) {
      setTargetDir(selected)
      setResult(null)
      setError(null)
      if (status !== 'running') setStatus('idle')
    }
  }

  const startExport = async () => {
    if (!sourceFolder || !targetDir || status === 'running') return
    if (sourceFolder.status === 'path_missing') {
      setError(t('selection.sourceMissing.exportDisabled'))
      setStatus('error')
      return
    }
    const exportOptions = {
      grades: [...grades],
      min: min !== null && Number.isFinite(min) ? min : null,
      max: max !== null && Number.isFinite(max) ? max : null,
      layout,
      contentMode,
      targetDir,
    }
    const exportSource = {
      folder: sourceFolder,
      photos: sourcePhotos,
      summary: sourceSummary,
    }
    setLockedSource(exportSource)
    setLockedOptions(exportOptions)
    setStatus('running')
    setCollapsed(true)
    setResult(null)
    setError(null)
    try {
      const response = await api.exportLibrary(exportSource.folder.id, {
        target_dir: exportOptions.targetDir,
        grades: exportOptions.grades,
        min_score: exportOptions.min,
        max_score: exportOptions.max,
        copy_files: exportOptions.contentMode !== 'xmp_only',
        include_companions: true,
        include_xmp_sidecars: exportOptions.contentMode !== 'files',
        layout: exportOptions.layout,
        preserve_structure: true,
        include_manifest: true,
      })
      setResult(response)
      setStatus('success')
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
      setStatus('error')
    }
  }

  const closePanel = () => {
    if (status !== 'running') onClose()
  }

  const openExportOutput = async () => {
    if (!result?.output_dir) return
    const openResult = await window.plumelens?.openPathInFinder?.(result.output_dir)
    if (openResult && !openResult.ok) {
      setError(t('export.result.openFailed'))
    }
  }

  const resetExport = () => {
    setLockedSource(null)
    setLockedOptions(null)
    setResult(null)
    setError(null)
    setStatus('idle')
    setCollapsed(false)
  }

  const canStart = Boolean(
    sourceFolder &&
    !sourceMissing &&
    targetDir &&
    exportPhotos.length > 0 &&
    status === 'idle' &&
    !controlsLocked,
  )
  const statusText =
    status === 'running'
      ? t('export.status.running')
      : status === 'success'
        ? t('export.status.success')
        : status === 'error'
          ? t('export.status.error')
          : t('export.status.ready')

  if (collapsed) {
    return (
      <aside className="export-sidecar export-sidecar--collapsed" aria-label={t('export.label')}>
        <button
          className="export-sidecar__collapsed-main"
          onClick={() => setCollapsed(false)}
          type="button"
        >
          {status === 'running' ? (
            <RefreshCw className="h-4 w-4 animate-spin" />
          ) : status === 'success' ? (
            <Check className="h-4 w-4" />
          ) : (
            <Download className="h-4 w-4" />
          )}
          <span>
            <strong>{statusText}</strong>
            <small>{t('export.summary.count', { count: exportPhotos.length })}</small>
          </span>
        </button>
        <button
          aria-label={t('common.expand')}
          className="icon-button"
          onClick={() => setCollapsed(false)}
          type="button"
        >
          <ArrowLeft className="h-4 w-4" />
        </button>
        {status !== 'running' ? (
          <button
            aria-label={t('common.close')}
            className="icon-button"
            onClick={onClose}
            type="button"
          >
            <X className="h-4 w-4" />
          </button>
        ) : null}
      </aside>
    )
  }

  return (
    <aside className="export-sidecar" aria-label={t('export.label')}>
      <div className="export-sidecar__head">
        <div>
          <SectionLabel label={t('export.label')} />
          <h2>{t('export.title')}</h2>
          <p>{sourceFolder ? `${sourceFolder.displayName} · ${sourceFolder.rootPath}` : '--'}</p>
        </div>
        <div className="export-sidecar__actions">
          <button
            aria-label={t('common.collapse')}
            className="icon-button"
            onClick={() => setCollapsed(true)}
            type="button"
          >
            <ArrowRight className="h-4 w-4" />
          </button>
          <button
            aria-label={t('common.close')}
            className="icon-button"
            disabled={status === 'running'}
            onClick={closePanel}
            type="button"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
      </div>

      <div className="export-sidecar__body">
        <div className="export-target">
          <SectionLabel label={t('export.target.label')} />
          <button
            className="button-ghost export-target__button"
            disabled={controlsLocked}
            onClick={chooseTargetDir}
            type="button"
          >
            <FolderOpen className="h-4 w-4" />
            {activeOptions.targetDir ? t('export.target.change') : t('export.target.choose')}
          </button>
          <p title={activeOptions.targetDir || undefined}>
            {activeOptions.targetDir || t('export.target.empty')}
          </p>
        </div>

        <div className="export-grid">
          <ExportOption title={t('export.scope.label')} value={t('export.scope.reviewed')} />
          <ExportOption
            title={t('export.content.label')}
            value={t(`export.content.${activeOptions.contentMode}.short`)}
          />
          <ExportOption
            title={t('export.structure.label')}
            value={
              activeOptions.layout === 'merged'
                ? t('export.layout.merged.short')
                : t('export.layout.byGrade.short')
            }
          />
          <ExportOption title={t('export.bundle.label')} value={t('export.bundle.report')} />
        </div>

        <div className="export-control-block">
          <SectionLabel label={t('export.content.label')} />
          <div className="export-layout-grid" role="group" aria-label={t('export.content.label')}>
            {(['files', 'files_xmp', 'xmp_only'] as ExportContentMode[]).map((mode) => (
              <button
                className={cn(
                  'export-layout-button',
                  activeOptions.contentMode === mode && 'is-active',
                )}
                disabled={controlsLocked}
                key={mode}
                onClick={() => setContentMode(mode)}
                type="button"
              >
                {mode === 'xmp_only' ? (
                  <PencilLine className="h-4 w-4" />
                ) : (
                  <Download className="h-4 w-4" />
                )}
                <span>
                  <strong>{t(`export.content.${mode}.label`)}</strong>
                  <small>{t(`export.content.${mode}.hint`)}</small>
                </span>
              </button>
            ))}
          </div>
        </div>

        <div className="export-control-block">
          <SectionLabel label={t('export.layout.label')} />
          <div className="export-layout-grid" role="group" aria-label={t('export.layout.label')}>
            <button
              className={cn(
                'export-layout-button',
                activeOptions.layout === 'merged' && 'is-active',
              )}
              disabled={controlsLocked}
              onClick={() => setLayout('merged')}
              type="button"
            >
              <FolderOpen className="h-4 w-4" />
              <span>
                <strong>{t('export.layout.merged.label')}</strong>
                <small>{t('export.layout.merged.hint')}</small>
              </span>
            </button>
            <button
              className={cn(
                'export-layout-button',
                activeOptions.layout === 'by_grade' && 'is-active',
              )}
              disabled={controlsLocked}
              onClick={() => setLayout('by_grade')}
              type="button"
            >
              <Trophy className="h-4 w-4" />
              <span>
                <strong>{t('export.layout.byGrade.label')}</strong>
                <small>{t('export.layout.byGrade.hint')}</small>
              </span>
            </button>
          </div>
        </div>

        <div className="export-control-block">
          <SectionLabel label={t('export.scope.manual')} />
          <div className="export-grade-grid">
            {(['select', 'usable', 'record', 'reject'] as PhotoGrade[]).map((grade) => (
              <label className="export-check" key={grade}>
                <input
                  checked={activeOptions.grades.includes(grade)}
                  disabled={controlsLocked}
                  onChange={() => toggleGrade(grade)}
                  type="checkbox"
                />
                <span>{t(gradeLabelKey(grade))}</span>
              </label>
            ))}
          </div>
        </div>

        <div className="export-control-block">
          <SectionLabel label={t('export.scoreRange.label')} />
          <div className="export-range">
            <input
              inputMode="decimal"
              disabled={controlsLocked}
              max="100"
              min="0"
              onChange={(event) => setMinScore(event.target.value)}
              placeholder={t('export.scoreRange.min')}
              type="number"
              value={minScore}
            />
            <span>–</span>
            <input
              inputMode="decimal"
              disabled={controlsLocked}
              max="100"
              min="0"
              onChange={(event) => setMaxScore(event.target.value)}
              placeholder={t('export.scoreRange.max')}
              type="number"
              value={maxScore}
            />
          </div>
        </div>

        <div className="metric-strip">
          <MetricCell
            label={t('selection.metrics.selectPhotos')}
            tone="success"
            value={sourceSummary.gradeCounts.select}
          />
          <MetricCell
            label={t('selection.metrics.usablePhotos')}
            value={sourceSummary.gradeCounts.usable}
          />
          <MetricCell
            label={t('selection.metrics.recordPhotos')}
            tone="warning"
            value={sourceSummary.gradeCounts.record}
          />
          <MetricCell
            label={t('selection.metrics.rejectCount')}
            tone="accent"
            value={sourceSummary.gradeCounts.reject}
          />
        </div>

        <div className="export-result-count">
          {t('export.summary.count', { count: exportPhotos.length })}
        </div>

        <div className={cn('export-status', `export-status--${status}`)}>
          {status === 'running' ? <RefreshCw className="h-4 w-4 animate-spin" /> : null}
          {status === 'success' ? <Check className="h-4 w-4" /> : null}
          {status === 'idle' ? <Clock3 className="h-4 w-4" /> : null}
          {status === 'error' ? <X className="h-4 w-4" /> : null}
          <span>{statusText}</span>
        </div>
        {result ? (
          <div className="export-output">
            <small>{t('export.result.output')}</small>
            <p title={result.output_dir}>{result.output_dir}</p>
            <small>
              {t('export.result.stats', {
                companions: result.companion_count,
                exported: result.exported_count,
                failed: result.failed_count,
                xmp: result.xmp_count ?? 0,
              })}
            </small>
          </div>
        ) : null}
        {error ? <p className="export-error">{error}</p> : null}

        {controlsLocked && status !== 'running' ? (
          <div className="export-completion-actions">
            {result ? (
              <button className="button-ghost" onClick={openExportOutput} type="button">
                <FolderOpen className="h-4 w-4" />
                {t('export.result.openFolder')}
              </button>
            ) : null}
            <button className="button-ghost" onClick={resetExport} type="button">
              <RefreshCw className="h-4 w-4" />
              {t('export.result.reset')}
            </button>
          </div>
        ) : null}

        <div className="action-row">
          <button
            className="button-primary"
            disabled={!canStart}
            onClick={startExport}
            type="button"
          >
            {status === 'running' ? (
              <RefreshCw className="h-4 w-4 animate-spin" />
            ) : (
              <Download className="h-4 w-4" />
            )}
            {status === 'running' ? t('export.status.running') : t('export.confirm')}
          </button>
          <button className="button-ghost" onClick={() => setCollapsed(true)} type="button">
            {t('common.collapse')}
          </button>
        </div>
      </div>
    </aside>
  )
}

function BackgroundTaskBar({
  activeFolder,
  t,
}: {
  activeFolder: FolderRecord | null
  t: ReturnType<typeof useTranslation>['t']
}) {
  if (!activeFolder || !folderHasActiveTasks(activeFolder.status)) return null

  return (
    <footer className="background-taskbar">
      <span>{t(statusLabelKey(activeFolder.status))}</span>
      {/* 进度条本身用 success(绿色)而非 statusTone — 状态文案仍由
          statusLabelKey 控制(分析进行中 / 扫描中 / 哈希中),颜色语义在
          glyph-matrix 上单独表达"已经完成的进度",绿色更直观;breathing 动画
          见 app.css `.glyph-matrix .tone-success`,提示仍在运行。 */}
      <GlyphMatrix
        tone="success"
        value={Math.max(
          3,
          Math.round((activeFolder.analyzedCount / Math.max(activeFolder.totalCount, 1)) * 12),
        )}
      />
      <span>{formatRatio(activeFolder.analyzedCount, activeFolder.totalCount)}</span>
    </footer>
  )
}

export function TagCluster({
  photo,
  t,
}: {
  photo: PhotoRecord
  t: ReturnType<typeof useTranslation>['t']
}) {
  return (
    <div className="tag-cluster">
      {photo.problemTags.length === 0 ? (
        <span className="chip chip--success">{t('selection.inspector.cleanFrame')}</span>
      ) : (
        photo.problemTags.map((tag) => (
          <span className="chip chip--warning" key={tag}>
            {t(problemTagKey(tag))}
          </span>
        ))
      )}
      {photo.poseTags.map((tag) => (
        <span className="chip" key={tag}>
          {t(poseTagKey(tag))}
        </span>
      ))}
    </div>
  )
}

function GlyphMatrix({ tone, value }: { tone: Tone; value: number }) {
  return (
    <span className="glyph-matrix" aria-hidden="true">
      {Array.from({ length: 12 }, (_item, index) => (
        <i className={cn(index < value && `tone-${tone}`)} key={`glyph-${index + 1}`} />
      ))}
    </span>
  )
}

export function SectionLabel({ label }: { label: string }) {
  return <div className="section-label">{label}</div>
}

function ArchiveMetricCell({
  active,
  filterId,
  label,
  onClick,
  signal,
  t,
  tone,
  value,
}: {
  active: boolean
  filterId: SpeciesCollectionFilter
  label: string
  onClick: () => void
  signal: string
  t: ReturnType<typeof useTranslation>['t']
  tone: Tone
  value: number | string
}) {
  return (
    <button
      aria-pressed={active}
      className={cn(
        'metric-cell',
        'archive-filter-cell',
        `archive-filter-cell--${filterId}`,
        active && 'archive-filter-cell--active',
      )}
      onClick={onClick}
      title={signal}
      type="button"
    >
      <span>{label}</span>
      <strong>{value}</strong>
      <i
        aria-label={t('archive.summarySignalAria', { label, signal })}
        className={cn('status-dot', 'archive-filter-cell__signal', `status-dot--${tone}`)}
        role="img"
      />
    </button>
  )
}

function MetricCell({
  label,
  tone = 'neutral',
  value,
}: {
  label: string
  tone?: Tone
  value: number | string
}) {
  return (
    <div className="metric-cell">
      <span>{label}</span>
      <strong>{value}</strong>
      <StatusDot tone={tone} />
    </div>
  )
}

function StatRow({
  label,
  onValueClick,
  tone = 'neutral',
  value,
  valueAriaLabel,
}: {
  label: string
  onValueClick?: () => void
  tone?: Tone
  value: number | string
  valueAriaLabel?: string
}) {
  return (
    <div className="stat-row">
      <span>{label}</span>
      {onValueClick ? (
        <button
          aria-label={valueAriaLabel}
          className={cn('stat-row__value-button', `tone-text-${tone}`)}
          onClick={onValueClick}
          type="button"
        >
          {value}
        </button>
      ) : (
        <strong className={`tone-text-${tone}`}>{value}</strong>
      )}
    </div>
  )
}

function StatusPill({
  label,
  tone = 'neutral',
  title,
}: {
  label: string
  tone?: Tone
  title?: string
}) {
  return (
    <span className={cn('status-pill', `status-pill--${tone}`)} title={title}>
      {label}
    </span>
  )
}

function StatusDot({ tone = 'neutral' }: { tone?: Tone }) {
  return <span className={cn('status-dot', `status-dot--${tone}`)} />
}

export function IconButton({
  active,
  ariaKeyShortcuts,
  children,
  className,
  disabled,
  label,
  onClick,
  title,
}: {
  active?: boolean
  ariaKeyShortcuts?: string
  children: ReactNode
  className?: string
  disabled?: boolean
  label: string
  onClick?: () => void
  title?: string
}) {
  return (
    <button
      aria-label={label}
      aria-keyshortcuts={ariaKeyShortcuts}
      className={cn('icon-button', active && 'icon-button--active', className)}
      disabled={disabled}
      onClick={onClick}
      title={title}
      type="button"
    >
      {children}
    </button>
  )
}

function ExportOption({ title, value }: { title: string; value: string }) {
  return (
    <div className="export-option">
      <SectionLabel label={title} />
      <strong>{value}</strong>
    </div>
  )
}

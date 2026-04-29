import {
  Aperture,
  ArrowRight,
  Check,
  ChevronLeft,
  ChevronRight,
  Clock3,
  Download,
  Feather,
  FolderOpen,
  FolderSearch2,
  LibraryBig,
  MapPin,
  RefreshCw,
  Search,
  Settings2,
  Shield,
  Sparkles,
  Trophy,
  Waypoints,
  X,
} from 'lucide-react'
import {
  startTransition,
  useCallback,
  useDeferredValue,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from 'react'
import { useTranslation } from 'react-i18next'

import { ThumbnailImage, type ThumbnailLoadStatus } from '@/components/thumbnail-image'
import { useAnalysisProgress, useStartBatch } from '@/hooks/use-analysis'
import { useBackendHealth } from '@/hooks/use-backend'
import { useBatchSetDecisions, useSetDecision, useSetSpeciesOverride } from '@/hooks/use-decisions'
import {
  useAllLibraryDetails,
  useBuildPhotoThumbnail,
  useImportLibrary,
  useLibraries,
  useLibraryDetail,
  useLibraryEvents,
} from '@/hooks/use-library'
import { buildFragmentFromDetail, computeIqaCropBox } from '@/lib/backend-adapter'
import type {
  AnalysisProgressEvent,
  DecisionValue,
  LibraryDetail,
  SpeciesOverrideValue,
} from '@/lib/api-client'

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

type Tone = 'neutral' | 'warning' | 'accent' | 'success' | 'muted'
type SortMode = 'score' | 'shot_at' | 'name'
type PhotoCategory = PhotoGrade | 'no_bird'

type FolderSummary = {
  newSpeciesCount: number
  birdPhotoCount: number
  noBirdCount: number
  speciesCount: number
  gradeCounts: Record<PhotoGrade, number>
}

type ReviewDetail = {
  photo: PhotoRecord
  group: PhotoGroupRecord | null
}

const routeIcons: Record<AppRoute, typeof Aperture> = {
  start: Aperture,
  selection: Sparkles,
  archive: LibraryBig,
}

const THUMBNAIL_REPAIR_COOLDOWN_MS = 30_000

const quickFilters: QuickFilter[] = ['select', 'usable', 'record', 'reject', 'no_bird']

const archiveTabs: ArchiveTab[] = ['species', 'map']
type SpeciesCollectionFilter = 'all' | 'collected' | 'locked'
const speciesCollectionFilters: SpeciesCollectionFilter[] = ['all', 'collected', 'locked']
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

function formatScore(score: number | null | undefined): string {
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

function effectivePhotoGrade(photo: PhotoRecord): PhotoGrade {
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
  const manualEntries: typeof rawEntries = []

  for (const detection of photo.birdDetections ?? []) {
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
  if (filters.length === 0) return false
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

function speciesSourceTone(photo: PhotoRecord): Tone {
  if (photo.speciesSource === 'group_consensus') return 'success'
  if (photo.speciesConflict || photo.speciesSource === 'conflict') return 'warning'
  if (photo.speciesSource === 'manual' || photo.manualSpecies) return 'accent'
  return 'muted'
}

function speciesSourceKind(photo: PhotoRecord): 'conflict' | 'correction' | 'manual' | null {
  if (photo.speciesSource === 'group_consensus') return 'correction'
  if (photo.speciesConflict || photo.speciesSource === 'conflict') return 'conflict'
  if (photo.speciesSource === 'manual' || photo.manualSpecies) return 'manual'
  return null
}

function speciesSourceBadge(
  photo: PhotoRecord,
  t: ReturnType<typeof useTranslation>['t'],
): string | null {
  if (photo.speciesSource === 'group_consensus') {
    return t('selection.speciesSource.groupConsensus')
  }
  if (photo.speciesConflict || photo.speciesSource === 'conflict') {
    return t('selection.speciesSource.conflict')
  }
  if (photo.speciesSource === 'manual' || photo.manualSpecies) {
    return t('selection.speciesSource.manual')
  }
  return null
}

function effectiveSpeciesName(photo: PhotoRecord): string | null {
  if (photo.manualSpecies || photo.speciesSource === 'manual') return photo.speciesName
  if (photo.speciesSource === 'group_consensus') return photo.groupSpeciesName ?? photo.speciesName
  if (photo.speciesSource === 'model') return photo.modelSpeciesName ?? photo.speciesName
  return photo.speciesName
}

function effectiveSpeciesLatinName(photo: PhotoRecord): string | null {
  if (photo.manualSpecies || photo.speciesSource === 'manual') return photo.speciesLatinName
  if (photo.speciesSource === 'group_consensus') {
    return photo.groupSpeciesLatinName ?? photo.speciesLatinName
  }
  if (photo.speciesSource === 'model') return photo.modelSpeciesLatinName ?? photo.speciesLatinName
  return photo.speciesLatinName
}

function speciesSourceDetail(
  photo: PhotoRecord,
  t: ReturnType<typeof useTranslation>['t'],
): string | null {
  const support =
    photo.groupSpeciesSupport !== null &&
    photo.groupSpeciesSupport !== undefined &&
    photo.groupSpeciesEvidence !== null &&
    photo.groupSpeciesEvidence !== undefined
      ? `${photo.groupSpeciesSupport}/${photo.groupSpeciesEvidence}`
      : '--'
  const raw = photo.modelSpeciesName
  const effective = effectiveSpeciesName(photo)

  if (photo.speciesSource === 'group_consensus') {
    if (raw && raw !== effective) {
      return t('selection.speciesSource.groupConsensusWithRaw', { species: raw, support })
    }
    return t('selection.speciesSource.groupConsensusDetail', { support })
  }
  if (photo.speciesConflict || photo.speciesSource === 'conflict') {
    return t('selection.speciesSource.conflictDetail')
  }
  if (photo.speciesSource === 'manual' || photo.manualSpecies) {
    return t('selection.speciesSource.manualDetail')
  }
  return null
}

function decisionTone(decision: SelectionDecision): Tone {
  if (decision === 'select' || decision === 'usable') return 'success'
  if (decision === 'record') return 'warning'
  if (decision === 'reject') return 'accent'
  return 'muted'
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

function gradeLabelKey(grade: PhotoGrade) {
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

function photoReviewReason(photo: PhotoRecord): string {
  if (photo.decision) return 'selection.reviewReasons.manualOverride'
  if (photo.problemTags.includes('no_bird')) return 'selection.reviewReasons.no_bird'
  if (photo.isNewSpecies) return 'selection.reviewReasons.new_species'
  if (effectivePhotoGrade(photo) === 'select') return 'selection.reviewReasons.top_pick'
  if (photo.problemTags.length > 0) return 'selection.reviewReasons.has_issues'
  return 'selection.reviewReasons.candidate'
}

function legacyAfPointToOverlay(point: { x: number; y: number } | null): AfOverlay | null {
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

const chinaMapRegionById = new Map<
  MapRegionId,
  (typeof chinaMapRegions)[number]
>(chinaMapRegions.map((region) => [region.id, region] as const))

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
  // 起手用空 workspace，避免 useLibraries 还没 fetch 完时闪现 mock 数据。
  // useLibraries effect 拿到真数据后会注入；fetch 失败的 fallback 在 handleChooseFolder 里。
  const [workspace, setWorkspace] = useState<WorkspaceSnapshot>(() => ({
    folders: [],
    groups: [],
    photos: [],
    species: [],
  }))

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
    comparePhotoIds,
    reviewPhotoId,
    compareOpen,
    exportOpen,
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
    setCompareOpen,
    setExportOpen,
    toggleComparePhotoId,
    clearCompare,
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
      comparePhotoIds: state.comparePhotoIds,
      reviewPhotoId: state.reviewPhotoId,
      compareOpen: state.compareOpen,
      exportOpen: state.exportOpen,
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
      setCompareOpen: state.setCompareOpen,
      setExportOpen: state.setExportOpen,
      toggleComparePhotoId: state.toggleComparePhotoId,
      clearCompare: state.clearCompare,
    })),
  )

  const deferredSearch = useDeferredValue(searchQuery)
  const speciesRecords = useMemo(() => deriveSpeciesRecords(workspace), [workspace])

  // TODO: Replace mock workspace mutations with backend API + TanStack Query mutations
  // once scan, decision, compare, and export endpoints are wired.
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
  const activeFolder =
    workspace.folders.find((folder) => folder.id === activeFolderId) ?? visibleFolders[0] ?? null
  const activeFolderPhotos = workspace.photos.filter((photo) => photo.folderId === activeFolder?.id)
  const activeFolderSummary = buildFolderSummary(activeFolderPhotos)
  const filteredSelectionPhotos = sortPhotos(
    activeFolderPhotos.filter(
      (photo) =>
        filterPhotoByQuickFilters(photo, activeQuickFilters) &&
        matchesQuery([photo.fileName, photo.speciesName, photo.caption], deferredSearch),
    ),
    activeSort,
  )

  const folderGroups = workspace.groups
    .filter((group) => group.folderId === activeFolder?.id)
    .map((group) => ({
      group,
      photos: filteredSelectionPhotos.filter((photo) => photo.groupId === group.id),
    }))
    .filter((entry) => entry.photos.length > 0)
    .toSorted((left, right) => {
      // 组间排序与组内排序口径一致：先看"组的最佳档位"（精选 > 可用 > 记录 > 淘汰），
      // 同档位再比"组的最佳分数"。group.photos[0] 因为已经经过 sortPhotos 档位优先排序，
      // 所以就是组内最佳那张。
      const lp = left.photos[0]
      const rp = right.photos[0]
      const lRank = lp ? GRADE_RANK[effectivePhotoGrade(lp)] : -1
      const rRank = rp ? GRADE_RANK[effectivePhotoGrade(rp)] : -1
      if (lRank !== rRank) return rRank - lRank
      return (rp?.finalScore ?? -1) - (lp?.finalScore ?? -1)
    })

  const flatSelectionPhotos =
    viewMode === 'flat' ? filteredSelectionPhotos : folderGroups.flatMap((entry) => entry.photos)

  const focusedPhoto = workspace.photos.find((photo) => photo.id === focusedPhotoId) ?? null
  const reviewPhoto = workspace.photos.find((photo) => photo.id === reviewPhotoId) ?? null
  const reviewGroup = workspace.groups.find((group) => group.id === reviewPhoto?.groupId) ?? null
  const comparePhotos = comparePhotoIds
    .map((id) => workspace.photos.find((photo) => photo.id === id) ?? null)
    .filter((photo): photo is PhotoRecord => photo !== null)
  const activeSpecies =
    speciesRecords.find((species) => species.id === activeSpeciesId) ??
    speciesRecords.find((species) => species.collected) ??
    speciesRecords[0] ??
    null

  useEffect(() => {
    if (speciesRecords.length === 0) {
      if (activeSpeciesId !== null) setActiveSpeciesId(null)
      return
    }
    if (!activeSpeciesId || !speciesRecords.some((species) => species.id === activeSpeciesId)) {
      setActiveSpeciesId(
        speciesRecords.find((species) => species.collected)?.id ?? speciesRecords[0]?.id ?? null,
      )
    }
  }, [activeSpeciesId, setActiveSpeciesId, speciesRecords])

  const archivePhotos = sortPhotos(
    workspace.photos.filter(
      (photo) => isArchiveEligiblePhoto(photo) && matchesQuery(archivePhotoSearchParts(photo), deferredSearch),
    ),
    'score',
  )
  const archiveSpecies = speciesRecords.filter((species) =>
    matchesQuery([species.name, species.latinName, species.summary], deferredSearch),
  )
  const reviewPhotos = useMemo(() => {
    if (!reviewPhoto) return []
    const source = route === 'archive' ? archivePhotos : flatSelectionPhotos
    if (source.some((photo) => photo.id === reviewPhoto.id)) return source
    return [reviewPhoto, ...source.filter((photo) => photo.id !== reviewPhoto.id)]
  }, [archivePhotos, flatSelectionPhotos, reviewPhoto, route])

  const { data: realLibraries } = useLibraries()
  const allLibraryIds = useMemo(() => (realLibraries ?? []).map((l) => l.id), [realLibraries])
  const allDetails = useAllLibraryDetails(allLibraryIds)
  const { data: activeDetail } = useLibraryDetail(activeFolderId)
  useLibraryEvents(activeFolderId, Boolean(activeFolderId))
  const importLibrary = useImportLibrary()
  const startBatch = useStartBatch()
  const { mutate: rebuildPhotoThumbnail } = useBuildPhotoThumbnail(activeFolderId)
  const thumbnailRepairingRef = useRef(new Set<string>())
  const thumbnailLastRepairAtRef = useRef(new Map<string, number>())
  // SSE 重连 key：startBatch 成功后 bump，强制 useAnalysisProgress 重建连接。
  // 应对 SSE idle close（v0.1.0 后端 bug）/ 网络抖动 / 老连接卡住等场景，
  // 确保用户点「开始分析」后立刻能看到 pending 数变化。
  const [sseRestartKey, setSseRestartKey] = useState(0)
  const progressEvent = useAnalysisProgress(activeFolderId, Boolean(activeFolderId), sseRestartKey)
  const setDecisionMutation = useSetDecision(activeFolderId)
  const batchSetDecisionsMutation = useBatchSetDecisions(activeFolderId)
  const setSpeciesOverrideMutation = useSetSpeciesOverride(activeFolderId)

  const handleThumbnailLoadStatus = useCallback(
    (photoId: string, status: ThumbnailLoadStatus) => {
      if (status !== 'error') {
        if (status === 'loaded') thumbnailRepairingRef.current.delete(photoId)
        return
      }
      if (thumbnailRepairingRef.current.has(photoId)) return

      const now = Date.now()
      const lastRepairAt = thumbnailLastRepairAtRef.current.get(photoId) ?? 0
      if (now - lastRepairAt < THUMBNAIL_REPAIR_COOLDOWN_MS) return

      thumbnailRepairingRef.current.add(photoId)
      thumbnailLastRepairAtRef.current.set(photoId, now)
      rebuildPhotoThumbnail(photoId, {
        onSettled: () => {
          thumbnailRepairingRef.current.delete(photoId)
        },
      })
    },
    [rebuildPhotoThumbnail],
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
            `${d.library.id}:${d.library.status}:${d.library.last_scanned_at ?? ''}:${d.library.last_analyzed_at ?? ''}:${d.photos.length}:${d.library.analyzed_count}:${libraryDetailContentHash(d)}`,
        )
        .join('|'),
    [allDetails],
  )
  // 所有 library 的详情就绪后，把真照片注入 workspace（archive 页跨 library 聚合需要）。
  // useAllLibraryDetails 每次 render 返回新数组引用 → 用 allDetailsKey（稳定字符串）作为
  // useEffect 唯一依赖，allDetails 通过闭包读最新值。避免引用变化触发死循环。
  useEffect(() => {
    if (allDetails.length === 0) return
    const fragments = allDetails.map(buildFragmentFromDetail)
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
  }, [allDetailsKey])

  // 单 library detail 就绪（active folder 切换时优先级更高，立即注入）
  useEffect(() => {
    if (!activeDetail) return
    const fragment = buildFragmentFromDetail(activeDetail)
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
  }, [activeDetail])

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

  async function handleStartAnalysis() {
    if (!activeFolderId) return
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
      { photoId, birdIndex, species },
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
    if (route !== 'selection' || reviewPhotoId !== null || compareOpen || exportOpen) return
    if (!focusedPhotoId || !flatSelectionPhotos.some((photo) => photo.id === focusedPhotoId)) return

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || !isPlainSpaceKey(event)) return
      if (shouldIgnoreSelectionReviewShortcutTarget(event.target)) return
      event.preventDefault()
      handleOpenReview(focusedPhotoId)
    }

    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [compareOpen, exportOpen, flatSelectionPhotos, focusedPhotoId, reviewPhotoId, route])

  function handleOpenCompare() {
    if (comparePhotos.length >= 2) {
      startTransition(() => setCompareOpen(true))
    }
  }

  function handleKeepBestOne() {
    const bestPhoto = comparePhotos.toSorted(
      (left, right) => (right.finalScore ?? -1) - (left.finalScore ?? -1),
    )[0]
    if (!bestPhoto) return

    const updates: Array<[string, DecisionValue]> = comparePhotoIds.map((pid) => [
      pid,
      pid === bestPhoto.id ? 'select' : 'reject',
    ])

    // 乐观更新
    startTransition(() => {
      setWorkspace((current) => ({
        ...current,
        photos: current.photos.map((photo) => {
          if (!comparePhotoIds.includes(photo.id)) return photo
          return {
            ...photo,
            decision: photo.id === bestPhoto.id ? 'select' : 'reject',
          }
        }),
      }))
      clearCompare()
    })
    // 批量落库
    batchSetDecisionsMutation.mutate(updates, {
      onError: (err) => {
        console.warn('Failed to persist batch decisions:', err)
      },
    })
  }

  return (
    <AppShell
      onNavigate={handleNavigate}
      onOpenExport={() => setExportOpen(true)}
      onSearchChange={setSearchQuery}
      route={route}
      searchQuery={searchQuery}
      t={t}
    >
      {route === 'selection' ? (
        <SelectionScreen
          activeFolder={activeFolder}
          activeFolderSummary={activeFolderSummary}
          activeQuickFilters={activeQuickFilters}
          activeSort={activeSort}
          analysisStarting={startBatch.isPending}
          compareCount={comparePhotoIds.length}
          compareEnabled={comparePhotos.length >= 2}
          filteredGroups={folderGroups}
          flatPhotos={flatSelectionPhotos}
          focusedPhoto={focusedPhoto}
          focusedPhotoId={focusedPhotoId}
          folderPhotos={activeFolderPhotos}
          folders={visibleFolders}
          onThumbnailLoadStatus={handleThumbnailLoadStatus}
          onOpenCompare={handleOpenCompare}
          onOpenExport={() => setExportOpen(true)}
          onOpenReview={handleOpenReview}
          onSelectFolder={handleSelectFolder}
          onSetDecision={handleSetDecision}
          onStartAnalysis={handleStartAnalysis}
          onToggleCompare={toggleComparePhotoId}
          progressEvent={progressEvent}
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
          onOpenFolder={handleSelectFolder}
          t={t}
        />
      )}

      {reviewPhoto ? (
        <ReviewModal
          detail={{ photo: reviewPhoto, group: reviewGroup }}
          onAddToCompare={toggleComparePhotoId}
          onClose={() => setReviewPhotoId(null)}
          onSelectPhoto={handleOpenReview}
          onSetDecision={handleSetDecision}
          onSetSpeciesOverride={handleSetSpeciesOverride}
          onThumbnailLoadStatus={handleThumbnailLoadStatus}
          photos={reviewPhotos}
          t={t}
        />
      ) : null}

      {compareOpen ? (
        <CompareModal
          onClose={clearCompare}
          onKeepBestOne={handleKeepBestOne}
          onSetDecision={handleSetDecision}
          photos={comparePhotos}
          t={t}
        />
      ) : null}

      {exportOpen ? (
        <ExportDrawer
          activeFolder={activeFolder}
          photos={activeFolderPhotos}
          onClose={() => setExportOpen(false)}
          summary={activeFolderSummary}
          t={t}
        />
      ) : null}
    </AppShell>
  )
}

function AppShell({
  children,
  onNavigate,
  onOpenExport,
  onSearchChange,
  route,
  searchQuery,
  t,
}: {
  children: ReactNode
  onNavigate: (route: AppRoute) => void
  onOpenExport: () => void
  onSearchChange: (value: string) => void
  route: AppRoute
  searchQuery: string
  t: ReturnType<typeof useTranslation>['t']
}) {
  return (
    <div className="app-shell">
      <header className="command-bar">
        <button className="brand-mark" onClick={() => onNavigate('start')} type="button">
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
                key={item}
                onClick={() => onNavigate(item)}
                type="button"
              >
                <Icon className="h-4 w-4" />
                <span>{t(routeLabelKey(item))}</span>
              </button>
            )
          })}
        </nav>

        <div className="command-actions">
          <label className="search-pill">
            <Search className="h-4 w-4" />
            <input
              onChange={(event) => onSearchChange(event.target.value)}
              placeholder={t('nav.search')}
              value={searchQuery}
            />
          </label>
          <IconButton label={t('common.export')} onClick={onOpenExport}>
            <Download className="h-4 w-4" />
          </IconButton>
          <IconButton label={t('common.settings')}>
            <Settings2 className="h-4 w-4" />
          </IconButton>
          {/* 引擎状态在左下角 status bar 已有完整展示，此处不重复 */}
        </div>
      </header>

      <div className="app-body">{children}</div>
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
  onOpenFolder,
  t,
}: {
  backendData: ReturnType<typeof useBackendHealth>['data']
  folders: FolderRecord[]
  isError: boolean
  isReady: boolean
  onChooseFolder: () => void
  onContinueLatest: () => void
  onOpenFolder: (folderId: string) => void
  t: ReturnType<typeof useTranslation>['t']
}) {
  const recentFolders = folders.toSorted((left, right) =>
    right.lastOpenedAt.localeCompare(left.lastOpenedAt),
  )
  const pipelineModels = backendData?.pipeline?.models
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
                  onClick={() => onOpenFolder(folder.id)}
                  type="button"
                >
                  <span>
                    <strong>{folder.displayName}</strong>
                    <small>{folder.parentPath}</small>
                  </span>
                  <StatusDot tone={statusTone(folder.status)} />
                </button>
              ))}
            </div>
          </div>
        </section>
      ) : null}
      <EnginePanel
        detectorReady={Boolean(pipelineModels?.yolo?.loaded)}
        isError={isError}
        isReady={isReady}
        t={t}
      />
    </main>
  )
}

function EnginePanel({
  detectorReady,
  isError,
  isReady,
  t,
}: {
  detectorReady: boolean
  isError: boolean
  isReady: boolean
  t: ReturnType<typeof useTranslation>['t']
}) {
  const statusToneValue: Tone = isReady ? 'success' : isError ? 'accent' : 'warning'
  const pipelineItems = [
    {
      label: t('start.status.engine'),
      tone: statusToneValue,
      value: isReady ? t('start.status.ready') : t('start.status.pending'),
    },
    {
      label: t('start.status.detector'),
      tone: detectorReady ? 'success' : 'warning',
      value: detectorReady ? t('start.status.ready') : t('start.status.pending'),
    },
    {
      label: t('start.status.species'),
      tone: 'success',
      value: t('start.status.ready'),
    },
  ] satisfies Array<{ label: string; tone: Tone; value: string }>

  return (
    <aside className="pipeline-bar">
      <div className="pipeline-bar__summary">
        <StatusDot tone={statusToneValue} />
        <span>{t('start.pipelineState')}</span>
        <strong>
          {isReady ? t('status.connected') : isError ? t('status.error') : t('status.connecting')}
        </strong>
      </div>

      <div className="pipeline-bar__items">
        {pipelineItems.map((item) => (
          <PipelineStatusItem
            key={item.label}
            label={item.label}
            tone={item.tone}
            value={item.value}
          />
        ))}
      </div>

      <div className="pipeline-bar__note">{t('start.localOnly')}</div>
    </aside>
  )
}

function PipelineStatusItem({ label, tone, value }: { label: string; tone: Tone; value: string }) {
  return (
    <div className="pipeline-bar__item">
      <small>{label}</small>
      <strong>{value}</strong>
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
  compareCount,
  compareEnabled,
  filteredGroups,
  flatPhotos,
  focusedPhoto,
  focusedPhotoId,
  folderPhotos,
  folders,
  onOpenCompare,
  onOpenExport,
  onOpenReview,
  onSelectFolder,
  onSetDecision,
  onStartAnalysis,
  onThumbnailLoadStatus,
  onToggleCompare,
  progressEvent,
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
  compareCount: number
  compareEnabled: boolean
  filteredGroups: Array<{ group: PhotoGroupRecord; photos: PhotoRecord[] }>
  flatPhotos: PhotoRecord[]
  focusedPhoto: PhotoRecord | null
  focusedPhotoId: string | null
  folderPhotos: PhotoRecord[]
  folders: FolderRecord[]
  onOpenCompare: () => void
  onOpenExport: () => void
  onOpenReview: (photoId: string) => void
  onSelectFolder: (folderId: string) => void
  onSetDecision: (photoId: string, decision: SelectionDecision) => void
  onStartAnalysis: () => void
  onThumbnailLoadStatus: (photoId: string, status: ThumbnailLoadStatus) => void
  onToggleCompare: (photoId: string) => void
  progressEvent: AnalysisProgressEventLite | null
  setActiveQuickFilter: (filter: QuickFilter) => void
  setActiveSort: (sort: SortMode) => void
  setFocusedPhotoId: (photoId: string | null) => void
  setRoute: (route: AppRoute) => void
  setViewMode: (mode: ViewMode) => void
  t: ReturnType<typeof useTranslation>['t']
  viewMode: ViewMode
  workspace: WorkspaceSnapshot
}) {
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
        onSelectFolder={onSelectFolder}
        t={t}
        workspace={workspace}
      />

      <section className="selection-main selection-scroll">
        <FolderTopline
          activeFolder={activeFolder}
          analysisStarting={analysisStarting}
          onOpenExport={onOpenExport}
          onStartAnalysis={onStartAnalysis}
          progressEvent={progressEvent}
          t={t}
        />
        <MetricStrip photos={folderPhotos} summary={activeFolderSummary} t={t} />
        <SelectionControls
          activeQuickFilters={activeQuickFilters}
          activeSort={activeSort}
          compareCount={compareCount}
          compareEnabled={compareEnabled}
          onOpenCompare={onOpenCompare}
          setActiveQuickFilter={setActiveQuickFilter}
          setActiveSort={setActiveSort}
          setViewMode={setViewMode}
          t={t}
          viewMode={viewMode}
        />

        <div className="photo-flow">
          {viewMode === 'grouped' ? (
            filteredGroups.map(({ group, photos }) => (
              <PhotoGroup
                focusedPhotoId={focusedPhotoId}
                group={group}
                key={group.id}
                onFocusPhoto={setFocusedPhotoId}
                onOpenReview={onOpenReview}
                onThumbnailLoadStatus={onThumbnailLoadStatus}
                photos={photos}
                t={t}
              />
            ))
          ) : (
            <PhotoGrid
              focusedPhotoId={focusedPhotoId}
              onFocusPhoto={setFocusedPhotoId}
              onOpenReview={onOpenReview}
              onThumbnailLoadStatus={onThumbnailLoadStatus}
              photos={flatPhotos}
              t={t}
            />
          )}
        </div>
      </section>

      <InspectorPanel
        onOpenReview={onOpenReview}
        onSetDecision={onSetDecision}
        onToggleCompare={onToggleCompare}
        photo={focusedPhoto}
        setFocusedPhotoId={setFocusedPhotoId}
        t={t}
      />

      <BackgroundTaskBar activeFolder={activeFolder} t={t} />
    </main>
  )
}

function FolderRail({
  activeFolderId,
  folders,
  onSelectFolder,
  t,
  workspace,
}: {
  activeFolderId: string | null
  folders: FolderRecord[]
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
              const photos = workspace.photos.filter((photo) => photo.folderId === folder.id)
              const summary = buildFolderSummary(photos)
              return (
                <button
                  className={cn(
                    'folder-rail-item',
                    folder.id === activeFolderId && 'folder-rail-item--active',
                  )}
                  key={folder.id}
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
                    <span>{summary.gradeCounts.select}</span>
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
  onStartAnalysis,
  progressEvent,
  t,
}: {
  activeFolder: FolderRecord
  analysisStarting: boolean
  onOpenExport: () => void
  onStartAnalysis: () => void
  progressEvent: AnalysisProgressEventLite | null
  t: ReturnType<typeof useTranslation>['t']
}) {
  // 是否正在跑：pending/processing 还有任务
  const running = progressEvent ? progressEvent.pending + progressEvent.processing > 0 : false
  const hasProgress = progressEvent !== null && progressEvent.total > 0
  const ratio = hasProgress
    ? Math.min(1, progressEvent.completed / Math.max(progressEvent.total, 1))
    : 0
  const progressLabel = hasProgress ? `${progressEvent.completed} / ${progressEvent.total}` : null

  return (
    <header className="folder-topline">
      <div>
        <SectionLabel label={t('selection.currentFolder')} />
        <h1>{activeFolder.displayName}</h1>
        <p>{activeFolder.rootPath}</p>
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
          disabled={analysisStarting || running}
          onClick={onStartAnalysis}
          type="button"
        >
          <Sparkles className="h-4 w-4" />
          {running
            ? t('selection.folderHeader.analyzingPercent', { percent: Math.round(ratio * 100) })
            : analysisStarting
              ? t('selection.folderHeader.starting')
              : t('selection.folderHeader.startAnalysis')}
        </button>
        <button className="button-ghost button-compact" onClick={onOpenExport} type="button">
          <Download className="h-4 w-4" />
          {t('common.export')}
        </button>
        <button className="button-ghost button-compact" type="button">
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
  compareCount,
  compareEnabled,
  onOpenCompare,
  setActiveQuickFilter,
  setActiveSort,
  setViewMode,
  t,
  viewMode,
}: {
  activeQuickFilters: QuickFilter[]
  activeSort: SortMode
  compareCount: number
  compareEnabled: boolean
  onOpenCompare: () => void
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
        <button
          className="button-ghost button-compact"
          disabled={!compareEnabled}
          onClick={onOpenCompare}
          type="button"
        >
          <Waypoints className="h-4 w-4" />
          {t('selection.compare.action')}
          <span>{compareCount}</span>
        </button>
      </div>
    </section>
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
  const bestScore = photos[0]?.finalScore ?? null

  return (
    <section className="photo-group">
      <div className="photo-group__header">
        <div>
          <SectionLabel label={t(sceneTagKey(group.sceneTag))} />
          <h2>{group.title}</h2>
          <p>
            {photos.length} {t('selection.group.photos')}
            {bestScore !== null
              ? ` · ${t('selection.group.bestScore')} ${formatScore(bestScore)}`
              : ''}
          </p>
        </div>
        {group.containsNewSpecies ? (
          <span className="chip chip--accent">{t('selection.quickFilters.new_species')}</span>
        ) : null}
      </div>
      <PhotoGrid
        focusedPhotoId={focusedPhotoId}
        onFocusPhoto={onFocusPhoto}
        onOpenReview={onOpenReview}
        onThumbnailLoadStatus={onThumbnailLoadStatus}
        photos={photos}
        t={t}
      />
    </section>
  )
}

function PhotoGrid({
  focusedPhotoId,
  onFocusPhoto,
  onOpenReview,
  onThumbnailLoadStatus,
  photos,
  t,
}: {
  focusedPhotoId: string | null
  onFocusPhoto: (photoId: string | null) => void
  onOpenReview: (photoId: string) => void
  onThumbnailLoadStatus: (photoId: string, status: ThumbnailLoadStatus) => void
  photos: PhotoRecord[]
  t: ReturnType<typeof useTranslation>['t']
}) {
  return (
    <div className="photo-grid">
      {photos.map((photo) => (
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
  const speciesBadge = speciesSourceBadge(photo, t)
  const speciesKind = speciesSourceKind(photo)
  const displaySpecies =
    effectiveSpeciesName(photo) ??
    (photo.analysisStatus === 'pending'
      ? t('selection.analysisStatus.pending')
      : photo.analysisStatus === 'running'
        ? t('selection.analysisStatus.running')
        : photo.analysisStatus === 'failed'
          ? t('selection.analysisStatus.failed')
          : photo.birdCount === 0
            ? t('selection.photo.noBird')
            : t('selection.photo.unidentified'))
  return (
    <article
      className={cn(
        'photo-tile',
        focused && 'photo-tile--focused',
        (photo.analysisStatus === 'pending' || photo.analysisStatus === 'running') &&
          'photo-tile--analyzing',
      )}
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
          {photo.analysisStatus === 'pending' || photo.analysisStatus === 'running' ? (
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
        </span>
        <span className="photo-preview__bottom">
          <span>
            <strong className="photo-preview__species">
              <span>{displaySpecies}</span>
              {speciesBadge && speciesKind ? (
                <em className={cn('species-source-inline', `species-source-inline--${speciesKind}`)}>
                  {t('selection.speciesSource.inline', { source: speciesBadge })}
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

function InspectorPanel({
  onOpenReview,
  onSetDecision,
  onToggleCompare,
  photo,
  setFocusedPhotoId,
  t,
}: {
  onOpenReview: (photoId: string) => void
  onSetDecision: (photoId: string, decision: SelectionDecision) => void
  onToggleCompare: (photoId: string) => void
  photo: PhotoRecord | null
  setFocusedPhotoId: (photoId: string | null) => void
  t: ReturnType<typeof useTranslation>['t']
}) {
  const speciesBadge = photo ? speciesSourceBadge(photo, t) : null
  const speciesKind = photo ? speciesSourceKind(photo) : null
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
              <span>{effectiveSpeciesName(photo) ?? t('selection.photo.noBird')}</span>
              {speciesBadge && speciesKind ? (
                <em className={cn('species-source-inline', `species-source-inline--${speciesKind}`)}>
                  {t('selection.speciesSource.inline', { source: speciesBadge })}
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
            <button
              className="button-ghost"
              onClick={() => onToggleCompare(photo.id)}
              type="button"
            >
              <Waypoints className="h-4 w-4" />
              {t('selection.actions.compare')}
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
  const [selectedMapPinId, setSelectedMapPinId] = useState<string | null>(null)
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
    if (collectionFilter === 'locked') {
      return archiveSpecies.filter((species) => !species.collected)
    }
    return archiveSpecies
  }, [archiveSpecies, collectionFilter])
  const mapPins = useMemo(
    () => buildArchiveMapPins(archivePhotos, archiveSpecies),
    [archivePhotos, archiveSpecies],
  )
  const unmappedPhotoCount = useMemo(
    () =>
      new Set(
        archivePhotos
          .filter((photo) => {
            const gps = extractPhotoGps(photo.exif)
            return !gps || !gpsToChinaMapPoint(gps.lat, gps.lon)
          })
          .map((photo) => photo.id),
      ).size,
    [archivePhotos],
  )
  const selectedMapPin =
    mapPins.find((pin) => pin.id === selectedMapPinId) ??
    mapPins.find((pin) => pin.speciesId === activeSpecies?.id) ??
    mapPins[0] ??
    null
  const mapSpeciesCount = new Set(mapPins.map((pin) => pin.speciesId)).size
  const collectionGroups = useMemo(() => {
    return buildSpeciesCollectionGroups(filteredArchiveSpecies)
  }, [filteredArchiveSpecies])

  return (
    <main className="archive-screen selection-scroll">
      <section className="archive-main">
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

        <section className="metric-strip metric-strip--archive">
          <MetricCell
            label={t('archive.summary.collected')}
            tone="success"
            value={collectedSpeciesCount}
          />
          <MetricCell label={t('archive.summary.species')} value={archiveSpecies.length} />
          {collectionGroupStats.map((group) => (
            <MetricCell
              key={group.id}
              label={t(`archive.collection.groups.${group.id}`)}
              tone={speciesCollectionGroupTone(group.id)}
              value={formatRatio(group.litCount, group.species.length)}
            />
          ))}
        </section>

        {archiveTab === 'species' ? (
          <div className="collection-board">
            <div className="collection-toolbar">
              <div className="mini-segment mini-segment--compact">
                {speciesCollectionFilters.map((filter) => (
                  <button
                    className={cn(collectionFilter === filter && 'is-active')}
                    key={filter}
                    onClick={() => setCollectionFilter(filter)}
                    type="button"
                  >
                    {t(`archive.collection.filters.${filter}`)}
                  </button>
                ))}
              </div>
            </div>
            {collectionGroups.map((group) => {
              const litCount = group.species.filter((species) => species.collected).length
              return (
                <section className="collection-section" key={group.id}>
                  <div className="collection-section__heading">
                    <span>
                      <Shield className="h-4 w-4" />
                      {t(`archive.collection.groups.${group.id}`)}
                    </span>
                    <small>{formatRatio(litCount, group.species.length)}</small>
                  </div>
                  <div className="collection-grid">
                    {group.species.map((species) => (
                      <button
                        className={cn(
                          'collection-card',
                          species.collected ? 'collection-card--lit' : 'collection-card--locked',
                          !species.imageUrl && 'collection-card--empty-art',
                          activeSpecies?.id === species.id && 'collection-card--active',
                        )}
                        key={species.id}
                        onClick={() => onSelectSpecies(species.id)}
                        style={speciesArtworkStyle(species.imageUrl, species.coverGradient)}
                        type="button"
                      >
                        <span className="collection-card__signal">
                          {species.collected ? (
                            <Trophy className="h-3.5 w-3.5" />
                          ) : (
                            <span aria-hidden="true" />
                          )}
                          {species.collected
                            ? t('archive.collection.collected')
                            : t('archive.collection.locked')}
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
                    ))}
                  </div>
                </section>
              )
            })}
            {collectionGroups.length === 0 ? (
              <p className="collection-empty">{t('archive.collection.empty')}</p>
            ) : null}
          </div>
        ) : (
          <div className="archive-map-layout">
            <section className="china-map-card">
              <div className="china-map-card__heading">
                <div>
                  <SectionLabel label={t('archive.map.label')} />
                  <h2>{t('archive.map.title')}</h2>
                </div>
                <span>{t('archive.map.locatedSpecies', { count: mapSpeciesCount })}</span>
              </div>
              <div className="china-map-canvas" aria-label={t('archive.map.title')}>
                <svg className="china-map-svg" viewBox="0 0 640 460" aria-hidden="true">
                  <path
                    className="china-map-svg__land"
                    d="M95 158 L142 117 L218 102 L270 62 L350 88 L418 70 L520 120 L560 196 L521 258 L544 326 L478 379 L384 364 L320 410 L242 370 L154 388 L104 324 L122 244 Z"
                  />
                  <path
                    className="china-map-svg__inner"
                    d="M164 142 L230 132 L296 96 M320 116 L354 352 M214 186 L512 206 M170 276 L486 306 M274 244 L194 360 M410 120 L472 342"
                  />
                </svg>
                {chinaMapRegions.map((region) => (
                  <span
                    className="map-region-label"
                    key={region.id}
                    style={{ left: `${region.x}%`, top: `${region.y}%` }}
                  >
                    {t(region.labelKey)}
                  </span>
                ))}
                {mapPins.map((pin) => (
                  <button
                    className={cn(
                      'map-pin',
                      selectedMapPin?.id === pin.id && 'map-pin--active',
                    )}
                    key={pin.id}
                    onClick={() => {
                      setSelectedMapPinId(pin.id)
                      onSelectSpecies(pin.speciesId)
                    }}
                    style={{ left: `${pin.x}%`, top: `${pin.y}%` }}
                    type="button"
                  >
                    <MapPin className="h-4 w-4" />
                    <span>{pin.photos.length}</span>
                  </button>
                ))}
              </div>
              <p className="archive-map-note">
                {unmappedPhotoCount > 0
                  ? t('archive.map.unlocated', { count: unmappedPhotoCount })
                  : t('archive.map.allLocated')}
              </p>
            </section>

            <aside className="map-photo-panel">
              <SectionLabel label={t('archive.map.detailLabel')} />
              {selectedMapPin ? (
                <>
                  <div className="map-photo-panel__heading">
                    <strong>{selectedMapPin.speciesName}</strong>
                    <small>
                      {t(selectedMapPin.regionLabelKey)} · {selectedMapPin.latinName}
                    </small>
                  </div>
                  <div className="map-photo-list selection-scroll">
                    {selectedMapPin.photos.map((photo) => (
                      <button
                        className="map-photo-card"
                        key={photo.id}
                        onClick={() => onOpenReview(photo.id)}
                        style={{
                          backgroundImage: photo.placeholderGradient ?? photo.previewGradient,
                        }}
                        type="button"
                      >
                        <ThumbnailImage
                          alt={photo.fileName}
                          className="map-photo-card__image"
                          src={photo.thumbGridUrl}
                        />
                        <span>
                          <strong>{photo.fileName}</strong>
                          <small>{formatScore(photo.finalScore)}</small>
                        </span>
                      </button>
                    ))}
                  </div>
                </>
              ) : (
                <p className="archive-map-empty">{t('archive.map.empty')}</p>
              )}
            </aside>
          </div>
        )}
      </section>

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

function ReviewModal({
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

  const bbox = photo.bestBbox ?? null
  const pose = photo.bestPose ?? null
  // AF 覆盖层：Canon 官方语义中，单点 / 扩展 / Zone / Whole area 的呈现不同。
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
          <ScoreHeader photo={photo} t={t} />

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

          <SpeciesOverrideEditor onSetSpeciesOverride={onSetSpeciesOverride} photo={photo} t={t} />

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
  onSetSpeciesOverride,
  photo,
  t,
}: {
  onSetSpeciesOverride: (
    photoId: string,
    birdIndex: number,
    species: SpeciesOverrideValue | null,
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
  const [activeIndex, setActiveIndex] = useState(0)
  const [query, setQuery] = useState('')
  const allSpecies = useMemo(() => listAllSpecies(), [])

  useEffect(() => {
    setActiveIndex(birds[0]?.index ?? 0)
    setQuery('')
  }, [photo.id])

  useEffect(() => {
    setActiveIndex((current) =>
      birds.some((bird) => bird.index === current) ? current : (birds[0]?.index ?? 0),
    )
  }, [birds])

  const activeBird = birds.find((bird) => bird.index === activeIndex) ?? birds[0] ?? null
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
              onClick={() => setActiveIndex(bird.index)}
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
                onSetSpeciesOverride(photo.id, activeBird.index, {
                  canonical_sci: option.canonical_sci,
                  canonical_zh: option.canonical_zh,
                  canonical_en: option.canonical_en,
                })
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
        onClick={() => onSetSpeciesOverride(photo.id, activeBird.index, null)}
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

/** 顶部：大字号分数 + 分级胶囊 + 物种名（颜色按 grade 区分） */
function ScoreHeader({
  photo,
  t,
}: {
  photo: PhotoRecord
  t: ReturnType<typeof useTranslation>['t']
}) {
  const grade = effectivePhotoGrade(photo)
  const score = photo.finalScore
  const sourceDetail = speciesSourceDetail(photo, t)
  const sourceBadge = speciesSourceBadge(photo, t)
  const sourceKind = speciesSourceKind(photo)
  const speciesName = effectiveSpeciesName(photo) ?? t('selection.photo.unidentified')
  const speciesLatinName = effectiveSpeciesLatinName(photo)
  return (
    <div className={cn('score-header', `score-header--${grade}`)}>
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
        <div className={cn('score-header__source', `score-header__source--${speciesSourceTone(photo)}`)}>
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

function CompareModal({
  onClose,
  onKeepBestOne,
  onSetDecision,
  photos,
  t,
}: {
  onClose: () => void
  onKeepBestOne: () => void
  onSetDecision: (photoId: string, decision: SelectionDecision) => void
  photos: PhotoRecord[]
  t: ReturnType<typeof useTranslation>['t']
}) {
  return (
    <div className="overlay-backdrop">
      <div className="compare-panel">
        <div className="modal-heading">
          <div>
            <SectionLabel label={t('selection.compare.label')} />
            <h2>{t('selection.compare.title')}</h2>
          </div>
          <div className="action-row">
            <button className="button-primary button-compact" onClick={onKeepBestOne} type="button">
              <Check className="h-4 w-4" />
              {t('selection.compare.keepBest')}
            </button>
            <IconButton label={t('common.close')} onClick={onClose}>
              <X className="h-4 w-4" />
            </IconButton>
          </div>
        </div>
        <div className="compare-grid">
          {photos.map((photo) => (
            <article className="compare-card" key={photo.id}>
              <div
                className="archive-card__image"
                style={{ backgroundImage: photo.previewGradient }}
              />
              <div className="compare-card__body">
                <div>
                  <strong>{photo.speciesName ?? t('selection.photo.noBird')}</strong>
                  <small>{photo.fileName}</small>
                </div>
                <b>{formatScore(photo.finalScore)}</b>
                <div className="action-row">
                  <IconButton
                    label={t('selection.actions.select')}
                    onClick={() => onSetDecision(photo.id, 'select')}
                  >
                    <Sparkles className="h-4 w-4" />
                  </IconButton>
                  <IconButton
                    label={t('selection.actions.usable')}
                    onClick={() => onSetDecision(photo.id, 'usable')}
                  >
                    <Check className="h-4 w-4" />
                  </IconButton>
                  <IconButton
                    label={t('selection.actions.record')}
                    onClick={() => onSetDecision(photo.id, 'record')}
                  >
                    <Clock3 className="h-4 w-4" />
                  </IconButton>
                  <IconButton
                    label={t('selection.actions.reject')}
                    onClick={() => onSetDecision(photo.id, 'reject')}
                  >
                    <X className="h-4 w-4" />
                  </IconButton>
                </div>
              </div>
            </article>
          ))}
        </div>
      </div>
    </div>
  )
}

function ExportDrawer({
  activeFolder,
  photos,
  onClose,
  summary,
  t,
}: {
  activeFolder: FolderRecord | null
  photos: PhotoRecord[]
  onClose: () => void
  summary: FolderSummary
  t: ReturnType<typeof useTranslation>['t']
}) {
  const [grades, setGrades] = useState<PhotoGrade[]>(['select', 'usable', 'record'])
  const [minScore, setMinScore] = useState('')
  const [maxScore, setMaxScore] = useState('')

  const min = minScore.trim() === '' ? null : Number(minScore)
  const max = maxScore.trim() === '' ? null : Number(maxScore)
  const exportPhotos = photos.filter((photo) => {
    if (!grades.includes(effectivePhotoGrade(photo))) return false
    const score = photo.finalScore === null ? null : photo.finalScore * 100
    if (score !== null && min !== null && Number.isFinite(min) && score < min) return false
    if (score !== null && max !== null && Number.isFinite(max) && score > max) return false
    return true
  })

  const toggleGrade = (grade: PhotoGrade) => {
    setGrades((current) =>
      current.includes(grade) ? current.filter((item) => item !== grade) : [...current, grade],
    )
  }

  return (
    <div className="overlay-backdrop overlay-backdrop--bottom">
      <div className="export-drawer">
        <div>
          <SectionLabel label={t('export.label')} />
          <h2>{t('export.title')}</h2>
          <p>{activeFolder ? `${activeFolder.displayName} · ${activeFolder.rootPath}` : '--'}</p>
        </div>
        <div className="export-grid">
          <ExportOption title={t('export.scope.label')} value={t('export.scope.reviewed')} />
          <ExportOption title={t('export.structure.label')} value={t('export.structure.keep')} />
          <ExportOption title={t('export.bundle.label')} value={t('export.bundle.report')} />
        </div>
        <div className="export-controls">
          <div className="export-control-block">
            <SectionLabel label={t('export.scope.manual')} />
            <div className="export-grade-grid">
              {(['select', 'usable', 'record', 'reject'] as PhotoGrade[]).map((grade) => (
                <label className="export-check" key={grade}>
                  <input
                    checked={grades.includes(grade)}
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
                max="100"
                min="0"
                onChange={(event) => setMaxScore(event.target.value)}
                placeholder={t('export.scoreRange.max')}
                type="number"
                value={maxScore}
              />
            </div>
          </div>
        </div>
        <div className="metric-strip">
          <MetricCell
            label={t('selection.metrics.selectPhotos')}
            tone="success"
            value={summary.gradeCounts.select}
          />
          <MetricCell
            label={t('selection.metrics.usablePhotos')}
            value={summary.gradeCounts.usable}
          />
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
        </div>
        <div className="export-result-count">
          {t('export.summary.count', { count: exportPhotos.length })}
        </div>
        <div className="action-row">
          <button className="button-primary" type="button">
            <Download className="h-4 w-4" />
            {t('export.confirm')}
          </button>
          <button className="button-ghost" onClick={onClose} type="button">
            {t('common.close')}
          </button>
        </div>
      </div>
    </div>
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
      <GlyphMatrix
        tone={statusTone(activeFolder.status)}
        value={Math.max(
          3,
          Math.round((activeFolder.analyzedCount / Math.max(activeFolder.totalCount, 1)) * 12),
        )}
      />
      <span>{formatRatio(activeFolder.analyzedCount, activeFolder.totalCount)}</span>
    </footer>
  )
}

function TagCluster({
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

function SectionLabel({ label }: { label: string }) {
  return <div className="section-label">{label}</div>
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

function StatusPill({ label, tone = 'neutral' }: { label: string; tone?: Tone }) {
  return <span className={cn('status-pill', `status-pill--${tone}`)}>{label}</span>
}

function StatusDot({ tone = 'neutral' }: { tone?: Tone }) {
  return <span className={cn('status-dot', `status-dot--${tone}`)} />
}

function IconButton({
  active,
  ariaKeyShortcuts,
  children,
  className,
  disabled,
  label,
  onClick,
}: {
  active?: boolean
  ariaKeyShortcuts?: string
  children: ReactNode
  className?: string
  disabled?: boolean
  label: string
  onClick?: () => void
}) {
  return (
    <button
      aria-label={label}
      aria-keyshortcuts={ariaKeyShortcuts}
      className={cn('icon-button', active && 'icon-button--active', className)}
      disabled={disabled}
      onClick={onClick}
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

import {
  Aperture,
  Download,
  LibraryBig,
  Search,
  Settings2,
  Sparkles,
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
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
} from 'react'
import { useTranslation } from 'react-i18next'

import appIconUrl from '../../build/icon.png?url'
import { EngineStatusBanner } from '@/components/engine-status-banner'
const ReviewModal = lazy(() =>
  import('@/components/review/review-modal').then((m) => ({ default: m.ReviewModal })),
)
// SettingsModal / ExportDrawer / ReviewModal / ArchiveScreen / SelectionScreen
// 全部 lazy — 起始页只下载 StartScreen + AppShell + EngineStatusBanner 子集,
// 主 bundle 从 4.4MB 起步显著缩水(实测见构建 stat)。
const SettingsModal = lazy(() =>
  import('@/components/settings-modal').then((m) => ({ default: m.SettingsModal })),
)
import { type ThumbnailLoadStatus } from '@/components/thumbnail-image'
import { useAnalysisProgress, useStartBatch } from '@/hooks/use-analysis'
import { useBackendHealth } from '@/hooks/use-backend'
import { useSetDecision, useSetSpeciesOverride } from '@/hooks/use-decisions'
import {
  LIBRARIES_KEY,
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
  DecisionValue,
  LibraryDetail,
  SpeciesOverrideBBox,
  SpeciesOverrideValue,
} from '@/lib/api-client'

import { listAllSpecies, normalizeSpeciesAlias } from '@/lib/species-wiki'
import type {
  AppRoute,
  FolderRecord,
  PhotoGroupRecord,
  PhotoRecord,
  SelectionDecision,
  SpeciesRecord,
  WorkspaceSnapshot,
} from '@/lib/mock-workspace'
import { cn } from '@/lib/utils'
import { useShallow, useUIStore, type QuickFilter } from '@/stores/ui-store'
import { subscribeEngineStatus, useEngineStore } from '@/stores/engine-store'
import { ErrorBoundary } from '@/components/common/error-boundary'
import { IconButton } from '@/components/common/icon-button'
import type { ExportSourceSnapshot } from '@/components/export-drawer'
const ExportDrawer = lazy(() =>
  import('@/components/export-drawer').then((m) => ({ default: m.ExportDrawer })),
)
const ArchiveScreen = lazy(() =>
  import('@/components/archive/archive-screen').then((m) => ({ default: m.ArchiveScreen })),
)
const SelectionScreen = lazy(() =>
  import('@/components/selection-chrome/selection-screen').then((m) => ({
    default: m.SelectionScreen,
  })),
)
import {
  FolderContextMenu,
  StartScreen,
  type FolderContextMenuState,
} from '@/components/start/start-screen'
import {
  buildGroupStartMsMap,
  buildReviewPhotoOrderForGroupedEntries,
  buildReviewSegmentPhotosByPhotoId,
  compareGroupStartDesc,
  sortPhotos,
} from '@/lib/photo-grid-helpers'
import {
  speciesCollectionGroupId,
  speciesCollectionGroupRank,
} from '@/lib/archive-collection'
import { routeLabelKey } from '@/lib/i18n-keys'
import {
  getArchiveSpeciesEntries,
  isArchiveEligiblePhoto,
  photoCategory,
} from '@/lib/photo-display'
import {
  effectivePhotoGrade,
  type FolderSummary,
} from '@/lib/photo-helpers'
import { logger } from '@/lib/logger'


type ExportSession = {
  id: string
  folderId: string
  initialSource: ExportSourceSnapshot
}

const FOLDER_CONTEXT_MENU_WIDTH = 188
const FOLDER_CONTEXT_MENU_HEIGHT = 88

const EMPTY_PHOTOS: PhotoRecord[] = []
const EMPTY_SPECIES: SpeciesRecord[] = []
const EMPTY_FOLDER_SUMMARY: FolderSummary = {
  newSpeciesCount: 0,
  birdPhotoCount: 0,
  noBirdCount: 0,
  failedCount: 0,
  speciesCount: 0,
  gradeCounts: { reject: 0, record: 0, usable: 0, select: 0 },
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

const speciesCatalog = listAllSpecies()

type SpeciesCatalogItem = (typeof speciesCatalog)[number]
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


function matchesQuery(parts: Array<string | null | undefined>, query: string): boolean {
  const normalized = query.trim().toLowerCase()
  if (!normalized) return true
  return parts.some((part) => part?.toLowerCase().includes(normalized))
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
  const newSpeciesCount = new Set(
    photos
      .filter((photo) => photo.isNewSpecies)
      .flatMap((photo) => getArchiveSpeciesEntries(photo).map((entry) => entry.key)),
  ).size
  return photos.reduce<FolderSummary>(
    (acc, photo) => {
      // 失败照片单独计数,不进 grade buckets / 有鸟无鸟分类(它们的 birdCount/grade
      // 是无效结果,混入会让"有鸟照片 943"这类统计被无效行污染)。
      if (photo.analysisStatus === 'failed') {
        acc.failedCount += 1
        return acc
      }
      const category = photoCategory(photo)
      if (category !== 'no_bird') acc.gradeCounts[category] += 1
      if (photo.birdCount > 0) acc.birdPhotoCount += 1
      if (photo.birdCount === 0) acc.noBirdCount += 1
      return acc
    },
    {
      newSpeciesCount,
      birdPhotoCount: 0,
      noBirdCount: 0,
      failedCount: 0,
      speciesCount: new Set(
        photos.flatMap((photo) => (photo.speciesName ? [photo.speciesName] : [])),
      ).size,
      gradeCounts: { reject: 0, record: 0, usable: 0, select: 0 },
    },
  )
}

/**
 * 跨 library 标记 isNewSpecies — 按拍摄时间升序,先确定每个物种的首次出现场景,
 * 再把该首次场景里属于这个物种的照片都打 true,同步回写 group.containsNewSpecies。
 *
 * 之前 backend-adapter 把 photo.isNewSpecies / group.containsNewSpecies 写死 false
 * (TODO),导致选片"新增物种"角标永不亮、archive 视图统计永远 0、组卡片"含新种"徽
 * 标常错。新逻辑跑在 workspace 层面(allDetails / activeDetail 两条 useEffect 注入完
 * 毕后),保证跨 library 全局一致 — 用户即便分多个 library 拍同一种鸟,也只在最早遇
 * 到该物种的场景里标"新种"。
 *
 * 物种身份用 getArchiveSpeciesEntries 返回的 entry.key(latin name 优先),与羽迹页
 * 同维度,自动排除 model_unconfirmed / conflict / 无识别等不入档照片。
 */
export function applyNewSpeciesMarkers(
  photos: PhotoRecord[],
  groups: PhotoGroupRecord[],
): { photos: PhotoRecord[]; groups: PhotoGroupRecord[] } {
  if (photos.length === 0) return { photos, groups }
  // 按拍摄时间升序排;ties 用 photo.id 稳定排序避免不同渲染下 first-seen 漂移
  const sorted = [...photos].sort((a, b) => {
    const aTs = Date.parse(a.shotAt)
    const bTs = Date.parse(b.shotAt)
    const aSafe = Number.isFinite(aTs) ? aTs : 0
    const bSafe = Number.isFinite(bTs) ? bTs : 0
    if (aSafe !== bSafe) return aSafe - bSafe
    return a.id.localeCompare(b.id)
  })
  const seenSpecies = new Set<string>()
  const firstEncounterSpeciesKeysByGroupId = new Map<string, Set<string>>()
  for (const photo of sorted) {
    const entries = getArchiveSpeciesEntries(photo)
    if (entries.length === 0) continue
    for (const entry of entries) {
      if (!seenSpecies.has(entry.key)) {
        seenSpecies.add(entry.key)
        const groupKeys = firstEncounterSpeciesKeysByGroupId.get(photo.groupId) ?? new Set<string>()
        groupKeys.add(entry.key)
        firstEncounterSpeciesKeysByGroupId.set(photo.groupId, groupKeys)
      }
    }
  }
  // 仅 mutate 标记需要变化的照片/组,大库下避免全量复制
  const markedPhotos = photos.map((p) => {
    const firstEncounterKeys = firstEncounterSpeciesKeysByGroupId.get(p.groupId)
    const should =
      firstEncounterKeys !== undefined &&
      getArchiveSpeciesEntries(p).some((entry) => firstEncounterKeys.has(entry.key))
    if (p.isNewSpecies === should) return p
    return { ...p, isNewSpecies: should }
  })
  const markedGroups = groups.map((g) => {
    const should = firstEncounterSpeciesKeysByGroupId.has(g.id)
    if (g.containsNewSpecies === should) return g
    return { ...g, containsNewSpecies: should }
  })
  return { photos: markedPhotos, groups: markedGroups }
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
  // 失败照片:仅在显式包含 'failed' filter 时显示。源文件损坏 / 解码错的照片
  // 没有有效分析结果(birdCount=0 / grade 默认),混在场景组里只会让用户困惑("为
  // 什么这张是空的"),默认隐藏,quickFilter 切到"失败"才查看。
  if (photo.analysisStatus === 'failed') return filters.includes('failed')
  // 还在分析中(pending / running): 始终显示,用户能看到分析进度。
  if (photo.analysisStatus !== 'done') return true
  // 空 filter = "未应用任何过滤" = 显示全部(行业惯例 + 用户取消所有 chip 的直觉)。
  // 旧实现 `return false` 让"全清 chip"变成"全部隐藏",对用户语义反转。
  if (filters.length === 0) return true
  return filters.includes(photoCategory(photo))
}

function photoHasFlyingPosture(photo: PhotoRecord): boolean {
  const bestDetectionPose = photo.birdDetections?.find((detection) => detection.isBest)?.pose
  const pose = photo.bestPose ?? bestDetectionPose ?? null
  if (pose?.posture === 'flying') return true
  return photo.poseTags.includes('wings_open')
}

function filterPhotoByFeatureConstraints(photo: PhotoRecord, onlyFlying: boolean): boolean {
  if (!onlyFlying) return true
  return photo.analysisStatus === 'done' && photoHasFlyingPosture(photo)
}

export function photoReviewReason(photo: PhotoRecord): string {
  if (photo.decision) return 'selection.reviewReasons.manualOverride'
  if (photo.problemTags.includes('no_bird')) return 'selection.reviewReasons.no_bird'
  if (photo.isNewSpecies) return 'selection.reviewReasons.new_species'
  if (effectivePhotoGrade(photo) === 'select') return 'selection.reviewReasons.top_pick'
  if (photo.problemTags.length > 0) return 'selection.reviewReasons.has_issues'
  return 'selection.reviewReasons.candidate'
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
    return `${left.name}|${left.latinName}`.localeCompare(
      `${right.name}|${right.latinName}`,
      'zh-Hans-CN',
    )
  })
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
  const [importError, setImportError] = useState<string | null>(null)

  const {
    route,
    archiveTab,
    activeFolderId,
    activeSpeciesId,
    activeQuickFilters,
    onlyFlying,
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
    setOnlyFlying,
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
      onlyFlying: state.onlyFlying,
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
      setOnlyFlying: state.setOnlyFlying,
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
        logger.warn('Failed to open folder in Finder:', result.reason)
      }
    } catch (err) {
      logger.warn('Failed to open folder in Finder:', err)
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
            filterPhotoByFeatureConstraints(photo, onlyFlying) &&
            matchesQuery([photo.fileName, photo.speciesName, photo.caption], deferredSearch),
        ),
        activeSort,
      ),
    [activeFolderPhotos, activeQuickFilters, activeSort, deferredSearch, onlyFlying],
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
      .toSorted((left, right) => compareGroupStartDesc(left, right, groupStartMs))
  }, [activeFolder?.id, filteredSelectionPhotos, groupStartMs, workspace.groups])
  const groupedSelectionPhotos = useMemo(
    () => buildReviewPhotoOrderForGroupedEntries(folderGroups),
    [folderGroups],
  )

  const flatSelectionPhotos = useMemo(
    () => (viewMode === 'flat' ? filteredSelectionPhotos : groupedSelectionPhotos),
    [filteredSelectionPhotos, groupedSelectionPhotos, viewMode],
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

  // 引擎 cold-start 时 useLibraries 等 query 在 ~5s 模型加载窗口内多次失败 → 永远
  // 卡在 error state,recent folders 不显示。engineSseKey 在 engine 每次 'ready'
  // 事件都自增,作触发器把所有可能受冷启影响的 query 强制 invalidate 让 react-query
  // 重 fetch。libraries / decisions / archive / geocoding 都没自带 refetchInterval
  // (SSE 不轮询原则),这里是它们"engine 就绪后回血"的唯一机会。
  // 'library' 也包了一份是为了 useLibraryDetail(activeFolderId 持久化时,选片屏挂载
  // 立即触发 detail fetch 也会冷启失败)。
  useEffect(() => {
    if (engineSseKey === 0) return // initial render,engine 还没发过 'ready' 事件
    queryClient.invalidateQueries({ queryKey: LIBRARIES_KEY })
    queryClient.invalidateQueries({ queryKey: ['library'] })
    queryClient.invalidateQueries({ queryKey: ['decisions'] })
    queryClient.invalidateQueries({ queryKey: ['archive'] })
    queryClient.invalidateQueries({ queryKey: ['geocoding'] })
  }, [engineSseKey, queryClient])
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
    setWorkspace((current) => {
      // 删除某 library 后,首张"新种"照片可能落在被删 library 里 → 剩余照片
      // 中"新种"标记可能漂移(下一张同物种应升格为 first-seen)。重跑 markers 保
      // 持一致。
      const merged = applyNewSpeciesMarkers(
        current.photos.filter((p) => realFolderIds.has(p.folderId)),
        current.groups.filter((g) => realFolderIds.has(g.folderId)),
      )
      return {
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
        photos: merged.photos,
        groups: merged.groups,
        // 物种列表清空 — deriveSpeciesRecords 会从真 photos 聚合
        species: [],
      }
    })
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
    setWorkspace((current) => {
      // applyNewSpeciesMarkers 跨 library 重新标"新种"(photo + group 维度) —
      // 否则 backend-adapter 一律给 false,UI 上"新增物种"角标永远不亮。
      const merged = applyNewSpeciesMarkers(
        [
          ...current.photos.filter((p) => !realFolderIdsInDetails.has(p.folderId)),
          ...fragments.flatMap((f) => f.photos),
        ],
        [
          ...current.groups.filter((g) => !realFolderIdsInDetails.has(g.folderId)),
          ...fragments.flatMap((f) => f.groups),
        ],
      )
      return {
        folders: current.folders.map((f) => {
          const updated = fragments.find((fr) => fr.folder.id === f.id)
          return updated ? updated.folder : f
        }),
        photos: merged.photos,
        groups: merged.groups,
        species: [],
      }
    })
  }, [allDetailsKey, t])

  // 单 library detail 就绪（active folder 切换时优先级更高，立即注入）
  useEffect(() => {
    if (!activeDetail) return
    const fragment = buildFragmentFromDetail(activeDetail, t)
    setWorkspace((current) => {
      // 同上 useEffect:applyNewSpeciesMarkers 跨 library 重算"新种"标记
      const merged = applyNewSpeciesMarkers(
        [...current.photos.filter((p) => p.folderId !== fragment.folder.id), ...fragment.photos],
        [...current.groups.filter((g) => g.folderId !== fragment.folder.id), ...fragment.groups],
      )
      return {
        ...current,
        folders: current.folders.map((f) => (f.id === fragment.folder.id ? fragment.folder : f)),
        photos: merged.photos,
        groups: merged.groups,
      }
    })
  }, [activeDetail, t])

  async function handleChooseFolder() {
    const path = await window.plumelens?.openFolder?.()
    if (!path) return

    setImportError(null)
    // 先切到 selection 路由，给用户即时视觉反馈
    startTransition(() => {
      setRoute('selection')
      setViewMode('grouped')
    })

    // 调用真后端 import；成功后用返回的 library_id 作为 activeFolderId
    // → useLibraryDetail 自动拉详情 → useEffect 把真 photos 注入 workspace
    try {
      const lib = await importLibrary.mutateAsync({ root_path: path })
      setImportError(null)
      setActiveFolderId(lib.id)
    } catch (err) {
      // 后端不可用 / 路径无效 / 库已存在等失败,**绝不**降级到 mock 数据
      // (历史上的 createImportedFolder 会注入"池鹭/翠鸟/崇明东滩"等假种子,
      // 用户当真照片处理 → 快捷键 1234 命中不存在的 photo_id → 错乱)。
      // 切回 start 页,用应用内错误条把 backend 错误透传给用户。
      logger.error('Library import to backend failed:', err)
      const detail = err instanceof Error ? err.message : String(err)
      setImportError(detail)
      startTransition(() => {
        setRoute('start')
      })
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
        logger.warn('Failed to relink library source folder:', err)
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
      logger.error('Failed to start batch analysis:', err)
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
    // 异步落库。失败时 useSetDecision 内部会 invalidate library detail → refetch
    // → 同步 useEffect 把后端真值重新注入 workspace,自动回滚乐观写入。
    setDecisionMutation.mutate(
      { photoId, decision: decision as DecisionValue },
      {
        onError: (err) => {
          logger.warn('Failed to persist decision (will rollback via refetch):', err)
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

    // 失败时 useSetSpeciesOverride 内部 invalidate → refetch → 同步 useEffect
    // 把乐观写入回滚到后端真实状态。
    setSpeciesOverrideMutation.mutate(
      { photoId, birdIndex, species, bbox: bbox ?? null },
      {
        onError: (err) => {
          logger.warn('Failed to persist species override (will rollback via refetch):', err)
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
      <Suspense fallback={null}>
      {route === 'selection' ? (
        <SelectionScreen
          activeFolder={activeFolder}
          activeFolderSummary={activeFolderSummary}
          activeQuickFilters={activeQuickFilters}
          onlyFlying={onlyFlying}
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
          setOnlyFlying={setOnlyFlying}
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
          importError={importError}
          isError={isError}
          isReady={isReady}
          onChooseFolder={handleChooseFolder}
          onContinueLatest={() => handleNavigate('selection')}
          onDismissImportError={() => setImportError(null)}
          onOpenFolderContextMenu={openFolderContextMenu}
          onOpenFolder={handleSelectFolder}
          t={t}
        />
      )}
      </Suspense>

      {reviewPhoto ? (
        <Suspense fallback={null}>
          {/* ReviewModal 自带 backdrop,fallback 用 null 避免双重 overlay */}
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
        </Suspense>
      ) : null}

      {exportSessions.length > 0 ? (
        <Suspense fallback={null}>
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
        </Suspense>
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
          <span className="brand-mark__icon brand-mark__icon--app">
            <img alt="" aria-hidden="true" className="brand-mark__logo" src={appIconUrl} />
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
      <ErrorBoundary t={t}>
        <div className="app-body">{children}</div>
      </ErrorBoundary>
      <Suspense fallback={null}>
        <SettingsModal />
      </Suspense>
    </div>
  )
}



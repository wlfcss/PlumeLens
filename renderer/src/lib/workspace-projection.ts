import type { LibraryDetail } from '@/lib/api-client'
import { speciesCollectionGroupId, speciesCollectionGroupRank } from '@/lib/archive-collection'
import { getArchiveSpeciesEntries, photoCategory } from '@/lib/photo-display'
import { effectivePhotoGrade, type FolderSummary } from '@/lib/photo-helpers'
import { speciesArtworkAssetUrl } from '@/lib/species-artwork'
import { listAllSpecies, normalizeSpeciesAlias } from '@/lib/species-wiki'
import type {
  PhotoGroupRecord,
  PhotoRecord,
  SpeciesRecord,
  WorkspaceSnapshot,
} from '@/lib/workspace-types'

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

export function buildFolderSummary(photos: PhotoRecord[]): FolderSummary {
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
 * 之前 backend-adapter 把 photo.isNewSpecies / group.containsNewSpecies 写死 false,
 * 导致选片"新增物种"角标永不亮、archive 视图统计永远 0、组卡片"含新种"徽
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

export function archivePhotoSearchParts(photo: PhotoRecord): Array<string | null | undefined> {
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

export function libraryDetailContentHash(detail: LibraryDetail): string {
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
      imageUrl: speciesArtworkAssetUrl(item.canonical_sci),
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

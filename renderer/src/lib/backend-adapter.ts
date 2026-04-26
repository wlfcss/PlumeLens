/**
 * 把后端 LibraryDetail（真 API 返回）适配成前端 WorkspaceSnapshot 子集（folders + photos + groups）。
 *
 * 设计原则：
 * - 字段缺失（后端尚未返回的细节）给安全 fallback，UI 不崩
 * - 保持 PhotoRecord 类型契约不变，只是数据来源换成真后端
 * - 物种拉丁名/百科信息靠前端本地 wiki bundle 兜底（speciesWikiData 已打包）
 *
 * 后端 PhotoRow → 前端 PhotoRecord 字段映射详见 buildPhotoRecordFromRow()。
 */
import type { LibraryDetail, LibrarySummary, PhotoRow } from '@/lib/api-client'
import type {
  FolderRecord,
  FolderStatus,
  PhotoGrade,
  PhotoGroupRecord,
  PhotoRecord,
  ProblemTagId,
  SelectionDecision,
} from '@/lib/mock-workspace'
import speciesWikiJson from '@/lib/species-wiki.json'

// 反向索引：中文名 → 拉丁名（首次访问时构建，~1500 条）
type WikiEntry = { zh_title: string | null; en_title: string | null }
let zhToLatinIndex: Map<string, string> | null = null
function getZhToLatinIndex(): Map<string, string> {
  if (zhToLatinIndex) return zhToLatinIndex
  const map = new Map<string, string>()
  const data = speciesWikiJson as Record<string, WikiEntry>
  for (const [latin, entry] of Object.entries(data)) {
    if (entry.zh_title) map.set(entry.zh_title, latin)
  }
  zhToLatinIndex = map
  return map
}

// ---------- Folder ----------

export function buildFolderRecord(summary: LibrarySummary): FolderRecord {
  return {
    id: summary.id,
    displayName: summary.display_name,
    parentPath: summary.parent_path,
    rootPath: summary.root_path,
    status: summary.status as FolderStatus,
    totalCount: summary.total_count,
    analyzedCount: summary.analyzed_count,
    recursive: summary.recursive,
    lastOpenedAt: summary.last_opened_at,
    lastScannedAt: summary.last_scanned_at ?? summary.last_opened_at,
    lastAnalyzedAt: summary.last_analyzed_at,
  }
}

// ---------- Group: 用后端 scene_id（lingjian-v2 算法：AKAZE 特征 + 颜色直方图）----------

interface GroupPlan {
  id: string
  folderId: string
  sceneId: number
  startMs: number
  endMs: number
  photoIds: string[]
  primarySpecies: string | null
  isNewSpecies: boolean
}

/**
 * 按后端写入的 photo.scene_id 聚类。
 *
 * 后端用 lingjian-v2 的算法：相邻 photo 用 AKAZE 特征匹配（≥0.05 相似 → 同场景），
 * 特征不足时回退 HSV 颜色直方图（≥0.82 → 同场景）。详见
 * engine/pipeline/scene_grouping.py。
 *
 * scene_id 为 null 的 photo（场景分组还没跑完）回退到按时间近似分（每张单独一组）。
 * lifespan 启动 + import 完成会自动后台补 scene_id。
 */
function planGroups(libraryId: string, photos: PhotoRow[]): GroupPlan[] {
  const map = new Map<string, GroupPlan>()
  const order: string[] = []

  for (const photo of photos) {
    const ts = Date.parse(photo.shot_at)
    const safeTs = Number.isFinite(ts) ? ts : Date.parse(photo.created_at)
    // 没分到场景的（后台分组未完成）每张单独一组，等下次 detail refetch 就修正
    const sceneKey =
      photo.scene_id !== null && photo.scene_id !== undefined
        ? `${libraryId}-scene-${photo.scene_id}`
        : `${libraryId}-orphan-${photo.id}`

    let plan = map.get(sceneKey)
    if (!plan) {
      plan = {
        id: sceneKey,
        folderId: libraryId,
        sceneId: photo.scene_id ?? -1,
        startMs: safeTs,
        endMs: safeTs,
        photoIds: [],
        primarySpecies: null,
        isNewSpecies: false,
      }
      map.set(sceneKey, plan)
      order.push(sceneKey)
    }
    plan.photoIds.push(photo.id)
    if (safeTs < plan.startMs) plan.startMs = safeTs
    if (safeTs > plan.endMs) plan.endMs = safeTs
  }

  return order.map((k) => map.get(k)!)
}

function summarizeGroupSpecies(
  group: GroupPlan,
  photos: PhotoRecord[],
): { primarySpecies: string | null; isNewSpecies: boolean } {
  const inGroup = photos.filter((p) => group.photoIds.includes(p.id))
  // 物种出现频次
  const counts = new Map<string, { n: number; bestScore: number }>()
  for (const p of inGroup) {
    if (!p.speciesName) continue
    const cur = counts.get(p.speciesName) ?? { n: 0, bestScore: -Infinity }
    cur.n += 1
    cur.bestScore = Math.max(cur.bestScore, p.finalScore ?? 0)
    counts.set(p.speciesName, cur)
  }
  let primary: string | null = null
  let bestN = 0
  let bestScore = -Infinity
  for (const [name, { n, bestScore: bs }] of counts) {
    if (n > bestN || (n === bestN && bs > bestScore)) {
      primary = name
      bestN = n
      bestScore = bs
    }
  }
  const isNew = inGroup.some((p) => p.isNewSpecies)
  return { primarySpecies: primary, isNewSpecies: isNew }
}

/** 格式化组标题：'场景 #N · HH:MM · 12 张'（场景分组完成时）/ '未分组单张' */
function buildGroupTitle(group: GroupPlan): string {
  const start = new Date(group.startMs)
  const hh = String(start.getHours()).padStart(2, '0')
  const mm = String(start.getMinutes()).padStart(2, '0')
  const photoCount = group.photoIds.length
  const spanSec = Math.round((group.endMs - group.startMs) / 1000)

  if (group.sceneId < 0) {
    // scene_id 还没分配（后台未完成）
    return `${hh}:${mm} · 待分组`
  }
  if (photoCount === 1) {
    return `场景 #${group.sceneId + 1} · ${hh}:${mm}`
  }
  if (spanSec < 60) {
    return `场景 #${group.sceneId + 1} · ${hh}:${mm} · ${photoCount} 张`
  }
  const minutes = Math.round(spanSec / 60)
  return `场景 #${group.sceneId + 1} · ${hh}:${mm} · ${photoCount} 张 · ${minutes} 分钟`
}

// ---------- Photo ----------

const VALID_GRADES = new Set<PhotoGrade>(['reject', 'record', 'usable', 'select'])
const VALID_DECISIONS = new Set<SelectionDecision>([
  'unreviewed',
  'selected',
  'maybe',
  'rejected',
])

function safeGrade(value: string | null): PhotoGrade {
  if (value && (VALID_GRADES as Set<string>).has(value)) {
    return value as PhotoGrade
  }
  return 'reject'
}

function safeDecision(value: string): SelectionDecision {
  if ((VALID_DECISIONS as Set<string>).has(value)) {
    return value as SelectionDecision
  }
  return 'unreviewed'
}

function lookupLatinName(speciesName: string | null): string | null {
  if (!speciesName) return null
  return getZhToLatinIndex().get(speciesName) ?? null
}

/**
 * 根据 grade + bird_count + species 推导问题标签。
 * 这是 UI 层启发式，不是后端权威信号；后端补齐后可替换。
 */
function deriveProblemTags(row: PhotoRow): ProblemTagId[] {
  const tags: ProblemTagId[] = []
  if (row.bird_count === 0 || row.bird_count === null) tags.push('no_bird')
  if (row.grade === 'reject') tags.push('subject_small')
  if (row.species === null && (row.bird_count ?? 0) > 0) {
    tags.push('low_species_confidence')
  }
  return tags
}

/**
 * 缩略图 URL：
 * - 后端 photo.thumb_grid 为 "grid/{photo_id}.jpg"（相对路径）
 * - Electron main 注册了 plumelens://thumb/{relPath} 协议，映射到磁盘
 * - 缩略图未生成时返回 null，由调用方 fallback 到渐变
 */
function thumbnailUrl(thumbRel: string | null, level: 'grid' | 'preview'): string | null {
  // 后端目前 grid 和 preview 都按相对路径回传（grid/xxx.jpg 或 preview/xxx.jpg）
  if (!thumbRel) return null
  // 简单 sanitize：只允许 grid/preview 前缀
  if (!thumbRel.startsWith('grid/') && !thumbRel.startsWith('preview/')) return null
  // level 参数预留以便 caller 显式覆盖（preview 视图想强制要 1920px 版本时）
  void level
  return `plumelens://thumb/${thumbRel}`
}

/**
 * 渐变占位（缩略图未生成时）。
 * 用 photo_id 的 hash 决定色相，保证同一张照片每次渲染一致。
 */
function gradientPlaceholder(photoId: string): string {
  let h = 0
  for (let i = 0; i < photoId.length; i++) {
    h = (h * 31 + photoId.charCodeAt(i)) >>> 0
  }
  const hue = h % 360
  return `linear-gradient(135deg, hsl(${hue}, 35%, 28%), hsl(${(hue + 40) % 360}, 30%, 14%))`
}

/**
 * Photo tile 背景：优先真缩略图（CSS background-image url），fallback 到渐变。
 */
function buildPreviewBg(thumbRel: string | null, photoId: string): string {
  const url = thumbnailUrl(thumbRel, 'grid')
  if (url) {
    return `url("${url}"), ${gradientPlaceholder(photoId)}`
  }
  return gradientPlaceholder(photoId)
}

export function buildPhotoRecordFromRow(
  row: PhotoRow,
  folderId: string,
  groupId: string,
  cameraFallback = '未知机身',
  lensFallback = '未知镜头',
): PhotoRecord {
  const grade = safeGrade(row.grade)
  const decision = safeDecision(row.decision)
  const isAnalyzed = row.pipeline_version !== null

  return {
    id: row.id,
    folderId,
    groupId,
    fileName: row.file_name,
    shotAt: row.shot_at,
    camera: cameraFallback,
    lens: lensFallback,
    speciesName: row.species,
    speciesLatinName: lookupLatinName(row.species),
    speciesCandidates: row.species
      ? [{ name: row.species, confidence: row.quality_score ?? 0 }]
      : [],
    isNewSpecies: false, // TODO: 跨 library 比对决定（archive 视图侧统计）
    birdCount: row.bird_count ?? 0,
    grade,
    decision,
    finalScore: row.quality_score,
    semanticScore: row.quality_score, // 后端尚未单独返回 CLIPIQA+ 分量
    technicalScore: row.quality_score, // 后端尚未单独返回 HyperIQA 分量
    poseScore: null,
    analysisStatus: isAnalyzed ? 'done' : 'pending',
    poseTags: [],
    problemTags: deriveProblemTags(row),
    sceneTag: 'record_shot',
    caption: isAnalyzed
      ? `${row.species ?? '未识别物种'} · ${grade} · 分数 ${(row.quality_score ?? 0).toFixed(2)}`
      : '等待分析',
    previewGradient: buildPreviewBg(row.thumb_grid, row.id),
    boxes: bboxToPercentBoxes(row),
    imageWidth: row.width,
    imageHeight: row.height,
    thumbPreviewUrl: thumbnailUrl(row.thumb_preview, 'preview'),
    exif: row.exif,
    bestBbox: row.best_detection?.bbox ?? null,
    bestPose: row.best_detection?.pose ?? null,
  }
}

/** 把 best_detection.bbox（原图坐标）转成相对百分比 bbox（review modal 渲染用）。 */
function bboxToPercentBoxes(
  row: PhotoRow,
): Array<{ x: number; y: number; w: number; h: number }> {
  const bbox = row.best_detection?.bbox
  const W = row.width
  const H = row.height
  if (!bbox || !W || !H || W === 0 || H === 0) return []
  return [
    {
      x: (bbox.x1 / W) * 100,
      y: (bbox.y1 / H) * 100,
      w: ((bbox.x2 - bbox.x1) / W) * 100,
      h: ((bbox.y2 - bbox.y1) / H) * 100,
    },
  ]
}

// ---------- 整合：把单库 detail 转 photos/groups ----------

export interface DetailFragment {
  folder: FolderRecord
  groups: PhotoGroupRecord[]
  photos: PhotoRecord[]
}

export function buildFragmentFromDetail(detail: LibraryDetail): DetailFragment {
  const folder = buildFolderRecord(detail.library)

  // 1. 时间窗口聚类（5min）：连拍/同场景照片自动归入一组
  const plans = planGroups(folder.id, detail.photos)
  // 反查表：photoId → groupId
  const photoToGroup = new Map<string, string>()
  for (const plan of plans) {
    for (const pid of plan.photoIds) photoToGroup.set(pid, plan.id)
  }

  // 2. PhotoRecord：每张照片带正确 groupId
  const photos: PhotoRecord[] = detail.photos.map((row) =>
    buildPhotoRecordFromRow(row, folder.id, photoToGroup.get(row.id) ?? `group-${folder.id}-orphan`),
  )

  // 3. 组内排序：由 SelectionScreen 渲染时按 quality_score 降序（在 App.tsx 已有 sortPhotos）
  // 这里只生成 group 元数据
  const groups: PhotoGroupRecord[] = plans.map((plan) => {
    const { primarySpecies, isNewSpecies } = summarizeGroupSpecies(plan, photos)
    return {
      id: plan.id,
      folderId: folder.id,
      title: buildGroupTitle(plan),
      groupType: plan.photoIds.length >= 3 ? 'burst' : 'time',
      sceneTag: 'record_shot',
      primarySpecies,
      containsNewSpecies: isNewSpecies,
    }
  })

  return { folder, groups, photos }
}

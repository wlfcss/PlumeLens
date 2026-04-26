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

// ---------- Group: 按时间窗口分组（连拍 / 同场景）----------

/**
 * 时间窗口阈值：相邻两张拍摄时间差 ≤ 此值则属于同组。
 * 5 分钟覆盖：高速连拍组、同一只鸟前后短暂多帧、同一场景调整构图重新拍。
 * 大于此值视为新场景/新主体。
 */
const GROUP_TIME_WINDOW_MS = 5 * 60 * 1000

interface GroupPlan {
  id: string
  folderId: string
  startMs: number
  endMs: number
  photoIds: string[]
  primarySpecies: string | null
  isNewSpecies: boolean
}

/**
 * 把 photos 按 shot_at 时间窗口聚类成 groups。
 * - photos 必须按 shot_at 升序传入（后端已 ORDER BY file_mtime ASC）
 * - 相邻 photo 时间差 ≤ GROUP_TIME_WINDOW_MS 则同组，否则开新组
 * - primarySpecies：组内出现次数最多的物种（tie 时取分数最高那张的物种）
 *
 * 后续可演进：用检测框 + 物种相似度判定"场景类似"（当前先靠时间近似）。
 */
function planGroups(libraryId: string, photos: PhotoRow[]): GroupPlan[] {
  const plans: GroupPlan[] = []
  let current: GroupPlan | null = null
  let groupSeq = 0

  for (const photo of photos) {
    const ts = Date.parse(photo.shot_at)
    const safeTs = Number.isFinite(ts) ? ts : Date.parse(photo.created_at)

    if (!current || safeTs - current.endMs > GROUP_TIME_WINDOW_MS) {
      groupSeq++
      current = {
        id: `group-${libraryId}-${groupSeq}`,
        folderId: libraryId,
        startMs: safeTs,
        endMs: safeTs,
        photoIds: [photo.id],
        primarySpecies: null,
        isNewSpecies: false,
      }
      plans.push(current)
    } else {
      current.endMs = safeTs
      current.photoIds.push(photo.id)
    }
  }

  // 组内 primarySpecies + 是否含新增种 待 photo 转换后再算
  return plans
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

/** 格式化组标题：'06:42 起 · 8 张' */
function buildGroupTitle(group: GroupPlan): string {
  const start = new Date(group.startMs)
  const hh = String(start.getHours()).padStart(2, '0')
  const mm = String(start.getMinutes()).padStart(2, '0')
  const span = group.endMs - group.startMs
  const photoCount = group.photoIds.length
  if (span < 60 * 1000 || photoCount === 1) {
    return `${hh}:${mm} · ${photoCount} 张`
  }
  const minutes = Math.round(span / 60000)
  return `${hh}:${mm} 起 · ${photoCount} 张 · ${minutes} 分钟`
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
    shotAt: row.created_at, // 后端尚未拆 EXIF DateTimeOriginal，先用 created_at
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
    boxes: [], // 后端 PhotoRow 暂未返回 detections，待扩展
  }
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

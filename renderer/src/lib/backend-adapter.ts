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

// ---------- Group ----------

/**
 * 后端目前不做组划分，所有照片归入一个默认组（按文件夹）。
 * 后续接入真实组（连拍/场景/物种）后改为基于 photo.group_id。
 */
export function buildDefaultGroup(libraryId: string, displayName: string): PhotoGroupRecord {
  return {
    id: `group-${libraryId}-default`,
    folderId: libraryId,
    title: displayName,
    groupType: 'time',
    sceneTag: 'record_shot',
    primarySpecies: null,
    containsNewSpecies: false,
  }
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
    previewGradient: gradientPlaceholder(row.id),
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
  const group = buildDefaultGroup(folder.id, folder.displayName)
  const photos = detail.photos.map((row) =>
    buildPhotoRecordFromRow(row, folder.id, group.id),
  )
  return { folder, groups: [group], photos }
}

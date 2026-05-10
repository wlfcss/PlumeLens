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
  AfOverlay,
  FolderRecord,
  FolderStatus,
  PhotoGrade,
  PhotoGroupRecord,
  PhotoRecord,
  PoseTagId,
  ProblemTagId,
  SelectionDecision,
  SpeciesCandidate,
} from '@/lib/mock-workspace'
import { resolveSpeciesCanonicalSci } from '@/lib/species-wiki'

type Translate = (key: string, options?: Record<string, unknown>) => string

function formatScore(score: number | null | undefined): string {
  if (score === null || score === undefined || !Number.isFinite(score)) return '--'
  return (score * 100).toFixed(1)
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

// ---------- Group: 用后端 scene_id（连续拍摄事件 / 同一观察上下文）----------

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
 * scene group 表示一次连续观察/拍摄事件；同一 scene 内仍可能包含多个 burst stack。
 * burst stack 是前端在 scene 内按主体几何连续性拆出的更小候选组，用来表达
 * “这几张可以作为同一连拍候选展开比较”。不要把 stack 和 scene 混用。
 *
 * scene_id 为 null 的 photo（场景分组还没跑完）回退到按时间近似分（每张单独一组）。
 * lifespan 启动 + import 完成会自动后台补 scene_id。
 */
function planGroups(libraryId: string, photos: PhotoRow[]): GroupPlan[] {
  const map = new Map<string, GroupPlan>()
  const order: string[] = []

  for (const photo of photos) {
    const ts = Date.parse(photo.shot_at)
    const createdTs = Date.parse(photo.created_at)
    const safeTs = Number.isFinite(ts) ? ts : Number.isFinite(createdTs) ? createdTs : 0
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

/** 格式化组标题：场景分组完成时展示 scene id / 时间 / 张数。 */
function buildGroupTitle(group: GroupPlan, t: Translate): string {
  const start = new Date(group.startMs)
  const hh = String(start.getHours()).padStart(2, '0')
  const mm = String(start.getMinutes()).padStart(2, '0')
  const photoCount = group.photoIds.length
  const spanSec = Math.round((group.endMs - group.startMs) / 1000)

  if (group.sceneId < 0) {
    // scene_id 还没分配（后台未完成）
    return t('selection.group.pendingTitle', { time: `${hh}:${mm}` })
  }
  if (photoCount === 1) {
    return t('selection.group.singleTitle', { scene: group.sceneId + 1, time: `${hh}:${mm}` })
  }
  if (spanSec < 60) {
    return t('selection.group.countTitle', {
      scene: group.sceneId + 1,
      time: `${hh}:${mm}`,
      count: photoCount,
    })
  }
  const minutes = Math.round(spanSec / 60)
  return t('selection.group.durationTitle', {
    scene: group.sceneId + 1,
    time: `${hh}:${mm}`,
    count: photoCount,
    minutes,
  })
}

// ---------- Photo ----------

const VALID_GRADES = new Set<PhotoGrade>(['reject', 'record', 'usable', 'select'])
const VALID_DECISIONS = new Set<SelectionDecision>(['select', 'usable', 'record', 'reject'])

function safeGrade(value: string | null): PhotoGrade {
  if (value && (VALID_GRADES as Set<string>).has(value)) {
    return value as PhotoGrade
  }
  return 'reject'
}

function safeDecision(value: string | null): SelectionDecision {
  if (value === null) return null
  if (value === 'selected') return 'select'
  if (value === 'maybe') return 'record'
  if (value === 'rejected') return 'reject'
  if (value === 'unreviewed') return null
  if ((VALID_DECISIONS as Set<string>).has(value)) {
    return value as SelectionDecision
  }
  return null
}

function lookupLatinName(speciesName: string | null): string | null {
  return resolveSpeciesCanonicalSci(speciesName)
}

function withConsensusCandidate(row: PhotoRow, candidates: SpeciesCandidate[]): SpeciesCandidate[] {
  if (row.species_source !== 'group_consensus' || !row.group_species || !row.group_species_latin) {
    return candidates
  }
  // group_consensus 是后端 read-time 派生的"组内共识"伪候选 — 优先放最前。
  // 若同一拉丁名也在原 candidates 里(共识来自候选自身),保留原 candidate 的
  // recognitionState / rejectScore / top1Top2Margin 三个 v6 字段;否则共识作为
  // 单独条目入栈,这三个字段没有数据来源,留 undefined 由 UI 兜底("--")。
  const matched = candidates.find((c) => c.latinName === row.group_species_latin)
  const consensus: SpeciesCandidate = {
    name: row.group_species,
    latinName: row.group_species_latin,
    confidence: row.group_species_confidence ?? 0,
    recognitionState: matched?.recognitionState,
    rejectScore: matched?.rejectScore,
    top1Top2Margin: matched?.top1Top2Margin,
  }
  return [
    consensus,
    ...candidates.filter((candidate) => candidate.latinName !== consensus.latinName),
  ]
}

/**
 * 根据 grade + bird_count + species + pose 推导问题标签。
 * 这是 UI 层启发式，不是后端权威信号；后端补齐后可替换。
 */
function deriveProblemTags(row: PhotoRow): ProblemTagId[] {
  const tags: ProblemTagId[] = []
  if (row.bird_count === 0 || row.bird_count === null) tags.push('no_bird')
  if (row.grade === 'reject') tags.push('subject_small')
  if (row.species === null && (row.bird_count ?? 0) > 0) {
    tags.push('low_species_confidence')
  }
  // pose 派生:头/眼不可见 → 对应问题标签。要求有 pose(避免无 pose 时把所有照片都
  // 标"头部遮挡"误导用户)。
  const pose = row.best_detection?.pose
  if (pose) {
    if (!pose.head_visible) {
      tags.push('head_occluded')
    } else if (!pose.eye_visible) {
      // 头可见但眼部关键点未过可见阈值。这里表达的是 pose 可见性证据不足,
      // 不是独立的眼部清晰度或锐度模型判断。
      tags.push('eye_soft')
    }
  }
  return tags
}

/**
 * 根据 best_detection.pose + bird_count 推导姿态标签(tile chips 用)。
 *
 * 之前 backend-adapter 把 poseTags 写死 [],导致选片瓦片完全没有姿态徽标 —
 * "眼可见/头部完整/展翅/停栖/多鸟"五个 chip 永远不显示。修复后从 best_detection.pose
 * 派生(后端 _build_detection_detail 现在透传完整 11 关键点 + 5 visibility + 3 posture)。
 */
function derivePoseTags(row: PhotoRow): PoseTagId[] {
  const tags: PoseTagId[] = []
  const pose = row.best_detection?.pose
  if (pose) {
    if (pose.eye_visible) tags.push('eye_visible')
    if (pose.head_visible) tags.push('head_clean')
    // wings_open 语义是"展翅"(飞行特征),不是简单的"翅膀关键点可见" — 后者
    // 栖息鸟也常成立(折翅仍可检测),会让 chip 失去信号价值。
    if (pose.posture === 'flying') tags.push('wings_open')
    if (pose.posture === 'perched') tags.push('perched')
  }
  if ((row.bird_count ?? 0) > 1) tags.push('multi_bird')
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
 * Preview background for larger non-lazy surfaces. Photo tiles use the separate
 * lazy <img> URL plus placeholderGradient to avoid firing hundreds of eager
 * CSS background requests at once.
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
  t: Translate,
): PhotoRecord {
  const grade = safeGrade(row.grade)
  const decision = safeDecision(row.decision)
  const isAnalyzed = row.pipeline_version !== null
  const bestQuality = row.best_detection?.quality ?? null
  const speciesCandidates = withConsensusCandidate(
    row,
    row.best_detection?.species_candidates
      ?.map((candidate) => ({
        name: candidate.canonical_zh ?? candidate.canonical_sci ?? '',
        latinName: candidate.canonical_sci ?? null,
        englishName: candidate.canonical_en ?? null,
        confidence: candidate.confidence ?? 0,
        recognitionState: candidate.recognition_state,
        rejectScore: candidate.reject_score,
        top1Top2Margin: candidate.top1_top2_margin,
      }))
      .filter((candidate) => candidate.name.length > 0) ?? [],
  )
  const finalScore = bestQuality?.combined ?? row.quality_score

  return {
    id: row.id,
    folderId,
    groupId,
    fileName: row.file_name,
    filePath: row.file_path,
    shotAt: row.shot_at,
    camera: t('selection.exif.unknownCamera'),
    lens: t('selection.exif.unknownLens'),
    speciesName: row.species,
    speciesLatinName: row.species_latin ?? lookupLatinName(row.species),
    manualSpecies: row.manual_species,
    speciesSource:
      row.species_source ?? (row.manual_species ? 'manual' : row.species ? 'model' : 'none'),
    modelSpeciesName: row.model_species ?? row.species,
    modelSpeciesLatinName:
      row.model_species_latin ?? row.species_latin ?? lookupLatinName(row.species),
    groupSpeciesName: row.group_species ?? null,
    groupSpeciesLatinName: row.group_species_latin ?? null,
    groupSpeciesConfidence: row.group_species_confidence ?? null,
    groupSpeciesSupport: row.group_species_support ?? null,
    groupSpeciesEvidence: row.group_species_evidence ?? null,
    groupSpeciesTotal: row.group_species_total ?? null,
    speciesConflict: Boolean(row.species_conflict),
    speciesCandidates:
      speciesCandidates.length > 0
        ? speciesCandidates
        : row.species
          ? [
              {
                name: row.species,
                latinName: row.species_latin ?? lookupLatinName(row.species),
                confidence: row.quality_score ?? 0,
              },
            ]
          : [],
    birdDetections: buildBirdDetections(row),
    // 单 library 维度的 backend-adapter 看不到全局物种历史,这里先给 false。
    // App.tsx 的 applyNewSpeciesMarkers 在所有 library detail 注入 workspace 后跨库
    // 按 shotAt 升序统一回标 photo.isNewSpecies + group.containsNewSpecies(每个物种第
    // 一张照片为 true)。
    isNewSpecies: false,
    birdCount: row.bird_count ?? 0,
    grade,
    decision,
    finalScore,
    semanticScore: bestQuality?.clipiqa ?? row.quality_score,
    technicalScore: bestQuality?.hyperiqa ?? row.quality_score,
    poseScore: null,
    // 后端 analysis_status 已在 SQL JOIN task_queue 后给出权威映射(done/failed/pending);
    // 老 PhotoRow 没这个字段时回落到 isAnalyzed 派生(向后兼容)。
    analysisStatus: row.analysis_status ?? (isAnalyzed ? 'done' : 'pending'),
    analysisErrorCode: row.analysis_error_code ?? null,
    analysisError: row.analysis_error ?? null,
    poseTags: derivePoseTags(row),
    problemTags: deriveProblemTags(row),
    sceneTag: 'record_shot',
    caption: isAnalyzed
      ? t('selection.photo.analysisCaption', {
          species: row.species ?? t('selection.photo.unidentified'),
          grade,
          score: formatScore(finalScore),
        })
      : t('selection.photo.pendingCaption'),
    previewGradient: buildPreviewBg(row.thumb_grid, row.id),
    placeholderGradient: gradientPlaceholder(row.id),
    thumbGridUrl: thumbnailUrl(row.thumb_grid, 'grid'),
    boxes: bboxToPercentBoxes(row),
    imageWidth: row.width,
    imageHeight: row.height,
    thumbPreviewUrl: thumbnailUrl(row.thumb_preview, 'preview'),
    exif: row.exif,
    bestBbox: row.best_detection?.bbox ?? null,
    bestPose: row.best_detection?.pose ?? null,
    bestAfPoint: extractAfPoint(row.exif),
    bestAfArea: extractAfArea(row.exif),
    companionPath: row.companion_path ?? null,
    companionFormat: row.companion_format ?? null,
    companionSize: row.companion_size ?? null,
    country: row.country ?? null,
    province: row.province ?? null,
    city: row.city ?? null,
    district: row.district ?? null,
    place: row.place ?? null,
  }
}

function buildBirdDetections(row: PhotoRow): PhotoRecord['birdDetections'] {
  const detections = row.detections ? [...row.detections] : []
  if (detections.length === 0 && row.best_detection) {
    detections.push({ ...row.best_detection, is_best: true })
  }
  return detections.map((d) => {
    const candidates =
      d.species_candidates
        ?.map((candidate) => ({
          name: candidate.canonical_zh ?? candidate.canonical_sci ?? '',
          latinName: candidate.canonical_sci ?? null,
          englishName: candidate.canonical_en ?? null,
          confidence: candidate.confidence ?? 0,
          recognitionState: candidate.recognition_state,
          rejectScore: candidate.reject_score,
          top1Top2Margin: candidate.top1_top2_margin,
        }))
        .filter((candidate) => candidate.name.length > 0) ?? []
    const useConsensus =
      row.species_source === 'group_consensus' &&
      d.is_best &&
      !d.manual_species &&
      row.bird_count === 1 &&
      row.group_species &&
      row.group_species_latin
    const effectiveCandidates = withConsensusCandidate(row, candidates)
    return {
      index: d.index,
      bbox: d.bbox,
      // detection-level pose（多鸟图深度复核切换鸟时显示对应 detection 的关键点）
      pose: d.pose ?? null,
      speciesName: useConsensus ? row.group_species! : d.species,
      speciesLatinName: useConsensus ? row.group_species_latin! : d.species_latin,
      speciesCandidates: effectiveCandidates,
      manualSpecies: d.manual_species,
      // detection-level species_source（v6 backend schema）。useConsensus 命中时
      // best detection 跟随 photo-level 共识，避免旧缓存/分页上下文里 detection
      // source 仍停在 model_unconfirmed 时把 UI 拉回待审。
      // 老数据（v5 之前）detection 没这字段 → undefined，下游 getArchiveSpeciesEntries
      // 走 fallback 按老逻辑（按 photo-level / manualSpecies）走。
      speciesSource: useConsensus ? 'group_consensus' : d.species_source,
      isBest: d.is_best,
    }
  })
}

/**
 * 从 EXIF 字段里读取 af_area / af_point（后端 scanner.py 已注入）。
 * 没有就返回 null（不是 Canon 机身或 MakerNote 无 AFInfo2 都会落到这里）。
 */
function extractAfPoint(
  exif: Record<string, unknown> | null | undefined,
): { x: number; y: number } | null {
  if (!exif) return null
  const af = exif.af_point
  if (isPoint(af)) {
    return { x: af.x, y: af.y }
  }
  return null
}

function extractAfArea(exif: Record<string, unknown> | null | undefined): AfOverlay | null {
  if (!exif) return null
  const afArea = exif.af_area
  if (isAfOverlay(afArea)) return afArea

  const afPoint = extractAfPoint(exif)
  if (!afPoint) return null
  return {
    kind: 'point',
    source: 'legacy',
    center: afPoint,
    points: [{ ...afPoint, in_focus: true, selected: true }],
    focused_points: [{ ...afPoint, in_focus: true, selected: true }],
    selected_points: [{ ...afPoint, in_focus: true, selected: true }],
    focused_count: 1,
    selected_count: 1,
    point_count: 1,
  }
}

function isPoint(value: unknown): value is { x: number; y: number } {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { x?: unknown }).x === 'number' &&
    typeof (value as { y?: unknown }).y === 'number'
  )
}

function isAfOverlay(value: unknown): value is AfOverlay {
  if (typeof value !== 'object' || value === null) return false
  const candidate = value as { center?: unknown; kind?: unknown }
  return typeof candidate.kind === 'string' && isPoint(candidate.center)
}

/** 把 best_detection.bbox（原图坐标）转成相对百分比 bbox（review modal 渲染用）。 */
function bboxToPercentBoxes(row: PhotoRow): Array<{ x: number; y: number; w: number; h: number }> {
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

/**
 * 复刻后端 `engine/pipeline/preprocess.py::expand_for_iqa` 的逻辑：
 * 同比例放大 bbox（默认 2.5×）+ 纵横比限制 + cap 到原图 + shift 防越界。
 * 用途：ReviewModal 右图 "IQA 裁切预览" 渲染。
 */
export function computeIqaCropBox(
  imageW: number,
  imageH: number,
  bbox: { x1: number; y1: number; x2: number; y2: number },
  expand = 2.5,
  maxAspectRatio = 2.0,
): { x1: number; y1: number; x2: number; y2: number } | null {
  const bw = bbox.x2 - bbox.x1
  const bh = bbox.y2 - bbox.y1
  if (bw <= 0 || bh <= 0 || imageW <= 0 || imageH <= 0) return null

  const cx = (bbox.x1 + bbox.x2) / 2
  const cy = (bbox.y1 + bbox.y2) / 2

  // 1) 同比例放大
  let tw = bw * expand
  let th = bh * expand

  // 2) 纵横比限制
  if (tw > th * maxAspectRatio) th = tw / maxAspectRatio
  else if (th > tw * maxAspectRatio) tw = th / maxAspectRatio

  // 3) cap 到原图
  tw = Math.min(tw, imageW)
  th = Math.min(th, imageH)

  // 4) 中心对齐 + shift
  let fx1 = cx - tw / 2
  let fy1 = cy - th / 2
  let fx2 = fx1 + tw
  let fy2 = fy1 + th
  if (fx1 < 0) {
    fx2 -= fx1
    fx1 = 0
  }
  if (fy1 < 0) {
    fy2 -= fy1
    fy1 = 0
  }
  if (fx2 > imageW) {
    fx1 -= fx2 - imageW
    fx2 = imageW
  }
  if (fy2 > imageH) {
    fy1 -= fy2 - imageH
    fy2 = imageH
  }
  fx1 = Math.max(0, fx1)
  fy1 = Math.max(0, fy1)
  return { x1: fx1, y1: fy1, x2: fx2, y2: fy2 }
}

// ---------- 整合：把单库 detail 转 photos/groups ----------

export interface DetailFragment {
  folder: FolderRecord
  groups: PhotoGroupRecord[]
  photos: PhotoRecord[]
}

export function buildFragmentFromDetail(detail: LibraryDetail, t: Translate): DetailFragment {
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
    buildPhotoRecordFromRow(
      row,
      folder.id,
      photoToGroup.get(row.id) ?? `group-${folder.id}-orphan`,
      t,
    ),
  )

  // 3. 组内排序：由 SelectionScreen 渲染时按 quality_score 降序（在 App.tsx 已有 sortPhotos）
  // 这里只生成 group 元数据
  const groups: PhotoGroupRecord[] = plans.map((plan) => {
    const { primarySpecies, isNewSpecies } = summarizeGroupSpecies(plan, photos)
    return {
      id: plan.id,
      folderId: folder.id,
      title: buildGroupTitle(plan, t),
      sceneNumber: plan.sceneId >= 0 ? plan.sceneId + 1 : null,
      startAt: new Date(plan.startMs).toISOString(),
      endAt: new Date(plan.endMs).toISOString(),
      originalPhotoCount: plan.photoIds.length,
      groupType: plan.photoIds.length >= 3 ? 'burst' : 'time',
      sceneTag: 'record_shot',
      primarySpecies,
      containsNewSpecies: isNewSpecies,
    }
  })

  return { folder, groups, photos }
}

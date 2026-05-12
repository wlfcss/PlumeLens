import { logger } from '@/lib/logger'

/**
 * API client for PlumeLens backend.
 *
 * Backend URL resolution:
 * - Electron runtime: 通过 ``window.plumelens.engineRequest`` 在 preload 完成
 *   fetch,token 不进入 renderer JS(H5 修复)。renderer 这边只看到 URL string
 *   和已经反序列化的 response body — 没有 raw token 可被 XSS / 第三方依赖窃取。
 * - Fallback (dev shell / 单元测试 / vite-only renderer): 直连 ``http://127.0.0.1:8000``
 *   不带 token (开发期 engine 通常无 api_token)。
 *
 * All JSON requests carry ``Content-Type: application/json`` (FastAPI 0.132+ strict).
 */

/**
 * Resolve the backend URL on every request.
 *
 * 不缓存：Electron 启动早期 engine 还没 spawn 完，IPC 返回 null。每次重新拉
 * (IPC 异步开销 <1ms)。如果 engine 没 ready，重试 200ms 间隔最多 60s,然后抛
 * ApiError(503) 让上层(useBackend / engine-status banner)能 surface 给用户操作,
 * 而不是把所有请求 / EventSource 都吊死在 await 上(看上去整个 UI 卡死)。
 *
 * 60s 是经验值:engine 冷启 + 模型加载 + manifest 校验最多 ~5s,留 12× 缓冲足以
 * 覆盖慢盘 / Rosetta / 极端机器,又不至于让用户等到怀疑应用死了才反馈。
 */
const BACKEND_BOOT_TIMEOUT_MS = 60_000
const BACKEND_BOOT_POLL_MS = 200

async function getBackendUrl(): Promise<string> {
  if (typeof window !== 'undefined' && window.plumelens) {
    const deadline = Date.now() + BACKEND_BOOT_TIMEOUT_MS
    let attempts = 0
    while (Date.now() < deadline) {
      const url = await window.plumelens.getBackendUrl()
      if (url) return url
      attempts += 1
      if (attempts % 25 === 0) {
        logger.warn(`等待 engine 后端启动... ${(attempts * BACKEND_BOOT_POLL_MS) / 1000}s`)
      }
      await new Promise((resolve) => setTimeout(resolve, BACKEND_BOOT_POLL_MS))
    }
    throw new ApiError(503, `engine backend not ready after ${BACKEND_BOOT_TIMEOUT_MS / 1000}s`)
  }
  // Dev / test fallback (Playwright vite-server 模式 / 单元测试)
  return 'http://127.0.0.1:8000'
}

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    message: string,
    public readonly detail?: unknown,
  ) {
    super(message)
    this.name = 'ApiError'
  }
}

// 默认 60s 超时 — 大库 detail/SSE setup 可能需要 30s+,留足余量。
// 调用方传入的 init.signal 会被合并到 timeout signal,任一触发都中断。
const REQUEST_TIMEOUT_MS = 60_000

function _bodyAsString(body: BodyInit | null | undefined): string | null {
  if (body == null) return null
  if (typeof body === 'string') return body
  // api-client 当前只用 JSON.stringify 出来的字符串 body;binary 上传暂不在调用面。
  // 这里抛错,避免静默丢 body 导致后端 422。
  throw new Error('api-client: only string bodies are supported (use JSON.stringify)')
}

function _normalizeHeaders(input: HeadersInit | undefined): Record<string, string> | undefined {
  if (input === undefined) return undefined
  const out: Record<string, string> = {}
  if (input instanceof Headers) {
    input.forEach((v, k) => {
      out[k] = v
    })
  } else if (Array.isArray(input)) {
    for (const [k, v] of input) out[k] = v
  } else {
    Object.assign(out, input)
  }
  return out
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  // Preferred path: preload's engineRequest — token 永远在 isolated context,
  // 不进 renderer JS。当 renderer 跑在 vite-only(无 preload)时 fallback 直连。
  const bodyStr = _bodyAsString(init.body as BodyInit | null | undefined)
  const headers = _normalizeHeaders(init.headers)

  if (typeof window !== 'undefined' && window.plumelens?.engineRequest) {
    let res: import('@/env').EngineResponse
    try {
      res = await window.plumelens.engineRequest(path, {
        method: init.method,
        body: bodyStr,
        headers,
        timeoutMs: REQUEST_TIMEOUT_MS,
      })
    } catch (err) {
      // 网络层失败(engine 重启 / 超时 / 偏移端口) — 包成 ApiError 让上层 banner 处理。
      const msg = err instanceof Error ? err.message : String(err)
      throw new ApiError(0, msg, err)
    }
    if (!res.ok) {
      let detail: unknown
      try {
        detail = JSON.parse(res.body)
      } catch {
        detail = res.body || undefined
      }
      const detailText = typeof detail === 'string' ? detail : JSON.stringify(detail)
      throw new ApiError(res.status, `${res.status} ${res.statusText}: ${detailText}`, detail)
    }
    if (res.status === 204 || res.body.length === 0) return undefined as T
    return JSON.parse(res.body) as T
  }

  // Fallback: vite dev / 单元测试 — 直连 127.0.0.1:8000,无 token。
  const base = await getBackendUrl()
  const url = `${base}${path}`
  const fallbackHeaders = new Headers(init.headers)
  if (!fallbackHeaders.has('Content-Type') && init.body) {
    fallbackHeaders.set('Content-Type', 'application/json')
  }
  const timeoutCtrl = new AbortController()
  const timer = setTimeout(() => timeoutCtrl.abort(), REQUEST_TIMEOUT_MS)
  const callerSignal = init.signal
  const onCallerAbort = (): void => timeoutCtrl.abort(callerSignal?.reason)
  if (callerSignal) {
    if (callerSignal.aborted) timeoutCtrl.abort(callerSignal.reason)
    else callerSignal.addEventListener('abort', onCallerAbort, { once: true })
  }
  let res: Response
  try {
    res = await fetch(url, { ...init, headers: fallbackHeaders, signal: timeoutCtrl.signal })
  } finally {
    clearTimeout(timer)
    callerSignal?.removeEventListener('abort', onCallerAbort)
  }
  if (!res.ok) {
    let detail: unknown
    try {
      detail = await res.json()
    } catch {
      detail = await res.text().catch(() => undefined)
    }
    const detailText = typeof detail === 'string' ? detail : JSON.stringify(detail)
    throw new ApiError(res.status, `${res.status} ${res.statusText}: ${detailText}`, detail)
  }
  if (res.status === 204) return undefined as T
  return (await res.json()) as T
}

// ---------------- Types (mirror engine/api/schemas/*) ----------------

export type LibraryStatus =
  | 'idle'
  | 'scanning'
  | 'hashing'
  | 'analyzing_partial'
  | 'ready'
  | 'updating'
  | 'path_missing'
  | 'exporting'
  | 'error'

export interface LibrarySummary {
  id: string
  display_name: string
  parent_path: string
  root_path: string
  status: LibraryStatus
  total_count: number
  analyzed_count: number
  recursive: boolean
  last_opened_at: string
  last_scanned_at: string | null
  last_analyzed_at: string | null
}

export interface BBox {
  x1: number
  y1: number
  x2: number
  y2: number
  confidence: number
}

export interface Keypoint {
  x: number
  y: number
  confidence: number
}

export interface PoseDetail {
  // 头部 5 关键点
  bill: Keypoint
  crown: Keypoint
  nape: Keypoint
  left_eye: Keypoint
  right_eye: Keypoint
  // 躯干 6 关键点(v2 新增,旧 cache 反序列化时有 default 占位)
  belly?: Keypoint
  breast?: Keypoint
  back?: Keypoint
  tail?: Keypoint
  left_wing?: Keypoint
  right_wing?: Keypoint
  // 5 项可见性
  head_visible: boolean
  eye_visible: boolean
  body_visible?: boolean
  tail_visible?: boolean
  wings_visible?: boolean
  // 3 项姿态(影响 grader 飞版升档)
  view_angle?: 'frontal' | 'side' | 'back' | 'unknown'
  facing?: 'left' | 'right' | 'unknown'
  posture?: 'perched' | 'flying' | 'unknown'
  posture_confidence?: number
  posture_method?: 'classifier' | 'heuristic'
}

export interface SpeciesCandidate {
  canonical_sci?: string
  canonical_zh?: string
  canonical_en?: string
  confidence?: number
  recognition_state?: 'recognized' | 'uncertain' | 'unrecognized'
  reject_score?: number
  top1_top2_margin?: number
}

export interface AfOverlayPoint {
  index?: number
  x: number
  y: number
  width?: number
  height?: number
  bounds?: { x1: number; y1: number; x2: number; y2: number }
  in_focus?: boolean
  selected?: boolean
}

export interface AfOverlay {
  provider?: string
  mode?: number
  kind: 'point' | 'expanded' | 'zone' | 'whole_area' | 'unknown'
  source?: 'in_focus' | 'selected' | 'legacy'
  center: { x: number; y: number }
  bounds?: { x1: number; y1: number; x2: number; y2: number }
  points?: AfOverlayPoint[]
  focused_points?: AfOverlayPoint[]
  selected_points?: AfOverlayPoint[]
  focused_count?: number
  selected_count?: number
  point_count?: number
}

export interface BestDetection {
  index: number
  bbox: BBox
  pose: PoseDetail | null
  quality: { clipiqa: number; hyperiqa: number; combined: number } | null
  species: string | null
  species_latin: string | null
  manual_species: boolean
  // 每个 detection 独立的 species_source（多鸟图混合可见性的关键 — 后端 v6 schema）。
  // photo-level species_source 由 best detection 决定，但 detection-level 才是
  // 羽迹聚合 / confirm 按钮显隐的真实依据。
  species_source?:
    | 'none'
    | 'model'
    | 'model_unconfirmed'
    | 'manual'
    | 'group_consensus'
    | 'conflict'
  species_candidates: SpeciesCandidate[]
}

export interface BirdDetectionDetail extends BestDetection {
  is_best: boolean
}

export interface PhotoRow {
  id: string
  file_path: string
  file_name: string
  format: string | null
  width: number | null
  height: number | null
  thumb_grid: string | null
  thumb_preview: string | null
  // JPG/RAW 同名 pair 的 RAW 同伴文件信息(scanner v7+)。无 pair 时全 null。
  // UI 在卡片 / 复核屏显示 "+CR3 25 MB" 让用户知道还有原片可导出。
  companion_path?: string | null
  companion_format?: string | null
  companion_size?: number | null
  country?: string | null
  province?: string | null
  city?: string | null
  district?: string | null
  place?: string | null
  created_at: string
  shot_at: string // ISO8601 拍摄时间（EXIF DateTimeOriginal 优先）
  scene_id: number | null // 场景分组 id
  pipeline_version: string | null
  grade: string | null
  quality_score: number | null
  bird_count: number | null
  species: string | null
  species_latin: string | null
  manual_species: boolean
  species_source?:
    | 'none'
    | 'model'
    | 'model_unconfirmed'
    | 'manual'
    | 'group_consensus'
    | 'conflict'
  model_species?: string | null
  model_species_latin?: string | null
  group_species?: string | null
  group_species_latin?: string | null
  group_species_confidence?: number | null
  group_species_support?: number | null
  group_species_evidence?: number | null
  group_species_total?: number | null
  species_conflict?: boolean
  decision: string | null // manual grade override: select / usable / record / reject
  // 分析任务状态:done / failed / pending (前端按此显示"已分析" / "分析失败" / "等待分析")
  // failed 包含 task DEAD(attempts 用尽,通常是图损坏/读取失败)
  analysis_status?: 'done' | 'failed' | 'pending'
  // 失败原因的语义 code,前端用于 i18n 映射:broken_image / invalid_image / file_missing
  // / timeout / unknown。仅在 analysis_status=failed 时有意义。
  analysis_error_code?: string | null
  analysis_error?: string | null // 原始错误消息(英文 PIL/rawpy 输出),fallback 显示用
  exif: Record<string, unknown> | null // EXIF whitelist 字段 + structured AF metadata
  best_detection: BestDetection | null // 深度复核需要画 bbox / 关键点
  detections: BirdDetectionDetail[] | null
}

export interface LibraryDetail {
  library: LibrarySummary
  photos: PhotoRow[]
  photo_total?: number | null
  photo_offset?: number
  photo_limit?: number | null
  next_offset?: number | null
}

export interface PhotoThumbnailResponse {
  photo_id: string
  library_id: string
  built: boolean
  thumb_grid: string | null
  thumb_preview: string | null
}

export interface ImportLibraryRequest {
  root_path: string
  display_name?: string | null
  recursive?: boolean
}

export interface LibraryDetailOptions {
  limit?: number
  offset?: number
  signal?: AbortSignal
}

export interface UpdateLibraryRequest {
  display_name: string
}

export interface RelinkLibraryRequest {
  root_path: string
}

export interface RelinkLibraryResponse {
  library: LibrarySummary
  previous_root_path: string
  matched_photos: number
  relinked_photos: number
  missing_photos: number
  relinked_companions: number
}

export type TaskQueueStats = Record<string, number>

export interface QueueStatsResponse {
  library_id: string | null
  stats: TaskQueueStats
}

export interface AnalysisBatchResponse {
  library_id: string
  enqueued: number
  stats: TaskQueueStats
}

export interface AnalysisProgressEvent {
  library_id: string
  completed: number
  total: number
  pending: number
  processing: number
  failed: number
  dead: number
  current_photo_id: string | null
}

export interface ModelVersionItem {
  id: string
  label: string
  version: string
  revision: string
  assets: string[]
  loaded: boolean
  provider: string | null
}

export interface ModelVersionsResponse {
  pipeline_version: string | null
  manifest_generated_at: string | null
  models: ModelVersionItem[]
}

export interface ClearHistoryResponse {
  libraries_deleted: number
  photos_deleted: number
  analysis_results_deleted: number
  decisions_deleted: number
  species_overrides_deleted: number
  tasks_deleted: number
  thumbnails_deleted: boolean
}

// Decisions
export type DecisionValue = 'select' | 'usable' | 'record' | 'reject' | null

export interface DecisionRow {
  photo_id: string
  decision: DecisionValue
}

export interface DecisionCountsResponse {
  library_id: string
  counts: Record<Exclude<DecisionValue, null>, number>
}

export interface ExportLibraryRequest {
  target_dir: string
  grades: Array<'select' | 'usable' | 'record' | 'reject'>
  min_score?: number | null
  max_score?: number | null
  copy_files?: boolean
  include_companions?: boolean
  include_xmp_sidecars?: boolean
  layout?: 'merged' | 'by_grade'
  preserve_structure?: boolean
  include_manifest?: boolean
}

export interface ExportLibraryResponse {
  library_id: string
  output_dir: string
  selected_count: number
  exported_count: number
  companion_count: number
  xmp_count: number
  skipped_missing: number
  failed_count: number
  manifest: {
    json: string | null
    csv: string | null
  }
}

export interface SpeciesOverrideValue {
  canonical_sci: string
  canonical_zh?: string | null
  canonical_en?: string | null
}

/** 写入 manual species 时同步上送的 detection bbox（原图像素坐标）— 后端用它做
    read-time IoU 匹配，让人工标注的归属随鸟稳定，不被 pipeline_version bump 时
    detections 数组重排错配。老 client 不传 → 后端 fallback 到 bird_index 匹配。 */
export interface SpeciesOverrideBBox {
  x1: number
  y1: number
  x2: number
  y2: number
}

export interface SpeciesOverrideRow {
  photo_id: string
  bird_index: number
  canonical_sci: string | null
  canonical_zh: string | null
  canonical_en: string | null
}

// ---------------- Endpoints ----------------

export const api = {
  // Settings / maintenance
  modelVersions: () => request<ModelVersionsResponse>('/settings/models'),
  clearLocalHistory: () =>
    request<ClearHistoryResponse>('/settings/history/clear', {
      method: 'POST',
      body: JSON.stringify({ confirm: true }),
    }),

  // Libraries
  listLibraries: () => request<LibrarySummary[]>('/library'),
  importLibrary: (body: ImportLibraryRequest) =>
    request<LibrarySummary>('/library/import', {
      method: 'POST',
      body: JSON.stringify(body),
    }),
  libraryDetail: (id: string, options: LibraryDetailOptions = {}) => {
    const params = new URLSearchParams()
    if (options.limit !== undefined) params.set('limit', String(options.limit))
    if (options.offset !== undefined) params.set('offset', String(options.offset))
    const query = params.toString()
    return request<LibraryDetail>(`/library/${id}${query ? `?${query}` : ''}`, {
      signal: options.signal,
    })
  },
  updateLibrary: (id: string, body: UpdateLibraryRequest) =>
    request<LibrarySummary>(`/library/${id}`, {
      method: 'PATCH',
      body: JSON.stringify(body),
    }),
  relinkLibrary: (id: string, body: RelinkLibraryRequest) =>
    request<RelinkLibraryResponse>(`/library/${id}/relink`, {
      method: 'POST',
      body: JSON.stringify(body),
    }),
  deleteLibrary: (id: string) => request<void>(`/library/${id}`, { method: 'DELETE' }),
  buildThumbnails: (id: string) =>
    request<{ built: number; skipped: number; failed: number }>(`/library/${id}/thumbnails`, {
      method: 'POST',
    }),
  buildPhotoThumbnail: (photoId: string) =>
    request<PhotoThumbnailResponse>(`/library/photo/${photoId}/thumbnail`, { method: 'POST' }),
  libraryEventsUrl: async (libraryId: string): Promise<string> => {
    // preload 的 engineSseUrl 在 isolated world 内拼接 token,renderer 这边收到的是
    // 已经包含 ?token=xxx 的 URL string(SSE native EventSource 不能传 header 的妥协)。
    // 见 preload.ts::performEngineSseUrl 注释。
    if (typeof window !== 'undefined' && window.plumelens?.engineSseUrl) {
      return window.plumelens.engineSseUrl(`/library/${libraryId}/events`)
    }
    // Fallback: vite dev / 测试无 preload — 直连无 token。
    const base = await getBackendUrl()
    return `${base}/library/${libraryId}/events`
  },

  // Analysis
  startBatch: (libraryId: string, forceRerun = false) =>
    request<AnalysisBatchResponse>('/analysis/batch', {
      method: 'POST',
      body: JSON.stringify({ library_id: libraryId, force_rerun: forceRerun }),
    }),
  pauseAnalysis: (libraryId: string) =>
    request<QueueStatsResponse>(`/analysis/library/${libraryId}/pause`, { method: 'POST' }),
  resumeAnalysis: (libraryId: string) =>
    request<QueueStatsResponse>(`/analysis/library/${libraryId}/resume`, { method: 'POST' }),
  cancelAnalysis: (libraryId: string) =>
    request<QueueStatsResponse>(`/analysis/library/${libraryId}/cancel`, { method: 'POST' }),
  getQueueStats: (libraryId: string) =>
    request<QueueStatsResponse>(`/analysis/library/${libraryId}/stats`),

  // SSE — returns URL only; caller constructs EventSource
  progressUrl: async (libraryId: string): Promise<string> => {
    if (typeof window !== 'undefined' && window.plumelens?.engineSseUrl) {
      return window.plumelens.engineSseUrl(`/analysis/library/${libraryId}/progress`)
    }
    const base = await getBackendUrl()
    const url = new URL(`${base}/analysis/library/${libraryId}/progress`)
    return url.toString()
  },

  // Decisions
  getDecision: (photoId: string) => request<DecisionRow>(`/decisions/photo/${photoId}`),
  setDecision: (photoId: string, decision: DecisionValue) =>
    request<DecisionRow>(`/decisions/photo/${photoId}`, {
      method: 'PUT',
      body: JSON.stringify({ decision }),
    }),
  batchSetDecisions: (updates: Array<[string, DecisionValue]>) =>
    request<{ updated: number }>('/decisions/batch', {
      method: 'POST',
      body: JSON.stringify({ updates }),
    }),
  setSpeciesOverride: (
    photoId: string,
    birdIndex: number,
    species: SpeciesOverrideValue | null,
    bbox?: SpeciesOverrideBBox | null,
  ) => {
    // bbox 在 set 和 clear 两种路径都送 — clear 时后端用它 IoU 反查 DB 实际行的
    // bird_index,避免 pipeline_version bump 后 caller 看到的下标 ≠ DB 下标导致删错行。
    const bboxBody = bbox ? { x1: bbox.x1, y1: bbox.y1, x2: bbox.x2, y2: bbox.y2 } : null
    return request<SpeciesOverrideRow>(`/decisions/photo/${photoId}/species/${birdIndex}`, {
      method: 'PUT',
      body: JSON.stringify(
        species
          ? {
              canonical_sci: species.canonical_sci,
              canonical_zh: species.canonical_zh ?? null,
              canonical_en: species.canonical_en ?? null,
              bbox: bboxBody,
            }
          : { canonical_sci: null, bbox: bboxBody },
      ),
    })
  },
  listLibraryDecisions: (libraryId: string) =>
    request<DecisionRow[]>(`/decisions/library/${libraryId}`),
  libraryDecisionCounts: (libraryId: string) =>
    request<DecisionCountsResponse>(`/decisions/library/${libraryId}/counts`),

  // Export
  exportLibrary: (libraryId: string, body: ExportLibraryRequest) =>
    request<ExportLibraryResponse>(`/export/library/${libraryId}`, {
      method: 'POST',
      body: JSON.stringify(body),
    }),

  // Reverse geocoding — provider chain(amap → baidu → tencent → nominatim → offline),
  // 后端按可用 key 自动选,前端只看 display_name + source 标识即可。
  reverseGeocode: (lat: number, lon: number, lang = 'zh-CN') =>
    request<ReverseGeocodeResponse>(
      `/geocoding/reverse?lat=${lat}&lon=${lon}&lang=${encodeURIComponent(lang)}`,
    ),

  // 羽迹三级地图聚合 — 后端 SQL 聚合,前端按需 lazy load 各级 GeoJSON
  geoSummary: () => request<GeoSummary>('/archive/geo/summary'),
  geoProvinces: () => request<GeoProvinceRow[]>('/archive/geo/provinces'),
  geoCities: (province: string) =>
    request<GeoCityRow[]>(`/archive/geo/cities?province=${encodeURIComponent(province)}`),
  geoSpots: (province: string, city: string) =>
    request<GeoSpot[]>(
      `/archive/geo/spots?province=${encodeURIComponent(province)}&city=${encodeURIComponent(city)}`,
    ),
}

export interface GeoSummary {
  total_with_gps: number
  resolved: number
  pending: number
  unresolved_count: number
  photos_without_gps: number
}

export interface GeoProvinceRow {
  province: string
  photo_count: number
  species_count: number
}

export interface GeoCityRow {
  city: string
  photo_count: number
  species_count: number
}

export interface GeoSpecies {
  name: string
  latin_name: string | null
  english_name: string | null
  photo_count: number
}

export interface GeoSpotPhoto {
  photo_id: string
  file_name: string
  species: GeoSpecies[]
  species_latin: string | null
  species_zh: string | null
  thumb_grid: string | null
  grade: string | null
  quality_score: number | null
}

export interface GeoSpot {
  lat: number
  lon: number
  place: string | null
  photo_count: number
  species_count: number
  species: GeoSpecies[]
  photos: GeoSpotPhoto[]
}

export interface ReverseGeocodeResponse {
  display_name: string | null
  source: 'amap' | 'baidu' | 'tencent' | 'nominatim' | 'offline' | null
  lat: number
  lon: number
}

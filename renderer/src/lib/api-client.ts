import { replaceEqualDeep } from '@tanstack/react-query'

import { logger } from '@/lib/logger'
import { benchmarkTrace, type BenchmarkApiArea } from '@/lib/benchmark-trace'
import {
  hydrateCompactSummaryRow,
  LIBRARY_SUMMARY_BATCH_MEDIA_TYPE,
  LIBRARY_SUMMARY_COMPACT_FORMAT,
  normalizeLibraryRootPrefix,
} from '../../../shared/library-summary-stream'
import { engineRequestTimeout, engineStartupTimeout } from '../../../shared/engine-request-timeout'

/**
 * API client for PlumeLens backend.
 *
 * Backend URL resolution:
 * - Electron runtime: 通过 ``window.plumelens.engineRequest`` 在 preload 完成
 *   fetch,token 不进入 renderer JS。SSE 优先走 ``engineSseSubscribe``，同样由
 *   preload 注入 Authorization。renderer 只看到 path/response body，不接触 raw token。
 * - Fallback (dev shell / 单元测试 / vite-only renderer): 直连 ``http://127.0.0.1:8000``
 *   不带 token (开发期 engine 通常无 api_token)。
 *
 * All JSON requests carry ``Content-Type: application/json`` (FastAPI 0.132+ strict).
 */

const BACKEND_BOOT_POLL_MS = 200

async function getBackendUrl(): Promise<string> {
  if (typeof window !== 'undefined' && window.plumelens) {
    const timeoutMs = engineStartupTimeout(window.plumelens.platform)
    const deadline = Date.now() + timeoutMs
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
    throw new ApiError(503, `engine backend not ready after ${timeoutMs / 1000}s`)
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

export interface SelectionQuery {
  species_keys: string[]
  include_review: boolean
  grades: Array<'select' | 'usable' | 'record' | 'reject'>
  include_no_bird: boolean
  include_failed: boolean
  only_flying: boolean
  photo_query: string
  sort: 'score' | 'time' | 'name'
}

export interface SelectionSpeciesFacet {
  key: string
  name: string
  latin_name: string | null
  english_name: string | null
  search_aliases: string[]
  photo_count: number
  review_photo_count: number
}

export interface SelectionQueryResult {
  library_id: string
  projection_revision: string
  query: SelectionQuery
  matched_photo_ids: string[]
  matched_count: number
  total_count: number
  pending_count: number
  failed_count: number
  no_bird_count: number
  facets: SelectionSpeciesFacet[]
  offset?: number
  limit?: number | null
  next_offset?: number | null
}

// 默认 60s 超时 — 大库 detail/SSE setup 可能需要 30s+,留足余量。
// 调用方传入的 init.signal 会被合并到 timeout signal,任一触发都中断。

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

type ApiTraceMark = (name: string, fields?: { at?: number; status?: number }) => void

function traceApiRequest(path: string): ApiTraceMark | undefined {
  const trace = benchmarkTrace
  if (!trace) return undefined
  const [pathname] = path.split('?', 1)
  let area: BenchmarkApiArea
  if (pathname === '/library') area = 'library-list'
  else if (pathname === '/health') area = 'health'
  else if (/^\/library\/[^/]+$/.test(pathname)) area = 'library-detail'
  else if (/^\/library\/[^/]+\/selection\/query$/.test(pathname)) area = 'selection-query'
  else if (/^\/library\/photo\/[^/]+\/review$/.test(pathname)) area = 'photo-review'
  else return undefined
  const id = trace.start('api.start', area)
  return (name, fields) => trace.mark(name, { id, area, ...fields })
}

function parseApiResponse(text: string, mark: ApiTraceMark | undefined): unknown {
  if (!mark) return JSON.parse(text)
  mark('api.parse_start')
  try {
    return JSON.parse(text)
  } finally {
    mark('api.parse_end')
  }
}

async function request<T>(
  path: string,
  init: RequestInit = {},
  receiveSummaryLine?: (line: string) => void,
): Promise<T> {
  const mark = traceApiRequest(path)
  const timeoutMs = engineRequestTimeout(path)
  // Preferred path: preload's engineRequest — token 永远在 isolated context,
  // 不进 renderer JS。当 renderer 跑在 vite-only(无 preload)时 fallback 直连。
  const bodyStr = _bodyAsString(init.body as BodyInit | null | undefined)
  const headers = _normalizeHeaders(init.headers)

  if (typeof window !== 'undefined' && window.plumelens?.engineRequest) {
    init.signal?.throwIfAborted()
    const bridgeRequestId = init.signal
      ? `r-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
      : undefined
    const onCallerAbort = (): void => {
      if (bridgeRequestId) window.plumelens?.engineCancelRequest?.(bridgeRequestId)
    }
    init.signal?.addEventListener('abort', onCallerAbort, { once: true })
    let res: import('@/env').EngineResponse
    try {
      let firstRecord = true
      res = await window.plumelens.engineRequest(
        path,
        {
          method: init.method,
          body: bodyStr,
          headers,
          timeoutMs,
          ...(bridgeRequestId ? { requestId: bridgeRequestId } : {}),
        },
        receiveSummaryLine &&
          ((line) => {
            if (firstRecord) {
              mark?.('api.stream_first_record')
              firstRecord = false
            }
            receiveSummaryLine(line)
          }),
      )
    } catch (err) {
      if (init.signal?.aborted) {
        throw init.signal.reason instanceof Error
          ? init.signal.reason
          : new DOMException('Aborted', 'AbortError')
      }
      mark?.('api.transport_error')
      // 网络层失败(engine 重启 / 超时 / 偏移端口) — 包成 ApiError 让上层 banner 处理。
      const msg = err instanceof Error ? err.message : String(err)
      throw new ApiError(0, msg, err)
    } finally {
      init.signal?.removeEventListener('abort', onCallerAbort)
    }
    mark?.('api.transport_end', { status: res.status })
    if (mark && res.benchmarkTiming) {
      const { timeOrigin, fetchStart, headers, body } = res.benchmarkTiming
      const offset = timeOrigin - performance.timeOrigin
      mark('api.fetch_start', { at: offset + fetchStart })
      mark('api.headers', { at: offset + headers, status: res.status })
      mark('api.body', { at: offset + body })
    }
    if (!res.ok) {
      let detail: unknown
      try {
        detail = parseApiResponse(res.body, mark)
      } catch {
        detail = res.body || undefined
      }
      const detailText = typeof detail === 'string' ? detail : JSON.stringify(detail)
      throw new ApiError(res.status, `${res.status} ${res.statusText}: ${detailText}`, detail)
    }
    if (res.status === 204 || res.body.length === 0) return undefined as T
    return parseApiResponse(res.body, mark) as T
  }

  // Fallback: vite dev / 单元测试 — 直连 127.0.0.1:8000,无 token。
  const base = await getBackendUrl()
  const url = `${base}${path}`
  const fallbackHeaders = new Headers(init.headers)
  if (!fallbackHeaders.has('Content-Type') && init.body) {
    fallbackHeaders.set('Content-Type', 'application/json')
  }
  const timeoutCtrl = new AbortController()
  const timer = setTimeout(() => timeoutCtrl.abort(), timeoutMs)
  const callerSignal = init.signal
  const onCallerAbort = (): void => timeoutCtrl.abort(callerSignal?.reason)
  if (callerSignal) {
    if (callerSignal.aborted) timeoutCtrl.abort(callerSignal.reason)
    else callerSignal.addEventListener('abort', onCallerAbort, { once: true })
  }
  let res: Response
  try {
    mark?.('api.fetch_start')
    res = await fetch(url, { ...init, headers: fallbackHeaders, signal: timeoutCtrl.signal })
    mark?.('api.headers', { status: res.status })
  } catch (error) {
    mark?.('api.transport_error')
    throw error
  } finally {
    clearTimeout(timer)
    callerSignal?.removeEventListener('abort', onCallerAbort)
  }
  if (mark && res.ok && res.status !== 204) {
    const body = await res.text()
    mark('api.body')
    mark('api.transport_end', { status: res.status })
    return parseApiResponse(body, mark) as T
  }
  mark?.('api.transport_end', { status: res.status })
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
  // 轻量图库详情只包含可见性和姿态，关键点随单张复核请求返回。
  bill?: Keypoint
  crown?: Keypoint
  nape?: Keypoint
  left_eye?: Keypoint
  right_eye?: Keypoint
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
  species_english?: string | null
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
  // Summary rows keep the leading candidate's signals, while review owns the full list.
  candidate_confidence?: number | null
  candidate_recognition_state?: SpeciesCandidate['recognition_state'] | null
  species_candidates?: SpeciesCandidate[]
}

export interface BirdDetectionDetail extends BestDetection {
  is_best: boolean
}

export interface PhotoRow {
  id: string
  input_revision?: number
  review_revision?: string | null
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
  species_english?: string | null
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
  projection_revision?: string | null
  library: LibrarySummary
  photos: PhotoRow[]
  photo_total?: number | null
  photo_offset?: number
  photo_limit?: number | null
  next_offset?: number | null
  summary_format?: 'full' | 'compact-v1' | null
}

export interface PhotoBatchResponse {
  library_id: string
  projection_revision?: string | null
  photos: PhotoRow[]
}

export interface ArchiveSpeciesSummaryRow {
  key: string
  name: string
  latin_name: string | null
  english_name: string | null
  photo_count: number
  best_score: number | null
  first_seen_at: string | null
  latest_seen_at: string | null
  library_count: number
}

export interface ArchiveSpeciesSummaryResponse {
  total_species: number
  total_photos: number
  species: ArchiveSpeciesSummaryRow[]
}

export interface PhotoReviewResponse {
  library_id: string
  photo: PhotoRow
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

/** Assemble one complete revision before publishing it to Query and selection. */
async function requestLibrarySummary(
  path: string,
  signal: AbortSignal | undefined,
  previousPhotos: readonly PhotoRow[],
): Promise<LibraryDetail> {
  let detail: Omit<LibraryDetail, 'photos'> | undefined
  let rootPrefix = ''
  let isCompact = false
  let completed = false
  const photos: PhotoRow[] = []
  const buffered = await request<LibraryDetail>(
    path,
    { signal, headers: { Accept: LIBRARY_SUMMARY_BATCH_MEDIA_TYPE } },
    (line) => {
      signal?.throwIfAborted()
      const frame: unknown = JSON.parse(line)
      if (!completed && Array.isArray(frame) && detail) {
        for (const rawRow of frame as Record<string, unknown>[]) {
          const row = isCompact
            ? hydrateCompactSummaryRow<PhotoRow>(rawRow, rootPrefix)
            : (rawRow as unknown as PhotoRow)
          // Share before retaining the next frame. Query's final structural
          // comparison can then reuse these rows by reference.
          photos.push(replaceEqualDeep(previousPhotos[photos.length], row))
        }
      } else if (!detail && frame && typeof frame === 'object' && 'library' in frame) {
        detail = frame as Omit<LibraryDetail, 'photos'>
        isCompact = detail.summary_format === LIBRARY_SUMMARY_COMPACT_FORMAT
        rootPrefix = isCompact ? normalizeLibraryRootPrefix(detail.library?.root_path) : ''
      } else if (detail && !completed && frame === photos.length) {
        completed = true
      } else {
        throw new Error('Invalid library summary stream')
      }
    },
  )
  if (buffered !== undefined && !detail) return buffered
  if (!detail || !completed) throw new ApiError(0, 'Incomplete library summary stream')
  signal?.throwIfAborted()
  return { ...detail, photos }
}

export interface LibraryDetailOptions {
  limit?: number
  offset?: number
  view?: 'summary' | 'full'
  includeSelectionSnapshot?: boolean
  signal?: AbortSignal
  previousPhotos?: readonly PhotoRow[]
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
  run_id?: string | null
  desired_state?: 'running' | 'paused' | 'cancelled' | 'completed' | null
  library_id: string | null
  stats: TaskQueueStats
}

export interface AnalysisBatchResponse {
  library_id: string
  enqueued: number
  stats: TaskQueueStats
}

export interface AnalysisProgressEvent {
  run_id?: string | null
  desired_state?: 'running' | 'paused' | 'cancelled' | 'completed' | null
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
  scope?: 'library' | 'selection'
  selection_query?: SelectionQuery | null
  projection_revision?: string | null
  target_dir: string
  grades: Array<'select' | 'usable' | 'record' | 'reject'>
  min_score?: number | null
  max_score?: number | null
  copy_files?: boolean
  include_companions?: boolean
  include_xmp_sidecars?: boolean
  /** 格式白名单（大写不含点，如 ['JPG','CR3']）。null/省略 = 不限格式。 */
  formats?: string[] | null
  layout?: 'merged' | 'by_grade'
  preserve_structure?: boolean
  include_manifest?: boolean
}

/** 源图库里实际存在的一种格式及其存量。 */
export interface ExportFormatStat {
  ext: string
  count: number
  bytes: number
  is_raw: boolean
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

/** POST /export/library/{id} 的即时响应 — 导出已在后台开跑，进度走 SSE。 */
export interface ExportJobStart {
  job_id: string
  library_id: string
  total: number
  total_bytes: number
}

export type ExportJobStatus = 'running' | 'succeeded' | 'failed' | 'cancelled'

/** 后端结构化错误：code 供前端查 i18n 表，其余字段是渲染文案要用的数值。 */
export interface ExportErrorDetail {
  code: string
  message?: string
  required_bytes?: number
  free_bytes?: number
  job_id?: string
}

/** SSE 每帧的 job 快照。 */
export interface ExportJobSnapshot {
  job_id: string
  library_id: string
  status: ExportJobStatus
  total: number
  processed: number
  exported: number
  companions: number
  xmp: number
  missing: number
  failed: number
  total_bytes: number
  copied_bytes: number
  current_file: string | null
  output_dir: string | null
  result: ExportLibraryResponse | null
  error: ExportErrorDetail | null
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
  querySelection: (
    libraryId: string,
    query: SelectionQuery,
    signal?: AbortSignal,
    projectionRevision?: string,
    pagination?: { limit?: number; offset?: number },
  ) => {
    const params = new URLSearchParams()
    if (projectionRevision) params.set('projection_revision', projectionRevision)
    if (pagination?.limit !== undefined) params.set('limit', String(pagination.limit))
    if (pagination?.offset !== undefined && pagination.offset > 0) {
      params.set('offset', String(pagination.offset))
    }
    const search = params.toString()
    return request<SelectionQueryResult>(
      `/library/${libraryId}/selection/query${search ? `?${search}` : ''}`,
      {
        method: 'POST',
        body: JSON.stringify(query),
        signal,
      },
    )
  },
  photoBatch: (
    libraryId: string,
    photoIds: string[],
    options: { view?: 'summary' | 'full'; projectionRevision?: string; signal?: AbortSignal } = {},
  ) => {
    const params = new URLSearchParams()
    if (options.projectionRevision) params.set('projection_revision', options.projectionRevision)
    const search = params.toString()
    return request<PhotoBatchResponse>(
      `/library/${libraryId}/photos/batch${search ? `?${search}` : ''}`,
      {
        method: 'POST',
        body: JSON.stringify({ photo_ids: photoIds, view: options.view ?? 'summary' }),
        signal: options.signal,
      },
    )
  },
  archiveSpeciesSummary: (signal?: AbortSignal) =>
    request<ArchiveSpeciesSummaryResponse>('/archive/species/summary', { signal }),
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
    if (options.view) params.set('view', options.view)
    if (options.includeSelectionSnapshot) params.set('include_selection_snapshot', 'true')
    const query = params.toString()
    const path = `/library/${id}${query ? `?${query}` : ''}`
    if (
      options.view === 'summary' &&
      options.limit === undefined &&
      typeof window !== 'undefined' &&
      window.plumelens?.engineRequest
    ) {
      params.set('summary_format', LIBRARY_SUMMARY_COMPACT_FORMAT)
      const compactPath = `/library/${id}?${params.toString()}`
      return requestLibrarySummary(compactPath, options.signal, options.previousPhotos ?? [])
    }
    return request<LibraryDetail>(path, { signal: options.signal })
  },
  photoReview: (photoId: string, signal?: AbortSignal) =>
    request<PhotoReviewResponse>(`/library/photo/${encodeURIComponent(photoId)}/review`, {
      signal,
    }),
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
    // Vite-only / test fallback without Electron preload (no bearer token).
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

  // Vite-only / test fallback — Electron runtime always uses engineSseSubscribe.
  progressUrl: async (libraryId: string): Promise<string> => {
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
  // 导出是长任务(实测 964 张 / 80 GB 约两小时) — POST 只启动并立刻返回 job 句柄，
  // 进度与结果走 exportJobEventsUrl 的 SSE，中途可 cancelExportJob。
  exportLibrary: (libraryId: string, body: ExportLibraryRequest) =>
    request<ExportJobStart>(`/export/library/${libraryId}`, {
      method: 'POST',
      body: JSON.stringify(body),
    }),
  exportFormats: (libraryId: string) =>
    request<{ formats: ExportFormatStat[] }>(`/export/library/${libraryId}/formats`),
  exportJobSnapshot: (jobId: string) => request<ExportJobSnapshot>(`/export/jobs/${jobId}`),
  cancelExportJob: (jobId: string) =>
    request<{ job_id: string; status: ExportJobStatus }>(`/export/jobs/${jobId}/cancel`, {
      method: 'POST',
    }),
  exportJobEventsUrl: async (jobId: string): Promise<string> => {
    const base = await getBackendUrl()
    return `${base}/export/jobs/${jobId}/events`
  },

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

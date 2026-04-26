/**
 * API client for PlumeLens backend.
 *
 * Backend URL resolution:
 * - Electron runtime: via window.plumelens.getBackendUrl() (dynamic port)
 * - Fallback (dev shell / tests): http://127.0.0.1:8000
 *
 * All requests carry `Content-Type: application/json` (FastAPI 0.132+ strict).
 */

/**
 * Resolve the backend URL on every request.
 *
 * 不缓存：Electron 启动早期 engine 还没 spawn 完，IPC 返回 null。每次重新拉
 * （IPC 异步开销 <1ms）。如果 engine 没 ready，无限轮询 200ms 间隔直到拿到 URL；
 * 不抛错 — 抛了之后 useEffect 一次性 hook（如 useAnalysisProgress 的 EventSource）
 * 拒绝重连，整个流死。
 */
async function getBackendUrl(): Promise<string> {
  if (typeof window !== 'undefined' && window.plumelens) {
    // 无限重试 200ms 间隔，每 5 秒打一次 console.warn 让用户知道进度
    let attempts = 0
    while (true) {
      const url = await window.plumelens.getBackendUrl()
      if (url) return url
      attempts += 1
      if (attempts % 25 === 0) {
        // eslint-disable-next-line no-console
        console.warn(`等待 engine 后端启动... ${(attempts * 200) / 1000}s`)
      }
      await new Promise((resolve) => setTimeout(resolve, 200))
    }
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

async function request<T>(
  path: string,
  init: RequestInit = {},
): Promise<T> {
  const base = await getBackendUrl()
  const url = `${base}${path}`
  const headers = new Headers(init.headers)
  if (!headers.has('Content-Type') && init.body) {
    headers.set('Content-Type', 'application/json')
  }
  const res = await fetch(url, { ...init, headers })
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
  if (res.status === 204) {
    return undefined as T
  }
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

export interface PhotoRow {
  id: string
  file_path: string
  file_name: string
  format: string | null
  width: number | null
  height: number | null
  thumb_grid: string | null
  thumb_preview: string | null
  created_at: string
  shot_at: string  // ISO8601 拍摄时间（EXIF DateTimeOriginal 优先）
  scene_id: number | null  // 场景分组 id（同 library 内部连续整数），null 表示尚未跑过
  pipeline_version: string | null
  grade: string | null
  quality_score: number | null
  bird_count: number | null
  species: string | null
  decision: string  // 'unreviewed' | 'selected' | 'maybe' | 'rejected' (默认 unreviewed)
}

export interface LibraryDetail {
  library: LibrarySummary
  photos: PhotoRow[]
}

export interface ImportLibraryRequest {
  root_path: string
  display_name?: string | null
  recursive?: boolean
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

// Decisions
export type DecisionValue = 'unreviewed' | 'selected' | 'maybe' | 'rejected'

export interface DecisionRow {
  photo_id: string
  decision: DecisionValue
}

export interface DecisionCountsResponse {
  library_id: string
  counts: Record<DecisionValue, number>
}

// ---------------- Endpoints ----------------

export const api = {
  // Libraries
  listLibraries: () => request<LibrarySummary[]>('/library'),
  importLibrary: (body: ImportLibraryRequest) =>
    request<LibrarySummary>('/library/import', {
      method: 'POST',
      body: JSON.stringify(body),
    }),
  libraryDetail: (id: string) => request<LibraryDetail>(`/library/${id}`),
  deleteLibrary: (id: string) =>
    request<void>(`/library/${id}`, { method: 'DELETE' }),
  buildThumbnails: (id: string) =>
    request<{ built: number; skipped: number; failed: number }>(
      `/library/${id}/thumbnails`,
      { method: 'POST' },
    ),

  // Analysis
  startBatch: (libraryId: string, forceRerun = false) =>
    request<AnalysisBatchResponse>('/analysis/batch', {
      method: 'POST',
      body: JSON.stringify({ library_id: libraryId, force_rerun: forceRerun }),
    }),
  pauseAnalysis: (libraryId: string) =>
    request<QueueStatsResponse>(
      `/analysis/library/${libraryId}/pause`,
      { method: 'POST' },
    ),
  resumeAnalysis: (libraryId: string) =>
    request<QueueStatsResponse>(
      `/analysis/library/${libraryId}/resume`,
      { method: 'POST' },
    ),
  cancelAnalysis: (libraryId: string) =>
    request<QueueStatsResponse>(
      `/analysis/library/${libraryId}/cancel`,
      { method: 'POST' },
    ),
  getQueueStats: (libraryId: string) =>
    request<QueueStatsResponse>(`/analysis/library/${libraryId}/stats`),

  // SSE — returns URL only; caller constructs EventSource
  progressUrl: async (libraryId: string): Promise<string> => {
    const base = await getBackendUrl()
    return `${base}/analysis/library/${libraryId}/progress`
  },

  // Decisions
  getDecision: (photoId: string) =>
    request<DecisionRow>(`/decisions/photo/${photoId}`),
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
  listLibraryDecisions: (libraryId: string) =>
    request<DecisionRow[]>(`/decisions/library/${libraryId}`),
  libraryDecisionCounts: (libraryId: string) =>
    request<DecisionCountsResponse>(`/decisions/library/${libraryId}/counts`),
}

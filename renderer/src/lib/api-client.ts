/**
 * API client for PlumeLens backend.
 *
 * Backend URL resolution:
 * - Electron runtime: via window.plumelens.getBackendUrl() (dynamic port)
 * - Fallback (dev shell / tests): http://127.0.0.1:8000
 *
 * All requests carry `Content-Type: application/json` (FastAPI 0.132+ strict).
 */

let _cachedBackendUrl: string | null = null

async function getBackendUrl(): Promise<string> {
  if (_cachedBackendUrl) return _cachedBackendUrl
  if (typeof window !== 'undefined' && window.plumelens) {
    const url = await window.plumelens.getBackendUrl()
    if (url) {
      _cachedBackendUrl = url
      return url
    }
  }
  // Dev / test fallback
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
  pipeline_version: string | null
  grade: string | null
  quality_score: number | null
  bird_count: number | null
  species: string | null
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
}

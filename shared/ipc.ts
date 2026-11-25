/**
 * Shared IPC & Preload bridge contracts between Electron Main, Preload, and Renderer.
 *
 * Single source of truth to prevent type drift across `electron/main.ts`,
 * `electron/preload.ts`, and `renderer/src/env.d.ts`.
 */

import type { EngineBenchmarkTiming } from './benchmark-trace'

export type EngineStatusPayload =
  | { kind: 'ready'; url: string }
  | { kind: 'unhealthy'; consecutiveFailures: number; threshold: number }
  | {
      kind: 'crashed'
      code: number | null
      signal: string | null
      restartCount: number
      maxRestarts: number
    }
  | { kind: 'fatal'; message: string }
  | { kind: 'cpu-fallback' }

export interface EngineResponse {
  ok: boolean
  status: number
  statusText: string
  body: string
  contentType: string | null
  benchmarkTiming?: EngineBenchmarkTiming
}

export interface EngineRequestInit {
  method?: string
  body?: string | null
  headers?: Record<string, string>
  timeoutMs?: number
  requestId?: string
}

export type EngineSseBridgeEvent =
  | { type: 'open' }
  | { type: 'message'; event: string; data: string }
  | { type: 'error'; message: string; status?: number }

export type UpdateCheckResult =
  | {
      ok: true
      currentVersion: string
      latestVersion: string
      hasUpdate: boolean
      releaseUrl: string
      releaseName: string | null
      publishedAt: string | null
    }
  | {
      ok: false
      currentVersion: string
      reason: 'network' | 'invalid_response' | 'rate_limited' | 'not_found'
      message: string
    }

export interface UserSettings {
  amapKey?: string
  baiduAk?: string
  tencentKey?: string
}

export type EditorTool = 'topaz' | 'photoshop'

export interface EditorListResult {
  topaz: string | null
  photoshop: string | null
}

export type OpenInEditorResult =
  | { ok: true; app: string }
  | {
      ok: false
      reason:
        | 'invalid_args'
        | 'not_installed'
        | 'file_missing'
        | 'app_missing'
        | 'spawn_failed'
    }

export type OpenPathResult =
  | { ok: true }
  | { ok: false; reason: 'invalid_path' | 'path_missing' | 'open_failed'; message?: string }

export type OpenExternalUrlResult =
  | { ok: true }
  | { ok: false; reason: 'invalid_url' | 'open_failed'; message?: string }

/// <reference types="vite/client" />

import type {
  ClearLogsResult,
  ExportDiagnosticsResult,
  LoggingStatusSnapshot,
  RendererLogInput,
} from '../../shared/client-log'
import type {
  EditorListResult,
  EngineRequestInit,
  EngineResponse,
  EngineSseBridgeEvent,
  EngineStatusPayload,
  OpenExternalUrlResult,
  OpenInEditorResult,
  OpenPathResult,
  UpdateCheckResult,
  UserSettings,
} from '../../shared/ipc'
import type { BenchmarkTraceEvent } from '@/lib/benchmark-trace'

export type {
  EditorListResult,
  EngineRequestInit,
  EngineResponse,
  EngineSseBridgeEvent,
  EngineStatusPayload,
  OpenExternalUrlResult,
  OpenInEditorResult,
  OpenPathResult,
  UpdateCheckResult,
  UserSettings,
}

interface PlumeLensAPI {
  readonly platform?: string
  readonly benchmarkTraceEnabled?: boolean
  getBackendUrl(): Promise<string | null>
  /** Engine API 请求 — 在 preload 内完成 fetch,token 不进 renderer JS(H5)。 */
  engineRequest?: (
    path: string,
    init?: EngineRequestInit,
    receiveSummaryLine?: (line: string) => void,
  ) => Promise<EngineResponse>
  /** 取消指定 requestId 的在途 engineRequest。 */
  engineCancelRequest?: (requestId: string) => void
  /** 订阅 engine SSE；Electron packaged 路径下 token 留在 preload Authorization header。 */
  engineSseSubscribe?: (path: string, onEvent: (event: EngineSseBridgeEvent) => void) => () => void
  getAppVersion(): Promise<string>
  checkForUpdates(): Promise<UpdateCheckResult>
  openFolder(): Promise<string | null>
  selectExportDirectory(): Promise<string | null>
  openLogsDir(): Promise<string>
  logBatch?: (entries: RendererLogInput[]) => void
  getLoggingStatus?: () => Promise<LoggingStatusSnapshot>
  setLoggingConsent?: (enabled: boolean) => Promise<LoggingStatusSnapshot>
  setLoggingEnabled?: (enabled: boolean) => Promise<LoggingStatusSnapshot>
  setLoggingLevel?: (level: 'info' | 'debug') => Promise<LoggingStatusSnapshot>
  exportDiagnosticsBundle?: () => Promise<ExportDiagnosticsResult>
  clearLogs?: () => Promise<ClearLogsResult>
  onLoggingStateChanged?: (cb: (status: LoggingStatusSnapshot) => void) => () => void
  openPathInFinder(path: string): Promise<OpenPathResult>
  openExternalUrl(url: string): Promise<OpenExternalUrlResult>
  /** 兼容老 channel；调用方必须在 unmount 时调用返回的 unsubscribe。 */
  onBackendReady(cb: (url: string) => void): () => void
  /** 兼容老 channel；调用方必须在 unmount 时调用返回的 unsubscribe。 */
  onBackendError(cb: (msg: string) => void): () => void
  /** 订阅 engine 状态变化(ready/unhealthy/crashed/fatal)。返回 unsubscribe。 */
  onEngineStatus(cb: (payload: EngineStatusPayload) => void): () => void
  /** 启动期探测的外部编辑器(Topaz/Photoshop)解析名;null = 未安装,UI 应隐藏对应按钮。 */
  listEditors(): Promise<EditorListResult>
  /** 用指定外部编辑器打开文件。 */
  openInEditor(tool: 'topaz' | 'photoshop', path: string): Promise<OpenInEditorResult>
  /** 读用户设置(API keys 等),持久化在 userData/settings.json */
  getUserSettings(): Promise<UserSettings>
  /** 保存设置 — 空字符串视为清除该 key;merge 不动未传入字段。 */
  saveUserSettings(
    partial: UserSettings,
  ): Promise<
    | { ok: true; settings: UserSettings }
    | { ok: false; reason: 'safe_storage_unavailable' | 'unknown'; message: string }
  >
  /** 重启 engine — settings 改后调让新 key 注入生效 */
  restartEngine(): Promise<boolean>
}

declare global {
  interface Window {
    plumelens?: PlumeLensAPI
    __PLUMELENS_BENCHMARK_TRACE__?: BenchmarkTraceEvent[]
  }
}

export {}

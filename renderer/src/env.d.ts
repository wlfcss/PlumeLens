/// <reference types="vite/client" />

// 与 electron/preload.ts 的 EngineStatusPayload 保持一致
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

/** Mirror of electron/preload.ts `EngineResponse`. body 永远是 string;若日后需
 *  返回二进制再加 `engineRequestBlob`。 */
export interface EngineResponse {
  ok: boolean
  status: number
  statusText: string
  body: string
  contentType: string | null
}

export interface EngineRequestInit {
  method?: string
  body?: string | null
  headers?: Record<string, string>
  /** 单次请求超时(毫秒);默认 60000。 */
  timeoutMs?: number
}

interface PlumeLensAPI {
  getBackendUrl(): Promise<string | null>
  /** Engine API 请求 — 在 preload 内完成 fetch,token 不进 renderer JS(H5)。
   *  vite-only / 单元测试可能没有这个 method;调用方 ?. 后 fallback 直连。 */
  engineRequest?: (path: string, init?: EngineRequestInit) => Promise<EngineResponse>
  /** 构造 SSE URL(包含 query token,native EventSource 限制)。 */
  engineSseUrl?: (path: string) => Promise<string>
  getAppVersion(): Promise<string>
  openFolder(): Promise<string | null>
  selectExportDirectory(): Promise<string | null>
  openLogsDir(): Promise<string>
  openPathInFinder(
    path: string,
  ): Promise<
    | { ok: true }
    | { ok: false; reason: 'invalid_path' | 'path_missing' | 'open_failed'; message?: string }
  >
  openExternalUrl(
    url: string,
  ): Promise<{ ok: true } | { ok: false; reason: 'invalid_url' | 'open_failed'; message?: string }>
  /** 兼容老 channel；调用方必须在 unmount 时调用返回的 unsubscribe。 */
  onBackendReady(cb: (url: string) => void): () => void
  /** 兼容老 channel；调用方必须在 unmount 时调用返回的 unsubscribe。 */
  onBackendError(cb: (msg: string) => void): () => void
  /** 订阅 engine 状态变化(ready/unhealthy/crashed/fatal)。返回 unsubscribe。 */
  onEngineStatus(cb: (payload: EngineStatusPayload) => void): () => void
  /** 启动期探测的外部编辑器解析名;null = 未安装,UI 应隐藏对应按钮。 */
  listEditors(): Promise<{ topaz: string | null; photoshop: string | null }>
  /** 用指定外部编辑器打开文件。失败时 reason: not_installed/file_missing/app_missing/spawn_failed。 */
  openInEditor(
    tool: 'topaz' | 'photoshop',
    path: string,
  ): Promise<
    | { ok: true; app: string }
    | { ok: false; reason: 'not_installed' | 'file_missing' | 'app_missing' | 'spawn_failed' }
  >
  /** 读用户设置(API keys 等),持久化在 userData/settings.json */
  getUserSettings(): Promise<UserSettings>
  /** 保存设置 — 空字符串视为清除该 key;merge 不动未传入字段。
   *  失败时返回 ok=false + reason 让 UI 提示("safe_storage_unavailable" 表示
   *  Linux 平台缺 keyring,值不会被存,UI 应隐藏 settings 表单)。 */
  saveUserSettings(
    partial: UserSettings,
  ): Promise<
    | { ok: true; settings: UserSettings }
    | { ok: false; reason: 'safe_storage_unavailable' | 'unknown'; message: string }
  >
  /** 重启 engine — settings 改后调让新 key 注入生效 */
  restartEngine(): Promise<boolean>
}

export interface UserSettings {
  amapKey?: string
  baiduAk?: string
  tencentKey?: string
}

declare global {
  interface Window {
    plumelens?: PlumeLensAPI
  }
}

export {}

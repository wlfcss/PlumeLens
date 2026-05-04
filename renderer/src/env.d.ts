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

interface PlumeLensAPI {
  getBackendUrl(): Promise<string | null>
  getBackendAuthToken(): Promise<string | null>
  getAppVersion(): Promise<string>
  openFolder(): Promise<string | null>
  openLogsDir(): Promise<string>
  onBackendReady(cb: (url: string) => void): void
  onBackendError(cb: (msg: string) => void): void
  /** 订阅 engine 状态变化(ready/unhealthy/crashed/fatal)。返回 unsubscribe。 */
  onEngineStatus(cb: (payload: EngineStatusPayload) => void): () => void
  /** 启动期探测的外部编辑器解析名;null = 未安装,UI 应隐藏对应按钮。 */
  listEditors(): Promise<{ topaz: string | null; photoshop: string | null }>
  /** 用指定外部编辑器打开文件。失败时 reason: not_installed/file_missing/spawn_failed。 */
  openInEditor(
    tool: 'topaz' | 'photoshop',
    path: string,
  ): Promise<{ ok: true; app: string } | { ok: false; reason: string }>
  /** 读用户设置(API keys 等),持久化在 userData/settings.json */
  getUserSettings(): Promise<UserSettings>
  /** 保存设置 — 空字符串视为清除该 key;merge 不动未传入字段 */
  saveUserSettings(partial: UserSettings): Promise<UserSettings>
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

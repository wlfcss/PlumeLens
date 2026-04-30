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
}

declare global {
  interface Window {
    plumelens?: PlumeLensAPI
  }
}

export {}

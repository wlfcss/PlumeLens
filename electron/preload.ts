import { contextBridge, ipcRenderer } from 'electron'

// 与 main.ts 的 EngineStatusPayload 对应 — 改动需同步两边。
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

contextBridge.exposeInMainWorld('plumelens', {
  getBackendUrl: (): Promise<string | null> => ipcRenderer.invoke('get-backend-url'),
  getBackendAuthToken: (): Promise<string | null> =>
    ipcRenderer.invoke('get-backend-auth-token'),
  getAppVersion: (): Promise<string> => ipcRenderer.invoke('get-app-version'),
  openFolder: (): Promise<string | null> => ipcRenderer.invoke('dialog:open-folder'),
  /** 打开 logs 目录 — 用户在 fatal 状态点 banner 触发,Finder/Explorer 弹窗。 */
  openLogsDir: (): Promise<string> => ipcRenderer.invoke('open-logs-dir'),
  /** 启动期探测的外部编辑器(Topaz/Photoshop)解析名;null = 未安装。 */
  listEditors: (): Promise<{ topaz: string | null; photoshop: string | null }> =>
    ipcRenderer.invoke('list-editors'),
  /** 用指定外部编辑器打开文件(macOS spawn `open -a`)。 */
  openInEditor: (
    tool: 'topaz' | 'photoshop',
    path: string,
  ): Promise<{ ok: true; app: string } | { ok: false; reason: string }> =>
    ipcRenderer.invoke('open-in-editor', { tool, path }),
  onBackendReady: (cb: (url: string) => void): void => {
    ipcRenderer.on('backend-ready', (_event, url: string) => cb(url))
  },
  onBackendError: (cb: (msg: string) => void): void => {
    ipcRenderer.on('backend-error', (_event, msg: string) => cb(msg))
  },
  // 统一的 engine 状态推送 — renderer 用 zustand store 订阅这里转发的事件,
  // 整个 UI 一处响应(进度条/toast/SSE 重连触发)。
  onEngineStatus: (cb: (payload: EngineStatusPayload) => void): (() => void) => {
    const handler = (_event: unknown, payload: EngineStatusPayload): void => cb(payload)
    ipcRenderer.on('engine-status', handler)
    // 返回 unsubscribe — React unmount 时清掉,避免泄漏
    return (): void => {
      ipcRenderer.removeListener('engine-status', handler)
    }
  },
})

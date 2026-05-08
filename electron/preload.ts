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

/**
 * Engine 单次请求的结果 — engineRequest 内部从 fetch 读完 .text() 后压成
 * 可序列化的纯对象,通过 contextBridge 跨 isolated world 传给 renderer。
 *
 * `body` 永远是字符串(response.text()),renderer 侧 api-client 自行 JSON.parse。
 * 二进制响应当前没有调用方,后续如有需求另开 engineRequestBlob。
 */
export interface EngineResponse {
  ok: boolean
  status: number
  statusText: string
  body: string
  contentType: string | null
}

export interface EngineRequestInit {
  method?: string
  /** 已 JSON.stringify 过的 body 字符串;binary upload 暂不支持。 */
  body?: string | null
  /** caller 显式 headers,会与 preload 注入的 Authorization / Content-Type merge。 */
  headers?: Record<string, string>
  /** 单次请求超时(毫秒);默认 60000。caller 信号无法跨 contextBridge 传过来,所以
   *  renderer 侧 caller 的 AbortSignal 不会传播;只能靠这里的本地超时兜底。 */
  timeoutMs?: number
}

// 缓存 url + token,首次调用时通过 IPC 拉一次,engine 重启后清空让下次重取。
// 关键点:这两个变量 *只存在于 preload 的 isolated context*,renderer JS
// (window 上下文,即使 XSS)读不到 — 这是 H5 的核心:Bearer Token 不进渲染器。
let cachedBackendUrl: string | null = null
let cachedAuthToken: string | null = null
let bootstrapPromise: Promise<void> | null = null
// Generation 计数器:engine 每次 ready/crashed/fatal 都 ++。bootstrapAuth 在 IPC
// 拉数据期间 capture 当前 generation,完成时如果 generation 已变,说明 engine 中
// 途重启了,这次拿到的 url/token 已经是旧 process 的,丢弃不写回 cache。否则会
// 出现"engine 重启完了 cache 却被旧 IPC 结果覆盖回 stale URL"的赛跑(audit-batch-2 P1)。
let cacheGeneration = 0

async function bootstrapAuth(): Promise<void> {
  // 加锁:多个并发 engineRequest 不会同时 invoke 两次 IPC。
  if (cachedBackendUrl !== null && cachedAuthToken !== null) return
  if (bootstrapPromise === null) {
    const generation = cacheGeneration
    bootstrapPromise = (async () => {
      const [url, token] = await Promise.all([
        ipcRenderer.invoke('get-backend-url') as Promise<string | null>,
        ipcRenderer.invoke('get-backend-auth-token') as Promise<string | null>,
      ])
      // engine 重启过 → 抛弃 stale 结果,下一次请求会重新 bootstrap(因为 cache 还是 null)。
      if (generation !== cacheGeneration) return
      cachedBackendUrl = url
      cachedAuthToken = token
    })().finally(() => {
      bootstrapPromise = null
    })
  }
  await bootstrapPromise
}

// engine 重启 → 旧 url / token 失效。监听事件清缓存 + bump generation,
// 让 in-flight bootstrap 不会把旧值覆盖回 cache。
ipcRenderer.on('engine-status', (_event, payload: EngineStatusPayload) => {
  if (payload.kind === 'ready' || payload.kind === 'crashed' || payload.kind === 'fatal') {
    cacheGeneration += 1
    cachedBackendUrl = null
    cachedAuthToken = null
  }
})

async function ensureUrl(): Promise<string> {
  await bootstrapAuth()
  if (!cachedBackendUrl) {
    // 兜底再拉一次(engine 还没 ready)。renderer api-client 会重试。
    cachedBackendUrl = (await ipcRenderer.invoke('get-backend-url')) as string | null
  }
  if (!cachedBackendUrl) {
    throw new Error('Engine backend URL not available yet')
  }
  return cachedBackendUrl
}

async function performEngineRequest(
  path: string,
  init: EngineRequestInit = {},
): Promise<EngineResponse> {
  const url = await ensureUrl()
  const headers = new Headers(init.headers ?? {})
  if (cachedAuthToken && !headers.has('Authorization')) {
    headers.set('Authorization', `Bearer ${cachedAuthToken}`)
  }
  if (init.body && !headers.has('Content-Type')) {
    headers.set('Content-Type', 'application/json')
  }
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), init.timeoutMs ?? 60_000)
  try {
    const res = await fetch(`${url}${path}`, {
      method: init.method ?? 'GET',
      headers,
      body: init.body ?? undefined,
      signal: ctrl.signal,
    })
    const body = await res.text()
    return {
      ok: res.ok,
      status: res.status,
      statusText: res.statusText,
      body,
      contentType: res.headers.get('content-type'),
    }
  } finally {
    clearTimeout(timer)
  }
}

/**
 * 给 SSE 消费者构造 EventSource URL(原生 EventSource 不支持自定义 header,
 * 因此 token 必须以 query string 形式传到 server)。
 *
 * **已知限制:这一步会把 token 带回 renderer 上下文(URL string)。** 与
 * engineRequest 的 token-not-in-renderer 模型不同,因为 native EventSource
 * 只能接受 URL 参数。后续若做 IPC SSE bridge(main 主控 EventSource → 转发
 * IPC event)可彻底切断;当前 trade-off:复用浏览器自带 reconnect / backoff,
 * 简化 renderer 代码。
 */
async function performEngineSseUrl(path: string): Promise<string> {
  const url = await ensureUrl()
  const final = new URL(`${url}${path}`)
  if (cachedAuthToken) final.searchParams.set('token', cachedAuthToken)
  return final.toString()
}

contextBridge.exposeInMainWorld('plumelens', {
  getBackendUrl: (): Promise<string | null> => ipcRenderer.invoke('get-backend-url'),
  /**
   * Engine API 请求 — 在 preload 的 isolated world 内完成 fetch,token 不进
   * renderer JS。详见 H5 修复(security-batch-2)。
   */
  engineRequest: (path: string, init?: EngineRequestInit): Promise<EngineResponse> =>
    performEngineRequest(path, init),
  /** 构造 SSE URL(包含 token 的 query string,详见 performEngineSseUrl 注释)。 */
  engineSseUrl: (path: string): Promise<string> => performEngineSseUrl(path),
  getAppVersion: (): Promise<string> => ipcRenderer.invoke('get-app-version'),
  openFolder: (): Promise<string | null> => ipcRenderer.invoke('dialog:open-folder'),
  selectExportDirectory: (): Promise<string | null> =>
    ipcRenderer.invoke('dialog:select-export-directory'),
  /** 打开 logs 目录 — 用户在 fatal 状态点 banner 触发,Finder/Explorer 弹窗。 */
  openLogsDir: (): Promise<string> => ipcRenderer.invoke('open-logs-dir'),
  /** 在 Finder 中打开指定本地路径。 */
  openPathInFinder: (
    path: string,
  ): Promise<
    | { ok: true }
    | { ok: false; reason: 'invalid_path' | 'path_missing' | 'open_failed'; message?: string }
  > => ipcRenderer.invoke('open-path-in-finder', path),
  /** 启动期探测的外部编辑器(Topaz/Photoshop)解析名;null = 未安装。 */
  listEditors: (): Promise<{ topaz: string | null; photoshop: string | null }> =>
    ipcRenderer.invoke('list-editors'),
  /** 读 userData/settings.json — 外部地理 API keys 等用户配置 */
  getUserSettings: (): Promise<{
    amapKey?: string
    baiduAk?: string
    tencentKey?: string
  }> => ipcRenderer.invoke('get-user-settings'),
  /** 保存 settings.json — 字段空字符串视为清除该 key,merge 不动其他字段 */
  saveUserSettings: (partial: {
    amapKey?: string
    baiduAk?: string
    tencentKey?: string
  }): Promise<{ amapKey?: string; baiduAk?: string; tencentKey?: string }> =>
    ipcRenderer.invoke('save-user-settings', partial),
  /** 重启 engine 子进程 — settings 改后调使新 env 注入生效 */
  restartEngine: (): Promise<boolean> => ipcRenderer.invoke('restart-engine'),
  /** 用指定外部编辑器打开文件(Topaz 走 bundle executable,其他走系统 open)。 */
  openInEditor: (
    tool: 'topaz' | 'photoshop',
    path: string,
  ): Promise<{ ok: true; app: string } | { ok: false; reason: string }> =>
    ipcRenderer.invoke('open-in-editor', { tool, path }),
  /** 兼容老 channel；调用方必须保存返回值并在 unmount 时调用，避免 listener 泄漏。 */
  onBackendReady: (cb: (url: string) => void): (() => void) => {
    const handler = (_event: unknown, url: string): void => cb(url)
    ipcRenderer.on('backend-ready', handler)
    return (): void => {
      ipcRenderer.removeListener('backend-ready', handler)
    }
  },
  /** 兼容老 channel；调用方必须保存返回值并在 unmount 时调用，避免 listener 泄漏。 */
  onBackendError: (cb: (msg: string) => void): (() => void) => {
    const handler = (_event: unknown, msg: string): void => cb(msg)
    ipcRenderer.on('backend-error', handler)
    return (): void => {
      ipcRenderer.removeListener('backend-error', handler)
    }
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

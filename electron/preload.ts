import { contextBridge, ipcRenderer } from 'electron'
import { BENCHMARK_TRACE_ARGUMENT } from '../shared/benchmark-trace'
import {
  type ClearLogsResult,
  type ExportDiagnosticsResult,
  type LoggingStatusSnapshot,
  type RendererLogInput,
} from '../shared/client-log'
import {
  type EngineRequestInit,
  type EngineResponse,
  type EngineSseBridgeEvent,
  type EngineStatusPayload,
  type UpdateCheckResult,
} from '../shared/ipc'
import { engineRequestTimeout } from '../shared/engine-request-timeout'
import {
  LIBRARY_SUMMARY_BATCH_MEDIA_TYPE,
  readSummaryLines,
} from '../shared/library-summary-stream'

export type {
  EngineRequestInit,
  EngineResponse,
  EngineSseBridgeEvent,
  EngineStatusPayload,
  UpdateCheckResult,
}

const benchmarkTraceEnabled = process.argv?.includes(BENCHMARK_TRACE_ARGUMENT) === true

function generateRequestId(): string {
  const bytes = new Uint8Array(4)
  if (typeof globalThis.crypto?.getRandomValues === 'function') {
    globalThis.crypto.getRandomValues(bytes)
    return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')
  }
  return Math.random().toString(16).slice(2, 10).padEnd(8, '0')
}

function sendPreloadLog(entry: RendererLogInput): void {
  try {
    ipcRenderer.send('client-log:batch', [{ ...entry, ts: new Date().toISOString() }], 'preload')
  } catch {
    /* best effort */
  }
}

function isEditorTool(value: unknown): value is 'topaz' | 'photoshop' {
  return value === 'topaz' || value === 'photoshop'
}

function normalizeEnginePath(path: string): string {
  if (typeof path !== 'string' || !path.startsWith('/') || path.startsWith('//')) {
    throw new Error('Engine path must be an absolute local path')
  }
  if (path.includes('\0')) {
    throw new Error('Engine path contains invalid characters')
  }
  return path
}

// 缓存 url + token,首次调用时通过 IPC 拉一次,engine 重启后清空让下次重取。
// 关键点:这两个变量 *只存在于 preload 的 isolated context*,renderer JS
// (window 上下文,即使 XSS)读不到 — 这是 H5 的核心:Bearer Token 不进渲染器。
let cachedBackendUrl: string | null = null
let cachedAuthToken: string | null = null
let bootstrapPromise: Promise<void> | null = null
let cacheGeneration = 0

function invalidateAuthCache(): void {
  cacheGeneration += 1
  cachedBackendUrl = null
  cachedAuthToken = null
}

async function bootstrapAuth(): Promise<void> {
  if (cachedBackendUrl !== null && cachedAuthToken !== null) return
  if (bootstrapPromise === null) {
    const generation = cacheGeneration
    bootstrapPromise = (async () => {
      const [url, token] = await Promise.all([
        ipcRenderer.invoke('get-backend-url') as Promise<string | null>,
        ipcRenderer.invoke('get-backend-auth-token') as Promise<string | null>,
      ])
      if (generation !== cacheGeneration) return
      cachedBackendUrl = url
      cachedAuthToken = token
    })().finally(() => {
      bootstrapPromise = null
    })
  }
  await bootstrapPromise
}

ipcRenderer.on('engine-status', (_event, payload: EngineStatusPayload) => {
  if (payload.kind === 'ready' || payload.kind === 'crashed' || payload.kind === 'fatal') {
    invalidateAuthCache()
  }
})

async function ensureAuth(): Promise<{ url: string; token: string | null }> {
  await bootstrapAuth()
  if (!cachedBackendUrl) {
    const generation = cacheGeneration
    const [url, token] = await Promise.all([
      ipcRenderer.invoke('get-backend-url') as Promise<string | null>,
      ipcRenderer.invoke('get-backend-auth-token') as Promise<string | null>,
    ])
    if (generation === cacheGeneration) {
      cachedBackendUrl = url
      cachedAuthToken = token
    }
    if (!url) {
      throw new Error('Engine backend URL not available yet')
    }
    return { url, token }
  }
  return { url: cachedBackendUrl, token: cachedAuthToken }
}

const inFlightRequests = new Map<string, AbortController>()

function cancelEngineRequest(requestId: string): void {
  const ctrl = inFlightRequests.get(requestId)
  if (ctrl) {
    inFlightRequests.delete(requestId)
    ctrl.abort()
  }
}

async function performEngineRequest(
  path: string,
  init: EngineRequestInit = {},
  receiveSummaryLine?: (line: string) => void,
): Promise<EngineResponse> {
  const { url, token } = await ensureAuth()
  const enginePath = normalizeEnginePath(path)
  const pathnameOnly = enginePath.split('?', 1)[0] ?? enginePath
  const requestId = init.requestId || generateRequestId()
  const method = (init.method ?? 'GET').toUpperCase()
  const headers = new Headers(init.headers ?? {})
  if (token && !headers.has('Authorization')) {
    headers.set('Authorization', `Bearer ${token}`)
  }
  if (!headers.has('X-PlumeLens-Request-Id')) {
    headers.set('X-PlumeLens-Request-Id', requestId)
  }
  if (init.body && !headers.has('Content-Type')) {
    headers.set('Content-Type', 'application/json')
  }
  const ctrl = new AbortController()
  inFlightRequests.set(requestId, ctrl)
  const timeoutMs = init.timeoutMs ?? engineRequestTimeout(enginePath)
  let timedOut = false
  const timer = setTimeout(() => {
    timedOut = true
    ctrl.abort()
  }, timeoutMs)
  const startedAt = performance.now()
  try {
    const fetchStart = benchmarkTraceEnabled ? performance.now() : undefined
    const res = await fetch(`${url}${enginePath}`, {
      method,
      headers,
      body: init.body ?? undefined,
      signal: ctrl.signal,
    })
    if (res.status === 401) {
      invalidateAuthCache()
    }
    const headersAt = benchmarkTraceEnabled ? performance.now() : undefined
    const contentType = res.headers.get('content-type')
    const mediaType = contentType?.split(';', 1)[0]?.trim().toLowerCase() ?? null
    let body = ''
    if (res.ok && mediaType === LIBRARY_SUMMARY_BATCH_MEDIA_TYPE && receiveSummaryLine) {
      if (!res.body) throw new Error('Missing library summary stream')
      await readSummaryLines(res.body, receiveSummaryLine)
    } else {
      body = await res.text()
    }
    const durationMs = Math.round((performance.now() - startedAt) * 10) / 10
    if (res.status >= 500 || res.status === 401) {
      sendPreloadLog({
        level: res.status >= 500 ? 'error' : 'warn',
        scope: 'engine-http',
        category: 'error',
        event: 'engine_http_error',
        meta: { method, path: pathnameOnly, status: res.status, durationMs, requestId },
      })
    } else if (durationMs >= 1500) {
      sendPreloadLog({
        level: 'info',
        scope: 'engine-http',
        category: 'ui_perf',
        event: 'engine_http_slow',
        meta: { method, path: pathnameOnly, status: res.status, durationMs, requestId },
      })
    }
    const benchmarkTiming =
      fetchStart !== undefined && headersAt !== undefined
        ? {
            timeOrigin: performance.timeOrigin,
            fetchStart,
            headers: headersAt,
            body: performance.now(),
          }
        : undefined
    return {
      ok: res.ok,
      status: res.status,
      statusText: res.statusText,
      body,
      contentType,
      ...(benchmarkTiming && { benchmarkTiming }),
    }
  } catch (err) {
    const durationMs = Math.round((performance.now() - startedAt) * 10) / 10
    // Caller-initiated aborts (rapid filter/folder switching) are normal and not logged as errors.
    if (timedOut || !ctrl.signal.aborted) {
      sendPreloadLog({
        level: 'warn',
        scope: 'engine-http',
        category: 'error',
        event: timedOut ? 'engine_http_timeout' : 'engine_http_transport_error',
        meta: { method, path: pathnameOnly, durationMs, timeoutMs, requestId },
        error: {
          name: err instanceof Error ? err.name : 'Error',
          message: err instanceof Error ? err.message : String(err),
        },
      })
    }
    throw err
  } finally {
    clearTimeout(timer)
    inFlightRequests.delete(requestId)
  }
}

function emitSseMessage(
  eventName: string,
  dataLines: string[],
  onEvent: (event: EngineSseBridgeEvent) => void,
): 'message' {
  if (dataLines.length > 0) {
    onEvent({ type: 'message', event: eventName, data: dataLines.join('\n') })
  }
  return 'message'
}

async function readSseStream(
  body: ReadableStream<Uint8Array>,
  onEvent: (event: EngineSseBridgeEvent) => void,
  isCancelled: () => boolean,
): Promise<void> {
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  let eventName = 'message'
  let dataLines: string[] = []

  const processLine = (rawLine: string): void => {
    const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine
    if (line === '') {
      eventName = emitSseMessage(eventName, dataLines, onEvent)
      dataLines = []
      return
    }
    if (line.startsWith(':')) return
    const separator = line.indexOf(':')
    const field = separator === -1 ? line : line.slice(0, separator)
    const value =
      separator === -1
        ? ''
        : line.slice(separator + 1).startsWith(' ')
          ? line.slice(separator + 2)
          : line.slice(separator + 1)
    if (field === 'event') eventName = value || 'message'
    if (field === 'data') dataLines.push(value)
  }

  try {
    while (!isCancelled()) {
      const { value, done } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      const lines = buffer.split('\n')
      buffer = lines.pop() ?? ''
      for (const line of lines) {
        if (isCancelled()) break
        processLine(line)
      }
    }

    buffer += decoder.decode()
    if (!isCancelled() && buffer) processLine(buffer)
    if (!isCancelled()) emitSseMessage(eventName, dataLines, onEvent)
  } finally {
    await reader.cancel().catch(() => undefined)
    reader.releaseLock()
  }
}

function performEngineSseSubscribe(
  path: string,
  onEvent: (event: EngineSseBridgeEvent) => void,
): () => void {
  const ctrl = new AbortController()
  let cancelled = false

  void (async () => {
    try {
      const { url, token } = await ensureAuth()
      const enginePath = normalizeEnginePath(path)
      const headers = new Headers({ Accept: 'text/event-stream' })
      if (token) headers.set('Authorization', `Bearer ${token}`)
      const res = await fetch(`${url}${enginePath}`, {
        headers,
        signal: ctrl.signal,
      })
      if (res.status === 401) {
        invalidateAuthCache()
      }
      if (!res.ok) {
        await res.body?.cancel().catch(() => undefined)
        onEvent({ type: 'error', message: `SSE HTTP ${res.status}`, status: res.status })
        return
      }
      if (!res.body) {
        onEvent({ type: 'error', message: 'SSE response body is unavailable' })
        return
      }
      if (cancelled) {
        await res.body.cancel().catch(() => undefined)
        return
      }
      onEvent({ type: 'open' })
      await readSseStream(res.body, onEvent, () => cancelled)
      if (!cancelled) {
        onEvent({ type: 'error', message: 'SSE stream closed' })
      }
    } catch (error) {
      if (cancelled || ctrl.signal.aborted) return
      onEvent({
        type: 'error',
        message: error instanceof Error ? error.message : String(error),
      })
    }
  })()

  return () => {
    cancelled = true
    ctrl.abort()
  }
}

contextBridge.exposeInMainWorld('plumelens', {
  platform: process.platform,
  ...(benchmarkTraceEnabled && { benchmarkTraceEnabled }),
  getBackendUrl: (): Promise<string | null> => ipcRenderer.invoke('get-backend-url'),
  /**
   * Engine API 请求 — 在 preload 的 isolated world 内完成 fetch,token 不进
   * renderer JS。详见 H5 修复(security-batch-2)。
   */
  engineRequest: (
    path: string,
    init?: EngineRequestInit,
    receiveSummaryLine?: (line: string) => void,
  ): Promise<EngineResponse> => performEngineRequest(path, init, receiveSummaryLine),
  /** 取消在途的 engineRequest（配合 AbortSignal 避免快速切库/筛选堆积旧请求）。 */
  engineCancelRequest: (requestId: string): void => {
    if (typeof requestId === 'string' && requestId.length > 0) {
      cancelEngineRequest(requestId)
    }
  },
  /** 订阅 engine SSE — fetch stream 在 preload 内注入 Authorization,token 不进 renderer。 */
  engineSseSubscribe: (
    path: string,
    onEvent: (event: EngineSseBridgeEvent) => void,
  ): (() => void) => performEngineSseSubscribe(path, onEvent),
  getAppVersion: (): Promise<string> => ipcRenderer.invoke('get-app-version'),
  checkForUpdates: (): Promise<UpdateCheckResult> => ipcRenderer.invoke('check-for-updates'),
  openFolder: (): Promise<string | null> => ipcRenderer.invoke('dialog:open-folder'),
  selectExportDirectory: (): Promise<string | null> =>
    ipcRenderer.invoke('dialog:select-export-directory'),
  /** 打开 logs 目录 — 用户在 fatal 状态点 banner 或设置页触发,Finder/Explorer 弹窗。 */
  openLogsDir: (): Promise<string> => ipcRenderer.invoke('open-logs-dir'),
  /** 批量上报渲染进程结构化日志（单向非阻塞 IPC）。 */
  logBatch: (entries: RendererLogInput[]): void => {
    if (!Array.isArray(entries) || entries.length === 0) return
    ipcRenderer.send('client-log:batch', entries, 'renderer')
  },
  /** 查询日志开关、知情同意状态、设备标识与日志体积统计。 */
  getLoggingStatus: (): Promise<LoggingStatusSnapshot> => ipcRenderer.invoke('logs:get-status'),
  /** 记录首次启动时的日志授权选择并立即生效。 */
  setLoggingConsent: (enabled: boolean): Promise<LoggingStatusSnapshot> =>
    ipcRenderer.invoke('logs:set-consent', enabled),
  /** 设置页实时开启或关闭本地日志（无需重启引擎）。 */
  setLoggingEnabled: (enabled: boolean): Promise<LoggingStatusSnapshot> =>
    ipcRenderer.invoke('logs:set-enabled', enabled),
  /** 设置页切换日志级别（info / debug）。 */
  setLoggingLevel: (level: 'info' | 'debug'): Promise<LoggingStatusSnapshot> =>
    ipcRenderer.invoke('logs:set-level', level),
  /** 导出脱敏后的诊断日志 ZIP 包（含硬件配置、数据库摘要与任务耗时统计）。 */
  exportDiagnosticsBundle: (): Promise<ExportDiagnosticsResult> =>
    ipcRenderer.invoke('logs:export-bundle'),
  /** 清空历史日志文件。 */
  clearLogs: (): Promise<ClearLogsResult> => ipcRenderer.invoke('logs:clear'),
  /** 监听主进程日志状态变化（开关/级别/清理后同步 UI 与前端队列行为）。 */
  onLoggingStateChanged: (cb: (status: LoggingStatusSnapshot) => void): (() => void) => {
    const handler = (_event: unknown, status: LoggingStatusSnapshot): void => cb(status)
    ipcRenderer.on('logging-state-changed', handler)
    return (): void => {
      ipcRenderer.removeListener('logging-state-changed', handler)
    }
  },
  /** 在 Finder 中打开指定本地路径。 */
  openPathInFinder: (
    path: string,
  ): Promise<
    | { ok: true }
    | { ok: false; reason: 'invalid_path' | 'path_missing' | 'open_failed'; message?: string }
  > => ipcRenderer.invoke('open-path-in-finder', path),
  /** 用系统外部应用打开允许的 URL（地图 / Wikipedia / 项目 GitHub / 联系邮箱）。 */
  openExternalUrl: (
    url: string,
  ): Promise<
    { ok: true } | { ok: false; reason: 'invalid_url' | 'open_failed'; message?: string }
  > => ipcRenderer.invoke('open-external-url', url),
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
  }): Promise<
    | {
        ok: true
        settings: { amapKey?: string; baiduAk?: string; tencentKey?: string }
      }
    | { ok: false; reason: 'safe_storage_unavailable' | 'unknown'; message: string }
  > => ipcRenderer.invoke('save-user-settings', partial),
  /** 重启 engine 子进程 — settings 改后调使新 env 注入生效 */
  restartEngine: (): Promise<boolean> => ipcRenderer.invoke('restart-engine'),
  /** 用指定外部编辑器打开文件(Topaz 走 bundle executable,其他走系统 open)。 */
  openInEditor: (
    tool: 'topaz' | 'photoshop',
    path: string,
  ): Promise<{ ok: true; app: string } | { ok: false; reason: string }> => {
    if (!isEditorTool(tool) || typeof path !== 'string' || path.trim() === '') {
      return Promise.resolve({ ok: false, reason: 'invalid_args' })
    }
    return ipcRenderer.invoke('open-in-editor', { tool, path })
  },
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

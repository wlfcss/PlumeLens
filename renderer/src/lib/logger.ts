/**
 * 渲染进程结构化日志门面 — 批量经 preload IPC 上报主进程统一脱敏落盘。
 *
 * 特性：
 * - 完全向后兼容原有 `logger.debug/info/warn/error(...args)` 调用；
 * - 新增 `createLogger(scope)` 支持结构化事件名、上下文 meta 与性能指标；
 * - 内存队列批量上报（满 20 条或 500ms flush，error 立即 flush，pagehide 尽力 flush）；
 * - 5 秒滑窗同事件去重折叠，防止 SSE / 缩略图报错刷屏；
 * - Dev 态同步输出到 DevTools 控制台，并带 `[pl-log]` 前缀避免主进程 `console-message` 重复采集。
 */

import type {
  LogCategory,
  LogLevel,
  RendererLogInput,
  SerializedError,
} from '../../../shared/client-log'

const isDev = import.meta.env.DEV
const FLUSH_DELAY_MS = 500
const FLUSH_BATCH_SIZE = 20
const DEDUPE_WINDOW_MS = 5000
const DEDUPE_MAX_PER_WINDOW = 5

type LogArg = unknown

export interface ScopedRendererLogger {
  debug(event: string, meta?: Record<string, unknown>, error?: unknown): void
  info(event: string, meta?: Record<string, unknown>, error?: unknown): void
  warn(event: string, meta?: Record<string, unknown>, error?: unknown): void
  error(event: string, meta?: Record<string, unknown>, error?: unknown): void
  metric(event: string, meta: Record<string, unknown>): void
}

const queue: RendererLogInput[] = []
let flushTimer: ReturnType<typeof setTimeout> | null = null
let globalHooksInstalled = false

interface DedupeBucket {
  windowStart: number
  count: number
  suppressed: number
}
const dedupeMap = new Map<string, DedupeBucket>()

function toSerializedError(value: unknown): SerializedError | undefined {
  if (value === undefined || value === null) return undefined
  if (value instanceof Error) {
    const code = (value as Error & { code?: unknown }).code
    return {
      name: value.name || 'Error',
      message: value.message || String(value),
      ...(value.stack ? { stack: value.stack } : {}),
      ...(typeof code === 'string' || typeof code === 'number' ? { code } : {}),
    }
  }
  return {
    name: 'Error',
    message: typeof value === 'string' ? value : String(value),
  }
}

export function flushRendererLogs(): void {
  if (flushTimer !== null) {
    clearTimeout(flushTimer)
    flushTimer = null
  }
  if (queue.length === 0) return
  const batch = queue.splice(0, queue.length)
  if (typeof window !== 'undefined' && typeof window.plumelens?.logBatch === 'function') {
    try {
      window.plumelens.logBatch(batch)
    } catch {
      /* never break UI on logging IPC failure */
    }
  }
}

function enqueue(entry: RendererLogInput): void {
  // Error logs always bypass dedupe so no crash/failure is hidden.
  if (entry.level !== 'error') {
    const key = `${entry.scope}::${entry.event}`
    const now = Date.now()
    const bucket = dedupeMap.get(key)
    if (!bucket || now - bucket.windowStart >= DEDUPE_WINDOW_MS) {
      if (bucket && bucket.suppressed > 0) {
        queue.push({
          ts: new Date().toISOString(),
          level: 'warn',
          scope: entry.scope,
          category: 'general',
          event: `${entry.event} (suppressed ${bucket.suppressed} repeats)`,
        })
      }
      dedupeMap.set(key, { windowStart: now, count: 1, suppressed: 0 })
      if (dedupeMap.size > 100) {
        const oldest = dedupeMap.keys().next()
        if (!oldest.done) dedupeMap.delete(oldest.value)
      }
    } else {
      bucket.count += 1
      if (bucket.count > DEDUPE_MAX_PER_WINDOW) {
        bucket.suppressed += 1
        return
      }
    }
  }

  queue.push({
    ...entry,
    ts: entry.ts ?? new Date().toISOString(),
  })

  // Guard memory if IPC is unavailable (e.g. plain Vite browser dev mode).
  if (queue.length > 200) {
    queue.splice(0, queue.length - 200)
  }

  if (entry.level === 'error' || queue.length >= FLUSH_BATCH_SIZE) {
    flushRendererLogs()
    return
  }

  if (flushTimer === null) {
    flushTimer = setTimeout(() => {
      flushTimer = null
      flushRendererLogs()
    }, FLUSH_DELAY_MS)
  }
}

function mirrorToConsole(level: LogLevel, scope: string, event: string, rest: unknown[]): void {
  if (!isDev && level !== 'warn' && level !== 'error') return
  const prefix = `[pl-log][${scope}]`
  if (level === 'debug') console.debug(prefix, event, ...rest)
  else if (level === 'info') console.info(prefix, event, ...rest)
  else if (level === 'warn') console.warn(prefix, event, ...rest)
  else console.error(prefix, event, ...rest)
}

function emitStructured(
  level: LogLevel,
  scope: string,
  category: LogCategory,
  event: string,
  meta?: Record<string, unknown>,
  error?: unknown,
): void {
  const rest: unknown[] = []
  if (meta) rest.push(meta)
  if (error !== undefined) rest.push(error)
  mirrorToConsole(level, scope, event, rest)

  enqueue({
    level,
    scope,
    category,
    event,
    ...(meta ? { meta } : {}),
    ...(error !== undefined ? { error: toSerializedError(error) } : {}),
  })
}

export function createLogger(scope: string): ScopedRendererLogger {
  return {
    debug: (event, meta, error) => emitStructured('debug', scope, 'general', event, meta, error),
    info: (event, meta, error) => emitStructured('info', scope, 'general', event, meta, error),
    warn: (event, meta, error) => emitStructured('warn', scope, 'general', event, meta, error),
    error: (event, meta, error) => emitStructured('error', scope, 'error', event, meta, error),
    metric: (event, meta) => emitStructured('info', scope, 'ui_perf', event, meta),
  }
}

function emitLegacy(level: LogLevel, args: LogArg[]): void {
  if (args.length === 0) return
  const first = args[0]
  const event = typeof first === 'string' ? first : first instanceof Error ? first.message : String(first)
  let errorArg: unknown
  const extra: unknown[] = []
  for (let i = 1; i < args.length; i += 1) {
    const item = args[i]
    if (errorArg === undefined && item instanceof Error) {
      errorArg = item
    } else {
      extra.push(item)
    }
  }
  if (errorArg === undefined && first instanceof Error) {
    errorArg = first
  }
  const meta =
    extra.length === 1 && typeof extra[0] === 'object' && extra[0] !== null && !Array.isArray(extra[0])
      ? (extra[0] as Record<string, unknown>)
      : extra.length > 0
        ? { details: extra.map((item) => (typeof item === 'string' ? item : String(item))) }
        : undefined

  emitStructured(level, 'renderer', level === 'error' ? 'error' : 'general', event, meta, errorArg)
}

export const logger = {
  debug(...args: LogArg[]): void {
    emitLegacy('debug', args)
  },
  info(...args: LogArg[]): void {
    emitLegacy('info', args)
  },
  warn(...args: LogArg[]): void {
    emitLegacy('warn', args)
  },
  error(...args: LogArg[]): void {
    emitLegacy('error', args)
  },
}

/**
 * Install global uncaught error / promise rejection handlers and flush on unload.
 * Safe to call multiple times (idempotent).
 */
export function installGlobalErrorLogging(): void {
  if (globalHooksInstalled || typeof window === 'undefined') return
  globalHooksInstalled = true

  const globalLog = createLogger('window')

  window.addEventListener('error', (event) => {
    globalLog.error(
      'uncaught_window_error',
      {
        filename: event.filename ? event.filename.split('/').pop() : undefined,
        lineno: event.lineno,
        colno: event.colno,
      },
      event.error ?? event.message,
    )
  })

  window.addEventListener('unhandledrejection', (event) => {
    globalLog.error('unhandled_promise_rejection', undefined, event.reason)
  })

  window.addEventListener('pagehide', () => {
    flushRendererLogs()
  })
}

/** Test-only helper to reset in-memory dedupe/queue state. */
export function __resetRendererLoggerForTests(): void {
  if (flushTimer !== null) {
    clearTimeout(flushTimer)
    flushTimer = null
  }
  queue.length = 0
  dedupeMap.clear()
}

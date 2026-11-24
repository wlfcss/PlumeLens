/**
 * Unified Electron client logger (`{userData}/logs/client.jsonl`).
 *
 * Key properties:
 * - Zero disk writes while user consent is `unset` or `disabled`: startup
 *   events before the first-run consent prompt are buffered in memory (up to
 *   200 entries) and either flushed if the user opts in or dropped if declined.
 * - Buffered async disk writes with 5MB × 5 rotation, 14-day retention cleanup,
 *   and `0o600` file permissions.
 * - Synchronous `drainSync()` and `writeCrashDump()` for `before-quit`, `exit`,
 *   `uncaughtException`, and `render-process-gone` paths.
 * - Unclean shutdown marker (`.active-session.json`) to detect native OOM kills
 *   or hard crashes that bypass JS exception handlers.
 * - Disk-full / AV-lock resilience with backoff + dropped-entry counter.
 * - Renderer IPC rate limiting (token bucket).
 */

import { randomBytes } from 'crypto'
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'fs'
import { appendFile } from 'fs/promises'
import { join } from 'path'
import {
  CLIENT_LOG_LIMITS,
  isValidLogLevel,
  LOG_CONSENT_VERSION,
  shouldLogAtLevel,
  type ClientLogEntry,
  type LogCategory,
  type LoggingConsentState,
  type LogLevel,
  type LogProcess,
  type RendererLogInput,
} from '../shared/client-log'
import { redactText, sanitizeLogEntry, serializeError, type RedactorOptions } from './log-redactor'

const ACTIVE_SESSION_FILE = '.active-session.json'
const FLUSH_INTERVAL_MS = 350
const FLUSH_BUFFER_BYTES = 32 * 1024
const WRITE_BACKOFF_BASE_MS = 1000
const WRITE_BACKOFF_MAX_MS = 30_000

export interface ScopedLogger {
  debug(event: string, meta?: Record<string, unknown>, error?: unknown): void
  info(event: string, meta?: Record<string, unknown>, error?: unknown): void
  warn(event: string, meta?: Record<string, unknown>, error?: unknown): void
  error(event: string, meta?: Record<string, unknown>, error?: unknown): void
  metric(event: string, meta: Record<string, unknown>): void
}

export interface ClientLoggerOptions {
  logsDir: string
  sessionId?: string
  deviceId?: string | null
  consent?: LoggingConsentState
  enabled?: boolean
  level?: 'info' | 'debug'
  mirrorToStderr?: boolean
  maxFileBytes?: number
  maxBackups?: number
  retentionDays?: number
}

interface ActiveSessionMarker {
  sessionId: string
  deviceId: string | null
  startedAt: string
  pid: number
}

export class ClientLogger {
  private readonly logsDir: string
  private readonly crashDir: string
  private readonly logFilePath: string
  private readonly markerPath: string
  private readonly sessionId: string
  private readonly mirrorToStderr: boolean
  private readonly maxFileBytes: number
  private readonly maxBackups: number
  private readonly retentionDays: number

  private deviceId: string | null
  private consent: LoggingConsentState
  private enabled: boolean
  private level: 'info' | 'debug'
  private extraSecrets: string[] = []

  // Events captured before consent is resolved (only used while consent === 'unset').
  private preConsentBuffer: ClientLogEntry[] = []

  // Serialized JSONL lines queued for async disk flush.
  private pendingLines: string[] = []
  private pendingBytes = 0
  private flushTimer: ReturnType<typeof setTimeout> | null = null
  private flushPromise: Promise<void> | null = null

  // Write failure backoff state (disk full / AV lock).
  private writeBlockedUntil = 0
  private consecutiveWriteErrors = 0
  private droppedOnWriteError = 0

  // Renderer IPC rate-limiting window.
  private rateWindowStart = Date.now()
  private rateWindowCount = 0
  private rateWindowDropped = 0

  private markerWritten = false

  constructor(options: ClientLoggerOptions) {
    this.logsDir = options.logsDir
    this.crashDir = join(this.logsDir, 'crash')
    this.logFilePath = join(this.logsDir, 'client.jsonl')
    this.markerPath = join(this.logsDir, ACTIVE_SESSION_FILE)
    this.sessionId = options.sessionId ?? randomBytes(4).toString('hex')
    this.deviceId = options.deviceId ?? null
    this.consent = options.consent ?? 'unset'
    this.enabled = options.enabled ?? false
    this.level = options.level ?? 'info'
    this.mirrorToStderr = options.mirrorToStderr ?? false
    this.maxFileBytes = options.maxFileBytes ?? CLIENT_LOG_LIMITS.maxFileBytes
    this.maxBackups = options.maxBackups ?? CLIENT_LOG_LIMITS.maxBackups
    this.retentionDays = options.retentionDays ?? CLIENT_LOG_LIMITS.retentionDays

    if (this.enabled) {
      this.activateDiskLogging()
    }
  }

  getSessionId(): string {
    return this.sessionId
  }

  getDeviceId(): string | null {
    return this.deviceId
  }

  getLogsDir(): string {
    return this.logsDir
  }

  getConsent(): LoggingConsentState {
    return this.consent
  }

  isEnabled(): boolean {
    return this.enabled
  }

  getLevel(): 'info' | 'debug' {
    return this.level
  }

  setDeviceId(deviceId: string | null): void {
    this.deviceId = deviceId
    for (const item of this.preConsentBuffer) {
      if (item.deviceId === 'pending' && deviceId) {
        item.deviceId = deviceId
      }
    }
    if (this.enabled && this.markerWritten) {
      this.writeActiveSessionMarker()
    }
  }

  registerSecret(secret: string | null | undefined): void {
    if (!secret || secret.length < 6) return
    if (!this.extraSecrets.includes(secret)) {
      this.extraSecrets.push(secret)
    }
  }

  setLevel(level: 'info' | 'debug'): void {
    this.level = level
    if (this.enabled) {
      this.log({
        level: 'info',
        process: 'main',
        scope: 'logger',
        category: 'lifecycle',
        event: 'log_level_changed',
        meta: { level },
      })
    }
  }

  /**
   * Apply user consent or toggle logging on/off at runtime without restart.
   */
  configure(next: {
    consent?: LoggingConsentState
    enabled?: boolean
    level?: 'info' | 'debug'
  }): void {
    const wasEnabled = this.enabled
    if (next.consent !== undefined) this.consent = next.consent
    if (next.level !== undefined) this.level = next.level
    if (next.enabled !== undefined) this.enabled = next.enabled

    if (this.enabled && !wasEnabled) {
      this.activateDiskLogging()
      const buffered = this.preConsentBuffer.splice(0)
      for (const entry of buffered) {
        if (this.deviceId && entry.deviceId === 'pending') {
          entry.deviceId = this.deviceId
        }
        if (shouldLogAtLevel(entry.level, this.level)) {
          this.enqueueForDisk(entry)
        }
      }
      this.log({
        level: 'info',
        process: 'main',
        scope: 'logger',
        category: 'lifecycle',
        event: 'logging_enabled',
        meta: { level: this.level, consentVersion: LOG_CONSENT_VERSION },
      })
      this.drainSync()
      return
    }

    if (!this.enabled) {
      // Clear any pre-consent buffer so declined sessions never leak to disk later.
      this.preConsentBuffer = []
      if (wasEnabled) {
        this.logDirectToDisk({
          ts: new Date().toISOString(),
          level: 'info',
          deviceId: this.deviceId ?? 'unknown',
          sessionId: this.sessionId,
          process: 'main',
          scope: 'logger',
          category: 'lifecycle',
          event: 'logging_disabled',
        })
        this.drainSync()
        this.removeActiveSessionMarker()
      }
    }
  }

  private getRedactorOptions(): RedactorOptions {
    return {
      deviceId: this.deviceId,
      extraSecrets: this.extraSecrets,
    }
  }

  private ensureDirs(): boolean {
    try {
      mkdirSync(this.logsDir, { recursive: true })
      mkdirSync(this.crashDir, { recursive: true })
      return true
    } catch {
      return false
    }
  }

  private activateDiskLogging(): void {
    if (!this.ensureDirs()) return
    this.detectUncleanPreviousSession()
    this.writeActiveSessionMarker()
    this.pruneExpiredFiles()
  }

  private detectUncleanPreviousSession(): void {
    if (!existsSync(this.markerPath)) return
    try {
      const raw = JSON.parse(readFileSync(this.markerPath, 'utf-8')) as Partial<ActiveSessionMarker>
      if (raw.sessionId && raw.sessionId !== this.sessionId) {
        this.enqueueForDisk(
          sanitizeLogEntry(
            {
              ts: new Date().toISOString(),
              level: 'warn',
              deviceId: this.deviceId ?? raw.deviceId ?? 'unknown',
              sessionId: this.sessionId,
              process: 'main',
              scope: 'lifecycle',
              category: 'lifecycle',
              event: 'previous_session_unclean_exit',
              meta: {
                previousSessionId: raw.sessionId,
                previousStartedAt: raw.startedAt ?? null,
                previousPid: raw.pid ?? null,
              },
            },
            this.getRedactorOptions(),
          ),
        )
      }
    } catch {
      /* ignore corrupted marker */
    }
  }

  private writeActiveSessionMarker(): void {
    try {
      const marker: ActiveSessionMarker = {
        sessionId: this.sessionId,
        deviceId: this.deviceId,
        startedAt: new Date().toISOString(),
        pid: process.pid,
      }
      writeFileSync(this.markerPath, JSON.stringify(marker), { encoding: 'utf-8', mode: 0o600 })
      this.markerWritten = true
    } catch {
      /* ignore */
    }
  }

  private removeActiveSessionMarker(): void {
    this.markerWritten = false
    try {
      if (existsSync(this.markerPath)) unlinkSync(this.markerPath)
    } catch {
      /* ignore */
    }
  }

  private pruneExpiredFiles(): void {
    const cutoffMs = Date.now() - this.retentionDays * 24 * 60 * 60 * 1000
    try {
      for (const name of readdirSync(this.logsDir)) {
        if (name === 'client.jsonl' || name === 'engine.jsonl' || name === ACTIVE_SESSION_FILE) {
          continue
        }
        if (/^(client\.jsonl\.\d+|engine\.jsonl\.\d+|engine\.stderr\..+\.log|electron\.log(\.old)?)$/.test(name)) {
          const full = join(this.logsDir, name)
          try {
            const st = statSync(full)
            if (st.mtimeMs < cutoffMs) unlinkSync(full)
          } catch {
            /* ignore */
          }
        }
      }
      if (existsSync(this.crashDir)) {
        const crashFiles = readdirSync(this.crashDir)
          .filter((name) => /^(client|engine)-.+\.txt$/.test(name))
          .map((name) => {
            const full = join(this.crashDir, name)
            try {
              return { full, mtimeMs: statSync(full).mtimeMs }
            } catch {
              return null
            }
          })
          .filter((item): item is { full: string; mtimeMs: number } => item !== null)
          .sort((a, b) => b.mtimeMs - a.mtimeMs)

        for (let i = 0; i < crashFiles.length; i += 1) {
          const item = crashFiles[i]
          if (!item) continue
          if (i >= CLIENT_LOG_LIMITS.maxCrashFiles || item.mtimeMs < cutoffMs) {
            try {
              unlinkSync(item.full)
            } catch {
              /* ignore */
            }
          }
        }
      }
    } catch {
      /* ignore */
    }
  }

  child(scope: string, processKind: LogProcess = 'main'): ScopedLogger {
    return {
      debug: (event, meta, error) =>
        this.log({ level: 'debug', process: processKind, scope, event, meta, error }),
      info: (event, meta, error) =>
        this.log({ level: 'info', process: processKind, scope, event, meta, error }),
      warn: (event, meta, error) =>
        this.log({ level: 'warn', process: processKind, scope, event, meta, error }),
      error: (event, meta, error) =>
        this.log({
          level: 'error',
          process: processKind,
          scope,
          category: 'error',
          event,
          meta,
          error,
        }),
      metric: (event, meta) =>
        this.log({
          level: 'info',
          process: processKind,
          scope,
          category: 'task_metric',
          event,
          meta,
        }),
    }
  }

  log(input: {
    level: LogLevel
    process: LogProcess
    scope: string
    category?: LogCategory
    event: string
    meta?: Record<string, unknown>
    error?: unknown
    ts?: string
  }): void {
    const redactorOpts = this.getRedactorOptions()
    const entry = sanitizeLogEntry(
      {
        ts: input.ts ?? new Date().toISOString(),
        level: input.level,
        deviceId: this.deviceId ?? 'pending',
        sessionId: this.sessionId,
        process: input.process,
        scope: input.scope,
        category: input.category ?? (input.level === 'error' ? 'error' : 'general'),
        event: input.event,
        ...(input.meta ? { meta: input.meta } : {}),
        ...(input.error !== undefined ? { error: serializeError(input.error, redactorOpts) } : {}),
      },
      redactorOpts,
    )

    if (this.mirrorToStderr) {
      const metaText = entry.meta ? ` ${JSON.stringify(entry.meta)}` : ''
      const errText = entry.error ? ` err=${entry.error.name}:${entry.error.message}` : ''
      process.stderr.write(
        `[${entry.process}:${entry.scope}] ${entry.level.toUpperCase()} ${entry.event}${metaText}${errText}\n`,
      )
    }

    if (!this.enabled) {
      if (this.consent === 'unset') {
        this.preConsentBuffer.push(entry)
        if (this.preConsentBuffer.length > CLIENT_LOG_LIMITS.pendingBufferMax) {
          this.preConsentBuffer.shift()
        }
      }
      return
    }

    if (!shouldLogAtLevel(entry.level, this.level)) return

    this.enqueueForDisk(entry)
  }

  /**
   * Ingest a bounded batch from Renderer or Preload IPC with token-bucket throttling.
   */
  ingestBatch(entries: unknown, sourceProcess: LogProcess = 'renderer'): void {
    if (!Array.isArray(entries) || entries.length === 0) return
    if (!this.enabled && this.consent !== 'unset') return

    const now = Date.now()
    if (now - this.rateWindowStart >= 1000) {
      if (this.rateWindowDropped > 0 && this.enabled) {
        this.log({
          level: 'warn',
          process: 'main',
          scope: 'logger',
          category: 'general',
          event: 'renderer_log_rate_limited',
          meta: { dropped: this.rateWindowDropped, windowMs: now - this.rateWindowStart },
        })
      }
      this.rateWindowStart = now
      this.rateWindowCount = 0
      this.rateWindowDropped = 0
    }

    const bounded = entries.slice(0, CLIENT_LOG_LIMITS.maxBatchSize)
    for (const raw of bounded) {
      if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) continue
      const item = raw as Partial<RendererLogInput>
      const level: LogLevel = isValidLogLevel(item.level) ? item.level : 'info'

      // Always let error entries through even when info/warn flood hits the rate limit.
      if (level !== 'error' && this.rateWindowCount >= CLIENT_LOG_LIMITS.rendererRateLimitPerSec) {
        this.rateWindowDropped += 1
        continue
      }
      this.rateWindowCount += 1

      this.log({
        ts: typeof item.ts === 'string' && !Number.isNaN(Date.parse(item.ts)) ? item.ts : undefined,
        level,
        process: sourceProcess,
        scope: typeof item.scope === 'string' ? item.scope : sourceProcess,
        category: item.category,
        event: typeof item.event === 'string' ? item.event : 'log',
        meta:
          typeof item.meta === 'object' && item.meta !== null && !Array.isArray(item.meta)
            ? item.meta
            : undefined,
        error: item.error,
      })
    }
  }

  private enqueueForDisk(entry: ClientLogEntry): void {
    const line = `${JSON.stringify(entry)}\n`
    this.pendingLines.push(line)
    this.pendingBytes += Buffer.byteLength(line, 'utf-8')

    // Hard memory cap if disk writes are stalled for a long time.
    while (this.pendingLines.length > 2000) {
      const dropped = this.pendingLines.shift()
      if (dropped) this.pendingBytes -= Buffer.byteLength(dropped, 'utf-8')
      this.droppedOnWriteError += 1
    }

    if (entry.level === 'error' || this.pendingBytes >= FLUSH_BUFFER_BYTES) {
      void this.flush()
      return
    }
    if (!this.flushTimer) {
      this.flushTimer = setTimeout(() => {
        this.flushTimer = null
        void this.flush()
      }, FLUSH_INTERVAL_MS)
    }
  }

  private logDirectToDisk(entry: ClientLogEntry): void {
    this.enqueueForDisk(sanitizeLogEntry(entry, this.getRedactorOptions()))
  }

  private rotateIfNeededSync(): void {
    if (!existsSync(this.logFilePath)) return
    let size = 0
    try {
      size = statSync(this.logFilePath).size
    } catch {
      return
    }
    if (size < this.maxFileBytes) return

    for (let i = this.maxBackups - 1; i >= 1; i -= 1) {
      const src = i === 1 ? this.logFilePath : `${this.logFilePath}.${i - 1}`
      const dst = `${this.logFilePath}.${i}`
      if (!existsSync(src)) continue
      try {
        if (existsSync(dst)) unlinkSync(dst)
        renameSync(src, dst)
      } catch {
        /* best effort on Windows lock */
      }
    }
  }

  private scheduleFlush(delayMs = FLUSH_INTERVAL_MS): void {
    if (this.flushTimer) return
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null
      void this.flush()
    }, Math.max(0, delayMs))
  }

  async flush(): Promise<void> {
    if (this.flushPromise) return this.flushPromise
    if (this.pendingLines.length === 0) return
    const now = Date.now()
    if (now < this.writeBlockedUntil) {
      this.scheduleFlush(this.writeBlockedUntil - now)
      return
    }

    if (this.flushTimer) {
      clearTimeout(this.flushTimer)
      this.flushTimer = null
    }

    const lines = this.pendingLines.splice(0)
    const bytes = this.pendingBytes
    this.pendingBytes = 0

    if (this.droppedOnWriteError > 0) {
      const dropEntry = sanitizeLogEntry(
        {
          ts: new Date().toISOString(),
          level: 'warn',
          deviceId: this.deviceId ?? 'unknown',
          sessionId: this.sessionId,
          process: 'main',
          scope: 'logger',
          category: 'general',
          event: 'log_entries_dropped',
          meta: { dropped: this.droppedOnWriteError },
        },
        this.getRedactorOptions(),
      )
      lines.unshift(`${JSON.stringify(dropEntry)}\n`)
      this.droppedOnWriteError = 0
    }

    const run = (async () => {
      try {
        if (!this.ensureDirs()) throw new Error('logs directory unavailable')
        this.rotateIfNeededSync()
        await appendFile(this.logFilePath, lines.join(''), { encoding: 'utf-8', mode: 0o600 })
        this.consecutiveWriteErrors = 0
        this.writeBlockedUntil = 0
      } catch {
        // Back off on ENOSPC or Windows AV locks without throwing.
        this.consecutiveWriteErrors += 1
        const delay = Math.min(
          WRITE_BACKOFF_BASE_MS * 2 ** (this.consecutiveWriteErrors - 1),
          WRITE_BACKOFF_MAX_MS,
        )
        this.writeBlockedUntil = Date.now() + delay
        // Re-queue up to 500 recent lines; drop the rest.
        const keep = lines.slice(-500)
        this.droppedOnWriteError += Math.max(0, lines.length - keep.length)
        this.pendingLines.unshift(...keep)
        this.pendingBytes += Math.min(bytes, Buffer.byteLength(keep.join(''), 'utf-8'))
        this.scheduleFlush(delay)
      } finally {
        this.flushPromise = null
        if (this.pendingLines.length > 0 && Date.now() >= this.writeBlockedUntil) {
          this.scheduleFlush(FLUSH_INTERVAL_MS)
        }
      }
    })()

    this.flushPromise = run
    return run
  }

  /**
   * Async drain for IPC / graceful shutdown paths: awaits any in-flight async
   * write first so `clear` / `export` / `shutdown` never race with `appendFile`.
   */
  async drain(): Promise<void> {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer)
      this.flushTimer = null
    }
    if (this.flushPromise) {
      await this.flushPromise
    }
    if (this.pendingLines.length > 0 && Date.now() >= this.writeBlockedUntil) {
      await this.flush()
    }
  }

  /**
   * Synchronous drain for shutdown / uncaughtException paths.
   */
  drainSync(): void {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer)
      this.flushTimer = null
    }
    if (this.pendingLines.length === 0) return
    const payload = this.pendingLines.splice(0).join('')
    this.pendingBytes = 0
    try {
      if (!this.ensureDirs()) return
      this.rotateIfNeededSync()
      appendFileSync(this.logFilePath, payload, { encoding: 'utf-8', mode: 0o600 })
    } catch {
      /* best effort on shutdown */
    }
  }

  /**
   * Write a crash snapshot to `{logsDir}/crash/client-{ts}.txt` synchronously.
   */
  writeCrashDump(kind: string, details: string, extra?: Record<string, unknown>): string | null {
    if (!this.enabled) return null
    try {
      if (!this.ensureDirs()) return null
      const tsCompact = new Date().toISOString().replace(/[-:.]/g, '')
      const crashPath = join(this.crashDir, `client-${tsCompact}.txt`)
      const redactorOpts = this.getRedactorOptions()
      const header = [
        `# PlumeLens client crash @ ${new Date().toISOString()}`,
        `# DeviceId: ${this.deviceId ?? 'unknown'}`,
        `# SessionId: ${this.sessionId}`,
        `# Kind: ${kind}`,
        `# Platform: ${process.platform} ${process.arch}`,
        extra ? `# Meta: ${redactText(JSON.stringify(extra), redactorOpts)}` : null,
        '',
        redactText(details, redactorOpts),
        '',
      ]
        .filter((line): line is string => line !== null)
        .join('\n')
      writeFileSync(crashPath, header, { encoding: 'utf-8', mode: 0o600 })
      this.logDirectToDisk({
        ts: new Date().toISOString(),
        level: 'error',
        deviceId: this.deviceId ?? 'unknown',
        sessionId: this.sessionId,
        process: 'main',
        scope: 'crash',
        category: 'error',
        event: 'client_crash_recorded',
        meta: { kind, crashFile: `crash/client-${tsCompact}.txt`, ...(extra ?? {}) },
      })
      this.drainSync()
      return crashPath
    } catch {
      return null
    }
  }

  shutdownSync(reason = 'normal'): void {
    if (this.enabled) {
      this.logDirectToDisk({
        ts: new Date().toISOString(),
        level: 'info',
        deviceId: this.deviceId ?? 'unknown',
        sessionId: this.sessionId,
        process: 'main',
        scope: 'lifecycle',
        category: 'lifecycle',
        event: 'app_shutdown_complete',
        meta: { reason },
      })
      this.drainSync()
      this.removeActiveSessionMarker()
    } else if (this.flushTimer) {
      clearTimeout(this.flushTimer)
      this.flushTimer = null
    }
  }
}

let activeLogger: ClientLogger | null = null

export function initClientLogger(options: ClientLoggerOptions): ClientLogger {
  activeLogger = new ClientLogger(options)
  return activeLogger
}

export function getClientLogger(): ClientLogger | null {
  return activeLogger
}

/**
 * Convenience helper for modules that may run inside unit tests where the
 * Electron main singleton was not initialized.
 */
export function getScopedLogger(scope: string, processKind: LogProcess = 'main'): ScopedLogger {
  const instance = activeLogger
  if (instance) return instance.child(scope, processKind)
  const fallback = (level: LogLevel, event: string, meta?: Record<string, unknown>, error?: unknown): void => {
    if (level === 'warn' || level === 'error') {
      const detail = error instanceof Error ? error.message : error ? String(error) : ''
      const metaPart = meta ? ` ${JSON.stringify(meta)}` : ''
      process.stderr.write(`[${scope}] ${event}${metaPart}${detail ? ` ${detail}` : ''}\n`)
    }
  }
  return {
    debug: (event, meta, error) => fallback('debug', event, meta, error),
    info: (event, meta, error) => fallback('info', event, meta, error),
    warn: (event, meta, error) => fallback('warn', event, meta, error),
    error: (event, meta, error) => fallback('error', event, meta, error),
    metric: () => undefined,
  }
}

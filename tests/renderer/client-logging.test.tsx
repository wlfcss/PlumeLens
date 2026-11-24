/**
 * Comprehensive unit tests for the PlumeLens client logging & diagnostics module:
 * - Device ID derivation & deterministic filename anonymization
 * - Secret & path redaction (Bearer tokens, map API keys, homedir, photo paths)
 * - ClientLogger consent gate (zero disk writes before consent), rotation, crash dumps, unclean exit detection
 * - Dependency-free ZIP builder & diagnostics bundle export (with redacted summary & task metrics)
 * - Renderer logger batching & repeat-flood throttling
 * - LoggingConsentModal first-run Chinese prompt UI
 */
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { inflateRawSync } from 'zlib'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import '@/i18n'

import { anonymizeFileName, deriveDeviceId, resolveDeviceId } from '../../electron/device-id'
import { redactText, sanitizeLogEntry } from '../../electron/log-redactor'
import { ClientLogger } from '../../electron/logger'
import {
  buildAndWriteDiagnosticsZip,
  buildAndWriteDiagnosticsZipAsync,
  buildTaskMetricsSummary,
  clearLogFiles,
  getLogsStorageStats,
} from '../../electron/log-diagnostics'
import { buildZipArchive, buildZipArchiveAsync } from '../../electron/zip-writer'
import {
  __resetRendererLoggerForTests,
  createLogger,
  flushRendererLogs,
} from '@/lib/logger'
import { LoggingConsentModal } from '@/components/logging-consent-modal'

const tempDirs: string[] = []

function makeTempDir(prefix = 'plumelens-log-test-'): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  tempDirs.push(dir)
  return dir
}

/** Minimal ZIP reader helper to inspect entries written by `buildZipArchive`. */
function readZipEntries(buf: Buffer): Map<string, string> {
  const result = new Map<string, string>()
  let offset = 0
  while (offset + 30 <= buf.length && buf.readUInt32LE(offset) === 0x04034b50) {
    const method = buf.readUInt16LE(offset + 8)
    const compressedSize = buf.readUInt32LE(offset + 18)
    const nameLen = buf.readUInt16LE(offset + 26)
    const extraLen = buf.readUInt16LE(offset + 28)
    const nameStart = offset + 30
    const name = buf.subarray(nameStart, nameStart + nameLen).toString('utf-8')
    const dataStart = nameStart + nameLen + extraLen
    const rawData = buf.subarray(dataStart, dataStart + compressedSize)
    const content = method === 8 ? inflateRawSync(rawData).toString('utf-8') : rawData.toString('utf-8')
    result.set(name, content)
    offset = dataStart + compressedSize
  }
  return result
}

afterEach(() => {
  __resetRendererLoggerForTests()
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()
    if (dir && existsSync(dir)) {
      rmSync(dir, { recursive: true, force: true })
    }
  }
})

describe('device-id and filename anonymization', () => {
  it('derives deterministic device IDs without exposing raw machine code', () => {
    const id1 = deriveDeviceId('A1B2C3D4-E5F6-7890-ABCD-1234567890EF')
    const id2 = deriveDeviceId('a1b2c3d4-e5f6-7890-abcd-1234567890ef ')
    expect(id1).toBe(id2)
    expect(id1).toMatch(/^pl-[0-9a-f]{24}$/)
    expect(id1).not.toContain('a1b2c3d4')
  })

  it('anonymizes paired JPG and RAW filenames with matching deterministic stem', () => {
    const deviceId = 'pl-0123456789abcdef01234567'
    const jpg = anonymizeFileName('/Users/alice/Photos/2026/5Y3A7448.JPG', deviceId)
    const cr3 = anonymizeFileName('/Users/alice/Photos/2026/5Y3A7448.CR3', deviceId)
    expect(jpg).toMatch(/^f_[0-9a-f]{12}\.jpg$/)
    expect(cr3).toMatch(/^f_[0-9a-f]{12}\.cr3$/)
    expect(jpg.slice(0, 14)).toBe(cr3.slice(0, 14))
    expect(jpg).not.toContain('5Y3A7448')
    expect(jpg).not.toContain('alice')
  })

  it('persists and reuses probed machine ID in device-id.json', async () => {
    const userData = makeTempDir()
    const rec1 = await resolveDeviceId(userData, {
      probe: async () => ({ raw: 'TEST-UUID-9999', source: 'macos_ioreg' }),
      persist: true,
    })
    const rec2 = await resolveDeviceId(userData, {
      probe: async () => {
        throw new Error('should read from cache instead of probing again')
      },
      persist: true,
    })
    expect(rec1.deviceId).toBe(rec2.deviceId)
    expect(rec1.source).toBe('macos_ioreg')
  })
})

describe('log redactor', () => {
  it('redacts tokens, map API keys, homedir, and photo paths', () => {
    const deviceId = 'pl-abcdef0123456789abcdef01'
    const raw =
      'Authorization: Bearer super_secret_token_1234567890 ' +
      'url=https://restapi.amap.com/v3/geocode?key=AMAP_SECRET_KEY_99&location=120,31 ' +
      'file=/Users/birdwatcher/Pictures/trip/5Y3A9994.CR3'

    const clean = redactText(raw, {
      deviceId,
      homeDir: '/Users/birdwatcher',
      extraSecrets: ['AMAP_SECRET_KEY_99'],
    })

    expect(clean).not.toContain('super_secret_token_1234567890')
    expect(clean).not.toContain('AMAP_SECRET_KEY_99')
    expect(clean).not.toContain('birdwatcher')
    expect(clean).not.toContain('5Y3A9994')
    expect(clean).toContain('Bearer [REDACTED]')
    expect(clean).toMatch(/<photo>\/f_[0-9a-f]{12}\.cr3/)
  })

  it('handles circular references and sensitive keys in meta safely', () => {
    const circular: Record<string, unknown> = { amapKey: 'my-secret-key', ok: 1 }
    circular['self'] = circular
    const sanitized = sanitizeLogEntry({
      ts: '2026-11-24T15:00:00.000Z',
      level: 'info',
      deviceId: 'pl-111111111111111111111111',
      sessionId: 'abcd1234',
      process: 'main',
      scope: 'test',
      category: 'general',
      event: 'hello\nworld',
      meta: circular,
    })
    expect(sanitized.event).toBe('hello world')
    expect(sanitized.meta?.['amapKey']).toBe('[REDACTED]')
    expect(sanitized.meta?.['self']).toBe('[Circular]')
  })

  it('redacts Windows JSON-escaped paths, forward slashes, and paths with spaces', () => {
    const deviceId = 'pl-abcdef0123456789abcdef01'
    const raw = JSON.stringify({
      winEscaped: 'C:\\Users\\Alice\\Bird Photos\\IMG 001.CR3',
      winForward: 'C:/Users/Alice/My Shots/IMG_002.JPG',
      winHome: 'C:\\Users\\Alice\\AppData\\Local',
    })
    const clean = redactText(raw, { deviceId, homeDir: 'C:\\Users\\Alice' })
    expect(clean).not.toContain('Alice')
    expect(clean).not.toContain('Bird Photos')
    expect(clean).not.toContain('IMG 001')
    expect(clean).not.toContain('IMG_002')
    expect((clean.match(/<photo>\/f_[0-9a-f]{12}\./g) ?? []).length).toBe(2)
  })
})

describe('ClientLogger lifecycle, consent, rotation, and crash dumps', () => {
  it('does not write any files while consent is unset, then flushes buffered startup logs on opt-in', async () => {
    const logsDir = join(makeTempDir(), 'logs')
    const logger = new ClientLogger({
      logsDir,
      deviceId: 'pl-aaaaaaaaaaaaaaaaaaaaaaaa',
      consent: 'unset',
      enabled: false,
      level: 'info',
    })

    logger.child('main').info('early_startup_event', { step: 1 })
    await logger.flush()
    expect(existsSync(logsDir)).toBe(false)

    // Opt in -> buffered event is immediately persisted
    logger.configure({ consent: 'enabled', enabled: true, level: 'info' })
    logger.drainSync()
    const content = readFileSync(join(logsDir, 'client.jsonl'), 'utf-8')
    expect(content).toContain('early_startup_event')
    expect(content).toContain('logging_enabled')
  })

  it('drops pre-consent buffer when user declines logging', async () => {
    const logsDir = join(makeTempDir(), 'logs')
    const logger = new ClientLogger({
      logsDir,
      consent: 'unset',
      enabled: false,
    })

    logger.child('main').info('early_event_should_drop')
    logger.configure({ consent: 'disabled', enabled: false })
    await logger.flush()
    expect(existsSync(join(logsDir, 'client.jsonl'))).toBe(false)
  })

  it('rotates client.jsonl when exceeding maxFileBytes and detects unclean previous sessions', () => {
    const logsDir = join(makeTempDir(), 'logs')
    const logger1 = new ClientLogger({
      logsDir,
      sessionId: 'sess0001',
      deviceId: 'pl-bbbbbbbbbbbbbbbbbbbbbbbb',
      consent: 'enabled',
      enabled: true,
      maxFileBytes: 400,
      maxBackups: 3,
    })

    for (let i = 0; i < 12; i += 1) {
      logger1.child('test').info(`entry_${i}`, { payload: 'x'.repeat(80) })
      logger1.drainSync()
    }
    expect(existsSync(join(logsDir, 'client.jsonl.1'))).toBe(true)

    // Intentionally skip shutdownSync() to simulate an OOM / SIGKILL crash.
    const logger2 = new ClientLogger({
      logsDir,
      sessionId: 'sess0002',
      deviceId: 'pl-bbbbbbbbbbbbbbbbbbbbbbbb',
      consent: 'enabled',
      enabled: true,
    })
    logger2.drainSync()
    const content2 = readFileSync(join(logsDir, 'client.jsonl'), 'utf-8')
    expect(content2).toContain('previous_session_unclean_exit')
    expect(content2).toContain('sess0001')

    // Clean shutdown removes the active-session marker.
    logger2.shutdownSync('test_done')
    expect(existsSync(join(logsDir, '.active-session.json'))).toBe(false)
  })

  it('writes redacted crash dumps to crash/client-*.txt', () => {
    const logsDir = join(makeTempDir(), 'logs')
    const logger = new ClientLogger({
      logsDir,
      deviceId: 'pl-cccccccccccccccccccccccc',
      consent: 'enabled',
      enabled: true,
    })
    logger.registerSecret('SECRET_BEARER_TOKEN_XYZ')
    const crashPath = logger.writeCrashDump(
      'uncaught_exception',
      'Boom with token SECRET_BEARER_TOKEN_XYZ on /Users/bob/IMG_0001.CR3',
    )
    expect(crashPath).not.toBeNull()
    const dumpText = readFileSync(crashPath!, 'utf-8')
    expect(dumpText).not.toContain('SECRET_BEARER_TOKEN_XYZ')
    expect(dumpText).not.toContain('IMG_0001')
    expect(dumpText).not.toContain('/Users/bob')
    expect(dumpText).toContain('[REDACTED]')
  })

  it('awaits in-flight async flush cleanly via drain()', async () => {
    const logsDir = join(makeTempDir(), 'logs')
    const logger = new ClientLogger({
      logsDir,
      deviceId: 'pl-eeeeeeeeeeeeeeeeeeeeeeee',
      consent: 'enabled',
      enabled: true,
    })
    logger.child('test').info('queued_before_drain', { seq: 1 })
    void logger.flush()
    logger.child('test').info('queued_during_flush', { seq: 2 })
    await logger.drain()

    const content = readFileSync(join(logsDir, 'client.jsonl'), 'utf-8')
    expect(content).toContain('queued_before_drain')
    expect(content).toContain('queued_during_flush')
  })
})

describe('ZIP builder and diagnostics bundle export', () => {
  it('builds a valid ZIP archive and exports redacted logs, summaries, and metrics', () => {
    const userDataDir = makeTempDir()
    const logsDir = join(userDataDir, 'logs')
    const logger = new ClientLogger({
      logsDir,
      deviceId: 'pl-dddddddddddddddddddddddd',
      sessionId: 'sess9999',
      consent: 'enabled',
      enabled: true,
    })
    logger.child('main').info('app_ready', { version: '0.7.9' })
    logger.drainSync()

    // Seed an engine.jsonl with a photo_analysis_done metric & a secret to verify redaction.
    writeFileSync(
      join(logsDir, 'engine.jsonl'),
      `${JSON.stringify({
        timestamp: '2026-11-24T15:00:01.000Z',
        level: 'info',
        event: 'photo_analysis_done',
        category: 'task_metric',
        from_cache: false,
        file: {
          name: 'f_1234567890ab.cr3',
          format: 'cr3',
          camera_model: 'Canon EOS R5',
          companion_used: false,
        },
        stages_ms: { load_decode: 180.5, yolo: 95.2, species: 60.1, total: 420.0 },
        outcome: { bird_count: 1, grade: 'select', yolo_cpu_fallback: false },
      })}\n` +
        `${JSON.stringify({
          timestamp: '2026-11-24T15:00:02.000Z',
          level: 'warning',
          event: 'leaked Bearer MY_ONE_TIME_TOKEN_9876543210',
        })}\n`,
      'utf-8',
    )

    const outZip = join(userDataDir, 'diagnostics.zip')
    const exported = buildAndWriteDiagnosticsZip({
      outputPath: outZip,
      logsDir,
      userDataDir,
      deviceId: 'pl-dddddddddddddddddddddddd',
      sessionId: 'sess9999',
      loggingEnabled: true,
      profile: null,
      dbSummary: { libraries: { total: 2 }, photos: { total: 100 }, db_size_bytes: 102400 },
      extraSecrets: ['MY_ONE_TIME_TOKEN_9876543210'],
    })

    expect(exported.sizeBytes).toBeGreaterThan(0)
    const entries = readZipEntries(readFileSync(outZip))
    expect(entries.has('SUMMARY.txt')).toBe(true)
    expect(entries.has('manifest.json')).toBe(true)
    expect(entries.has('db-summary.json')).toBe(true)
    expect(entries.has('task-metrics-summary.json')).toBe(true)
    expect(entries.has('logs/client.jsonl')).toBe(true)
    expect(entries.has('logs/engine.jsonl')).toBe(true)

    const engineExported = entries.get('logs/engine.jsonl') ?? ''
    expect(engineExported).not.toContain('MY_ONE_TIME_TOKEN_9876543210')
    expect(engineExported).toContain('Bearer [REDACTED]')

    const metricsSummary = JSON.parse(entries.get('task-metrics-summary.json') ?? '{}')
    expect(metricsSummary.photoAnalysis.totalEvents).toBe(1)
    expect(metricsSummary.photoAnalysis.formats.cr3).toBe(1)
    expect(metricsSummary.photoAnalysis.stagesMs.total.p50).toBe(420)

    const statsBefore = getLogsStorageStats(logsDir)
    expect(statsBefore.fileCount).toBeGreaterThanOrEqual(2)
    const cleared = clearLogFiles(logsDir)
    expect(cleared.ok).toBe(true)
    expect(getLogsStorageStats(logsDir).fileCount).toBe(0)
  })

  it('compresses and round-trips UTF-8 filenames in buildZipArchive and buildZipArchiveAsync', async () => {
    const payload = '鉴翎日志测试内容'.repeat(20)
    const zipSync = buildZipArchive([{ name: '摘要/说明.txt', data: payload }])
    const zipAsync = await buildZipArchiveAsync([{ name: '摘要/说明.txt', data: payload }])
    expect(readZipEntries(zipSync).get('摘要/说明.txt')).toBe(payload)
    expect(readZipEntries(zipAsync).get('摘要/说明.txt')).toBe(payload)

    const userDataDir = makeTempDir()
    const logsDir = join(userDataDir, 'logs')
    const outZip = join(userDataDir, 'async-diag.zip')
    const res = await buildAndWriteDiagnosticsZipAsync({
      outputPath: outZip,
      logsDir,
      userDataDir,
      deviceId: 'pl-1234567890abcdef12345678',
      sessionId: 'sess_async',
      loggingEnabled: true,
      profile: null,
      dbSummary: { libraries: { total: 1 }, photos: { total: 10 }, db_size_bytes: 4096 },
    })
    expect(res.sizeBytes).toBeGreaterThan(0)
    const entries = readZipEntries(readFileSync(outZip))
    expect(entries.has('SUMMARY.txt')).toBe(true)
    expect(entries.has('manifest.json')).toBe(true)
  })

  it('aggregates task metrics percentiles correctly', () => {
    const lines = [100, 200, 300, 400, 1000].map((total) =>
      JSON.stringify({
        event: 'photo_analysis_done',
        level: 'info',
        from_cache: false,
        stages_ms: { total },
      }),
    )
    const summary = buildTaskMetricsSummary([lines.join('\n')])
    expect(summary.photoAnalysis.stagesMs.total.count).toBe(5)
    expect(summary.photoAnalysis.stagesMs.total.p50).toBe(300)
    expect(summary.photoAnalysis.stagesMs.total.max).toBe(1000)
  })
})

describe('renderer logger batching and throttling', () => {
  it('flushes errors immediately and throttles repeated non-error floods', () => {
    const logBatch = vi.fn()
    const prev = window.plumelens
    window.plumelens = { ...(prev ?? ({} as NonNullable<typeof prev>)), logBatch }

    try {
      const log = createLogger('sse')
      for (let i = 0; i < 12; i += 1) {
        log.warn('stream_retry', { attempt: i })
      }
      flushRendererLogs()
      expect(logBatch).toHaveBeenCalledTimes(1)
      const firstBatch = logBatch.mock.calls[0]?.[0] as unknown[]
      expect(firstBatch.length).toBe(5)

      log.error('fatal_render_crash', { route: 'selection' }, new Error('boom'))
      expect(logBatch).toHaveBeenCalledTimes(2)
    } finally {
      window.plumelens = prev
    }
  })
})

describe('LoggingConsentModal', () => {
  it('shows first-run Chinese consent dialog and invokes setLoggingConsent on choice', async () => {
    const origShowModal = HTMLDialogElement.prototype.showModal
    const origClose = HTMLDialogElement.prototype.close
    HTMLDialogElement.prototype.showModal = function showModal() {
      this.setAttribute('open', '')
    }
    HTMLDialogElement.prototype.close = function close() {
      this.removeAttribute('open')
    }

    const setLoggingConsent = vi.fn().mockResolvedValue({ enabled: true, needsConsentPrompt: false })
    const getLoggingStatus = vi.fn().mockResolvedValue({
      consent: 'unset',
      consentVersion: 0,
      enabled: false,
      level: 'info',
      deviceId: null,
      sessionId: 'sess1',
      logsDir: '/tmp/logs',
      totalBytes: 0,
      fileCount: 0,
      crashCount: 0,
      needsConsentPrompt: true,
    })

    const prev = window.plumelens
    window.plumelens = {
      ...(prev ?? ({} as NonNullable<typeof prev>)),
      getLoggingStatus,
      setLoggingConsent,
    }

    try {
      render(<LoggingConsentModal />)
      await waitFor(() => {
        expect(screen.getByText('开启本地运行日志，方便排查异常？')).toBeInTheDocument()
      })
      fireEvent.click(screen.getByRole('button', { name: '开启本地日志（推荐）' }))
      await waitFor(() => {
        expect(setLoggingConsent).toHaveBeenCalledWith(true)
      })
    } finally {
      window.plumelens = prev
      HTMLDialogElement.prototype.showModal = origShowModal
      HTMLDialogElement.prototype.close = origClose
    }
  })
})

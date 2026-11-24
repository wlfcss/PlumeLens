/**
 * Diagnostics bundle builder, log storage statistics, and cleanup utilities.
 *
 * Produces a self-contained, redacted ZIP archive containing:
 * - `SUMMARY.txt`                Human-readable Chinese overview
 * - `manifest.json`              Export metadata & included file listing
 * - `system-profile.json`        Full hardware/disk/CPU/memory/GPU + AI runtime snapshot
 * - `db-summary.json`            Redacted database aggregate metrics (no paths/filenames/GPS)
 * - `task-metrics-summary.json`  Aggregated stage timings (P50/P95/Max) & file format stats
 * - `logs/client.jsonl` (+ .1)   Unified Main/Preload/Renderer structured logs
 * - `logs/engine.jsonl` (+ .1)   Python backend structured logs
 * - `logs/engine.stderr.*.log`   Up to 3 most recent raw engine stderr logs
 * - `crash/*`                    Up to 5 recent client + 5 recent engine crash dumps
 */

import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'fs'
import { dirname, join } from 'path'
import type {
  ClearLogsResult,
  SystemProfileSnapshot,
} from '../shared/client-log'
import { redactText, type RedactorOptions } from './log-redactor'
import { buildZipArchive, type ZipEntryInput } from './zip-writer'

const MAX_LOG_FILE_EXPORT_BYTES = 8 * 1024 * 1024 // 8 MB tail per log file
const MAX_STDERR_LOGS_EXPORT = 3
const MAX_CRASH_FILES_PER_KIND = 5

export interface LogsStorageStats {
  totalBytes: number
  fileCount: number
  crashCount: number
}

export function getLogsStorageStats(logsDir: string): LogsStorageStats {
  if (!existsSync(logsDir)) {
    return { totalBytes: 0, fileCount: 0, crashCount: 0 }
  }
  let totalBytes = 0
  let fileCount = 0
  let crashCount = 0

  const walk = (dir: string, isCrashDir: boolean): void => {
    let entries: string[]
    try {
      entries = readdirSync(dir)
    } catch {
      return
    }
    for (const name of entries) {
      if (name === '.active-session.json') continue
      const full = join(dir, name)
      try {
        const st = statSync(full)
        if (st.isDirectory()) {
          walk(full, isCrashDir || name === 'crash')
        } else if (st.isFile()) {
          totalBytes += st.size
          fileCount += 1
          if (isCrashDir) crashCount += 1
        }
      } catch {
        /* ignore disappearing files */
      }
    }
  }

  walk(logsDir, false)
  return { totalBytes, fileCount, crashCount }
}

export function clearLogFiles(logsDir: string): ClearLogsResult {
  if (!existsSync(logsDir)) {
    return { ok: true, freedBytes: 0, removedFiles: 0 }
  }
  let freedBytes = 0
  let removedFiles = 0

  const removeInDir = (dir: string): void => {
    let entries: string[]
    try {
      entries = readdirSync(dir)
    } catch {
      return
    }
    for (const name of entries) {
      if (name === '.active-session.json') continue
      const full = join(dir, name)
      try {
        const st = statSync(full)
        if (st.isDirectory()) {
          removeInDir(full)
        } else if (st.isFile()) {
          const size = st.size
          unlinkSync(full)
          freedBytes += size
          removedFiles += 1
        }
      } catch {
        /* file may be locked on Windows; skip */
      }
    }
  }

  try {
    removeInDir(logsDir)
    return { ok: true, freedBytes, removedFiles }
  } catch (err) {
    return {
      ok: false,
      reason: 'clear_failed',
      message: err instanceof Error ? err.message : String(err),
    }
  }
}

function readTailUtf8(filePath: string, maxBytes = MAX_LOG_FILE_EXPORT_BYTES): {
  text: string
  truncated: boolean
  originalBytes: number
} {
  const st = statSync(filePath)
  const originalBytes = st.size
  if (originalBytes <= maxBytes) {
    return {
      text: readFileSync(filePath, 'utf-8'),
      truncated: false,
      originalBytes,
    }
  }
  const fd = openSync(filePath, 'r')
  try {
    const start = originalBytes - maxBytes
    const buf = Buffer.alloc(maxBytes)
    const bytesRead = readSync(fd, buf, 0, maxBytes, start)
    let text = buf.subarray(0, bytesRead).toString('utf-8')
    const firstNewline = text.indexOf('\n')
    if (firstNewline !== -1) {
      text = text.slice(firstNewline + 1)
    }
    return { text, truncated: true, originalBytes }
  } finally {
    closeSync(fd)
  }
}

function percentile(sorted: number[], p: number): number | null {
  if (sorted.length === 0) return null
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1))
  const val = sorted[idx]
  return val !== undefined ? Math.round(val * 10) / 10 : null
}

function summarizeSeries(values: number[]): {
  count: number
  p50: number | null
  p95: number | null
  max: number | null
  avg: number | null
} {
  if (values.length === 0) {
    return { count: 0, p50: null, p95: null, max: null, avg: null }
  }
  const sorted = [...values].sort((a, b) => a - b)
  const sum = sorted.reduce((acc, v) => acc + v, 0)
  return {
    count: sorted.length,
    p50: percentile(sorted, 50),
    p95: percentile(sorted, 95),
    max: Math.round((sorted[sorted.length - 1] ?? 0) * 10) / 10,
    avg: Math.round((sum / sorted.length) * 10) / 10,
  }
}

export interface TaskMetricsSummary {
  generatedAt: string
  photoAnalysis: {
    totalEvents: number
    cacheHits: number
    failures: number
    companionFallbacks: number
    yoloCpuFallbacks: number
    formats: Record<string, number>
    cameras: Record<string, number>
    stagesMs: Record<
      string,
      { count: number; p50: number | null; p95: number | null; max: number | null; avg: number | null }
    >
  }
  recentAnalysisRuns: Array<Record<string, unknown>>
  recentScans: Array<Record<string, unknown>>
  recentThumbnails: Array<Record<string, unknown>>
  recentExports: Array<Record<string, unknown>>
  recentStartups: Array<Record<string, unknown>>
  topErrors: Array<{ event: string; count: number }>
}

export function buildTaskMetricsSummary(jsonlTexts: string[]): TaskMetricsSummary {
  const stageBuckets = new Map<string, number[]>()
  const formats: Record<string, number> = {}
  const cameras: Record<string, number> = {}
  const errorCounts = new Map<string, number>()

  let totalPhotoEvents = 0
  let cacheHits = 0
  let photoFailures = 0
  let companionFallbacks = 0
  let yoloCpuFallbacks = 0

  const recentAnalysisRuns: Array<Record<string, unknown>> = []
  const recentScans: Array<Record<string, unknown>> = []
  const recentThumbnails: Array<Record<string, unknown>> = []
  const recentExports: Array<Record<string, unknown>> = []
  const recentStartups: Array<Record<string, unknown>> = []

  const addStage = (name: string, val: unknown): void => {
    if (typeof val !== 'number' || !Number.isFinite(val) || val < 0) return
    let arr = stageBuckets.get(name)
    if (!arr) {
      arr = []
      stageBuckets.set(name, arr)
    }
    arr.push(val)
  }

  for (const text of jsonlTexts) {
    for (const line of text.split('\n')) {
      const trimmed = line.trim()
      if (!trimmed || !trimmed.startsWith('{')) continue
      let rec: Record<string, unknown>
      try {
        rec = JSON.parse(trimmed) as Record<string, unknown>
      } catch {
        continue
      }

      const event = typeof rec['event'] === 'string' ? rec['event'] : ''
      const level = typeof rec['level'] === 'string' ? rec['level'].toLowerCase() : ''

      if (level === 'error') {
        const key = event || 'unknown_error'
        errorCounts.set(key, (errorCounts.get(key) ?? 0) + 1)
      }

      if (event === 'photo_analysis_done' || event === 'photo_analysis_failed') {
        totalPhotoEvents += 1
        if (event === 'photo_analysis_failed') photoFailures += 1
        if (rec['from_cache'] === true) cacheHits += 1

        const file = rec['file'] as Record<string, unknown> | undefined
        if (file) {
          const fmt = typeof file['format'] === 'string' ? file['format'].toLowerCase() : null
          if (fmt) formats[fmt] = (formats[fmt] ?? 0) + 1
          if (file['companion_used'] === true) companionFallbacks += 1
          const camModel =
            typeof file['camera_model'] === 'string' && file['camera_model'].trim()
              ? file['camera_model'].trim()
              : null
          if (camModel) cameras[camModel] = (cameras[camModel] ?? 0) + 1
        }

        const outcome = rec['outcome'] as Record<string, unknown> | undefined
        if (outcome?.['yolo_cpu_fallback'] === true) yoloCpuFallbacks += 1

        const stages = rec['stages_ms'] as Record<string, unknown> | undefined
        if (stages) {
          for (const [k, v] of Object.entries(stages)) {
            addStage(k, v)
          }
        }
      } else if (event === 'Pipeline timing') {
        // Backwards compatibility with legacy timing entries already on disk
        totalPhotoEvents += 1
        addStage('load_decode', rec['load_ms'])
        addStage('yolo', rec['yolo_ms'])
        addStage('pose', rec['pose_ms'])
        addStage('iqa', rec['iqa_ms'])
        addStage('species', rec['species_ms'])
      } else if (event === 'analysis_run_summary') {
        recentAnalysisRuns.push(rec)
        if (recentAnalysisRuns.length > 20) recentAnalysisRuns.shift()
      } else if (event === 'library_scan_done') {
        recentScans.push(rec)
        if (recentScans.length > 20) recentScans.shift()
      } else if (event === 'thumbnail_batch_done') {
        recentThumbnails.push(rec)
        if (recentThumbnails.length > 20) recentThumbnails.shift()
      } else if (event === 'export_job_done' || event === 'export_job_failed') {
        recentExports.push(rec)
        if (recentExports.length > 20) recentExports.shift()
      } else if (event === 'engine_startup_timing' || event === 'app_startup_ready') {
        recentStartups.push(rec)
        if (recentStartups.length > 10) recentStartups.shift()
      }
    }
  }

  const stagesMs: TaskMetricsSummary['photoAnalysis']['stagesMs'] = {}
  for (const [k, vals] of stageBuckets.entries()) {
    stagesMs[k] = summarizeSeries(vals)
  }

  const topErrors = [...errorCounts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 15)
    .map(([event, count]) => ({ event, count }))

  return {
    generatedAt: new Date().toISOString(),
    photoAnalysis: {
      totalEvents: totalPhotoEvents,
      cacheHits,
      failures: photoFailures,
      companionFallbacks,
      yoloCpuFallbacks,
      formats,
      cameras,
      stagesMs,
    },
    recentAnalysisRuns,
    recentScans,
    recentThumbnails,
    recentExports,
    recentStartups,
    topErrors,
  }
}

function formatGiB(bytes: number | null | undefined): string {
  if (typeof bytes !== 'number' || !Number.isFinite(bytes)) return '未知'
  return `${(bytes / 1024 ** 3).toFixed(1)} GB`
}

function buildHumanSummaryText(params: {
  deviceId: string
  sessionId: string
  exportedAt: string
  loggingEnabled: boolean
  profile: SystemProfileSnapshot | null
  dbSummary: Record<string, unknown> | null
  metrics: TaskMetricsSummary
  includedFiles: string[]
}): string {
  const { profile, metrics, dbSummary } = params
  const lines: string[] = [
    '============================================================',
    '  鉴翎 (PlumeLens) 诊断日志包摘要',
    '============================================================',
    `导出时间: ${params.exportedAt}`,
    `设备标识: ${params.deviceId}`,
    `会话标识: ${params.sessionId}`,
    `日志开关: ${params.loggingEnabled ? '已开启' : '已关闭'}`,
    '',
  ]

  if (profile) {
    lines.push('【硬件与运行环境】')
    lines.push(
      `应用版本: ${profile.app.version} (Electron ${profile.app.electron} / packaged=${profile.app.isPackaged})`,
    )
    lines.push(`操作系统: ${profile.os.platform} ${profile.os.version} (${profile.os.arch})`)
    lines.push(
      `处理器  : ${profile.cpu.model} (${profile.cpu.logicalCores} 逻辑核${
        profile.cpu.physicalCores ? ` / ${profile.cpu.physicalCores} 物理核` : ''
      }${
        profile.cpu.performanceCores
          ? ` [P:${profile.cpu.performanceCores} + E:${profile.cpu.efficiencyCores ?? 0}]`
          : ''
      })`,
    )
    lines.push(
      `内存    : 共 ${formatGiB(profile.memory.totalBytes)}，当前可用 ${formatGiB(profile.memory.freeBytes)} (${
        profile.memory.usedPercent
      }% 已用)${profile.memory.unifiedMemory ? ' [统一内存]' : ''}`,
    )
    for (const gpu of profile.gpus) {
      lines.push(
        `显卡    : ${gpu.name}${gpu.cores ? ` (${gpu.cores} 核)` : ''}${
          gpu.vramBytes ? ` · 显存 ${formatGiB(gpu.vramBytes)}` : ''
        }${gpu.driverVersion ? ` · 驱动 ${gpu.driverVersion}` : ''}`,
      )
    }
    for (const disk of profile.disks) {
      const label = disk.role === 'app_install' ? '程序所在盘' : disk.role === 'user_data' ? '数据缓存盘' : '图库盘'
      lines.push(
        `${label}: ${disk.mountPoint ?? '未知'} [${disk.filesystem ?? '?'} / ${disk.mediaType}${
          disk.busProtocol ? ` / ${disk.busProtocol}` : ''
        }] 可用 ${formatGiB(disk.availableBytes)} / 共 ${formatGiB(disk.totalBytes)}`,
      )
    }
    lines.push('')
  }

  if (dbSummary) {
    const photos = dbSummary['photos'] as Record<string, unknown> | undefined
    const libs = dbSummary['libraries'] as Record<string, unknown> | undefined
    lines.push('【本地数据库摘要（已脱敏）】')
    if (dbSummary['engine_unreachable']) {
      lines.push('后端引擎当前不可达，仅统计本地文件体积。')
    } else {
      lines.push(
        `图库数: ${libs?.['total'] ?? '--'} | 照片总数: ${photos?.['total'] ?? '--'} | DB 体积: ${formatGiB(
          typeof dbSummary['db_size_bytes'] === 'number' ? dbSummary['db_size_bytes'] : null,
        )}`,
      )
    }
    lines.push('')
  }

  lines.push('【任务耗时统计】')
  lines.push(
    `单张分析样本: ${metrics.photoAnalysis.totalEvents} 条 (缓存命中 ${metrics.photoAnalysis.cacheHits}, 失败 ${metrics.photoAnalysis.failures}, YOLO CPU 回退 ${metrics.photoAnalysis.yoloCpuFallbacks})`,
  )
  const totalStage = metrics.photoAnalysis.stagesMs['total']
  if (totalStage && totalStage.count > 0) {
    lines.push(
      `单张总耗时  : P50=${totalStage.p50}ms | P95=${totalStage.p95}ms | Max=${totalStage.max}ms`,
    )
  }
  const stageKeys = ['load_decode', 'yolo', 'pose', 'flight', 'clipiqa', 'hyperiqa', 'species']
  const parts: string[] = []
  for (const key of stageKeys) {
    const stat = metrics.photoAnalysis.stagesMs[key]
    if (stat && stat.p50 !== null) {
      parts.push(`${key}=${stat.p50}/${stat.p95}ms`)
    }
  }
  if (parts.length > 0) {
    lines.push(`各节点 P50/P95: ${parts.join(' | ')}`)
  }
  if (metrics.topErrors.length > 0) {
    lines.push('近期高频错误:')
    for (const item of metrics.topErrors.slice(0, 5)) {
      lines.push(`  - ${item.event}: ${item.count} 次`)
    }
  }
  lines.push('')
  lines.push(`【压缩包内文件 (${params.includedFiles.length} 个)】`)
  for (const f of params.includedFiles) {
    lines.push(`  - ${f}`)
  }
  lines.push('')
  lines.push('隐私声明：本日志包已对照片文件名进行哈希匿名，已清除本地路径、令牌及地图密钥，不含照片原图。')
  return `${lines.join('\n')}\n`
}

export interface ExportBundleParams {
  outputPath: string
  logsDir: string
  userDataDir: string
  deviceId: string
  sessionId: string
  loggingEnabled: boolean
  profile: SystemProfileSnapshot | null
  dbSummary: Record<string, unknown> | null
  extraSecrets?: string[]
}

export function buildAndWriteDiagnosticsZip(params: ExportBundleParams): {
  sizeBytes: number
  fileCount: number
} {
  const exportedAt = new Date().toISOString()
  const redactorOpts: RedactorOptions = {
    deviceId: params.deviceId,
    extraSecrets: params.extraSecrets,
  }

  const zipEntries: ZipEntryInput[] = []
  const fileManifest: Array<{ path: string; truncated?: boolean; originalBytes?: number }> = []
  const jsonlTextsForMetrics: string[] = []

  const addRedactedTextFile = (
    archivePath: string,
    diskPath: string,
    collectForMetrics = false,
  ): void => {
    if (!existsSync(diskPath)) return
    try {
      const { text, truncated, originalBytes } = readTailUtf8(diskPath)
      const clean = redactText(text, redactorOpts)
      if (collectForMetrics) jsonlTextsForMetrics.push(clean)
      zipEntries.push({ name: archivePath, data: clean })
      fileManifest.push({ path: archivePath, truncated, originalBytes })
    } catch {
      /* skip unreadable file */
    }
  }

  // 1. Primary structured logs (current + most recent backup)
  addRedactedTextFile('logs/client.jsonl', join(params.logsDir, 'client.jsonl'), true)
  addRedactedTextFile('logs/client.jsonl.1', join(params.logsDir, 'client.jsonl.1'), true)
  addRedactedTextFile('logs/engine.jsonl', join(params.logsDir, 'engine.jsonl'), true)
  addRedactedTextFile('logs/engine.jsonl.1', join(params.logsDir, 'engine.jsonl.1'), true)

  // 2. Most recent engine stderr logs
  if (existsSync(params.logsDir)) {
    try {
      const stderrFiles = readdirSync(params.logsDir)
        .filter((f) => /^engine\.stderr\..+\.log$/.test(f))
        .map((name) => ({ name, mtimeMs: statSync(join(params.logsDir, name)).mtimeMs }))
        .sort((a, b) => b.mtimeMs - a.mtimeMs)
        .slice(0, MAX_STDERR_LOGS_EXPORT)
      for (const item of stderrFiles) {
        addRedactedTextFile(`logs/${item.name}`, join(params.logsDir, item.name))
      }
    } catch {
      /* ignore */
    }
  }

  // 3. Recent client & engine crash dumps
  const crashDir = join(params.logsDir, 'crash')
  if (existsSync(crashDir)) {
    try {
      const allCrash = readdirSync(crashDir)
        .filter((f) => /^(client|engine)-.+\.txt$/.test(f))
        .map((name) => ({ name, mtimeMs: statSync(join(crashDir, name)).mtimeMs }))
        .sort((a, b) => b.mtimeMs - a.mtimeMs)

      const clientCrashes = allCrash.filter((c) => c.name.startsWith('client-')).slice(0, MAX_CRASH_FILES_PER_KIND)
      const engineCrashes = allCrash.filter((c) => c.name.startsWith('engine-')).slice(0, MAX_CRASH_FILES_PER_KIND)
      for (const item of [...clientCrashes, ...engineCrashes]) {
        addRedactedTextFile(`crash/${item.name}`, join(crashDir, item.name))
      }
    } catch {
      /* ignore */
    }
  }

  // 4. Structured summaries
  const metrics = buildTaskMetricsSummary(jsonlTextsForMetrics)
  zipEntries.push({
    name: 'task-metrics-summary.json',
    data: redactText(JSON.stringify(metrics, null, 2), redactorOpts),
  })
  fileManifest.push({ path: 'task-metrics-summary.json' })

  if (params.profile) {
    zipEntries.push({
      name: 'system-profile.json',
      data: redactText(JSON.stringify(params.profile, null, 2), redactorOpts),
    })
    fileManifest.push({ path: 'system-profile.json' })
  }

  const fallbackDbSummary = params.dbSummary ?? buildOfflineDbFallbackSummary(params.userDataDir)
  zipEntries.push({
    name: 'db-summary.json',
    data: redactText(JSON.stringify(fallbackDbSummary, null, 2), redactorOpts),
  })
  fileManifest.push({ path: 'db-summary.json' })

  const manifestObj = {
    schemaVersion: 1,
    exportedAt,
    deviceId: params.deviceId,
    sessionId: params.sessionId,
    loggingEnabled: params.loggingEnabled,
    appVersion: params.profile?.app.version ?? null,
    files: fileManifest,
  }
  zipEntries.push({
    name: 'manifest.json',
    data: JSON.stringify(manifestObj, null, 2),
  })

  const summaryTxt = buildHumanSummaryText({
    deviceId: params.deviceId,
    sessionId: params.sessionId,
    exportedAt,
    loggingEnabled: params.loggingEnabled,
    profile: params.profile,
    dbSummary: fallbackDbSummary,
    metrics,
    includedFiles: ['SUMMARY.txt', 'manifest.json', ...fileManifest.map((f) => f.path)],
  })
  zipEntries.unshift({ name: 'SUMMARY.txt', data: summaryTxt })

  const zipBuffer = buildZipArchive(zipEntries)
  mkdirSync(dirname(params.outputPath), { recursive: true })
  writeFileSync(params.outputPath, zipBuffer, { mode: 0o600 })

  return {
    sizeBytes: zipBuffer.length,
    fileCount: zipEntries.length,
  }
}

function buildOfflineDbFallbackSummary(userDataDir: string): Record<string, unknown> {
  const safeSize = (p: string): number | null => {
    try {
      return existsSync(p) ? statSync(p).size : null
    } catch {
      return null
    }
  }
  return {
    engine_unreachable: true,
    db_size_bytes: safeSize(join(userDataDir, 'plumelens.db')),
    wal_size_bytes: safeSize(join(userDataDir, 'plumelens.db-wal')),
  }
}

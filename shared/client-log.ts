/**
 * Cross-process client logging & diagnostics contract.
 *
 * Shared between Electron main (`tsconfig.node.json`), preload, and renderer
 * (`tsconfig.web.json`). Kept dependency-free so it bundles cleanly into all
 * three targets without pulling Node or DOM globals.
 */

export type LogLevel = 'debug' | 'info' | 'warn' | 'error'
export type LogProcess = 'main' | 'preload' | 'renderer'
export type LogCategory = 'lifecycle' | 'task_metric' | 'resource' | 'error' | 'ui_perf' | 'general'
export type LoggingConsentState = 'unset' | 'enabled' | 'disabled'

export const LOG_CONSENT_VERSION = 1

export const LOG_LEVEL_PRIORITY: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
}

export const CLIENT_LOG_LIMITS = {
  maxBatchSize: 50,
  maxEntryBytes: 8 * 1024,
  maxStringLength: 1024,
  maxStackLength: 4096,
  maxMetaKeys: 32,
  maxDepth: 4,
  pendingBufferMax: 200,
  maxFileBytes: 5 * 1024 * 1024,
  maxBackups: 5,
  maxCrashFiles: 20,
  retentionDays: 14,
  rendererRateLimitPerSec: 120,
} as const

export interface SerializedError {
  name: string
  message: string
  stack?: string
  code?: string | number
}

export interface ClientLogEntry {
  ts: string
  level: LogLevel
  deviceId: string
  sessionId: string
  process: LogProcess
  scope: string
  category: LogCategory
  event: string
  meta?: Record<string, unknown>
  error?: SerializedError
}

export interface RendererLogInput {
  ts?: string
  level: LogLevel
  scope: string
  category?: LogCategory
  event: string
  meta?: Record<string, unknown>
  error?: SerializedError
}

export interface LoggingPreferences {
  consent: LoggingConsentState
  consentVersion: number
  enabled: boolean
  level: 'info' | 'debug'
}

export interface LoggingStatusSnapshot {
  consent: LoggingConsentState
  consentVersion: number
  enabled: boolean
  level: 'info' | 'debug'
  deviceId: string | null
  sessionId: string
  logsDir: string
  totalBytes: number
  fileCount: number
  crashCount: number
  needsConsentPrompt: boolean
}

export interface DiskProbeInfo {
  role: 'app_install' | 'user_data' | 'library'
  mountPoint: string | null
  filesystem: string | null
  mediaType: 'SSD' | 'HDD' | 'Virtual' | 'Network' | 'Unknown'
  busProtocol: string | null
  isInternal: boolean | null
  model: string | null
  totalBytes: number | null
  freeBytes: number | null
  availableBytes: number | null
  usedPercent: number | null
  probeError?: string
}

export interface CpuProfileInfo {
  model: string
  arch: string
  logicalCores: number
  physicalCores: number | null
  performanceCores: number | null
  efficiencyCores: number | null
  baseSpeedMhz: number | null
  maxSpeedMhz: number | null
  l2CacheBytes: number | null
  l3CacheBytes: number | null
}

export interface MemoryProfileInfo {
  totalBytes: number
  freeBytes: number
  usedPercent: number
  unifiedMemory: boolean
  memoryType: string | null
  speedMhz: number | null
  moduleCount: number | null
  appProcessRssBytes: number | null
}

export interface GpuDeviceInfo {
  name: string
  vendorId: string | null
  deviceId: string | null
  driverVersion: string | null
  driverDate: string | null
  vramBytes: number | null
  cores: number | null
  metalSupport: string | null
  active: boolean | null
}

export interface SystemProfileSnapshot {
  collectedAt: string
  deviceId: string
  deviceIdSource: 'macos_ioreg' | 'windows_registry' | 'windows_cim' | 'linux_machine_id' | 'fallback_random'
  sessionId: string
  app: {
    version: string
    isPackaged: boolean
    electron: string
    chromium: string
    node: string
    v8: string
  }
  os: {
    platform: string
    release: string
    version: string
    arch: string
    locale: string
    timezone: string
  }
  cpu: CpuProfileInfo
  memory: MemoryProfileInfo
  disks: DiskProbeInfo[]
  gpus: GpuDeviceInfo[]
  gpuFeatureStatus?: Record<string, string>
  engineRuntime?: Record<string, unknown> | null
}

export type ExportDiagnosticsResult =
  | {
      ok: true
      path: string
      sizeBytes: number
      fileCount: number
    }
  | {
      ok: false
      canceled?: boolean
      reason: 'canceled' | 'write_failed' | 'unknown'
      message?: string
    }

export type ClearLogsResult =
  | {
      ok: true
      freedBytes: number
      removedFiles: number
    }
  | {
      ok: false
      reason: string
      message?: string
    }

export function isValidLogLevel(value: unknown): value is LogLevel {
  return value === 'debug' || value === 'info' || value === 'warn' || value === 'error'
}

export function isValidConfigurableLogLevel(value: unknown): value is 'info' | 'debug' {
  return value === 'info' || value === 'debug'
}

export function isValidConsentState(value: unknown): value is LoggingConsentState {
  return value === 'unset' || value === 'enabled' || value === 'disabled'
}

export function shouldLogAtLevel(entryLevel: LogLevel, threshold: LogLevel): boolean {
  return LOG_LEVEL_PRIORITY[entryLevel] >= LOG_LEVEL_PRIORITY[threshold]
}

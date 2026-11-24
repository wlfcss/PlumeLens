/**
 * Log redaction, path/filename anonymization, and payload bounding.
 *
 * Ensures that neither on-disk logs nor exported diagnostic bundles leak:
 * - One-time API bearer tokens (`PLUMELENS_API_TOKEN`)
 * - User geocoding API keys (`amapKey`, `baiduAk`, `tencentKey`)
 * - User home directory names / absolute filesystem paths
 * - Original photo filenames (hashed deterministically via `anonymizeFileName`)
 */

import { homedir } from 'os'
import {
  CLIENT_LOG_LIMITS,
  type ClientLogEntry,
  type SerializedError,
} from '../shared/client-log'
import { anonymizeFileName } from './device-id'

export interface RedactorOptions {
  deviceId?: string | null
  homeDir?: string
  extraSecrets?: string[]
}

const SENSITIVE_KEY_PATTERN =
  /(?:^|[_-])(token|key|ak|secret|authorization|password|passwd|cookie|credential)(?:$|[_-])|^(amapKey|baiduAk|tencentKey|apiToken|authToken)$/i

const PHOTO_EXT_PATTERN =
  '(?:cr2|cr3|nef|nrw|arw|srf|sr2|orf|rw2|pef|dng|raf|srw|3fr|iiq|jpg|jpeg|png|webp|tif|tiff|heic|heif|avif)'

const PATH_PREFIX_PATTERN =
  '(?:[A-Za-z]:(?:\\\\\\\\|\\\\|/)|/(?:Users|home|Volumes|mnt|media|private|var|tmp)/)'
const PATH_SEG_PATTERN = `[^/\\\\\\s"'\\])}>,;]+(?: [^/\\\\\\s"'\\])}>,;]+){0,2}`

// Matches quoted absolute POSIX/Windows paths (including spaces and JSON-escaped `\\`) ending in a photo ext.
const PHOTO_PATH_QUOTED_RE = new RegExp(
  `(["'])(${PATH_PREFIX_PATTERN}[^"'\\r\\n\\t]+?\\.${PHOTO_EXT_PATTERN})(?=\\1)`,
  'gi',
)

// Matches unquoted absolute POSIX/Windows paths (linear-time segment grammar; supports `\\`, `/`, and spaces).
const PHOTO_PATH_RE = new RegExp(
  `${PATH_PREFIX_PATTERN}(?:${PATH_SEG_PATTERN}(?:\\\\\\\\|\\\\|/))*${PATH_SEG_PATTERN}\\.${PHOTO_EXT_PATTERN}\\b`,
  'gi',
)

// Matches generic user home paths (macOS / Linux / Windows including `\\` and `/`) even if os.homedir differs.
const GENERIC_USER_HOME_RE =
  /(?:\/Users\/[^/\s"'`]+|\/home\/[^/\s"'`]+|[A-Za-z]:(?:\\\\|\\|\/)Users(?:\\\\|\\|\/)[^\\/\s"'`]+)/g

const BEARER_RE = /\bBearer\s+[A-Za-z0-9._~+/-]{8,}/gi
const QUERY_SECRET_RE = /([?&](?:token|key|ak|api_key|apikey|secret|access_token)=)([^&\s"'`]+)/gi
const ENV_SECRET_RE =
  /\b(PLUMELENS_(?:API_TOKEN|AMAP_KEY|BAIDU_AK|TENCENT_KEY)\s*[=:]\s*)([^\s"'`,;]+)/gi
const JSON_SECRET_RE =
  /("(?:authorization|api_?token|auth_?token|amap_?key|baidu_?ak|tencent_?key|secret|password)"\s*:\s*")([^"]+)(")/gi

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

export function truncateString(value: string, maxLen: number): string {
  if (value.length <= maxLen) return value
  return `${value.slice(0, Math.max(0, maxLen - 14))}...[truncated]`
}

export function redactText(input: string, options: RedactorOptions = {}): string {
  if (!input) return input
  const deviceId = options.deviceId || 'pl-anonymous'
  const home = options.homeDir ?? homedir()

  let out = input
  if (options.extraSecrets && options.extraSecrets.length > 0) {
    for (const secret of options.extraSecrets) {
      if (secret && secret.length >= 6) {
        out = out.split(secret).join('[REDACTED]')
      }
    }
  }

  out = out
    .replace(BEARER_RE, 'Bearer [REDACTED]')
    .replace(QUERY_SECRET_RE, '$1[REDACTED]')
    .replace(ENV_SECRET_RE, '$1[REDACTED]')
    .replace(JSON_SECRET_RE, '$1[REDACTED]$3')

  // Replace photo file paths with deterministic anonymized filename before generic home replacement.
  out = out.replace(
    PHOTO_PATH_QUOTED_RE,
    (_full, quote: string, pathPart: string) => `${quote}<photo>/${anonymizeFileName(pathPart, deviceId)}`,
  )
  out = out.replace(PHOTO_PATH_RE, (matched) => `<photo>/${anonymizeFileName(matched, deviceId)}`)

  if (home && home.length > 1) {
    const homeJsonEscaped = home.replace(/\\/g, '\\\\')
    if (homeJsonEscaped !== home) {
      out = out.replace(new RegExp(escapeRegExp(homeJsonEscaped), 'g'), '~')
    }
    const homeRe = new RegExp(escapeRegExp(home), 'g')
    out = out.replace(homeRe, '~')
    const homeForward = home.replace(/\\/g, '/')
    if (homeForward !== home) {
      out = out.replace(new RegExp(escapeRegExp(homeForward), 'g'), '~')
    }
  }

  out = out.replace(GENERIC_USER_HOME_RE, '~')
  return out
}

function sanitizeValue(
  value: unknown,
  options: RedactorOptions,
  depth: number,
  seen: WeakSet<object>,
): unknown {
  if (value === null || value === undefined) return value
  if (typeof value === 'boolean' || typeof value === 'number') {
    return Number.isFinite(value as number) || typeof value === 'boolean' ? value : String(value)
  }
  if (typeof value === 'string') {
    return truncateString(redactText(value, options), CLIENT_LOG_LIMITS.maxStringLength)
  }
  if (typeof value === 'bigint') return value.toString()
  if (value instanceof Error) {
    return serializeError(value, options)
  }
  if (depth >= CLIENT_LOG_LIMITS.maxDepth) {
    return '[MaxDepth]'
  }
  if (typeof value === 'object') {
    if (seen.has(value)) return '[Circular]'
    seen.add(value)
    if (Array.isArray(value)) {
      return value.slice(0, 20).map((item) => sanitizeValue(item, options, depth + 1, seen))
    }
    const out: Record<string, unknown> = {}
    const entries = Object.entries(value as Record<string, unknown>).slice(
      0,
      CLIENT_LOG_LIMITS.maxMetaKeys,
    )
    for (const [key, rawVal] of entries) {
      if (SENSITIVE_KEY_PATTERN.test(key)) {
        out[key] = '[REDACTED]'
      } else {
        out[key] = sanitizeValue(rawVal, options, depth + 1, seen)
      }
    }
    return out
  }
  return String(value)
}

export function serializeError(err: unknown, options: RedactorOptions = {}): SerializedError {
  if (err instanceof Error) {
    const maybeCode = (err as Error & { code?: unknown }).code
    return {
      name: truncateString(err.name || 'Error', 120),
      message: truncateString(redactText(err.message || '', options), CLIENT_LOG_LIMITS.maxStringLength),
      ...(err.stack
        ? {
            stack: truncateString(redactText(err.stack, options), CLIENT_LOG_LIMITS.maxStackLength),
          }
        : {}),
      ...(typeof maybeCode === 'string' || typeof maybeCode === 'number'
        ? { code: maybeCode }
        : {}),
    }
  }
  if (typeof err === 'object' && err !== null) {
    const rec = err as Record<string, unknown>
    return {
      name: typeof rec['name'] === 'string' ? truncateString(rec['name'], 120) : 'Error',
      message: truncateString(
        redactText(typeof rec['message'] === 'string' ? rec['message'] : String(err), options),
        CLIENT_LOG_LIMITS.maxStringLength,
      ),
      ...(typeof rec['stack'] === 'string'
        ? {
            stack: truncateString(
              redactText(rec['stack'], options),
              CLIENT_LOG_LIMITS.maxStackLength,
            ),
          }
        : {}),
      ...(typeof rec['code'] === 'string' || typeof rec['code'] === 'number'
        ? { code: rec['code'] }
        : {}),
    }
  }
  return {
    name: 'Error',
    message: truncateString(redactText(String(err), options), CLIENT_LOG_LIMITS.maxStringLength),
  }
}

export function sanitizeMeta(
  meta: Record<string, unknown> | undefined,
  options: RedactorOptions = {},
): Record<string, unknown> | undefined {
  if (!meta) return undefined
  const sanitized = sanitizeValue(meta, options, 0, new WeakSet<object>())
  if (typeof sanitized === 'object' && sanitized !== null && !Array.isArray(sanitized)) {
    const rec = sanitized as Record<string, unknown>
    return Object.keys(rec).length > 0 ? rec : undefined
  }
  return undefined
}

export function sanitizeLogEntry(
  entry: ClientLogEntry,
  options: RedactorOptions = {},
): ClientLogEntry {
  const sanitized: ClientLogEntry = {
    ts: entry.ts,
    level: entry.level,
    deviceId: entry.deviceId,
    sessionId: entry.sessionId,
    process: entry.process,
    scope: truncateString(entry.scope || 'app', 64),
    category: entry.category,
    event: truncateString(
      redactText(entry.event || '', options).replace(/[\r\n]+/g, ' '),
      CLIENT_LOG_LIMITS.maxStringLength,
    ),
    ...(entry.meta ? { meta: sanitizeMeta(entry.meta, options) } : {}),
    ...(entry.error ? { error: serializeError(entry.error, options) } : {}),
  }

  const rawJson = JSON.stringify(sanitized)
  if (Buffer.byteLength(rawJson, 'utf-8') <= CLIENT_LOG_LIMITS.maxEntryBytes) {
    return sanitized
  }

  // Drop bulky meta/stack if the serialized record still exceeds the hard cap.
  const trimmed: ClientLogEntry = {
    ts: sanitized.ts,
    level: sanitized.level,
    deviceId: sanitized.deviceId,
    sessionId: sanitized.sessionId,
    process: sanitized.process,
    scope: sanitized.scope,
    category: sanitized.category,
    event: truncateString(sanitized.event, 512),
    ...(sanitized.error
      ? {
          error: {
            name: sanitized.error.name,
            message: truncateString(sanitized.error.message, 512),
            ...(sanitized.error.code !== undefined ? { code: sanitized.error.code } : {}),
          },
        }
      : {}),
    meta: { _truncated: true },
  }
  return trimmed
}

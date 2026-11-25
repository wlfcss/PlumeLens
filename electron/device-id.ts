/**
 * Stable, privacy-preserving device identifier derived from OS machine IDs.
 *
 * Raw hardware identifiers (macOS IOPlatformUUID, Windows MachineGuid, Linux
 * /etc/machine-id) are NEVER written to disk or exported. Instead we compute a
 * one-way domain-separated HMAC-SHA256 (`pl-<24 hex chars>`) and cache the
 * derived ID in `{userData}/device-id.json`.
 */

import { execFile } from 'child_process'
import { createHmac, randomUUID } from 'crypto'
import { existsSync, readFileSync } from 'fs'
import { basename, extname, join } from 'path'
import { promisify } from 'util'
import { writeJsonAtomicSync } from './atomic-file'

const execFileAsync = promisify(execFile)

export type DeviceIdSource =
  | 'macos_ioreg'
  | 'windows_registry'
  | 'windows_cim'
  | 'linux_machine_id'
  | 'fallback_random'

export interface DeviceIdRecord {
  deviceId: string
  source: DeviceIdSource
  platform: string
  createdAt: string
}

const DEVICE_ID_HMAC_KEY = 'plumelens:device:v1'
const PROBE_TIMEOUT_MS = 2500

export function deriveDeviceId(rawMachineCode: string): string {
  const normalized = rawMachineCode.trim().toLowerCase()
  const digest = createHmac('sha256', DEVICE_ID_HMAC_KEY).update(normalized).digest('hex')
  return `pl-${digest.slice(0, 24)}`
}

/**
 * Deterministically anonymize a file name (or path) into `f_<12-hex>.<ext>`.
 *
 * Matches Python `engine/core/logging.py:anonymize_filename` byte-for-byte:
 * - Hash key: `${deviceId}:file:v1`
 * - Message: lowercased file stem (filename without extension)
 * - Same JPG + RAW companion pair share the same anonymized stem.
 */
export function anonymizeFileName(filePathOrName: string, deviceId: string): string {
  const normalized = filePathOrName.replace(/\\/g, '/')
  const base = basename(normalized).trim()
  if (!base) return 'f_empty'
  const rawExt = extname(base)
  const ext = rawExt.replace(/^\./, '').toLowerCase()
  const stem = rawExt ? base.slice(0, -rawExt.length) : base
  const digest = createHmac('sha256', `${deviceId}:file:v1`)
    .update(stem.toLowerCase())
    .digest('hex')
    .slice(0, 12)
  return ext ? `f_${digest}.${ext}` : `f_${digest}`
}

async function probeMacMachineCode(): Promise<{ raw: string; source: DeviceIdSource } | null> {
  try {
    const { stdout } = await execFileAsync(
      'ioreg',
      ['-rd1', '-c', 'IOPlatformExpertDevice'],
      { timeout: PROBE_TIMEOUT_MS, encoding: 'utf-8' },
    )
    const uuidMatch = stdout.match(/"IOPlatformUUID"\s*=\s*"([^"]+)"/)
    if (uuidMatch?.[1]) {
      return { raw: uuidMatch[1], source: 'macos_ioreg' }
    }
    const serialMatch = stdout.match(/"IOPlatformSerialNumber"\s*=\s*"([^"]+)"/)
    if (serialMatch?.[1]) {
      return { raw: serialMatch[1], source: 'macos_ioreg' }
    }
  } catch {
    /* fall through */
  }
  return null
}

async function probeWindowsMachineCode(): Promise<{ raw: string; source: DeviceIdSource } | null> {
  try {
    const { stdout } = await execFileAsync(
      'reg.exe',
      ['query', 'HKLM\\SOFTWARE\\Microsoft\\Cryptography', '/v', 'MachineGuid'],
      { timeout: PROBE_TIMEOUT_MS, encoding: 'utf-8', windowsHide: true },
    )
    const match = stdout.match(/MachineGuid\s+REG_\w+\s+([0-9a-fA-F-]{8,})/)
    if (match?.[1]) {
      return { raw: match[1], source: 'windows_registry' }
    }
  } catch {
    /* fall through to CIM */
  }
  try {
    const { stdout } = await execFileAsync(
      'powershell.exe',
      [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        '(Get-CimInstance Win32_ComputerSystemProduct).UUID',
      ],
      { timeout: PROBE_TIMEOUT_MS, encoding: 'utf-8', windowsHide: true },
    )
    const candidate = stdout.trim()
    if (candidate && candidate.length >= 8 && !/^0+$/.test(candidate.replace(/-/g, ''))) {
      return { raw: candidate, source: 'windows_cim' }
    }
  } catch {
    /* fall through */
  }
  return null
}

function probeLinuxMachineCode(): { raw: string; source: DeviceIdSource } | null {
  for (const file of ['/etc/machine-id', '/var/lib/dbus/machine-id']) {
    try {
      if (!existsSync(file)) continue
      const content = readFileSync(file, 'utf-8').trim()
      if (content.length >= 8) {
        return { raw: content, source: 'linux_machine_id' }
      }
    } catch {
      /* try next */
    }
  }
  return null
}

export async function probeRawMachineCode(
  platform: NodeJS.Platform = process.platform,
): Promise<{ raw: string; source: DeviceIdSource } | null> {
  if (platform === 'darwin') return probeMacMachineCode()
  if (platform === 'win32') return probeWindowsMachineCode()
  return probeLinuxMachineCode()
}

function readCachedDeviceId(cachePath: string): DeviceIdRecord | null {
  if (!existsSync(cachePath)) return null
  try {
    const parsed = JSON.parse(readFileSync(cachePath, 'utf-8')) as Record<string, unknown>
    if (
      typeof parsed['deviceId'] === 'string' &&
      /^pl-[0-9a-f]{24}$/.test(parsed['deviceId']) &&
      typeof parsed['source'] === 'string' &&
      typeof parsed['createdAt'] === 'string'
    ) {
      return {
        deviceId: parsed['deviceId'],
        source: parsed['source'] as DeviceIdSource,
        platform: typeof parsed['platform'] === 'string' ? parsed['platform'] : process.platform,
        createdAt: parsed['createdAt'],
      }
    }
  } catch {
    /* corrupt cache; regenerate */
  }
  return null
}

function writeCachedDeviceId(cachePath: string, record: DeviceIdRecord): void {
  try {
    writeJsonAtomicSync(cachePath, record, 0o600)
  } catch {
    /* non-critical cache failure */
  }
}

export function readExistingDeviceId(userDataDir: string): DeviceIdRecord | null {
  return readCachedDeviceId(join(userDataDir, 'device-id.json'))
}

export async function resolveDeviceId(
  userDataDir: string,
  options?: {
    platform?: NodeJS.Platform
    probe?: () => Promise<{ raw: string; source: DeviceIdSource } | null>
    persist?: boolean
  },
): Promise<DeviceIdRecord> {
  const platform = options?.platform ?? process.platform
  const persist = options?.persist ?? true
  const cachePath = join(userDataDir, 'device-id.json')

  const cached = readCachedDeviceId(cachePath)
  if (cached && cached.source !== 'fallback_random') {
    return cached
  }

  const probed = options?.probe ? await options.probe() : await probeRawMachineCode(platform)
  if (probed) {
    const record: DeviceIdRecord = {
      deviceId: deriveDeviceId(probed.raw),
      source: probed.source,
      platform,
      createdAt: cached?.createdAt ?? new Date().toISOString(),
    }
    if (persist) writeCachedDeviceId(cachePath, record)
    return record
  }

  if (cached) return cached

  const fallback: DeviceIdRecord = {
    deviceId: deriveDeviceId(`fallback:${randomUUID()}`),
    source: 'fallback_random',
    platform,
    createdAt: new Date().toISOString(),
  }
  if (persist) writeCachedDeviceId(cachePath, fallback)
  return fallback
}

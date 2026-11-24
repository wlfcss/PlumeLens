import { app, safeStorage } from 'electron'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'fs'
import { join } from 'path'

/**
 * 用户设置(reverse geocoding 第三方 API keys)的持久化层。
 *
 * **存储格式**:userData/settings.json
 * 历史(0.6.0 及之前):key 字段直接存 plain text
 * 现行(0.6.1+):每个 key 走 Electron safeStorage 加密 + base64。
 * Electron 45+ 优先使用异步 safeStorage API（isAsyncEncryptionAvailable /
 * encryptStringAsync / decryptStringAsync），并在 shouldReEncrypt=true 时自动重加密。
 */

export interface UserSettings {
  amapKey?: string
  baiduAk?: string
  tencentKey?: string
}

type EncryptedField = { enc: string }
type SettingsOnDisk = Partial<Record<keyof UserSettings, string | EncryptedField>>

type AsyncSafeStorage = typeof safeStorage & {
  isAsyncEncryptionAvailable?: () => Promise<boolean>
  encryptStringAsync?: (plainText: string) => Promise<Buffer>
  decryptStringAsync?: (encrypted: Buffer) => Promise<{ result: string; shouldReEncrypt?: boolean }>
}

const SETTINGS_KEYS: (keyof UserSettings)[] = ['amapKey', 'baiduAk', 'tencentKey']

function settingsPath(): string {
  return join(app.getPath('userData'), 'settings.json')
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isEncryptedField(value: unknown): value is EncryptedField {
  return isPlainObject(value) && typeof value['enc'] === 'string' && value['enc'].length > 0
}

/** 错误类:saveUserSettings 加密失败时主动抛,IPC handler 让 UI surface 给用户。 */
export class SafeStorageUnavailableError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'SafeStorageUnavailableError'
  }
}

async function isSafeStorageAvailable(): Promise<boolean> {
  const storage = safeStorage as AsyncSafeStorage
  if (typeof storage.isAsyncEncryptionAvailable === 'function') {
    try {
      return await storage.isAsyncEncryptionAvailable()
    } catch {
      return false
    }
  }
  return safeStorage.isEncryptionAvailable()
}

async function encryptValue(plain: string): Promise<EncryptedField> {
  if (!(await isSafeStorageAvailable())) {
    throw new SafeStorageUnavailableError(
      'Secure storage is not available on this platform — install gnome-keyring / ' +
        'libsecret on Linux, or upgrade to a supported macOS/Windows release. ' +
        'Refusing to write API keys in plain text.',
    )
  }
  const storage = safeStorage as AsyncSafeStorage
  const buf =
    typeof storage.encryptStringAsync === 'function'
      ? await storage.encryptStringAsync(plain)
      : safeStorage.encryptString(plain)
  return { enc: buf.toString('base64') }
}

async function decryptValue(
  value: unknown,
): Promise<{ plain?: string; shouldReEncrypt: boolean; undecryptable: boolean }> {
  if (value === undefined) return { shouldReEncrypt: false, undecryptable: false }
  if (typeof value === 'string') {
    return { plain: value, shouldReEncrypt: value !== '', undecryptable: false }
  }
  if (!isEncryptedField(value)) return { shouldReEncrypt: false, undecryptable: false }
  if (!(await isSafeStorageAvailable())) {
    process.stderr.write(
      `[user-settings] cannot decrypt — safeStorage not available; ` +
        `key value will appear missing until reset\n`,
    )
    return { shouldReEncrypt: false, undecryptable: true }
  }
  try {
    const buf = Buffer.from(value.enc, 'base64')
    const storage = safeStorage as AsyncSafeStorage
    if (typeof storage.decryptStringAsync === 'function') {
      const decrypted = await storage.decryptStringAsync(buf)
      return {
        plain: decrypted.result,
        shouldReEncrypt: Boolean(decrypted.shouldReEncrypt),
        undecryptable: false,
      }
    }
    return {
      plain: safeStorage.decryptString(buf),
      shouldReEncrypt: false,
      undecryptable: false,
    }
  } catch (err) {
    process.stderr.write(
      `[user-settings] safeStorage decrypt failed: ${(err as Error).message}\n`,
    )
    return { shouldReEncrypt: false, undecryptable: true }
  }
}

function readRawSettingsOnDisk(): SettingsOnDisk {
  const path = settingsPath()
  if (!existsSync(path)) return {}
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, 'utf-8'))
    if (!isPlainObject(parsed)) return {}
    const out: SettingsOnDisk = {}
    for (const key of SETTINGS_KEYS) {
      const raw = parsed[key]
      if (typeof raw === 'string' || isEncryptedField(raw)) {
        out[key] = raw
      }
    }
    return out
  } catch (err) {
    process.stderr.write(`[user-settings] settings.json parse failed: ${(err as Error).message}\n`)
    return {}
  }
}

function writeRawSettingsAtomically(onDisk: SettingsOnDisk): void {
  const path = settingsPath()
  try {
    mkdirSync(app.getPath('userData'), { recursive: true })
  } catch {
    /* main.ts::lockdownUserData 已经 mkdir 过,这里是兜底 */
  }
  const tmpPath = `${path}.${process.pid}.${Date.now()}.tmp`
  writeFileSync(tmpPath, JSON.stringify(onDisk, null, 2), { encoding: 'utf-8', mode: 0o600 })
  renameSync(tmpPath, path)
}

/** 读 userData/settings.json,decrypt 出 in-memory plain text。
 *  遇到旧明文或 safeStorage 提示 shouldReEncrypt 时自动重加密写回。 */
export async function readUserSettings(): Promise<UserSettings> {
  const parsed = readRawSettingsOnDisk()
  const out: UserSettings = {}
  const preservedRaw: SettingsOnDisk = {}
  let needsRewrite = false

  for (const key of SETTINGS_KEYS) {
    const raw = parsed[key]
    if (raw === undefined) continue
    const { plain, shouldReEncrypt, undecryptable } = await decryptValue(raw)
    if (undecryptable) {
      preservedRaw[key] = raw
      continue
    }
    if (shouldReEncrypt) needsRewrite = true
    if (plain !== undefined && plain !== '') {
      out[key] = plain
    }
  }

  if (needsRewrite && (await isSafeStorageAvailable())) {
    try {
      const nextOnDisk: SettingsOnDisk = { ...preservedRaw }
      for (const key of SETTINGS_KEYS) {
        const value = out[key]
        if (value !== undefined && value !== '') {
          nextOnDisk[key] = await encryptValue(value)
        }
      }
      writeRawSettingsAtomically(nextOnDisk)
    } catch (err) {
      process.stderr.write(
        `[user-settings] failed to re-encrypt settings: ${(err as Error).message}\n`,
      )
    }
  }
  return out
}

/** 写盘前对所有 key 做 encrypt,并保证 userData 存在。 */
export async function writeUserSettings(settings: UserSettings): Promise<void> {
  const onDisk: SettingsOnDisk = {}
  for (const key of SETTINGS_KEYS) {
    const value = settings[key]
    if (value === undefined || value === '') continue
    onDisk[key] = await encryptValue(value)
  }
  writeRawSettingsAtomically(onDisk)
}

/**
 * Merge:partial 中传 `''` 视为清掉该 key,`undefined` 视为不动,其他视为更新。
 * 对当前机器暂时无法解密的未改动字段保留原密文，避免误删。
 */
export async function mergeUserSettings(partial: unknown): Promise<UserSettings> {
  if (!isPlainObject(partial)) {
    throw new TypeError('Settings payload must be a plain object')
  }
  const rawOnDisk = readRawSettingsOnDisk()
  const current: UserSettings = {}
  const preservedRaw: SettingsOnDisk = {}

  for (const key of SETTINGS_KEYS) {
    const raw = rawOnDisk[key]
    if (raw === undefined) continue
    const { plain, undecryptable } = await decryptValue(raw)
    if (undecryptable) {
      preservedRaw[key] = raw
    } else if (plain !== undefined && plain !== '') {
      current[key] = plain
    }
  }

  const merged: UserSettings = { ...current }
  for (const key of SETTINGS_KEYS) {
    const value = partial[key]
    if (value === undefined) continue
    if (typeof value !== 'string') {
      throw new TypeError(`Setting ${key} must be a string`)
    }
    delete preservedRaw[key]
    if (value === '') delete merged[key]
    else merged[key] = value
  }

  const nextOnDisk: SettingsOnDisk = { ...preservedRaw }
  for (const key of SETTINGS_KEYS) {
    const value = merged[key]
    if (value === undefined || value === '') continue
    nextOnDisk[key] = await encryptValue(value)
  }
  writeRawSettingsAtomically(nextOnDisk)
  return merged
}

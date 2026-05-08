import { app, safeStorage } from 'electron'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { join } from 'path'

/**
 * 用户设置(reverse geocoding 第三方 API keys)的持久化层。
 *
 * **存储格式**:userData/settings.json
 * 历史(0.6.0 及之前):key 字段直接存 plain text
 *   {"amapKey": "xxx", "baiduAk": "yyy", "tencentKey": "zzz"}
 * 现行(0.6.1+):每个 key 走 Electron safeStorage 加密 + base64,disk 上看不到
 * plaintext。macOS 走 Keychain Services,Linux 走 libsecret,Windows 走 DPAPI。
 *   {
 *     "amapKey": {"enc": "<base64>"},
 *     "baiduAk": {"enc": "<base64>"}
 *   }
 *
 * 启动时自动迁移:遇到旧 plain text 字段就解析成 plaintext,下一次 save 时自动
 * 重新加密。从用户视角无感切换;若 safeStorage 在当前平台不可用(老 Linux 没装
 * gnome-keyring 等),退化回 plain text 并写一行 stderr 警告 — 比直接 throw 让
 * 用户陷入"我设了 key 怎么不生效"的困惑要好。
 *
 * 安全收益:
 * - userData 目录权限 0o700 (main.ts::lockdownUserData) — owner 才能读 settings.json。
 * - safeStorage 加密 — 即便目录被复制走 (NAS / 云同步 / 误传给别人),没有当前用户
 *   的 Keychain 凭据无法解出 plain key。
 * - 攻击者拿到 settings.json + 系统访问 → 能解(safeStorage 走 OS 级隔离),这是
 *   平台层的限制,不在本模块的责任内。
 */

export interface UserSettings {
  amapKey?: string
  baiduAk?: string
  tencentKey?: string
}

type EncryptedField = { enc: string }
type SettingsOnDisk = Partial<Record<keyof UserSettings, string | EncryptedField>>

const SETTINGS_KEYS: (keyof UserSettings)[] = ['amapKey', 'baiduAk', 'tencentKey']

function settingsPath(): string {
  return join(app.getPath('userData'), 'settings.json')
}

function isEncryptedField(value: unknown): value is EncryptedField {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { enc?: unknown }).enc === 'string'
  )
}

function encryptValue(plain: string): string | EncryptedField {
  if (!safeStorage.isEncryptionAvailable()) {
    process.stderr.write(
      `[user-settings] safeStorage encryption unavailable on this platform; ` +
        `falling back to plain text for new keys\n`,
    )
    return plain
  }
  try {
    const buf = safeStorage.encryptString(plain)
    return { enc: buf.toString('base64') }
  } catch (err) {
    process.stderr.write(
      `[user-settings] safeStorage encryptString failed: ${(err as Error).message}; ` +
        `falling back to plain text\n`,
    )
    return plain
  }
}

function decryptValue(value: string | EncryptedField | undefined): string | undefined {
  if (value === undefined) return undefined
  if (typeof value === 'string') return value // 老 plain-text 字段,迁移后下次 save 自动加密
  if (!isEncryptedField(value)) return undefined
  if (!safeStorage.isEncryptionAvailable()) {
    process.stderr.write(
      `[user-settings] cannot decrypt — safeStorage not available; ` +
        `key value will appear missing until reset\n`,
    )
    return undefined
  }
  try {
    const buf = Buffer.from(value.enc, 'base64')
    return safeStorage.decryptString(buf)
  } catch (err) {
    // 解密失败常见于:同一 userData 被另一台机器同步过来(Keychain 不通用),
    // 或者用户重置了 OS 钥匙串。返回 undefined 让用户重新填即可。
    process.stderr.write(
      `[user-settings] safeStorage decryptString failed: ${(err as Error).message}\n`,
    )
    return undefined
  }
}

/** 读 userData/settings.json,decrypt 出 in-memory plain text。
 *
 *  发现 0.6.0 之前的 plain-text 格式时机会型迁移:解析成 plain 后立刻 re-save,
 *  让磁盘上的老明文被加密版本覆盖。即使用户从不打开 settings UI,只要打开过应用
 *  一次就会自动升级。 */
export function readUserSettings(): UserSettings {
  const path = settingsPath()
  if (!existsSync(path)) return {}
  let parsed: SettingsOnDisk
  try {
    parsed = JSON.parse(readFileSync(path, 'utf-8')) as SettingsOnDisk
  } catch (err) {
    process.stderr.write(`[user-settings] settings.json parse failed: ${(err as Error).message}\n`)
    return {}
  }
  const out: UserSettings = {}
  let hasLegacyPlaintext = false
  for (const key of SETTINGS_KEYS) {
    const raw = parsed[key]
    if (raw === undefined) continue
    if (typeof raw === 'string' && raw !== '') {
      hasLegacyPlaintext = true
    }
    const decrypted = decryptValue(raw)
    if (decrypted !== undefined && decrypted !== '') {
      out[key] = decrypted
    }
  }
  if (hasLegacyPlaintext && safeStorage.isEncryptionAvailable()) {
    try {
      writeUserSettings(out)
    } catch (err) {
      process.stderr.write(
        `[user-settings] failed to migrate legacy plaintext settings: ${(err as Error).message}\n`,
      )
    }
  }
  return out
}

/** 写盘前对所有 key 做 encrypt,并保证 userData 存在。 */
export function writeUserSettings(settings: UserSettings): void {
  const path = settingsPath()
  try {
    mkdirSync(app.getPath('userData'), { recursive: true })
  } catch {
    /* main.ts::lockdownUserData 已经 mkdir 过,这里是兜底 */
  }
  const onDisk: SettingsOnDisk = {}
  for (const key of SETTINGS_KEYS) {
    const value = settings[key]
    if (value === undefined || value === '') continue
    onDisk[key] = encryptValue(value)
  }
  writeFileSync(path, JSON.stringify(onDisk, null, 2), 'utf-8')
}

/**
 * Merge:partial 中传 `''` 视为清掉该 key,`undefined` 视为不动,其他视为更新。
 * 返回合并后的 settings(decrypted)给 caller (UI) 显示。
 */
export function mergeUserSettings(partial: UserSettings): UserSettings {
  const current = readUserSettings()
  const merged: UserSettings = { ...current }
  for (const key of SETTINGS_KEYS) {
    const value = partial[key]
    if (value === undefined) continue
    if (value === '') delete merged[key]
    else merged[key] = value
  }
  writeUserSettings(merged)
  return merged
}

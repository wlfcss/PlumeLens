/**
 * Non-sensitive UI & client preferences persisted in `{userData}/ui-prefs.json`.
 *
 * Intentionally separated from `user-settings.ts` (which requires OS safeStorage
 * encryption for third-party geocoding API keys) so that non-secret preferences
 * such as last-opened folders and local logging consent/level always remain
 * readable and writable even on systems without a keyring service.
 */

import { app } from 'electron'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'fs'
import { dirname, join } from 'path'
import {
  isValidConfigurableLogLevel,
  isValidConsentState,
  LOG_CONSENT_VERSION,
  type LoggingConsentState,
  type LoggingPreferences,
} from '../shared/client-log'

export interface UiPreferences {
  lastImportDir?: string
  lastExportDir?: string
  loggingConsent?: LoggingConsentState
  loggingConsentVersion?: number
  loggingEnabled?: boolean
  loggingLevel?: 'info' | 'debug'
}

function defaultPrefsPath(): string {
  return join(app.getPath('userData'), 'ui-prefs.json')
}

export function readUiPreferences(prefsFilePath?: string): UiPreferences {
  const path = prefsFilePath ?? defaultPrefsPath()
  if (!existsSync(path)) return {}
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, 'utf-8'))
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return {}
    const record = parsed as Record<string, unknown>
    return {
      ...(typeof record['lastImportDir'] === 'string'
        ? { lastImportDir: record['lastImportDir'] }
        : {}),
      ...(typeof record['lastExportDir'] === 'string'
        ? { lastExportDir: record['lastExportDir'] }
        : {}),
      ...(isValidConsentState(record['loggingConsent'])
        ? { loggingConsent: record['loggingConsent'] }
        : {}),
      ...(typeof record['loggingConsentVersion'] === 'number' &&
      Number.isInteger(record['loggingConsentVersion']) &&
      record['loggingConsentVersion'] > 0
        ? { loggingConsentVersion: record['loggingConsentVersion'] }
        : {}),
      ...(typeof record['loggingEnabled'] === 'boolean'
        ? { loggingEnabled: record['loggingEnabled'] }
        : {}),
      ...(isValidConfigurableLogLevel(record['loggingLevel'])
        ? { loggingLevel: record['loggingLevel'] }
        : {}),
    }
  } catch {
    return {}
  }
}

export function writeUiPreferences(
  patch: Partial<UiPreferences>,
  prefsFilePath?: string,
): UiPreferences {
  const path = prefsFilePath ?? defaultPrefsPath()
  const next: UiPreferences = {
    ...readUiPreferences(path),
    ...patch,
  }
  mkdirSync(dirname(path), { recursive: true })
  const tmp = `${path}.${process.pid}.${Date.now()}.tmp`
  writeFileSync(tmp, JSON.stringify(next, null, 2), { encoding: 'utf-8', mode: 0o600 })
  renameSync(tmp, path)
  return next
}

export function saveUiPreference<K extends keyof UiPreferences>(
  key: K,
  value: UiPreferences[K],
  prefsFilePath?: string,
): void {
  try {
    writeUiPreferences({ [key]: value } as Partial<UiPreferences>, prefsFilePath)
  } catch {
    /* non-critical UX preference */
  }
}

export function readLoggingPreferences(prefsFilePath?: string): LoggingPreferences {
  const prefs = readUiPreferences(prefsFilePath)
  const consent: LoggingConsentState = prefs.loggingConsent ?? 'unset'
  const consentVersion = prefs.loggingConsentVersion ?? 0
  const enabled =
    consent === 'enabled'
      ? (prefs.loggingEnabled ?? true)
      : consent === 'disabled'
        ? (prefs.loggingEnabled ?? false)
        : false
  const level: 'info' | 'debug' = prefs.loggingLevel ?? 'info'
  return {
    consent,
    consentVersion,
    enabled,
    level,
  }
}

export function saveLoggingPreferences(
  patch: Partial<LoggingPreferences>,
  prefsFilePath?: string,
): LoggingPreferences {
  const current = readLoggingPreferences(prefsFilePath)
  const next: LoggingPreferences = {
    consent: patch.consent ?? current.consent,
    consentVersion:
      patch.consentVersion ??
      (patch.consent && patch.consent !== 'unset' ? LOG_CONSENT_VERSION : current.consentVersion),
    enabled: patch.enabled ?? current.enabled,
    level: patch.level ?? current.level,
  }
  writeUiPreferences(
    {
      loggingConsent: next.consent,
      loggingConsentVersion: next.consentVersion,
      loggingEnabled: next.enabled,
      loggingLevel: next.level,
    },
    prefsFilePath,
  )
  return next
}

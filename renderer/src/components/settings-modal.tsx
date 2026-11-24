/**
 * 设置弹窗 — 左侧分栏导航：
 *   - 常规与地理：高德 / 百度 / 腾讯 API Keys（保存后重启引擎）
 *   - 日志与诊断：本地运行日志开关、级别、设备标识、导出脱敏日志包、打开目录、清空日志（即时生效）
 *   - 模型与数据：本地模型版本与加载态 + 清理本地识别记录
 *   - 关于与更新：版本、作者、反馈联系、GitHub Release 更新检查
 */
import {
  AlertTriangle,
  Check,
  Copy,
  Cpu,
  Download,
  ExternalLink,
  Eye,
  EyeOff,
  FileText,
  FolderOpen,
  Globe,
  Info,
  RefreshCw,
  Save,
  ShieldCheck,
  Trash2,
  X,
} from 'lucide-react'
import { useQueryClient } from '@tanstack/react-query'
import { useCallback, useEffect, useId, useRef, useState, type ReactElement } from 'react'
import { useTranslation } from 'react-i18next'

import type { LoggingStatusSnapshot } from '../../../shared/client-log'
import {
  api,
  ApiError,
  type ClearHistoryResponse,
  type ModelVersionsResponse,
} from '@/lib/api-client'
import { formatBytes } from '@/lib/format-bytes'
import { flushRendererLogs } from '@/lib/logger'
import { cn } from '@/lib/utils'
import { useShallow, useUIStore } from '@/stores/ui-store'
import type { UpdateCheckResult } from '@/env'
import { useModalDialog } from '@/hooks/use-modal-dialog'

type SettingsTab = 'general' | 'logging' | 'models' | 'about'

interface KeyFieldProps {
  hideLabel: string
  label: string
  hint: string
  showLabel: string
  value: string
  onChange: (value: string) => void
}

function KeyField({
  hideLabel,
  label,
  hint,
  showLabel,
  value,
  onChange,
}: KeyFieldProps): ReactElement {
  const [show, setShow] = useState(false)
  const id = useId()
  return (
    <div className="settings-field">
      <div className="settings-field__head">
        <label htmlFor={id} className="settings-field__label">
          {label}
        </label>
        <button
          aria-label={`${show ? hideLabel : showLabel} (${label})`}
          aria-pressed={show}
          className="settings-field__toggle"
          onClick={() => setShow((v) => !v)}
          type="button"
        >
          {show ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
        </button>
      </div>
      <input
        id={id}
        name={id}
        autoComplete="off"
        className="settings-field__input"
        onChange={(e) => onChange(e.target.value)}
        placeholder={hint}
        spellCheck={false}
        type={show ? 'text' : 'password'}
        value={value}
      />
    </div>
  )
}

const CONTACT_EMAIL = 'wlfcss@gmail.com'
const GITHUB_URL = 'https://github.com/wlfcss/PlumeLens'
const BLOG_URL = 'https://www.wlfcss.com'

function formatDate(value: string | null): string {
  if (!value) return '--'
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value
  return date.toLocaleString()
}

function describeUpdateFailure(
  result: Extract<UpdateCheckResult, { ok: false }>,
  t: ReturnType<typeof useTranslation>['t'],
): string {
  if (result.reason === 'rate_limited') {
    const resetAt = Number(result.message)
    if (Number.isFinite(resetAt) && resetAt > 0) {
      return t('settings.update.rateLimitedUntil', {
        time: new Date(resetAt).toLocaleTimeString(),
      })
    }
    return t('settings.update.rateLimited')
  }
  if (result.reason === 'not_found') return t('settings.update.notFound')
  return t('settings.update.failed', { error: result.message })
}

function clearHistorySummary(result: ClearHistoryResponse): string {
  return [
    result.libraries_deleted,
    result.photos_deleted,
    result.analysis_results_deleted,
    result.decisions_deleted + result.species_overrides_deleted,
  ].join(' / ')
}

export function SettingsModal(): ReactElement | null {
  const { t } = useTranslation()
  const queryClient = useQueryClient()
  const { open, setOpen, setActiveFolderId, clearSelectionSpeciesFilters } = useUIStore(
    useShallow((s) => ({
      open: s.settingsOpen,
      setOpen: s.setSettingsOpen,
      setActiveFolderId: s.setActiveFolderId,
      clearSelectionSpeciesFilters: s.clearSelectionSpeciesFilters,
    })),
  )

  const [activeTab, setActiveTab] = useState<SettingsTab>('general')
  const [amapKey, setAmapKey] = useState('')
  const dialogRef = useModalDialog(open)
  const [baiduAk, setBaiduAk] = useState('')
  const [tencentKey, setTencentKey] = useState('')
  const [version, setVersion] = useState('')
  const [modelVersions, setModelVersions] = useState<ModelVersionsResponse | null>(null)
  const [modelError, setModelError] = useState<string | null>(null)
  const [updateCheck, setUpdateCheck] = useState<UpdateCheckResult | null>(null)
  const [checkingUpdate, setCheckingUpdate] = useState(false)
  const [saving, setSaving] = useState(false)
  const [savedHint, setSavedHint] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)
  const [clearConfirming, setClearConfirming] = useState(false)
  const [clearingHistory, setClearingHistory] = useState(false)
  const [clearResult, setClearResult] = useState<ClearHistoryResponse | null>(null)
  const [clearError, setClearError] = useState<string | null>(null)

  // 日志与诊断状态
  const [logStatus, setLogStatus] = useState<LoggingStatusSnapshot | null>(null)
  const [logBusy, setLogBusy] = useState(false)
  const [logNotice, setLogNotice] = useState<string | null>(null)
  const [logError, setLogError] = useState<string | null>(null)
  const [exportedBundlePath, setExportedBundlePath] = useState<string | null>(null)
  const [clearLogsConfirming, setClearLogsConfirming] = useState(false)
  const [copiedDeviceId, setCopiedDeviceId] = useState(false)

  const savedHintTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const copyTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const updateCheckSeqRef = useRef(0)

  const clearSavedHintTimer = useCallback(() => {
    if (savedHintTimerRef.current !== null) {
      clearTimeout(savedHintTimerRef.current)
      savedHintTimerRef.current = null
    }
  }, [])

  const openExternal = useCallback((url: string) => {
    void window.plumelens?.openExternalUrl?.(url)
  }, [])

  const refreshLogStatus = useCallback(async () => {
    const getStatus = window.plumelens?.getLoggingStatus
    if (typeof getStatus !== 'function') return
    try {
      const status = await getStatus()
      setLogStatus(status)
    } catch {
      /* ignore when IPC unavailable */
    }
  }, [])

  const handleCheckUpdates = useCallback(async () => {
    const seq = ++updateCheckSeqRef.current
    setCheckingUpdate(true)
    try {
      const result = await window.plumelens?.checkForUpdates?.()
      if (updateCheckSeqRef.current !== seq) return
      setUpdateCheck(result ?? null)
    } catch (err) {
      if (updateCheckSeqRef.current !== seq) return
      setUpdateCheck({
        ok: false,
        currentVersion: '0.0.0',
        reason: 'network',
        message: err instanceof Error ? err.message : String(err),
      })
    } finally {
      if (updateCheckSeqRef.current === seq) {
        setCheckingUpdate(false)
      }
    }
  }, [])

  // 打开时拉当前值
  useEffect(() => {
    if (!open) return
    let cancelled = false
    clearSavedHintTimer()
    setSavedHint(false)
    setSaveError(null)
    setClearConfirming(false)
    setClearError(null)
    setClearResult(null)
    setLogNotice(null)
    setLogError(null)
    setExportedBundlePath(null)
    setClearLogsConfirming(false)
    setModelError(null)
    setModelVersions(null)
    setUpdateCheck(null)

    void window.plumelens?.getUserSettings?.().then((s) => {
      if (cancelled) return
      setAmapKey(s.amapKey ?? '')
      setBaiduAk(s.baiduAk ?? '')
      setTencentKey(s.tencentKey ?? '')
    })
    void window.plumelens?.getAppVersion?.().then((v) => {
      if (!cancelled) setVersion(v)
    })
    void refreshLogStatus()
    void api
      .modelVersions()
      .then((payload) => {
        if (!cancelled) setModelVersions(payload)
      })
      .catch((err) => {
        if (cancelled) return
        const message = err instanceof Error ? err.message : String(err)
        setModelError(message)
      })
    void handleCheckUpdates()

    const unsubscribeLog = window.plumelens?.onLoggingStateChanged?.((next) => {
      if (!cancelled) setLogStatus(next)
    })

    return () => {
      cancelled = true
      updateCheckSeqRef.current += 1
      unsubscribeLog?.()
    }
  }, [clearSavedHintTimer, handleCheckUpdates, open, refreshLogStatus])

  const closeModal = useCallback(() => {
    if (!saving && !clearingHistory && !logBusy) setOpen(false)
  }, [clearingHistory, logBusy, saving, setOpen])

  useEffect(() => {
    return () => {
      clearSavedHintTimer()
      if (copyTimerRef.current !== null) clearTimeout(copyTimerRef.current)
    }
  }, [clearSavedHintTimer])

  const handleSave = useCallback(async () => {
    setSaving(true)
    setSaveError(null)
    try {
      const result = await window.plumelens?.saveUserSettings?.({
        amapKey: amapKey.trim(),
        baiduAk: baiduAk.trim(),
        tencentKey: tencentKey.trim(),
      })
      if (result && result.ok === false) {
        if (result.reason === 'safe_storage_unavailable') {
          setSaveError(t('settings.error.safeStorageUnavailable'))
        } else {
          setSaveError(result.message)
        }
        return
      }
      const restarted = await window.plumelens?.restartEngine?.()
      if (restarted === false) {
        setSaveError(t('settings.error.restartFailed'))
        return
      }
      clearSavedHintTimer()
      setSavedHint(true)
      savedHintTimerRef.current = setTimeout(() => {
        setSavedHint(false)
        savedHintTimerRef.current = null
      }, 2400)
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      setSaveError(message)
    } finally {
      setSaving(false)
    }
  }, [amapKey, baiduAk, clearSavedHintTimer, t, tencentKey])

  const handleClearHistory = useCallback(async () => {
    setClearingHistory(true)
    setClearError(null)
    try {
      const result = await api.clearLocalHistory()
      setClearResult(result)
      setClearConfirming(false)
      setActiveFolderId(null)
      clearSelectionSpeciesFilters()
      await queryClient.invalidateQueries()
    } catch (err) {
      const message =
        err instanceof ApiError ? err.message : err instanceof Error ? err.message : String(err)
      setClearError(message)
    } finally {
      setClearingHistory(false)
    }
  }, [clearSelectionSpeciesFilters, queryClient, setActiveFolderId])

  const handleToggleLogging = useCallback(
    async (nextEnabled: boolean) => {
      if (!window.plumelens?.setLoggingEnabled) return
      setLogBusy(true)
      setLogError(null)
      setLogNotice(null)
      try {
        const status = await window.plumelens.setLoggingEnabled(nextEnabled)
        setLogStatus(status)
        setLogNotice(
          nextEnabled ? t('settings.logging.enabledFeedback') : t('settings.logging.disabledFeedback'),
        )
      } catch (err) {
        setLogError(err instanceof Error ? err.message : String(err))
      } finally {
        setLogBusy(false)
      }
    },
    [t],
  )

  const handleChangeLogLevel = useCallback(
    async (nextLevel: 'info' | 'debug') => {
      if (!window.plumelens?.setLoggingLevel) return
      setLogBusy(true)
      setLogError(null)
      setLogNotice(null)
      try {
        const status = await window.plumelens.setLoggingLevel(nextLevel)
        setLogStatus(status)
      } catch (err) {
        setLogError(err instanceof Error ? err.message : String(err))
      } finally {
        setLogBusy(false)
      }
    },
    [],
  )

  const handleExportLogs = useCallback(async () => {
    if (!window.plumelens?.exportDiagnosticsBundle) return
    setLogBusy(true)
    setLogError(null)
    setLogNotice(null)
    setExportedBundlePath(null)
    try {
      flushRendererLogs()
      const res = await window.plumelens.exportDiagnosticsBundle()
      if (res.ok) {
        setExportedBundlePath(res.path)
        setLogNotice(
          t('settings.logging.exportSuccess', {
            size: formatBytes(res.sizeBytes),
            count: res.fileCount,
          }),
        )
        await refreshLogStatus()
      } else if (!res.canceled) {
        setLogError(t('settings.logging.exportFailed', { error: res.message ?? res.reason }))
      }
    } catch (err) {
      setLogError(
        t('settings.logging.exportFailed', {
          error: err instanceof Error ? err.message : String(err),
        }),
      )
    } finally {
      setLogBusy(false)
    }
  }, [refreshLogStatus, t])

  const handleClearLogs = useCallback(async () => {
    if (!window.plumelens?.clearLogs) return
    setLogBusy(true)
    setLogError(null)
    setLogNotice(null)
    setExportedBundlePath(null)
    try {
      const res = await window.plumelens.clearLogs()
      if (res.ok) {
        setClearLogsConfirming(false)
        setLogNotice(
          t('settings.logging.clearSuccess', {
            size: formatBytes(res.freedBytes),
            count: res.removedFiles,
          }),
        )
        await refreshLogStatus()
      } else {
        setLogError(t('settings.logging.clearFailed', { error: res.message ?? res.reason }))
      }
    } catch (err) {
      setLogError(
        t('settings.logging.clearFailed', {
          error: err instanceof Error ? err.message : String(err),
        }),
      )
    } finally {
      setLogBusy(false)
    }
  }, [refreshLogStatus, t])

  const handleCopyDeviceId = useCallback(() => {
    const id = logStatus?.deviceId
    if (!id || typeof navigator === 'undefined' || !navigator.clipboard) return
    void navigator.clipboard.writeText(id).then(() => {
      setCopiedDeviceId(true)
      if (copyTimerRef.current !== null) clearTimeout(copyTimerRef.current)
      copyTimerRef.current = setTimeout(() => {
        setCopiedDeviceId(false)
        copyTimerRef.current = null
      }, 2000)
    })
  }, [logStatus?.deviceId])

  if (!open) return null

  const busy = saving || clearingHistory || logBusy
  const canUseLogIpc = Boolean(window.plumelens?.getLoggingStatus)

  const navItems: Array<{ id: SettingsTab; label: string; icon: typeof Globe }> = [
    { id: 'general', label: t('settings.tabs.general'), icon: Globe },
    { id: 'logging', label: t('settings.tabs.logging'), icon: FileText },
    { id: 'models', label: t('settings.tabs.models'), icon: Cpu },
    { id: 'about', label: t('settings.tabs.about'), icon: Info },
  ]

  return (
    <dialog
      ref={dialogRef}
      aria-label={t('settings.title')}
      onCancel={(event) => {
        event.preventDefault()
        closeModal()
      }}
      className="overlay-backdrop"
      onPointerDown={(event) => {
        if (event.target === event.currentTarget) closeModal()
      }}
    >
      <div className="settings-panel" onPointerDown={(event) => event.stopPropagation()}>
        <header className="settings-panel__head">
          <h2>{t('settings.title')}</h2>
          <button
            aria-label={t('common.close')}
            className="icon-button"
            disabled={busy}
            onClick={closeModal}
            type="button"
          >
            <X className="h-4 w-4" />
          </button>
        </header>

        <div className="settings-shell">
          <nav aria-label={t('settings.tabs.label')} className="settings-nav" role="tablist">
            {navItems.map((item) => {
              const Icon = item.icon
              const selected = activeTab === item.id
              return (
                <button
                  aria-selected={selected}
                  className={cn('settings-nav__item', selected && 'settings-nav__item--active')}
                  key={item.id}
                  onClick={() => setActiveTab(item.id)}
                  role="tab"
                  type="button"
                >
                  <Icon className="h-4 w-4 shrink-0" />
                  <span>{item.label}</span>
                </button>
              )
            })}
          </nav>

          <div className="settings-content selection-scroll" role="tabpanel">
            {activeTab === 'general' ? (
              <section className="settings-section settings-section--geocoding">
                <h3 className="settings-section__title">{t('settings.geocoding.title')}</h3>
                <p className="settings-section__hint">{t('settings.geocoding.hint')}</p>

                <KeyField
                  hideLabel={t('settings.geocoding.hideKey')}
                  label={t('settings.geocoding.amapLabel')}
                  hint={t('settings.geocoding.amapHint')}
                  onChange={setAmapKey}
                  showLabel={t('settings.geocoding.showKey')}
                  value={amapKey}
                />
                <KeyField
                  hideLabel={t('settings.geocoding.hideKey')}
                  label={t('settings.geocoding.baiduLabel')}
                  hint={t('settings.geocoding.baiduHint')}
                  onChange={setBaiduAk}
                  showLabel={t('settings.geocoding.showKey')}
                  value={baiduAk}
                />
                <KeyField
                  hideLabel={t('settings.geocoding.hideKey')}
                  label={t('settings.geocoding.tencentLabel')}
                  hint={t('settings.geocoding.tencentHint')}
                  onChange={setTencentKey}
                  showLabel={t('settings.geocoding.showKey')}
                  value={tencentKey}
                />
              </section>
            ) : null}

            {activeTab === 'logging' ? (
              <div className="settings-stack">
                <section className="settings-section">
                  <div className="settings-log-toggle-row">
                    <div className="settings-log-toggle-row__text">
                      <h3 className="settings-section__title">{t('settings.logging.title')}</h3>
                      <p className="settings-section__hint settings-section__hint--tight">
                        {t('settings.logging.hint')}
                      </p>
                    </div>
                    <button
                      aria-checked={Boolean(logStatus?.enabled)}
                      aria-label={t('settings.logging.toggleAria')}
                      className={cn(
                        'settings-switch',
                        logStatus?.enabled && 'settings-switch--checked',
                      )}
                      disabled={!canUseLogIpc || logBusy}
                      onClick={() => void handleToggleLogging(!logStatus?.enabled)}
                      role="switch"
                      type="button"
                    >
                      <span className="settings-switch__thumb" />
                    </button>
                  </div>

                  <div className="settings-log-meta-grid">
                    <div className="settings-log-meta-card">
                      <span className="settings-log-meta-card__label">
                        {t('settings.logging.statusLabel')}
                      </span>
                      <span className="settings-log-meta-card__value">
                        {logStatus?.enabled
                          ? t('settings.logging.statusEnabled')
                          : t('settings.logging.statusDisabled')}
                      </span>
                    </div>
                    <div className="settings-log-meta-card">
                      <span className="settings-log-meta-card__label">
                        {t('settings.logging.storageLabel')}
                      </span>
                      <span className="settings-log-meta-card__value">
                        {logStatus
                          ? t('settings.logging.storageValue', {
                              size: formatBytes(logStatus.totalBytes),
                              crashes: logStatus.crashCount,
                            })
                          : '--'}
                      </span>
                    </div>
                    <div className="settings-log-meta-card settings-log-meta-card--wide">
                      <span className="settings-log-meta-card__label">
                        {t('settings.logging.deviceIdLabel')}
                      </span>
                      <div className="settings-log-device-row">
                        <code className="settings-log-device-code">
                          {logStatus?.deviceId ?? t('settings.logging.deviceIdPending')}
                        </code>
                        {logStatus?.deviceId ? (
                          <button
                            className="button-ghost button-compact"
                            onClick={handleCopyDeviceId}
                            type="button"
                          >
                            {copiedDeviceId ? (
                              <Check className="h-3.5 w-3.5" />
                            ) : (
                              <Copy className="h-3.5 w-3.5" />
                            )}
                            {copiedDeviceId
                              ? t('settings.logging.copied')
                              : t('settings.logging.copy')}
                          </button>
                        ) : null}
                      </div>
                    </div>
                  </div>

                  <div className="settings-log-level-row">
                    <div>
                      <span className="settings-field__label">{t('settings.logging.levelLabel')}</span>
                      <p className="settings-section__hint settings-section__hint--compact">
                        {t('settings.logging.levelHint')}
                      </p>
                    </div>
                    <div className="settings-segmented" role="group">
                      <button
                        aria-pressed={(logStatus?.level ?? 'info') === 'info'}
                        className={cn(
                          'settings-segmented__btn',
                          (logStatus?.level ?? 'info') === 'info' && 'settings-segmented__btn--active',
                        )}
                        disabled={!canUseLogIpc || logBusy || !logStatus?.enabled}
                        onClick={() => void handleChangeLogLevel('info')}
                        type="button"
                      >
                        {t('settings.logging.levelInfo')}
                      </button>
                      <button
                        aria-pressed={logStatus?.level === 'debug'}
                        className={cn(
                          'settings-segmented__btn',
                          logStatus?.level === 'debug' && 'settings-segmented__btn--active',
                        )}
                        disabled={!canUseLogIpc || logBusy || !logStatus?.enabled}
                        onClick={() => void handleChangeLogLevel('debug')}
                        type="button"
                      >
                        {t('settings.logging.levelDebug')}
                      </button>
                    </div>
                  </div>
                </section>

                <section className="settings-section">
                  <h3 className="settings-section__title">{t('settings.logging.actionsTitle')}</h3>
                  <p className="settings-section__hint">{t('settings.logging.exportHint')}</p>

                  {logNotice ? (
                    <div className="settings-log-feedback settings-log-feedback--ok" role="status">
                      <span>{logNotice}</span>
                      {exportedBundlePath ? (
                        <button
                          className="button-ghost button-compact"
                          onClick={() =>
                            void window.plumelens?.openPathInFinder?.(exportedBundlePath)
                          }
                          type="button"
                        >
                          <FolderOpen className="h-3.5 w-3.5" />
                          {t('settings.logging.revealExported')}
                        </button>
                      ) : null}
                    </div>
                  ) : null}
                  {logError ? (
                    <p className="settings-panel__error" role="alert">
                      {logError}
                    </p>
                  ) : null}

                  <div className="settings-log-actions">
                    <button
                      className="button-primary"
                      disabled={!canUseLogIpc || logBusy}
                      onClick={() => void handleExportLogs()}
                      type="button"
                    >
                      <Download className="h-4 w-4" />
                      {logBusy
                        ? t('settings.logging.exporting')
                        : t('settings.logging.exportAction')}
                    </button>
                    <button
                      className="button-ghost"
                      disabled={!window.plumelens?.openLogsDir || logBusy}
                      onClick={() => void window.plumelens?.openLogsDir?.()}
                      type="button"
                    >
                      <FolderOpen className="h-4 w-4" />
                      {t('settings.logging.openDirAction')}
                    </button>
                    {!clearLogsConfirming ? (
                      <button
                        className="button-ghost"
                        disabled={!canUseLogIpc || logBusy || (logStatus?.fileCount ?? 0) === 0}
                        onClick={() => {
                          setLogNotice(null)
                          setLogError(null)
                          setClearLogsConfirming(true)
                        }}
                        type="button"
                      >
                        <Trash2 className="h-4 w-4" />
                        {t('settings.logging.clearAction')}
                      </button>
                    ) : null}
                  </div>

                  {clearLogsConfirming ? (
                    <div className="settings-confirm settings-confirm--spaced">
                      <AlertTriangle className="h-4 w-4" />
                      <div className="settings-confirm__body">
                        <strong>{t('settings.logging.clearConfirmTitle')}</strong>
                        <span>{t('settings.logging.clearConfirmBody')}</span>
                      </div>
                      <button
                        className="button-ghost"
                        disabled={logBusy}
                        onClick={() => setClearLogsConfirming(false)}
                        type="button"
                      >
                        {t('common.cancel')}
                      </button>
                      <button
                        className="button-danger"
                        disabled={logBusy}
                        onClick={() => void handleClearLogs()}
                        type="button"
                      >
                        <Trash2 className="h-4 w-4" />
                        {t('settings.logging.clearConfirmAction')}
                      </button>
                    </div>
                  ) : null}
                </section>

                <section className="settings-section settings-section--privacy">
                  <h3 className="settings-section__title settings-section__title--icon">
                    <ShieldCheck className="h-3.5 w-3.5" />
                    {t('settings.logging.privacyTitle')}
                  </h3>
                  <ul className="settings-privacy-list">
                    <li>{t('settings.logging.privacyItem1')}</li>
                    <li>{t('settings.logging.privacyItem2')}</li>
                    <li>{t('settings.logging.privacyItem3')}</li>
                  </ul>
                </section>
              </div>
            ) : null}

            {activeTab === 'models' ? (
              <div className="settings-stack">
                <section className="settings-section">
                  <h3 className="settings-section__title">{t('settings.models.title')}</h3>
                  <p className="settings-section__hint">
                    {t('settings.models.hint', {
                      pipeline: modelVersions?.pipeline_version ?? '--',
                    })}
                  </p>
                  {modelError ? (
                    <p className="settings-panel__error">
                      {t('settings.models.failed', { error: modelError })}
                    </p>
                  ) : modelVersions ? (
                    <div className="settings-model-list">
                      {modelVersions.models.map((model) => (
                        <div className="settings-model-row" key={model.id}>
                          <div className="settings-model-row__main">
                            <span className="settings-model-row__name">{model.label}</span>
                            <span className="settings-model-row__meta">
                              {model.version} · {model.revision}
                            </span>
                          </div>
                          <span
                            className={
                              model.loaded
                                ? 'settings-model-row__status settings-model-row__status--loaded'
                                : 'settings-model-row__status'
                            }
                          >
                            {model.loaded
                              ? t('settings.models.loaded')
                              : t('settings.models.notLoaded')}
                          </span>
                        </div>
                      ))}
                      <p className="settings-section__hint settings-section__hint--compact">
                        {t('settings.models.generatedAt', {
                          date: formatDate(modelVersions.manifest_generated_at),
                        })}
                      </p>
                    </div>
                  ) : (
                    <p className="settings-section__hint settings-section__hint--compact">
                      {t('settings.models.loading')}
                    </p>
                  )}
                </section>

                <section className="settings-section settings-section--danger">
                  <h3 className="settings-section__title">{t('settings.history.title')}</h3>
                  <p className="settings-section__hint">{t('settings.history.hint')}</p>
                  {clearResult ? (
                    <p className="settings-panel__saved">
                      {t('settings.history.cleared', {
                        summary: clearHistorySummary(clearResult),
                      })}
                    </p>
                  ) : null}
                  {clearError ? (
                    <p className="settings-panel__error">
                      {t('settings.history.failed', { error: clearError })}
                    </p>
                  ) : null}
                  {clearConfirming ? (
                    <div className="settings-confirm">
                      <AlertTriangle className="h-4 w-4" />
                      <div className="settings-confirm__body">
                        <strong>{t('settings.history.confirmTitle')}</strong>
                        <span>{t('settings.history.confirmBody')}</span>
                      </div>
                      <button
                        className="button-ghost"
                        disabled={clearingHistory}
                        onClick={() => setClearConfirming(false)}
                        type="button"
                      >
                        {t('common.cancel')}
                      </button>
                      <button
                        className="button-danger"
                        disabled={clearingHistory}
                        onClick={handleClearHistory}
                        type="button"
                      >
                        <Trash2 className="h-4 w-4" />
                        {clearingHistory
                          ? t('settings.history.clearing')
                          : t('settings.history.confirmAction')}
                      </button>
                    </div>
                  ) : (
                    <button
                      className="button-danger"
                      disabled={clearingHistory}
                      onClick={() => {
                        setClearResult(null)
                        setClearError(null)
                        setClearConfirming(true)
                      }}
                      type="button"
                    >
                      <Trash2 className="h-4 w-4" />
                      {t('settings.history.clearAction')}
                    </button>
                  )}
                </section>
              </div>
            ) : null}

            {activeTab === 'about' ? (
              <div className="settings-stack">
                <section className="settings-section settings-section--about">
                  <h3 className="settings-section__title">{t('settings.about.title')}</h3>
                  <div className="settings-about-list">
                    <div className="settings-about">
                      <span className="settings-about__label">{t('settings.about.version')}</span>
                      <span className="settings-about__value">{version || '--'}</span>
                    </div>
                    <div className="settings-about">
                      <span className="settings-about__label">{t('settings.about.author')}</span>
                      <button
                        aria-label={t('settings.about.authorBlog')}
                        className="settings-link settings-link--mono"
                        onClick={() => openExternal(BLOG_URL)}
                        title={BLOG_URL}
                        type="button"
                      >
                        {t('settings.about.authorValue')}
                        <ExternalLink className="h-3 w-3" />
                      </button>
                    </div>
                    <div className="settings-about">
                      <span className="settings-about__label">{t('settings.about.contact')}</span>
                      <button
                        className="settings-link"
                        onClick={() => openExternal(`mailto:${CONTACT_EMAIL}`)}
                        type="button"
                      >
                        {t('settings.about.contactValue')}
                        <ExternalLink className="h-3 w-3" />
                      </button>
                    </div>
                    <div className="settings-about">
                      <span className="settings-about__label">{t('settings.about.github')}</span>
                      <button
                        className="settings-link"
                        onClick={() => openExternal(GITHUB_URL)}
                        type="button"
                      >
                        {t('settings.about.githubValue')}
                        <ExternalLink className="h-3 w-3" />
                      </button>
                    </div>
                    <div className="settings-about">
                      <span className="settings-about__label">{t('settings.about.license')}</span>
                      <span className="settings-about__value">
                        {t('settings.about.licenseValue')}
                      </span>
                    </div>
                    <p className="settings-section__hint settings-section__hint--compact">
                      {t('settings.about.copyright')}
                    </p>
                  </div>
                </section>

                <section className="settings-section settings-section--update">
                  <h3 className="settings-section__title">{t('settings.update.title')}</h3>
                  <div className="settings-update">
                    <div>
                      <p className="settings-update__status">
                        {checkingUpdate
                          ? t('settings.update.checking')
                          : updateCheck?.ok
                            ? updateCheck.hasUpdate
                              ? t('settings.update.available', {
                                  version: updateCheck.latestVersion,
                                })
                              : t('settings.update.upToDate')
                            : updateCheck
                              ? describeUpdateFailure(updateCheck, t)
                              : t('settings.update.idle')}
                      </p>
                      {updateCheck?.ok ? (
                        <p className="settings-section__hint settings-section__hint--compact">
                          {t('settings.update.latestMeta', {
                            version: updateCheck.latestVersion,
                            date: formatDate(updateCheck.publishedAt),
                          })}
                        </p>
                      ) : null}
                    </div>
                    <div className="settings-update__actions">
                      {updateCheck?.ok && updateCheck.hasUpdate ? (
                        <button
                          className="button-ghost"
                          onClick={() => openExternal(updateCheck.releaseUrl)}
                          type="button"
                        >
                          <ExternalLink className="h-4 w-4" />
                          {t('settings.update.openRelease')}
                        </button>
                      ) : null}
                      <button
                        className="button-ghost"
                        disabled={checkingUpdate}
                        onClick={handleCheckUpdates}
                        type="button"
                      >
                        <RefreshCw className="h-4 w-4" />
                        {t('settings.update.checkNow')}
                      </button>
                    </div>
                  </div>
                </section>
              </div>
            ) : null}
          </div>
        </div>

        <footer className="settings-panel__foot">
          {activeTab === 'general' ? (
            <>
              {saveError ? (
                <span className="settings-panel__error" role="alert">
                  {t('settings.saveFailed', { error: saveError })}
                </span>
              ) : savedHint ? (
                <span className="settings-panel__saved">{t('settings.savedRestarted')}</span>
              ) : (
                <span className="settings-panel__hint">{t('settings.saveHint')}</span>
              )}
              <button className="button-ghost" disabled={busy} onClick={closeModal} type="button">
                {t('common.close')}
              </button>
              <button className="button-primary" disabled={busy} onClick={handleSave} type="button">
                <Save className="h-4 w-4" />
                {saving ? t('settings.saving') : t('settings.save')}
              </button>
            </>
          ) : (
            <>
              <span className="settings-panel__hint">{t('settings.instantHint')}</span>
              <button className="button-ghost" disabled={busy} onClick={closeModal} type="button">
                {t('common.close')}
              </button>
            </>
          )}
        </footer>
      </div>
    </dialog>
  )
}

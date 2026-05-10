/**
 * 设置弹窗 — 用户配置 reverse geocoding API keys 等。
 *
 * v1 范围:
 *   - 高德 / 百度 / 腾讯 三个 key 可填(任一即可,后端 chain 按顺序尝试)
 *   - 显示/隐藏 key(password input 默认遮挡)
 *   - 关于:版本号
 *   - 保存后必须重启 engine 才能让新 key 注入生效(后端通过 env var 读)
 *
 * 持久化到 ~/Library/Application Support/plumelens/settings.json,
 * process-manager 启动 engine 时读这个文件注入 PLUMELENS_*_KEY env。
 */
import { AlertTriangle, ExternalLink, Eye, EyeOff, RefreshCw, Save, Trash2, X } from 'lucide-react'
import { useQueryClient } from '@tanstack/react-query'
import { useCallback, useEffect, useRef, useState, type ReactElement } from 'react'
import { useTranslation } from 'react-i18next'

import {
  api,
  ApiError,
  type ClearHistoryResponse,
  type ModelVersionsResponse,
} from '@/lib/api-client'
import { useShallow, useUIStore } from '@/stores/ui-store'
import type { UpdateCheckResult } from '@/env'

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
  return (
    <div className="settings-field">
      <div className="settings-field__head">
        <label className="settings-field__label">{label}</label>
        <button
          aria-label={show ? hideLabel : showLabel}
          className="settings-field__toggle"
          onClick={() => setShow((v) => !v)}
          type="button"
        >
          {show ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
        </button>
      </div>
      <input
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

function formatDate(value: string | null): string {
  if (!value) return '--'
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value
  return date.toLocaleString()
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
  const { open, setOpen, setActiveFolderId } = useUIStore(
    useShallow((s) => ({
      open: s.settingsOpen,
      setOpen: s.setSettingsOpen,
      setActiveFolderId: s.setActiveFolderId,
    })),
  )

  const [amapKey, setAmapKey] = useState('')
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
  const savedHintTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const clearSavedHintTimer = useCallback(() => {
    if (savedHintTimerRef.current !== null) {
      clearTimeout(savedHintTimerRef.current)
      savedHintTimerRef.current = null
    }
  }, [])

  const openExternal = useCallback((url: string) => {
    void window.plumelens?.openExternalUrl?.(url)
  }, [])

  const handleCheckUpdates = useCallback(async () => {
    setCheckingUpdate(true)
    try {
      const result = await window.plumelens?.checkForUpdates?.()
      setUpdateCheck(result ?? null)
    } catch (err) {
      setUpdateCheck({
        ok: false,
        currentVersion: '0.0.0',
        reason: 'network',
        message: err instanceof Error ? err.message : String(err),
      })
    } finally {
      setCheckingUpdate(false)
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
    return () => {
      cancelled = true
    }
  }, [clearSavedHintTimer, handleCheckUpdates, open])

  const closeModal = useCallback(() => {
    if (!saving && !clearingHistory) setOpen(false)
  }, [clearingHistory, saving, setOpen])

  useEffect(() => clearSavedHintTimer, [clearSavedHintTimer])

  useEffect(() => {
    if (!open) return undefined
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault()
        closeModal()
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [closeModal, open])

  const handleSave = useCallback(async () => {
    setSaving(true)
    setSaveError(null)
    try {
      const result = await window.plumelens?.saveUserSettings?.({
        amapKey: amapKey.trim(),
        baiduAk: baiduAk.trim(),
        tencentKey: tencentKey.trim(),
      })
      // 主进程加密失败(safe_storage_unavailable on Linux 无 libsecret)→ surface
      // 给用户,不静默继续 — 之前的 silent fallback 会让 plain key 写到 disk。
      if (result && result.ok === false) {
        if (result.reason === 'safe_storage_unavailable') {
          setSaveError(t('settings.error.safeStorageUnavailable'))
        } else {
          setSaveError(result.message)
        }
        return
      }
      // 让新 key 立刻生效:重启 engine。expensive 但用户配 key 是低频操作。
      await window.plumelens?.restartEngine?.()
      clearSavedHintTimer()
      setSavedHint(true)
      savedHintTimerRef.current = setTimeout(() => {
        setSavedHint(false)
        savedHintTimerRef.current = null
      }, 2400)
    } catch (err) {
      // IPC 失败/engine 重启失败必须给用户反馈,否则"保存"按钮按了无反应,
      // 用户以为成功但实际 key 未持久化或新 key 未注入到 engine env。
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
      await queryClient.invalidateQueries()
    } catch (err) {
      const message =
        err instanceof ApiError ? err.message : err instanceof Error ? err.message : String(err)
      setClearError(message)
    } finally {
      setClearingHistory(false)
    }
  }, [queryClient, setActiveFolderId])

  if (!open) return null

  const busy = saving || clearingHistory

  return (
    <div
      className="overlay-backdrop"
      onPointerDown={(event) => {
        if (event.target === event.currentTarget) closeModal()
      }}
    >
      <div
        className="settings-panel"
        onPointerDown={(event) => event.stopPropagation()}
        role="dialog"
        aria-modal="true"
      >
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

        <div className="settings-panel__body selection-scroll">
          <section className="settings-section">
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

          <section className="settings-section">
            <h3 className="settings-section__title">{t('settings.about.title')}</h3>
            <div className="settings-about-list">
              <div className="settings-about">
                <span className="settings-about__label">{t('settings.about.version')}</span>
                <span className="settings-about__value">{version || '--'}</span>
              </div>
              <div className="settings-about">
                <span className="settings-about__label">{t('settings.about.author')}</span>
                <span className="settings-about__value">{t('settings.about.authorValue')}</span>
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
                <span className="settings-about__value">{t('settings.about.licenseValue')}</span>
              </div>
              <p className="settings-section__hint settings-section__hint--compact">
                {t('settings.about.copyright')}
              </p>
            </div>
          </section>

          <section className="settings-section">
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
                        ? t('settings.update.failed', { error: updateCheck.message })
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
                      {model.loaded ? t('settings.models.loaded') : t('settings.models.notLoaded')}
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
                {t('settings.history.cleared', { summary: clearHistorySummary(clearResult) })}
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
                  {t('common.close')}
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

        <footer className="settings-panel__foot">
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
        </footer>
      </div>
    </div>
  )
}

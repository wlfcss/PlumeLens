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
import { Eye, EyeOff, Save, X } from 'lucide-react'
import { useCallback, useEffect, useRef, useState, type ReactElement } from 'react'
import { useTranslation } from 'react-i18next'

import { useShallow, useUIStore } from '@/stores/ui-store'

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

export function SettingsModal(): ReactElement | null {
  const { t } = useTranslation()
  const { open, setOpen } = useUIStore(
    useShallow((s) => ({ open: s.settingsOpen, setOpen: s.setSettingsOpen })),
  )

  const [amapKey, setAmapKey] = useState('')
  const [baiduAk, setBaiduAk] = useState('')
  const [tencentKey, setTencentKey] = useState('')
  const [version, setVersion] = useState('')
  const [saving, setSaving] = useState(false)
  const [savedHint, setSavedHint] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)
  const savedHintTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const clearSavedHintTimer = useCallback(() => {
    if (savedHintTimerRef.current !== null) {
      clearTimeout(savedHintTimerRef.current)
      savedHintTimerRef.current = null
    }
  }, [])

  // 打开时拉当前值
  useEffect(() => {
    if (!open) return
    let cancelled = false
    clearSavedHintTimer()
    setSavedHint(false)
    setSaveError(null)
    void window.plumelens?.getUserSettings?.().then((s) => {
      if (cancelled) return
      setAmapKey(s.amapKey ?? '')
      setBaiduAk(s.baiduAk ?? '')
      setTencentKey(s.tencentKey ?? '')
    })
    void window.plumelens?.getAppVersion?.().then((v) => {
      if (!cancelled) setVersion(v)
    })
    return () => {
      cancelled = true
    }
  }, [clearSavedHintTimer, open])

  const closeModal = useCallback(() => {
    if (!saving) setOpen(false)
  }, [saving, setOpen])

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

  if (!open) return null

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
            disabled={saving}
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
            <div className="settings-about">
              <span className="settings-about__label">{t('settings.about.version')}</span>
              <span className="settings-about__value">{version || '--'}</span>
            </div>
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
          <button className="button-ghost" disabled={saving} onClick={closeModal} type="button">
            {t('common.close')}
          </button>
          <button className="button-primary" disabled={saving} onClick={handleSave} type="button">
            <Save className="h-4 w-4" />
            {saving ? t('settings.saving') : t('settings.save')}
          </button>
        </footer>
      </div>
    </div>
  )
}

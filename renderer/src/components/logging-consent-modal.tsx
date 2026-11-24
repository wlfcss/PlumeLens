/**
 * 首次启动本地运行日志知情同意弹窗。
 *
 * 原则：
 * - 仅在 Electron 环境且主进程报告 `needsConsentPrompt === true` 时显示；
 * - 未经用户选择前，主进程不写入任何日志文件、不采集设备机器码与硬件配置；
 * - 文案克制透明，明确说明「记录什么 / 不会记录什么 / 仅保存在本机绝不自动上传」；
 * - 用户可自由选择开启或暂不开启，且随时可在「设置 → 日志与诊断」中更改。
 */

import { FileText, ShieldCheck } from 'lucide-react'
import { useCallback, useEffect, useState, type ReactElement } from 'react'
import { useTranslation } from 'react-i18next'

import { useModalDialog } from '@/hooks/use-modal-dialog'

export function LoggingConsentModal(): ReactElement | null {
  const { t } = useTranslation()
  const [open, setOpen] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const dialogRef = useModalDialog(open)

  useEffect(() => {
    const getStatus = window.plumelens?.getLoggingStatus
    if (typeof getStatus !== 'function') return
    let cancelled = false
    void getStatus()
      .then((status) => {
        if (!cancelled && status.needsConsentPrompt) {
          setOpen(true)
        }
      })
      .catch(() => {
        /* ignore if IPC unavailable */
      })
    return () => {
      cancelled = true
    }
  }, [])

  const handleDecision = useCallback(async (enabled: boolean) => {
    if (submitting) return
    setSubmitting(true)
    try {
      await window.plumelens?.setLoggingConsent?.(enabled)
    } catch {
      /* never block user from entering the app */
    } finally {
      setSubmitting(false)
      setOpen(false)
    }
  }, [submitting])

  if (!open) return null

  return (
    <dialog
      ref={dialogRef}
      aria-labelledby="logging-consent-title"
      className="overlay-backdrop"
      onCancel={(event) => {
        event.preventDefault()
      }}
    >
      <div className="consent-panel" onPointerDown={(event) => event.stopPropagation()}>
        <header className="consent-panel__head">
          <span className="consent-panel__badge">
            <ShieldCheck className="h-4 w-4" />
            {t('loggingConsent.badge')}
          </span>
          <h2 id="logging-consent-title" className="consent-panel__title">
            {t('loggingConsent.title')}
          </h2>
          <p className="consent-panel__lead">{t('loggingConsent.lead')}</p>
        </header>

        <div className="consent-panel__body">
          <div className="consent-item">
            <span className="consent-item__label">{t('loggingConsent.recordedLabel')}</span>
            <p className="consent-item__text">{t('loggingConsent.recordedBody')}</p>
          </div>
          <div className="consent-item">
            <span className="consent-item__label">{t('loggingConsent.notRecordedLabel')}</span>
            <p className="consent-item__text">{t('loggingConsent.notRecordedBody')}</p>
          </div>
          <div className="consent-item">
            <span className="consent-item__label">{t('loggingConsent.localOnlyLabel')}</span>
            <p className="consent-item__text">{t('loggingConsent.localOnlyBody')}</p>
          </div>
          <p className="consent-panel__footnote">
            <FileText className="h-3.5 w-3.5 shrink-0" />
            <span>{t('loggingConsent.settingsHint')}</span>
          </p>
        </div>

        <footer className="consent-panel__foot">
          <button
            className="button-ghost"
            disabled={submitting}
            onClick={() => void handleDecision(false)}
            type="button"
          >
            {t('loggingConsent.decline')}
          </button>
          <button
            className="button-primary"
            disabled={submitting}
            onClick={() => void handleDecision(true)}
            type="button"
          >
            {t('loggingConsent.accept')}
          </button>
        </footer>
      </div>
    </dialog>
  )
}

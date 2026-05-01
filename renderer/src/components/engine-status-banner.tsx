import { AlertTriangle, Loader2, Cpu } from 'lucide-react'
import type { ReactElement } from 'react'
import { useTranslation } from 'react-i18next'

import { useEngineStore } from '@/stores/engine-store'
import { useShallow } from '@/stores/ui-store'

/** 全局后端状态横幅 — 跨所有路由顶部显示。
 *
 * 显示条件:
 *  - reconnecting (后端崩溃/重启中) — 红色,告知用户分析进度会自动恢复
 *  - fatal (重启上限达到) — 深红,提示用户重启应用
 *  - degraded (已切到 CPU) — 黄色,告知速度会变慢但更稳
 *
 * ready 状态不显示(避免噪音)。 */
export function EngineStatusBanner(): ReactElement | null {
  const { t } = useTranslation()
  const { state, restartCount, maxRestarts, lastCrash, totalCrashes } = useEngineStore(
    useShallow((s) => ({
      state: s.state,
      restartCount: s.restartCount,
      maxRestarts: s.maxRestarts,
      lastCrash: s.lastCrash,
      totalCrashes: s.totalCrashes,
    })),
  )

  if (state === 'ready') return null

  const handleOpenLogs = (): void => {
    void window.plumelens?.openLogsDir?.()
  }

  if (state === 'reconnecting') {
    // 区分冷启 vs 真崩溃:lastCrash=null 是冷启中,文案"正在连接";
    // 有 lastCrash 是真崩溃过,文案"正在重启 (n/max)"。
    const isColdStart = lastCrash === null && totalCrashes === 0
    const message = isColdStart
      ? t('engineBanner.connecting')
      : restartCount > 0
        ? t('engineBanner.reconnecting', { count: restartCount, max: maxRestarts })
        : t('engineBanner.reconnectingNoCount')
    return (
      <div
        role="status"
        aria-live="polite"
        className="engine-banner engine-banner--reconnecting"
      >
        <Loader2 className="h-4 w-4 animate-spin" />
        <span>{message}</span>
        {!isColdStart ? (
          <span className="engine-banner__hint">
            {lastCrash?.signal
              ? t('engineBanner.lastCrash', { signal: lastCrash.signal })
              : null}
            {totalCrashes > 1 ? (
              <>
                {lastCrash?.signal ? ' · ' : ''}
                {t('engineBanner.totalCrashes', { count: totalCrashes })}
              </>
            ) : null}
          </span>
        ) : null}
      </div>
    )
  }

  if (state === 'fatal') {
    // dev shell / 测试无 IPC 时按钮 disabled — 避免按了无反应。
    const canOpenLogs = typeof window !== 'undefined' && Boolean(window.plumelens?.openLogsDir)
    return (
      <div role="alert" aria-live="assertive" className="engine-banner engine-banner--fatal">
        <AlertTriangle className="h-4 w-4" />
        <span>{t('engineBanner.fatal')}</span>
        <span className="engine-banner__hint">
          {totalCrashes > 0
            ? t('engineBanner.totalCrashes', { count: totalCrashes })
            : null}
        </span>
        <button
          className="engine-banner__action"
          disabled={!canOpenLogs}
          onClick={handleOpenLogs}
          type="button"
        >
          {t('engineBanner.openLogs')}
        </button>
      </div>
    )
  }

  // state === 'degraded' — CPU 降级,后端能跑但慢
  return (
    <div role="status" aria-live="polite" className="engine-banner engine-banner--degraded">
      <Cpu className="h-4 w-4" />
      <span>{t('engineBanner.cpuFallback')}</span>
    </div>
  )
}

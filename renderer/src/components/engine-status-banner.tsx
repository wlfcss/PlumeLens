import { AlertTriangle, Loader2, Cpu } from 'lucide-react'
import type { ReactElement } from 'react'
import { useTranslation } from 'react-i18next'

import { useEngineStore } from '@/stores/engine-store'
import { useShallow } from '@/stores/ui-store'

/** 全局后端状态横幅 — 跨所有路由顶部显示。
 *
 * 显示条件(只在 start screen 之外屏看不到 EnginePanel 的"异常"事件时才出现):
 *  - reconnecting **且已经崩过** — 橙色,告知分析会自动恢复
 *  - fatal — 红色,提示重启应用 + 查看日志
 *  - degraded — 黄色,CPU 降级提示
 *
 * 冷启 / ready 不显示:start screen 底部 EnginePanel 已经有完整状态展示,顶部
 * banner 重复;选片/羽迹屏冷启用户能看到管线 idle 不会主动操作,无需打扰。 */
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

  // 冷启 reconnecting(从未崩过) 不显示横幅 — 与 start 屏底部 EnginePanel 重复。
  // 真崩过(lastCrash 非空 或 totalCrashes>0) 才进 banner 流程。
  if (state === 'reconnecting' && lastCrash === null && totalCrashes === 0) {
    return null
  }

  const handleOpenLogs = (): void => {
    void window.plumelens?.openLogsDir?.()
  }

  if (state === 'reconnecting') {
    const message =
      restartCount > 0
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

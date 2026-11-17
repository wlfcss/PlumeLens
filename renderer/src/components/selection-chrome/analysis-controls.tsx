import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import {
  useCancelAnalysis,
  usePauseAnalysis,
  useQueueStats,
  useResumeAnalysis,
} from '@/hooks/use-analysis'

export function AnalysisControls({ libraryId }: { libraryId: string }) {
  const { t } = useTranslation()
  const { data } = useQueueStats(libraryId)
  const pause = usePauseAnalysis()
  const resume = useResumeAnalysis()
  const cancel = useCancelAnalysis()
  const [error, setError] = useState(false)
  if (data?.desired_state !== 'running' && data?.desired_state !== 'paused') return null
  const busy = pause.isPending || resume.isPending || cancel.isPending
  const paused = data.desired_state === 'paused'
  const act = (action: typeof pause) => {
    setError(false)
    void action.mutateAsync(libraryId).catch(() => setError(true))
  }
  return (
    <div className="analysis-controls">
      <button
        type="button"
        className="button-ghost button-compact"
        disabled={busy}
        onClick={() => act(paused ? resume : pause)}
      >
        {t(paused ? 'selection.resume' : 'selection.pause')}
      </button>
      <button
        type="button"
        className="button-ghost button-compact"
        disabled={busy}
        onClick={() => act(cancel)}
      >
        {t('selection.cancel')}
      </button>
      {error ? <span role="alert">{t('selection.operationFailed')}</span> : null}
    </div>
  )
}

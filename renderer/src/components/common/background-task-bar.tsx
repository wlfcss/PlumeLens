import type { useTranslation } from 'react-i18next'

import { GlyphMatrix } from '@/components/common/glyph-matrix'
import type { AnalysisProgressEvent } from '@/lib/api-client'
import { statusLabelKey } from '@/lib/i18n-keys'
import type { FolderRecord, FolderStatus } from '@/lib/workspace-types'
import { formatRatio, type Tone } from '@/lib/photo-helpers'

type TaskbarPresentation = {
  label: string
  detail: string
  tone: Tone
  indeterminate: boolean
  glyphValue: number
}

const INDETERMINATE_STATUSES = new Set<FolderStatus>([
  'scanning',
  'hashing',
  'updating',
  'exporting',
])

export function resolveBackgroundTaskbar(
  activeFolder: FolderRecord | null,
  progressEvent: AnalysisProgressEvent | null | undefined,
  refreshing: boolean,
  t: ReturnType<typeof useTranslation>['t'],
): TaskbarPresentation | null {
  if (!activeFolder) return null

  const status: FolderStatus = refreshing ? 'updating' : activeFolder.status
  if (INDETERMINATE_STATUSES.has(status)) {
    let detail = t('selection.taskbar.inProgress')
    if (status === 'exporting') {
      detail = t('selection.taskbar.exportingHint')
    } else if (status === 'hashing') {
      detail =
        activeFolder.totalCount > 0
          ? t('selection.taskbar.hashingCount', { count: activeFolder.totalCount })
          : t('selection.taskbar.inProgress')
    } else if (activeFolder.totalCount > 0) {
      detail = t('selection.taskbar.discoveredCount', { count: activeFolder.totalCount })
    }
    return {
      label: t(statusLabelKey(status)),
      detail,
      tone: 'warning',
      indeterminate: true,
      glyphValue: 4,
    }
  }

  const event = progressEvent?.library_id === activeFolder.id ? progressEvent : null
  const desiredState = event?.desired_state ?? null
  const activeWork = (event?.pending ?? 0) + (event?.processing ?? 0)
  const isAnalyzing =
    status === 'analyzing_partial' ||
    activeWork > 0 ||
    desiredState === 'paused' ||
    (desiredState === 'cancelled' && (event?.processing ?? 0) > 0)

  if (!isAnalyzing) return null

  const hasEventTotal = event !== null && event.total > 0
  const total = hasEventTotal ? event.total : activeFolder.totalCount
  const processed = hasEventTotal
    ? Math.min(event.total, event.completed + event.failed + event.dead)
    : Math.min(activeFolder.totalCount, activeFolder.analyzedCount)
  const failedCount = hasEventTotal ? event.failed + event.dead : 0

  let label = t(statusLabelKey('analyzing_partial'))
  let tone: Tone = 'success'
  if (desiredState === 'paused') {
    label = t('selection.taskbar.analysisPaused')
    tone = 'warning'
  } else if (desiredState === 'cancelled') {
    label = t('selection.taskbar.analysisStopping')
    tone = 'warning'
  }

  const indeterminate = total <= 0
  const ratio = indeterminate ? t('selection.taskbar.inProgress') : formatRatio(processed, total)
  const detail =
    failedCount > 0
      ? `${ratio} · ${t('selection.taskbar.failedCount', { count: failedCount })}`
      : ratio

  return {
    label,
    detail,
    tone,
    indeterminate,
    glyphValue: indeterminate
      ? 4
      : Math.max(1, Math.min(12, Math.round((processed / Math.max(total, 1)) * 12))),
  }
}

export function BackgroundTaskBar({
  activeFolder,
  progressEvent = null,
  refreshing = false,
  t,
}: {
  activeFolder: FolderRecord | null
  progressEvent?: AnalysisProgressEvent | null
  refreshing?: boolean
  t: ReturnType<typeof useTranslation>['t']
}) {
  const presentation = resolveBackgroundTaskbar(activeFolder, progressEvent, refreshing, t)
  if (!presentation) return null

  return (
    <footer
      className="background-taskbar"
      role="status"
      aria-busy={presentation.indeterminate ? 'true' : undefined}
    >
      <span>{presentation.label}</span>
      <GlyphMatrix
        indeterminate={presentation.indeterminate}
        tone={presentation.tone}
        value={presentation.glyphValue}
      />
      <span>{presentation.detail}</span>
    </footer>
  )
}

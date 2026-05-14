/**
 * 导出面板(sidecar 形态) — 用户筛选出"入选/可用/记录"组合 + 评分范围,
 * 把照片复制到目标文件夹,可选附 XMP sidecar / 仅 XMP / 按 grade 分目录布局。
 *
 * 状态机:idle → running → success | error。锁定状态:开始导出后 source 和
 * options 都被 snapshot 锁,UI 进 read-only,避免运行中改源数据。
 *
 * 边界:plumelens preload 暴露 selectExportDirectory + openPathInFinder;
 * 后端 api.exportLibrary 接收完整 options 一次性完成所有文件操作。
 */

import {
  ArrowLeft,
  ArrowRight,
  Check,
  Clock3,
  Download,
  FolderOpen,
  PencilLine,
  RefreshCw,
  Trophy,
  X,
} from 'lucide-react'
import { useMemo, useState } from 'react'
import type { useTranslation } from 'react-i18next'

import { MetricCell } from '@/components/common/metric-cell'
import { SectionLabel } from '@/components/common/section-label'
import { api, type ExportLibraryResponse } from '@/lib/api-client'
import { gradeLabelKey } from '@/lib/i18n-keys'
import type { FolderRecord, PhotoGrade, PhotoRecord } from '@/lib/workspace-types'
import { effectivePhotoGrade, type FolderSummary } from '@/lib/photo-helpers'
import { cn } from '@/lib/utils'

export type ExportLayout = 'merged' | 'by_grade'
export type ExportContentMode = 'files' | 'files_xmp' | 'xmp_only'

export type ExportSourceSnapshot = {
  folder: FolderRecord
  photos: PhotoRecord[]
  summary: FolderSummary
}

type ExportOptionsSnapshot = {
  grades: PhotoGrade[]
  min: number | null
  max: number | null
  layout: ExportLayout
  contentMode: ExportContentMode
  targetDir: string
}

function ExportOption({ title, value }: { title: string; value: string }) {
  return (
    <div className="export-option">
      <SectionLabel label={title} />
      <strong>{value}</strong>
    </div>
  )
}

export function ExportDrawer({
  onClose,
  source,
  t,
}: {
  onClose: () => void
  source: ExportSourceSnapshot
  t: ReturnType<typeof useTranslation>['t']
}) {
  const [grades, setGrades] = useState<PhotoGrade[]>(['select', 'usable', 'record'])
  const [minScore, setMinScore] = useState('')
  const [maxScore, setMaxScore] = useState('')
  const [layout, setLayout] = useState<ExportLayout>('merged')
  const [contentMode, setContentMode] = useState<ExportContentMode>('files_xmp')
  const [targetDir, setTargetDir] = useState('')
  const [collapsed, setCollapsed] = useState(false)
  const [status, setStatus] = useState<'idle' | 'running' | 'success' | 'error'>('idle')
  const [result, setResult] = useState<ExportLibraryResponse | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [lockedSource, setLockedSource] = useState<ExportSourceSnapshot | null>(null)
  const [lockedOptions, setLockedOptions] = useState<ExportOptionsSnapshot | null>(null)

  const sourceFolder = lockedSource?.folder ?? source.folder
  const sourcePhotos = lockedSource?.photos ?? source.photos
  const sourceSummary = lockedSource?.summary ?? source.summary
  const sourceMissing = sourceFolder?.status === 'path_missing'

  const min = minScore.trim() === '' ? null : Number(minScore)
  const max = maxScore.trim() === '' ? null : Number(maxScore)
  const activeOptions = lockedOptions ?? { grades, min, max, layout, contentMode, targetDir }
  const controlsLocked = lockedOptions !== null
  const exportPhotos = useMemo(() => {
    const activeGrades = new Set(activeOptions.grades)
    return sourcePhotos.filter((photo) => {
      if (!activeGrades.has(effectivePhotoGrade(photo))) return false
      const score = photo.finalScore === null ? null : photo.finalScore * 100
      if (
        score !== null &&
        activeOptions.min !== null &&
        Number.isFinite(activeOptions.min) &&
        score < activeOptions.min
      ) {
        return false
      }
      if (
        score !== null &&
        activeOptions.max !== null &&
        Number.isFinite(activeOptions.max) &&
        score > activeOptions.max
      ) {
        return false
      }
      return true
    })
  }, [activeOptions.grades, activeOptions.max, activeOptions.min, sourcePhotos])

  const toggleGrade = (grade: PhotoGrade) => {
    setGrades((current) =>
      current.includes(grade) ? current.filter((item) => item !== grade) : [...current, grade],
    )
  }

  const chooseTargetDir = async () => {
    if (controlsLocked) return
    const selected = await window.plumelens?.selectExportDirectory?.()
    if (selected) {
      setTargetDir(selected)
      setResult(null)
      setError(null)
      if (status !== 'running') setStatus('idle')
    }
  }

  const startExport = async () => {
    if (!sourceFolder || !targetDir || status === 'running') return
    if (sourceFolder.status === 'path_missing') {
      setError(t('selection.sourceMissing.exportDisabled'))
      setStatus('error')
      return
    }
    const exportOptions = {
      grades: [...grades],
      min: min !== null && Number.isFinite(min) ? min : null,
      max: max !== null && Number.isFinite(max) ? max : null,
      layout,
      contentMode,
      targetDir,
    }
    const exportSource = {
      folder: sourceFolder,
      photos: sourcePhotos,
      summary: sourceSummary,
    }
    setLockedSource(exportSource)
    setLockedOptions(exportOptions)
    setStatus('running')
    setCollapsed(true)
    setResult(null)
    setError(null)
    try {
      const response = await api.exportLibrary(exportSource.folder.id, {
        target_dir: exportOptions.targetDir,
        grades: exportOptions.grades,
        min_score: exportOptions.min,
        max_score: exportOptions.max,
        copy_files: exportOptions.contentMode !== 'xmp_only',
        include_companions: true,
        include_xmp_sidecars: exportOptions.contentMode !== 'files',
        layout: exportOptions.layout,
        preserve_structure: true,
        include_manifest: true,
      })
      setResult(response)
      setStatus('success')
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
      setStatus('error')
    }
  }

  const closePanel = () => {
    if (status !== 'running') onClose()
  }

  const openExportOutput = async () => {
    if (!result?.output_dir) return
    const openResult = await window.plumelens?.openPathInFinder?.(result.output_dir)
    if (openResult && !openResult.ok) {
      setError(t('export.result.openFailed'))
    }
  }

  const resetExport = () => {
    setLockedSource(null)
    setLockedOptions(null)
    setResult(null)
    setError(null)
    setStatus('idle')
    setCollapsed(false)
  }

  const canStart = Boolean(
    sourceFolder &&
    !sourceMissing &&
    targetDir &&
    exportPhotos.length > 0 &&
    status === 'idle' &&
    !controlsLocked,
  )
  const statusText =
    status === 'running'
      ? t('export.status.running')
      : status === 'success'
        ? t('export.status.success')
        : status === 'error'
          ? t('export.status.error')
          : t('export.status.ready')

  if (collapsed) {
    return (
      <aside className="export-sidecar export-sidecar--collapsed" aria-label={t('export.label')}>
        <button
          className="export-sidecar__collapsed-main"
          onClick={() => setCollapsed(false)}
          type="button"
        >
          {status === 'running' ? (
            <RefreshCw className="h-4 w-4 animate-spin" />
          ) : status === 'success' ? (
            <Check className="h-4 w-4" />
          ) : (
            <Download className="h-4 w-4" />
          )}
          <span>
            <strong>{statusText}</strong>
            <small>{t('export.summary.count', { count: exportPhotos.length })}</small>
          </span>
        </button>
        <button
          aria-label={t('common.expand')}
          className="icon-button"
          onClick={() => setCollapsed(false)}
          type="button"
        >
          <ArrowLeft className="h-4 w-4" />
        </button>
        {status !== 'running' ? (
          <button
            aria-label={t('common.close')}
            className="icon-button"
            onClick={onClose}
            type="button"
          >
            <X className="h-4 w-4" />
          </button>
        ) : null}
      </aside>
    )
  }

  return (
    <aside className="export-sidecar" aria-label={t('export.label')}>
      <div className="export-sidecar__head">
        <div>
          <SectionLabel label={t('export.label')} />
          <h2>{t('export.title')}</h2>
          <p>{sourceFolder ? `${sourceFolder.displayName} · ${sourceFolder.rootPath}` : '--'}</p>
        </div>
        <div className="export-sidecar__actions">
          <button
            aria-label={t('common.collapse')}
            className="icon-button"
            onClick={() => setCollapsed(true)}
            type="button"
          >
            <ArrowRight className="h-4 w-4" />
          </button>
          <button
            aria-label={t('common.close')}
            className="icon-button"
            disabled={status === 'running'}
            onClick={closePanel}
            type="button"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
      </div>

      <div className="export-sidecar__body">
        <div className="export-target">
          <SectionLabel label={t('export.target.label')} />
          <button
            className="button-ghost export-target__button"
            disabled={controlsLocked}
            onClick={chooseTargetDir}
            type="button"
          >
            <FolderOpen className="h-4 w-4" />
            {activeOptions.targetDir ? t('export.target.change') : t('export.target.choose')}
          </button>
          <p title={activeOptions.targetDir || undefined}>
            {activeOptions.targetDir || t('export.target.empty')}
          </p>
        </div>

        <div className="export-grid">
          <ExportOption title={t('export.scope.label')} value={t('export.scope.reviewed')} />
          <ExportOption
            title={t('export.content.label')}
            value={t(`export.content.${activeOptions.contentMode}.short`)}
          />
          <ExportOption
            title={t('export.structure.label')}
            value={
              activeOptions.layout === 'merged'
                ? t('export.layout.merged.short')
                : t('export.layout.byGrade.short')
            }
          />
          <ExportOption title={t('export.bundle.label')} value={t('export.bundle.report')} />
        </div>

        <div className="export-control-block">
          <SectionLabel label={t('export.content.label')} />
          <div className="export-layout-grid" role="group" aria-label={t('export.content.label')}>
            {(['files', 'files_xmp', 'xmp_only'] as ExportContentMode[]).map((mode) => (
              <button
                className={cn(
                  'export-layout-button',
                  activeOptions.contentMode === mode && 'is-active',
                )}
                disabled={controlsLocked}
                key={mode}
                onClick={() => setContentMode(mode)}
                type="button"
              >
                {mode === 'xmp_only' ? (
                  <PencilLine className="h-4 w-4" />
                ) : (
                  <Download className="h-4 w-4" />
                )}
                <span>
                  <strong>{t(`export.content.${mode}.label`)}</strong>
                  <small>{t(`export.content.${mode}.hint`)}</small>
                </span>
              </button>
            ))}
          </div>
        </div>

        <div className="export-control-block">
          <SectionLabel label={t('export.layout.label')} />
          <div className="export-layout-grid" role="group" aria-label={t('export.layout.label')}>
            <button
              className={cn(
                'export-layout-button',
                activeOptions.layout === 'merged' && 'is-active',
              )}
              disabled={controlsLocked}
              onClick={() => setLayout('merged')}
              type="button"
            >
              <FolderOpen className="h-4 w-4" />
              <span>
                <strong>{t('export.layout.merged.label')}</strong>
                <small>{t('export.layout.merged.hint')}</small>
              </span>
            </button>
            <button
              className={cn(
                'export-layout-button',
                activeOptions.layout === 'by_grade' && 'is-active',
              )}
              disabled={controlsLocked}
              onClick={() => setLayout('by_grade')}
              type="button"
            >
              <Trophy className="h-4 w-4" />
              <span>
                <strong>{t('export.layout.byGrade.label')}</strong>
                <small>{t('export.layout.byGrade.hint')}</small>
              </span>
            </button>
          </div>
        </div>

        <div className="export-control-block">
          <SectionLabel label={t('export.scope.manual')} />
          <div className="export-grade-grid">
            {(['select', 'usable', 'record', 'reject'] as PhotoGrade[]).map((grade) => (
              <label className="export-check" key={grade}>
                <input
                  checked={activeOptions.grades.includes(grade)}
                  disabled={controlsLocked}
                  onChange={() => toggleGrade(grade)}
                  type="checkbox"
                />
                <span>{t(gradeLabelKey(grade))}</span>
              </label>
            ))}
          </div>
        </div>

        <div className="export-control-block">
          <SectionLabel label={t('export.scoreRange.label')} />
          <div className="export-range">
            <input
              inputMode="decimal"
              disabled={controlsLocked}
              max="100"
              min="0"
              onChange={(event) => setMinScore(event.target.value)}
              placeholder={t('export.scoreRange.min')}
              type="number"
              value={minScore}
            />
            <span>–</span>
            <input
              inputMode="decimal"
              disabled={controlsLocked}
              max="100"
              min="0"
              onChange={(event) => setMaxScore(event.target.value)}
              placeholder={t('export.scoreRange.max')}
              type="number"
              value={maxScore}
            />
          </div>
        </div>

        <div className="metric-strip">
          <MetricCell
            label={t('selection.metrics.selectPhotos')}
            tone="success"
            value={sourceSummary.gradeCounts.select}
          />
          <MetricCell
            label={t('selection.metrics.usablePhotos')}
            value={sourceSummary.gradeCounts.usable}
          />
          <MetricCell
            label={t('selection.metrics.recordPhotos')}
            tone="warning"
            value={sourceSummary.gradeCounts.record}
          />
          <MetricCell
            label={t('selection.metrics.rejectCount')}
            tone="accent"
            value={sourceSummary.gradeCounts.reject}
          />
        </div>

        <div className="export-result-count">
          {t('export.summary.count', { count: exportPhotos.length })}
        </div>

        <div className={cn('export-status', `export-status--${status}`)}>
          {status === 'running' ? <RefreshCw className="h-4 w-4 animate-spin" /> : null}
          {status === 'success' ? <Check className="h-4 w-4" /> : null}
          {status === 'idle' ? <Clock3 className="h-4 w-4" /> : null}
          {status === 'error' ? <X className="h-4 w-4" /> : null}
          <span>{statusText}</span>
        </div>
        {result ? (
          <div className="export-output">
            <small>{t('export.result.output')}</small>
            <p title={result.output_dir}>{result.output_dir}</p>
            <small>
              {t('export.result.stats', {
                companions: result.companion_count,
                exported: result.exported_count,
                failed: result.failed_count,
                xmp: result.xmp_count ?? 0,
              })}
            </small>
          </div>
        ) : null}
        {error ? <p className="export-error">{error}</p> : null}

        {controlsLocked && status !== 'running' ? (
          <div className="export-completion-actions">
            {result ? (
              <button className="button-ghost" onClick={openExportOutput} type="button">
                <FolderOpen className="h-4 w-4" />
                {t('export.result.openFolder')}
              </button>
            ) : null}
            <button className="button-ghost" onClick={resetExport} type="button">
              <RefreshCw className="h-4 w-4" />
              {t('export.result.reset')}
            </button>
          </div>
        ) : null}

        <div className="action-row">
          <button
            className="button-primary"
            disabled={!canStart}
            onClick={startExport}
            type="button"
          >
            {status === 'running' ? (
              <RefreshCw className="h-4 w-4 animate-spin" />
            ) : (
              <Download className="h-4 w-4" />
            )}
            {status === 'running' ? t('export.status.running') : t('export.confirm')}
          </button>
          <button className="button-ghost" onClick={() => setCollapsed(true)} type="button">
            {t('common.collapse')}
          </button>
        </div>
      </div>
    </aside>
  )
}

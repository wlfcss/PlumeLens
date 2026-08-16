/**
 * 导出面板(sidecar 形态) — 用户筛选出"入选/可用/记录"组合 + 评分范围,
 * 把照片复制到目标文件夹,可选附 XMP sidecar / 仅 XMP / 按 grade 分目录布局。
 *
 * 状态机:idle → starting → running → succeeded | cancelled | failed。
 * 锁定状态:开始导出后 source 和 options 都被 snapshot 锁,UI 进 read-only,
 * 避免运行中改源数据。
 *
 * **导出是后台任务**:POST 只启动并返回 job_id,进度经 SSE 推回来,用户可随时
 * 取消。历史 bug —— 导出曾经是一次性同步请求,964 张 / 80 GB 要跑两小时,前端
 * 60s 超时后 UI 报"导出失败",后端却毫不知情地继续复制;用户以为失败去重试,
 * 又叠一个后台导出抢同一个卷的 IO,越跑越慢。
 *
 * 边界:plumelens preload 暴露 selectExportDirectory + openPathInFinder + SSE 桥;
 * 后端负责全部文件操作与取消。
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
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { useTranslation } from 'react-i18next'

import { MetricCell } from '@/components/common/metric-cell'
import { SectionLabel } from '@/components/common/section-label'
import {
  ApiError,
  api,
  type ExportErrorDetail,
  type ExportFormatStat,
  type ExportJobSnapshot,
  type ExportLibraryResponse,
} from '@/lib/api-client'
import { formatBytes } from '@/lib/format-bytes'
import { gradeLabelKey } from '@/lib/i18n-keys'
import { logger } from '@/lib/logger'
import type { FolderRecord, PhotoGrade, PhotoRecord } from '@/lib/workspace-types'
import { effectivePhotoGrade, type FolderSummary } from '@/lib/photo-helpers'
import { cn } from '@/lib/utils'

export type ExportLayout = 'merged' | 'by_grade'
export type ExportContentMode = 'files' | 'files_xmp' | 'xmp_only'

type ExportPhase = 'idle' | 'starting' | 'running' | 'succeeded' | 'cancelled' | 'failed'

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
  formats: string[]
  targetDir: string
}

/** 文件名 → 大写扩展名（不含点）。与后端 `_ext_key` 保持一致。 */
function extOf(name: string | null | undefined): string | null {
  if (!name) return null
  const dot = name.lastIndexOf('.')
  if (dot < 0 || dot === name.length - 1) return null
  return name.slice(dot + 1).toUpperCase()
}

/**
 * 这张照片在给定格式白名单下会不会产出文件。
 *
 * 必须与后端 `_plan_files` 同构 —— 面板上"将导出 N 张"和实际导出量对不上是
 * 比少一个功能更糟的体验。
 */
function photoMatchesFormats(
  photo: PhotoRecord,
  allowed: Set<string>,
  copyFiles: boolean,
): boolean {
  if (!copyFiles) return true
  const mainExt = extOf(photo.fileName)
  const companionExt = photo.companionFormat
    ? photo.companionFormat.replace(/^\./, '').toUpperCase()
    : null
  const wantMain = mainExt !== null && allowed.has(mainExt)
  const wantCompanion = companionExt !== null && allowed.has(companionExt)
  return wantMain || wantCompanion
}

/** 后端 error code → i18n key。未收录的 code 回落到 export.error.unknown + 原始 message。 */
const ERROR_KEYS: Record<string, string> = {
  insufficient_space: 'export.error.insufficientSpace',
  target_inside_source: 'export.error.targetInsideSource',
  target_contains_source: 'export.error.targetContainsSource',
  library_not_found: 'export.error.libraryNotFound',
  source_path_missing: 'export.error.sourcePathMissing',
  export_already_running: 'export.error.alreadyRunning',
  job_not_found: 'export.error.jobNotFound',
  internal_error: 'export.error.internal',
}

/**
 * 从 ApiError 里剥出后端的结构化 detail。
 *
 * FastAPI 会把 HTTPException 的 detail 再包一层 ``{detail: {...}}``,所以这里
 * 要往里剥一层才能拿到 ``{code, ...}``。
 */
function parseExportError(err: unknown): ExportErrorDetail | null {
  if (!(err instanceof ApiError)) return null
  const raw: unknown = err.detail
  const inner =
    raw && typeof raw === 'object' && 'detail' in raw ? (raw as { detail: unknown }).detail : raw
  if (inner && typeof inner === 'object' && 'code' in inner) {
    return inner as ExportErrorDetail
  }
  return null
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
  const [availableFormats, setAvailableFormats] = useState<ExportFormatStat[] | null>(null)
  const [formats, setFormats] = useState<string[]>([])
  const [targetDir, setTargetDir] = useState('')
  const [collapsed, setCollapsed] = useState(false)
  const [phase, setPhase] = useState<ExportPhase>('idle')
  const [job, setJob] = useState<ExportJobSnapshot | null>(null)
  const [result, setResult] = useState<ExportLibraryResponse | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [cancelRequested, setCancelRequested] = useState(false)
  const [lockedSource, setLockedSource] = useState<ExportSourceSnapshot | null>(null)
  const [lockedOptions, setLockedOptions] = useState<ExportOptionsSnapshot | null>(null)

  const jobIdRef = useRef<string | null>(null)
  const unsubscribeRef = useRef<(() => void) | null>(null)

  const sourceFolder = lockedSource?.folder ?? source.folder
  const sourcePhotos = lockedSource?.photos ?? source.photos
  const sourceSummary = lockedSource?.summary ?? source.summary
  const sourceMissing = sourceFolder?.status === 'path_missing'
  const running = phase === 'starting' || phase === 'running'

  const min = minScore.trim() === '' ? null : Number(minScore)
  const max = maxScore.trim() === '' ? null : Number(maxScore)
  const activeOptions = lockedOptions ?? {
    grades,
    min,
    max,
    layout,
    contentMode,
    formats,
    targetDir,
  }
  const controlsLocked = lockedOptions !== null

  // 源文件夹里实际有哪些格式 —— 面板打开时拉一次,默认全选。
  const libraryId = sourceFolder?.id
  useEffect(() => {
    if (!libraryId) return
    let cancelled = false
    void api
      .exportFormats(libraryId)
      .then(({ formats: stats }) => {
        if (cancelled) return
        setAvailableFormats(stats)
        setFormats(stats.map((stat) => stat.ext))
      })
      .catch((e: unknown) => {
        if (cancelled) return
        logger.warn('拉取源文件夹格式列表失败:', e)
        setAvailableFormats([])
      })
    return () => {
      cancelled = true
    }
  }, [libraryId])

  const exportPhotos = useMemo(() => {
    const activeGrades = new Set(activeOptions.grades)
    const allowedFormats = new Set(activeOptions.formats)
    const copyFiles = activeOptions.contentMode !== 'xmp_only'
    return sourcePhotos.filter((photo) => {
      if (!activeGrades.has(effectivePhotoGrade(photo))) return false
      if (allowedFormats.size > 0 && !photoMatchesFormats(photo, allowedFormats, copyFiles)) {
        return false
      }
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
  }, [
    activeOptions.contentMode,
    activeOptions.formats,
    activeOptions.grades,
    activeOptions.max,
    activeOptions.min,
    sourcePhotos,
  ])

  const describeError = useCallback(
    (detail: ExportErrorDetail | null, fallback: string): string => {
      if (!detail) return fallback
      const key = ERROR_KEYS[detail.code]
      if (!key) {
        return t('export.error.unknown', { message: detail.message ?? fallback })
      }
      if (detail.code === 'insufficient_space') {
        const required = detail.required_bytes ?? 0
        const free = detail.free_bytes ?? 0
        return t(key, {
          required: formatBytes(required),
          free: formatBytes(free),
          shortfall: formatBytes(Math.max(0, required - free)),
        })
      }
      return t(key)
    },
    [t],
  )

  const teardownStream = useCallback(() => {
    unsubscribeRef.current?.()
    unsubscribeRef.current = null
  }, [])

  // 组件卸载只断开进度流，**不取消导出** —— 后台任务继续跑到底。
  useEffect(() => teardownStream, [teardownStream])

  const applySnapshot = useCallback(
    (snapshot: ExportJobSnapshot) => {
      setJob(snapshot)
      if (snapshot.status === 'running') {
        setPhase('running')
        return
      }
      teardownStream()
      setResult(snapshot.result)
      if (snapshot.status === 'succeeded') {
        setPhase('succeeded')
        setError(null)
      } else if (snapshot.status === 'cancelled') {
        setPhase('cancelled')
        setError(null)
      } else {
        setPhase('failed')
        setError(describeError(snapshot.error, t('export.status.error')))
      }
    },
    [describeError, t, teardownStream],
  )

  const subscribe = useCallback(
    (jobId: string) => {
      teardownStream()
      const handleFrame = (raw: string) => {
        try {
          applySnapshot(JSON.parse(raw) as ExportJobSnapshot)
        } catch (e) {
          logger.warn('导出进度帧解析失败:', e)
        }
      }

      if (typeof window !== 'undefined' && window.plumelens?.engineSseSubscribe) {
        unsubscribeRef.current = window.plumelens.engineSseSubscribe(
          `/export/jobs/${jobId}/events`,
          (bridgeEvent) => {
            if (bridgeEvent.type === 'message') {
              handleFrame(bridgeEvent.data)
              return
            }
            if (bridgeEvent.type === 'error') {
              // 后端在终态帧之后主动收流,桥会以 error 事件收尾 —— 这是正常结束。
              // 无论是正常收流还是真断线,都回查一次快照对齐状态,不让 UI 永远转圈。
              void api
                .exportJobSnapshot(jobId)
                .then(applySnapshot)
                .catch((e: unknown) => logger.warn('导出快照回查失败:', e))
            }
          },
        )
        return
      }

      // vite-only / 无 preload 的兜底路径
      void api
        .exportJobEventsUrl(jobId)
        .then((url) => {
          const es = new EventSource(url)
          es.onmessage = (msg) => handleFrame(msg.data)
          es.onerror = () => {
            es.close()
            void api
              .exportJobSnapshot(jobId)
              .then(applySnapshot)
              .catch((e: unknown) => logger.warn('导出快照回查失败:', e))
          }
          unsubscribeRef.current = () => es.close()
        })
        .catch((e: unknown) => logger.warn('导出进度流订阅失败:', e))
    },
    [applySnapshot, teardownStream],
  )

  const toggleGrade = (grade: PhotoGrade) => {
    setGrades((current) =>
      current.includes(grade) ? current.filter((item) => item !== grade) : [...current, grade],
    )
  }

  const toggleFormat = (ext: string) => {
    setFormats((current) =>
      current.includes(ext) ? current.filter((item) => item !== ext) : [...current, ext],
    )
  }

  const chooseTargetDir = async () => {
    if (controlsLocked) return
    const selected = await window.plumelens?.selectExportDirectory?.()
    if (selected) {
      setTargetDir(selected)
      setResult(null)
      setError(null)
      if (!running) setPhase('idle')
    }
  }

  const startExport = async () => {
    if (!sourceFolder || !targetDir || running) return
    if (sourceFolder.status === 'path_missing') {
      setError(t('selection.sourceMissing.exportDisabled'))
      setPhase('failed')
      return
    }
    const exportOptions: ExportOptionsSnapshot = {
      grades: [...grades],
      min: min !== null && Number.isFinite(min) ? min : null,
      max: max !== null && Number.isFinite(max) ? max : null,
      layout,
      contentMode,
      formats: [...formats],
      targetDir,
    }
    const exportSource = {
      folder: sourceFolder,
      photos: sourcePhotos,
      summary: sourceSummary,
    }
    setLockedSource(exportSource)
    setLockedOptions(exportOptions)
    setPhase('starting')
    setCollapsed(true)
    setResult(null)
    setJob(null)
    setError(null)
    setCancelRequested(false)
    try {
      const started = await api.exportLibrary(exportSource.folder.id, {
        target_dir: exportOptions.targetDir,
        grades: exportOptions.grades,
        min_score: exportOptions.min,
        max_score: exportOptions.max,
        copy_files: exportOptions.contentMode !== 'xmp_only',
        // 同伴文件是否复制由格式白名单决定 —— 勾了 CR3 才会带上 RAW。
        include_companions: true,
        include_xmp_sidecars: exportOptions.contentMode !== 'files',
        formats:
          availableFormats && exportOptions.formats.length < availableFormats.length
            ? exportOptions.formats
            : null,
        layout: exportOptions.layout,
        preserve_structure: true,
        include_manifest: true,
      })
      jobIdRef.current = started.job_id
      setJob({
        job_id: started.job_id,
        library_id: started.library_id,
        status: 'running',
        total: started.total,
        processed: 0,
        exported: 0,
        companions: 0,
        xmp: 0,
        missing: 0,
        failed: 0,
        total_bytes: started.total_bytes,
        copied_bytes: 0,
        current_file: null,
        output_dir: null,
        result: null,
        error: null,
      })
      setPhase('running')
      subscribe(started.job_id)
    } catch (err) {
      const fallback = err instanceof Error ? err.message : String(err)
      setError(describeError(parseExportError(err), fallback))
      setPhase('failed')
    }
  }

  const cancelExport = async () => {
    const jobId = jobIdRef.current
    if (!jobId || !running || cancelRequested) return
    setCancelRequested(true)
    try {
      await api.cancelExportJob(jobId)
    } catch (err) {
      setCancelRequested(false)
      const fallback = err instanceof Error ? err.message : String(err)
      setError(describeError(parseExportError(err), fallback))
    }
  }

  const closePanel = () => {
    if (!running) onClose()
  }

  const openExportOutput = async () => {
    const outputDir = result?.output_dir ?? job?.output_dir
    if (!outputDir) return
    const openResult = await window.plumelens?.openPathInFinder?.(outputDir)
    if (openResult && !openResult.ok) {
      setError(t('export.result.openFailed'))
    }
  }

  const resetExport = () => {
    teardownStream()
    jobIdRef.current = null
    setLockedSource(null)
    setLockedOptions(null)
    setResult(null)
    setJob(null)
    setError(null)
    setCancelRequested(false)
    setPhase('idle')
    setCollapsed(false)
  }

  const canStart = Boolean(
    sourceFolder &&
      !sourceMissing &&
      targetDir &&
      exportPhotos.length > 0 &&
      phase === 'idle' &&
      !controlsLocked,
  )
  const statusText = running
    ? cancelRequested
      ? t('export.cancelling')
      : t('export.status.running')
    : phase === 'succeeded'
      ? t('export.status.success')
      : phase === 'cancelled'
        ? t('export.status.cancelled')
        : phase === 'failed'
          ? t('export.status.error')
          : t('export.status.ready')

  const progressTotal = job?.total ?? exportPhotos.length
  const progressPercent =
    job && job.total > 0 ? Math.min(100, Math.round((job.processed / job.total) * 100)) : 0
  // phase 值与既有的 .export-status--* 配色类名不同名,这里做一次映射,避免改动样式表。
  const statusTone = running
    ? 'running'
    : phase === 'succeeded'
      ? 'success'
      : phase === 'failed'
        ? 'error'
        : phase === 'cancelled'
          ? 'cancelled'
          : 'idle'

  if (collapsed) {
    return (
      <aside className="export-sidecar export-sidecar--collapsed" aria-label={t('export.label')}>
        <button
          className="export-sidecar__collapsed-main"
          onClick={() => setCollapsed(false)}
          type="button"
        >
          {running ? (
            <RefreshCw className="h-4 w-4 animate-spin" />
          ) : phase === 'succeeded' ? (
            <Check className="h-4 w-4" />
          ) : (
            <Download className="h-4 w-4" />
          )}
          <span>
            <strong>{statusText}</strong>
            <small>
              {running && job
                ? t('export.progress.photos', { processed: job.processed, total: job.total })
                : t('export.summary.count', { count: exportPhotos.length })}
            </small>
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
        {!running ? (
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
            disabled={running}
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

        {/* 照片格式多选 —— 按源文件夹里实际存在的格式展示。此前同伴文件是硬编码
            的 include_companions: true,只想导 25 GB 的 JPG 会被强制搭上 56 GB 的
            CR3,预检直接判定磁盘空间不足。 */}
        {availableFormats === null || availableFormats.length > 0 ? (
          <div className="export-control-block">
            <SectionLabel label={t('export.formats.label')} />
            {availableFormats === null ? (
              <p className="export-hint">{t('export.formats.loading')}</p>
            ) : (
              <>
                <div
                  className="export-format-grid"
                  role="group"
                  aria-label={t('export.formats.label')}
                >
                  {availableFormats.map((stat) => (
                    <label className="export-check export-format" key={stat.ext}>
                      <input
                        checked={activeOptions.formats.includes(stat.ext)}
                        disabled={controlsLocked || activeOptions.contentMode === 'xmp_only'}
                        onChange={() => toggleFormat(stat.ext)}
                        type="checkbox"
                      />
                      <span>
                        <strong>{stat.ext}</strong>
                        <small>
                          {t('export.formats.stat', {
                            count: stat.count,
                            size: formatBytes(stat.bytes),
                          })}
                        </small>
                      </span>
                    </label>
                  ))}
                </div>
                <p className="export-hint">
                  {activeOptions.contentMode === 'xmp_only'
                    ? t('export.formats.xmpOnlyHint')
                    : t('export.formats.hint')}
                </p>
              </>
            )}
          </div>
        ) : null}

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

        <div className={cn('export-status', `export-status--${statusTone}`)}>
          {running ? <RefreshCw className="h-4 w-4 animate-spin" /> : null}
          {phase === 'succeeded' ? <Check className="h-4 w-4" /> : null}
          {phase === 'idle' ? <Clock3 className="h-4 w-4" /> : null}
          {phase === 'failed' || phase === 'cancelled' ? <X className="h-4 w-4" /> : null}
          <span>{statusText}</span>
        </div>

        {job && (running || phase === 'cancelled') ? (
          <div className="export-progress">
            <div className="export-progress__bar">
              <span style={{ width: `${progressPercent}%` }} />
            </div>
            <small>
              {t('export.progress.photos', { processed: job.processed, total: progressTotal })}
              {' · '}
              {t('export.progress.bytes', {
                copied: formatBytes(job.copied_bytes),
                total: formatBytes(job.total_bytes),
              })}
            </small>
            {job.current_file ? (
              <small title={job.current_file}>
                {t('export.progress.current', { name: job.current_file })}
              </small>
            ) : null}
          </div>
        ) : null}

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
            {phase === 'cancelled' ? <small>{t('export.result.cancelledHint')}</small> : null}
          </div>
        ) : null}
        {error ? <p className="export-error">{error}</p> : null}

        {controlsLocked && !running ? (
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
          {running ? (
            <button
              className="button-primary"
              disabled={cancelRequested}
              onClick={cancelExport}
              type="button"
            >
              <X className="h-4 w-4" />
              {cancelRequested ? t('export.cancelling') : t('export.cancel')}
            </button>
          ) : (
            <button
              className="button-primary"
              disabled={!canStart}
              onClick={startExport}
              type="button"
            >
              <Download className="h-4 w-4" />
              {t('export.confirm')}
            </button>
          )}
          <button className="button-ghost" onClick={() => setCollapsed(true)} type="button">
            {t('common.collapse')}
          </button>
        </div>
      </div>
    </aside>
  )
}

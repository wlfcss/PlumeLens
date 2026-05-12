/**
 * 起始页 — 文件夹历史 + 引擎/管线状态条 + BirdGlyph 装饰。
 *
 * 子组件:
 *   - StartScreen (主入口)
 *   - FolderContextMenu (右键文件夹弹小菜单 — 在 Finder 打开 / 重新链接路径)
 *   - EnginePanel (底部管线状态条 — 5 个模型 loaded/loading/error 状态)
 *   - PipelineStatusItem (管线条单格)
 *   - BirdGlyph (右上角点阵鸟,memo 化避免 SSE 健康推送驱动重渲染)
 *
 * BirdGlyph 数组 birdGlyphElements 在模块加载时一次性计算,避免 StartScreen 在
 * SSE 频繁触发的 re-render 中反复重建 504 个 React element + className 字符串。
 */

import { ArrowRight, FolderOpen, FolderSearch2, TriangleAlert, X } from 'lucide-react'
import {
  memo,
  useCallback,
  useEffect,
  useMemo,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
} from 'react'
import type { useTranslation } from 'react-i18next'

import { StatusDot } from '@/components/common/metric-cell'
import type { useBackendHealth } from '@/hooks/use-backend'
import { statusLabelKey } from '@/lib/i18n-keys'
import type { FolderRecord } from '@/lib/mock-workspace'
import { statusTone } from '@/lib/photo-display'
import type { Tone } from '@/lib/photo-helpers'
import { cn } from '@/lib/utils'
import { logger } from '@/lib/logger'

export type FolderContextMenuState = {
  folder: FolderRecord
  x: number
  y: number
} | null

const birdGlyphPattern = [
  '........................',
  '...............11.......',
  '.............111111.....',
  '............11111111....',
  '...........111....111...',
  '..........111..33..11...',
  '..........111.3223.1112.',
  '.........1111..33..1112.',
  '........111111.....11...',
  '.......111.111.....11...',
  '.......111..11.....11...',
  '......111...11....111...',
  '.....111...111....111...',
  '....111....111...111....',
  '....111...111...111.....',
  '...111111111111111......',
  '..111111111111111.......',
  '.11111111111111.........',
  '.111.....11..11.........',
  '.........11..11.........',
  '........................',
] as const
const birdGlyphRows = birdGlyphPattern.length
const birdGlyphColumns = birdGlyphPattern[0].length
const birdGlyphCornerRadius = 5

function isInsideRoundedGlyphFrame(rowIndex: number, columnIndex: number): boolean {
  const radius = birdGlyphCornerRadius
  const x = columnIndex + 0.5
  const y = rowIndex + 0.5
  const width = birdGlyphColumns
  const height = birdGlyphRows

  if (x >= radius && x <= width - radius) return true
  if (y >= radius && y <= height - radius) return true

  const cornerX = x < radius ? radius : width - radius
  const cornerY = y < radius ? radius : height - radius
  return Math.hypot(x - cornerX, y - cornerY) <= radius
}

// 预计算 glyph 单元 JSX 数组 — 模块加载时一次性完成,避免 StartScreen 每次 re-render
// (SSE 引擎状态推送频繁)都重算 504 个 React element + className/style 字符串。
// 隐式 grid flow 不变,outside-frame cell 仍保留 DOM 位置占位(用 visibility:hidden),
// 维持原渲染语义。
const birdGlyphElements: ReactNode[] = birdGlyphPattern.flatMap((row, rowIndex) =>
  [...row].map((cell, columnIndex) => (
    <i
      className={cn(
        cell !== '.' && 'is-lit',
        cell === '2' && 'is-bright',
        cell === '3' && 'is-eye-falloff',
        !isInsideRoundedGlyphFrame(rowIndex, columnIndex) && 'is-outside-frame',
      )}
      key={`bird-glyph-${rowIndex}-${columnIndex}`}
      style={{ animationDelay: `${(rowIndex + columnIndex) * 42}ms` }}
    />
  )),
)

const BirdGlyph = memo(function BirdGlyph() {
  return (
    <div className="start-glyph-bird" aria-hidden="true">
      {birdGlyphElements}
    </div>
  )
})

export function FolderContextMenu({
  menu,
  onClose,
  onOpenFolder,
  onRelinkFolder,
  t,
}: {
  menu: FolderContextMenuState
  onClose: () => void
  onOpenFolder: (folder: FolderRecord) => void
  onRelinkFolder: (folderId: string) => Promise<void>
  t: ReturnType<typeof useTranslation>['t']
}) {
  useEffect(() => {
    if (!menu) return

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose()
    }
    const handleClick = () => onClose()
    const handleScroll = () => onClose()

    window.addEventListener('keydown', handleKeyDown)
    window.addEventListener('click', handleClick)
    window.addEventListener('scroll', handleScroll, true)
    return () => {
      window.removeEventListener('keydown', handleKeyDown)
      window.removeEventListener('click', handleClick)
      window.removeEventListener('scroll', handleScroll, true)
    }
  }, [menu, onClose])

  if (!menu) return null

  return (
    <div
      className="folder-context-menu"
      onContextMenu={(event) => event.preventDefault()}
      onMouseDown={(event) => event.stopPropagation()}
      role="menu"
      style={{ left: menu.x, top: menu.y }}
      aria-label={t('selection.folderMenu.label')}
    >
      <button onClick={() => onOpenFolder(menu.folder)} role="menuitem" type="button">
        <FolderOpen className="h-4 w-4" />
        <span>{t('selection.folderMenu.openInFinder')}</span>
      </button>
      {menu.folder.status === 'path_missing' ? (
        <button
          onClick={(event) => {
            event.stopPropagation()
            onClose()
            void onRelinkFolder(menu.folder.id).catch((err) => {
              logger.warn('Failed to relink library source folder:', err)
            })
          }}
          role="menuitem"
          type="button"
        >
          <FolderSearch2 className="h-4 w-4" />
          <span>{t('selection.sourceMissing.relinkAction')}</span>
        </button>
      ) : null}
    </div>
  )
}

type BackendHealthData = ReturnType<typeof useBackendHealth>['data']
type PipelineModels = NonNullable<BackendHealthData>['pipeline']['models']
type PipelineModelState = PipelineModels[string]
type PipelineDevice = 'cpu' | 'gpu' | 'mps' | 'mixed' | 'unknown'
export type PipelineRuntime = {
  device: PipelineDevice
  deviceLabelKey: string
  providerLabel: string
}

type PipelineStatusItemModel = {
  key: string
  label: string
  loading: boolean
  runtime: PipelineRuntime | null
  tone: Tone
  value: string
}

export function pipelineRuntimeFromProvider(provider?: string | null): PipelineRuntime {
  const normalized = provider?.toLowerCase() ?? ''

  if (!normalized) {
    return {
      device: 'unknown',
      deviceLabelKey: 'start.device.detecting',
      providerLabel: '--',
    }
  }

  if (normalized.includes('mps')) {
    return {
      device: 'mps',
      deviceLabelKey: 'start.device.mps',
      providerLabel: 'MPS',
    }
  }

  if (normalized.includes('cuda')) {
    return {
      device: 'gpu',
      deviceLabelKey: 'start.device.gpu',
      providerLabel: 'CUDA',
    }
  }

  if (normalized.includes('coreml')) {
    return {
      device: 'gpu',
      deviceLabelKey: 'start.device.gpu',
      providerLabel: 'CoreML',
    }
  }

  if (normalized.includes('cpu')) {
    return {
      device: 'cpu',
      deviceLabelKey: 'start.device.cpu',
      providerLabel: normalized.includes('torch') ? 'Torch CPU' : 'CPU',
    }
  }

  return {
    device: 'unknown',
    deviceLabelKey: 'start.device.unknown',
    providerLabel: provider ?? '--',
  }
}

function mergePipelineRuntimes(models: Array<PipelineModelState | undefined>): PipelineRuntime {
  const runtimes = models
    .filter((model): model is PipelineModelState => Boolean(model?.provider))
    .map((model) => pipelineRuntimeFromProvider(model.provider))

  if (runtimes.length === 0) {
    return pipelineRuntimeFromProvider()
  }

  const providerLabels = Array.from(new Set(runtimes.map((runtime) => runtime.providerLabel)))
  const devices = Array.from(new Set(runtimes.map((runtime) => runtime.device)))
  const device = devices.length === 1 ? devices[0] : 'mixed'

  return {
    device,
    deviceLabelKey: device === 'mixed' ? 'start.device.mixed' : runtimes[0].deviceLabelKey,
    providerLabel: providerLabels.join(' + '),
  }
}

function getPipelineModel(models: PipelineModels | undefined, key: string) {
  return models?.[key]
}

function runtimeSummaryLabel(
  items: PipelineStatusItemModel[],
  t: ReturnType<typeof useTranslation>['t'],
) {
  const providers = Array.from(
    new Set(
      items
        .map((item) => item.runtime?.providerLabel)
        .filter((label): label is string => Boolean(label && label !== '--')),
    ),
  )

  return providers.length > 0 ? providers.join(' · ') : t('start.runtime.localOnly')
}

function PipelineStatusItem({
  label,
  loading,
  runtime,
  t,
  tone,
  value,
}: {
  label: string
  loading: boolean
  runtime: PipelineRuntime | null
  t: ReturnType<typeof useTranslation>['t']
  tone: Tone
  value: string
}) {
  return (
    <div className={cn('pipeline-bar__item', loading && 'pipeline-bar__item--loading')}>
      <small>{label}</small>
      <strong>{value}</strong>
      {runtime ? (
        <span
          className={cn('pipeline-device', `pipeline-device--${runtime.device}`)}
          title={runtime.providerLabel}
        >
          {t(runtime.deviceLabelKey)}
        </span>
      ) : null}
      <StatusDot tone={tone} />
    </div>
  )
}

function EnginePanel({
  backendData,
  isError,
  isReady,
  t,
}: {
  backendData: BackendHealthData
  isError: boolean
  isReady: boolean
  t: ReturnType<typeof useTranslation>['t']
}) {
  const pipeline = backendData?.pipeline
  const models = pipeline?.models
  const isInitializing = !backendData && !isError
  const isPipelineReady = Boolean(pipeline?.ready)
  const statusToneValue: Tone = isError ? 'accent' : isPipelineReady ? 'success' : 'warning'
  const yoloModel = getPipelineModel(models, 'yolo')
  const poseModel = getPipelineModel(models, 'bird_visibility')
  const clipiqaModel = getPipelineModel(models, 'clipiqa')
  const hyperiqaModel = getPipelineModel(models, 'hyperiqa')
  const speciesModel = getPipelineModel(models, 'dinov3_species_v4')

  const modelValue = useCallback(
    (loaded: boolean) => {
      if (isError) return t('start.status.error')
      if (isInitializing) return t('start.status.loading')
      return loaded ? t('start.status.ready') : t('start.status.pending')
    },
    [isError, isInitializing, t],
  )

  const modelTone = useCallback(
    (loaded: boolean): Tone => {
      if (isError) return 'accent'
      if (isInitializing) return 'warning'
      return loaded ? 'success' : 'warning'
    },
    [isError, isInitializing],
  )

  const detectorReady = Boolean(yoloModel?.loaded || pipeline?.ready)
  const qualityReady = Boolean(
    pipeline?.quality_available || (clipiqaModel?.loaded && hyperiqaModel?.loaded),
  )
  const poseReady = Boolean(pipeline?.pose_available || poseModel?.loaded)
  const speciesReady = Boolean(pipeline?.species_available || speciesModel?.loaded)

  const pipelineItems = useMemo(
    () =>
      [
        {
          key: 'engine',
          label: t('start.status.engine'),
          loading: isInitializing,
          runtime: null,
          tone: statusToneValue,
          value: isError
            ? t('start.status.error')
            : isReady
              ? isPipelineReady
                ? t('start.status.ready')
                : t('start.status.loading')
              : t('start.status.loading'),
        },
        {
          key: 'detector',
          label: t('start.status.detector'),
          loading: isInitializing,
          runtime: pipelineRuntimeFromProvider(yoloModel?.provider),
          tone: modelTone(detectorReady),
          value: modelValue(detectorReady),
        },
        {
          key: 'quality',
          label: t('start.status.quality'),
          loading: isInitializing,
          runtime: mergePipelineRuntimes([clipiqaModel, hyperiqaModel]),
          tone: modelTone(qualityReady),
          value: modelValue(qualityReady),
        },
        {
          key: 'pose',
          label: t('start.status.pose'),
          loading: isInitializing,
          runtime: pipelineRuntimeFromProvider(poseModel?.provider),
          tone: modelTone(poseReady),
          value: modelValue(poseReady),
        },
        {
          key: 'species',
          label: t('start.status.species'),
          loading: isInitializing,
          runtime: pipelineRuntimeFromProvider(speciesModel?.provider),
          tone: modelTone(speciesReady),
          value: modelValue(speciesReady),
        },
      ] satisfies PipelineStatusItemModel[],
    [
      clipiqaModel,
      detectorReady,
      hyperiqaModel,
      isError,
      isInitializing,
      isPipelineReady,
      isReady,
      modelTone,
      modelValue,
      poseModel,
      poseReady,
      qualityReady,
      speciesModel,
      speciesReady,
      statusToneValue,
      t,
      yoloModel,
    ],
  )

  const summaryValue = isError
    ? t('status.error')
    : isPipelineReady
      ? t('status.connected')
      : t('start.status.loading')
  const runtimeNote = isError
    ? t('start.runtime.unavailable')
    : isInitializing
      ? t('start.runtime.initializing')
      : runtimeSummaryLabel(pipelineItems, t)

  return (
    <aside className={cn('pipeline-bar', isInitializing && 'pipeline-bar--loading')}>
      <div className="pipeline-bar__summary">
        <StatusDot tone={statusToneValue} />
        <span>{t('start.pipelineState')}</span>
        <strong>{summaryValue}</strong>
        {isInitializing ? (
          <span className="pipeline-bar__loader" aria-hidden="true">
            <i />
            <i />
            <i />
          </span>
        ) : null}
      </div>

      <div className="pipeline-bar__items">
        {pipelineItems.map((item) => (
          <PipelineStatusItem
            key={item.label}
            label={item.label}
            tone={item.tone}
            t={t}
            value={item.value}
            loading={item.loading}
            runtime={item.runtime}
          />
        ))}
      </div>

      <div className="pipeline-bar__note">{runtimeNote}</div>
    </aside>
  )
}

export function StartScreen({
  backendData,
  folders,
  importError,
  isError,
  isReady,
  onChooseFolder,
  onContinueLatest,
  onDismissImportError,
  onOpenFolderContextMenu,
  onOpenFolder,
  t,
}: {
  backendData: BackendHealthData
  folders: FolderRecord[]
  importError: string | null
  isError: boolean
  isReady: boolean
  onChooseFolder: () => void
  onContinueLatest: () => void
  onDismissImportError: () => void
  onOpenFolderContextMenu: (folder: FolderRecord, event: ReactMouseEvent<HTMLElement>) => void
  onOpenFolder: (folderId: string) => void
  t: ReturnType<typeof useTranslation>['t']
}) {
  const recentFolders = folders.toSorted((left, right) =>
    right.lastOpenedAt.localeCompare(left.lastOpenedAt),
  )
  const hasRecentFolders = recentFolders.length > 0
  const recentFoldersOverflow = recentFolders.length > 4

  return (
    <main
      className={cn(
        'start-screen selection-scroll',
        !hasRecentFolders && 'start-screen--empty-history',
      )}
    >
      <section className="start-hero">
        <div className="start-copy">
          <div className="eyebrow-row">
            <StatusDot tone="accent" />
            <span>{t('start.kicker')}</span>
          </div>
          <h1>
            {t('start.title')
              .split('\n')
              .map((line) => (
                <span key={line}>{line}</span>
              ))}
          </h1>
          <p>{t('start.subtitle')}</p>
          <div className="action-row">
            <button className="button-primary" onClick={onChooseFolder} type="button">
              <FolderSearch2 className="h-4 w-4" />
              {t('start.primaryAction')}
            </button>
            <button
              className="button-ghost"
              disabled={!hasRecentFolders}
              onClick={onContinueLatest}
              type="button"
            >
              <ArrowRight className="h-4 w-4" />
              {t('start.secondaryAction')}
            </button>
          </div>
          {importError ? (
            <div className="start-import-error" role="alert">
              <TriangleAlert className="h-4 w-4" aria-hidden="true" />
              <div>
                <strong>{t('start.importErrorTitle')}</strong>
                <p>{t('start.importErrorBody', { detail: importError })}</p>
              </div>
              <button
                aria-label={t('common.close')}
                className="start-import-error__close"
                onClick={onDismissImportError}
                type="button"
              >
                <X className="h-3.5 w-3.5" />
              </button>
            </div>
          ) : null}
        </div>

        <BirdGlyph />
      </section>

      {hasRecentFolders ? (
        <section className="start-workbench">
          <div className="start-list">
            <div className="start-list__heading">
              <h2>{t('start.recentFolders')}</h2>
              <span>{`${recentFolders.length} ${t('start.entries')}`}</span>
            </div>
            <div
              aria-label={t('start.recentFolders')}
              className={cn('folder-stack', recentFoldersOverflow && 'folder-stack--scrollable')}
              data-testid="recent-folder-stack"
              tabIndex={recentFoldersOverflow ? 0 : undefined}
            >
              {recentFolders.map((folder) => (
                <button
                  className="folder-line"
                  key={folder.id}
                  onContextMenu={(event) => onOpenFolderContextMenu(folder, event)}
                  onClick={() => onOpenFolder(folder.id)}
                  type="button"
                >
                  <span>
                    <strong>{folder.displayName}</strong>
                    <small>{folder.parentPath}</small>
                  </span>
                  <span className="folder-line__status">
                    <StatusDot tone={statusTone(folder.status)} />
                    <span>{t(statusLabelKey(folder.status))}</span>
                  </span>
                </button>
              ))}
            </div>
          </div>
        </section>
      ) : null}
      <EnginePanel backendData={backendData} isError={isError} isReady={isReady} t={t} />
    </main>
  )
}

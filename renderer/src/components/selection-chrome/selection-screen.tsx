/**
 * 选片页框架 — 左侧 folder rail / 中部主区 / 右侧 inspector / 紧凑头部 /
 * 底部 background task bar / 回顶按钮。
 *
 * 内部子组件:
 *   - SelectionScreen (主入口)
 *   - FolderRail (左侧文件夹导航)
 *   - FolderTopline (主区上方的文件夹标题 + 进度 + 动作)
 *   - MetricStrip (顶部 metric cells 行)
 *   - SelectionControls (filter chips + sort/view segments)
 *   - SelectionCompactHeader (滚动后吸顶的紧凑头部)
 *
 * 历史:之前住在 App.tsx ~1090 行,本次大刀外迁完成 selection 子树全部抽离。
 * 中部 photo grid 家族已在 T2-G 抽到 components/selection-grid/。
 */

import {
  ArrowUp,
  Check,
  Download,
  Feather,
  FolderOpen,
  FolderSearch2,
  MoreHorizontal,
  PencilLine,
  RefreshCw,
  Sparkles,
  X,
} from 'lucide-react'
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
  type RefObject,
} from 'react'
import type { useTranslation } from 'react-i18next'

import { BackgroundTaskBar } from '@/components/common/background-task-bar'
import { MetricCell, StatusDot } from '@/components/common/metric-cell'
import { SectionLabel } from '@/components/common/section-label'
import { InspectorPanel } from '@/components/inspector/inspector-panel'
import { PhotoGroupsList, VirtualizedPhotoGrid } from '@/components/selection-grid/photo-grid'
import type { ThumbnailLoadStatus } from '@/components/thumbnail-image'
import type { AnalysisProgressEvent } from '@/lib/api-client'
import { statusLabelKey } from '@/lib/i18n-keys'
import type {
  AppRoute,
  FolderRecord,
  FolderStatus,
  PhotoGroupRecord,
  PhotoRecord,
  SelectionDecision,
  WorkspaceSnapshot,
} from '@/lib/mock-workspace'
import { photoCategory, statusTone } from '@/lib/photo-display'
import { formatRatio, type FolderSummary } from '@/lib/photo-helpers'
import type { SortMode } from '@/lib/photo-grid-helpers'
import { cn } from '@/lib/utils'
import type { QuickFilter, ViewMode } from '@/stores/ui-store'
import { logger } from '@/lib/logger'

const SELECTION_COMPACT_ENTER_SCROLL_PX = 148
const SELECTION_COMPACT_EXIT_SCROLL_PX = 72
const SELECTION_SCROLL_TOP_SHOW_PROGRESS = 1 / 3
const SELECTION_SCROLL_TOP_HIDE_PROGRESS = 0.25
const SELECTION_SCROLL_TOP_SHOW_MIN_PX = 900
const SELECTION_SCROLL_TOP_HIDE_MAX_PX = 220
const SELECTION_SCROLL_TOP_SETTLE_MS = 720
const SELECTION_SCROLL_TOP_EPSILON = 1

const EMPTY_GROUPS: PhotoGroupRecord[] = []

const quickFilters: QuickFilter[] = ['select', 'usable', 'record', 'reject', 'no_bird', 'failed']
const compactPrimaryFilters: QuickFilter[] = ['select', 'usable', 'record', 'reject']
const compactMoreFilters: QuickFilter[] = ['no_bird', 'failed']
const viewModes: ViewMode[] = ['grouped', 'flat']
const sortModes: SortMode[] = ['score', 'shot_at', 'name']

function viewModeKey(mode: ViewMode) {
  return `selection.viewModes.${mode}` as const
}

function sortLabelKey(sort: SortMode) {
  return `selection.sort.${sort}` as const
}

function quickFilterLabelKey(filter: QuickFilter) {
  return `selection.quickFilters.${filter}` as const
}

export function SelectionScreen({
  activeFolder,
  activeFolderSummary,
  activeQuickFilters,
  onlyFlying,
  activeSort,
  analysisStarting,
  filteredGroups,
  flatPhotos,
  focusedPhoto,
  focusedPhotoId,
  folderPhotos,
  folders,
  onOpenExport,
  onOpenFolderContextMenu,
  onOpenReview,
  onRelinkFolder,
  onRenameFolder,
  onSelectFolder,
  onSetDecision,
  onStartAnalysis,
  onThumbnailLoadStatus,
  progressEvent,
  relinkingFolderId,
  setActiveQuickFilter,
  setOnlyFlying,
  setActiveSort,
  setFocusedPhotoId,
  setRoute,
  setViewMode,
  t,
  viewMode,
  workspace,
}: {
  activeFolder: FolderRecord | null
  activeFolderSummary: FolderSummary
  activeQuickFilters: QuickFilter[]
  onlyFlying: boolean
  activeSort: SortMode
  analysisStarting: boolean
  filteredGroups: Array<{ group: PhotoGroupRecord; photos: PhotoRecord[] }>
  flatPhotos: PhotoRecord[]
  focusedPhoto: PhotoRecord | null
  focusedPhotoId: string | null
  folderPhotos: PhotoRecord[]
  folders: FolderRecord[]
  onOpenExport: () => void
  onOpenFolderContextMenu: (folder: FolderRecord, event: ReactMouseEvent<HTMLElement>) => void
  onOpenReview: (photoId: string) => void
  onRelinkFolder: (folderId: string) => Promise<void>
  onRenameFolder: (folderId: string, displayName: string) => Promise<void>
  onSelectFolder: (folderId: string) => void
  onSetDecision: (photoId: string, decision: SelectionDecision) => void
  onStartAnalysis: () => void
  onThumbnailLoadStatus: (photoId: string, status: ThumbnailLoadStatus) => void
  progressEvent: AnalysisProgressEvent | null
  relinkingFolderId: string | null
  setActiveQuickFilter: (filter: QuickFilter) => void
  setOnlyFlying: (enabled: boolean) => void
  setActiveSort: (sort: SortMode) => void
  setFocusedPhotoId: (photoId: string | null) => void
  setRoute: (route: AppRoute) => void
  setViewMode: (mode: ViewMode) => void
  t: ReturnType<typeof useTranslation>['t']
  viewMode: ViewMode
  workspace: WorkspaceSnapshot
}) {
  const selectionScrollRef = useRef<HTMLElement | null>(null)
  const compactMoreRef = useRef<HTMLDivElement | null>(null)
  const scrollTopSettleFrameRef = useRef<number | null>(null)
  const scrollTopSettleTimeoutRef = useRef<number | null>(null)
  const [selectionScrollElement, setSelectionScrollElement] = useState<HTMLElement | null>(null)
  const [selectionChromeState, setSelectionChromeState] = useState({
    compact: false,
    showScrollTop: false,
  })
  const selectionChromeStateRef = useRef(selectionChromeState)
  const [compactMoreOpen, setCompactMoreOpen] = useState(false)
  const setSelectionScrollNode = useCallback((node: HTMLElement | null) => {
    selectionScrollRef.current = node
    setSelectionScrollElement((current) => (current === node ? current : node))
  }, [])
  const selectionResetKey = `${activeFolder?.id ?? ''}:${viewMode}:${activeSort}`
  const activeFolderGroups = useMemo(
    () =>
      activeFolder
        ? workspace.groups.filter((group) => group.folderId === activeFolder.id)
        : EMPTY_GROUPS,
    [activeFolder?.id, workspace.groups],
  )

  const handlePhotoFlowPointerDown = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      const target = event.target
      if (!(target instanceof HTMLElement)) return
      if (
        target.closest(
          '.photo-tile, [data-photo-id], button, a, input, textarea, select, [role="button"]',
        )
      ) {
        return
      }
      setFocusedPhotoId(null)
    },
    [setFocusedPhotoId],
  )

  const cancelScrollTopSettle = useCallback(() => {
    if (scrollTopSettleFrameRef.current !== null) {
      window.cancelAnimationFrame(scrollTopSettleFrameRef.current)
      scrollTopSettleFrameRef.current = null
    }
    if (scrollTopSettleTimeoutRef.current !== null) {
      window.clearTimeout(scrollTopSettleTimeoutRef.current)
      scrollTopSettleTimeoutRef.current = null
    }
  }, [])

  const forceSelectionScrollTop = useCallback(
    (node: HTMLElement) => {
      cancelScrollTopSettle()
      node.scrollTo({ behavior: 'auto', left: 0, top: 0 })
      node.scrollTop = 0
      node.scrollLeft = 0
      const resetChrome = { compact: false, showScrollTop: false }
      selectionChromeStateRef.current = resetChrome
      setSelectionChromeState(resetChrome)
    },
    [cancelScrollTopSettle],
  )

  useEffect(() => cancelScrollTopSettle, [cancelScrollTopSettle])

  useEffect(() => {
    if (selectionScrollElement) {
      forceSelectionScrollTop(selectionScrollElement)
      return
    }
    const resetChrome = { compact: false, showScrollTop: false }
    selectionChromeStateRef.current = resetChrome
    setSelectionChromeState(resetChrome)
  }, [forceSelectionScrollTop, selectionResetKey, selectionScrollElement])

  useEffect(() => {
    const node = selectionScrollElement
    if (!node) return undefined

    let frame = 0
    const update = () => {
      frame = 0
      const maxScroll = Math.max(0, node.scrollHeight - node.clientHeight)
      const scrollTop = node.scrollTop
      const progress = maxScroll > 0 ? scrollTop / maxScroll : 0
      const current = selectionChromeStateRef.current
      const compact = current.compact
        ? scrollTop > SELECTION_COMPACT_EXIT_SCROLL_PX
        : scrollTop > SELECTION_COMPACT_ENTER_SCROLL_PX
      const showScrollTop = current.showScrollTop
        ? progress > SELECTION_SCROLL_TOP_HIDE_PROGRESS &&
          scrollTop > SELECTION_SCROLL_TOP_HIDE_MAX_PX
        : progress > SELECTION_SCROLL_TOP_SHOW_PROGRESS &&
          scrollTop > SELECTION_SCROLL_TOP_SHOW_MIN_PX
      if (current.compact === compact && current.showScrollTop === showScrollTop) return
      const next = { compact, showScrollTop }
      selectionChromeStateRef.current = next
      setSelectionChromeState(next)
    }

    const requestUpdate = () => {
      if (frame !== 0) return
      frame = window.requestAnimationFrame(update)
    }

    update()
    node.addEventListener('scroll', requestUpdate, { passive: true })
    return () => {
      if (frame !== 0) window.cancelAnimationFrame(frame)
      node.removeEventListener('scroll', requestUpdate)
    }
  }, [selectionScrollElement])

  useEffect(() => {
    if (!selectionChromeState.compact) setCompactMoreOpen(false)
  }, [selectionChromeState.compact])

  useEffect(() => {
    if (!compactMoreOpen) return undefined
    const handlePointerDown = (event: PointerEvent) => {
      const target = event.target
      if (!(target instanceof Node)) return
      if (!compactMoreRef.current?.contains(target)) {
        setCompactMoreOpen(false)
      }
    }
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setCompactMoreOpen(false)
    }
    document.addEventListener('pointerdown', handlePointerDown)
    document.addEventListener('keydown', handleKeyDown)
    return () => {
      document.removeEventListener('pointerdown', handlePointerDown)
      document.removeEventListener('keydown', handleKeyDown)
    }
  }, [compactMoreOpen])

  const scrollSelectionToTop = useCallback(() => {
    const node = selectionScrollRef.current ?? selectionScrollElement
    if (!node) return
    cancelScrollTopSettle()
    const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches
    setCompactMoreOpen(false)
    if (reduceMotion || node.scrollTop <= SELECTION_SCROLL_TOP_EPSILON) {
      forceSelectionScrollTop(node)
      return
    }

    node.scrollTo({ behavior: 'smooth', left: 0, top: 0 })

    const startedAt = window.performance.now()
    const settle = () => {
      if (selectionScrollRef.current !== node) {
        cancelScrollTopSettle()
        return
      }
      const elapsed = window.performance.now() - startedAt
      if (
        node.scrollTop <= SELECTION_SCROLL_TOP_EPSILON ||
        elapsed >= SELECTION_SCROLL_TOP_SETTLE_MS
      ) {
        forceSelectionScrollTop(node)
        return
      }
      scrollTopSettleFrameRef.current = window.requestAnimationFrame(settle)
    }

    scrollTopSettleFrameRef.current = window.requestAnimationFrame(settle)
    scrollTopSettleTimeoutRef.current = window.setTimeout(() => {
      if (selectionScrollRef.current === node && node.scrollTop > SELECTION_SCROLL_TOP_EPSILON) {
        forceSelectionScrollTop(node)
      }
    }, SELECTION_SCROLL_TOP_SETTLE_MS + 80)
  }, [cancelScrollTopSettle, forceSelectionScrollTop, selectionScrollElement])

  if (!activeFolder) {
    return (
      <main className="empty-screen">
        <div>
          <FolderOpen className="h-8 w-8" />
          <h1>{t('selection.empty.title')}</h1>
          <p>{t('selection.empty.body')}</p>
          <button className="button-primary" onClick={() => setRoute('start')} type="button">
            {t('selection.empty.action')}
          </button>
        </div>
      </main>
    )
  }

  return (
    <main className="selection-screen">
      <FolderRail
        activeFolderId={activeFolder.id}
        folders={folders}
        onOpenFolderContextMenu={onOpenFolderContextMenu}
        onSelectFolder={onSelectFolder}
        t={t}
        workspace={workspace}
      />

      <section className="selection-main selection-scroll" ref={setSelectionScrollNode}>
        <div className="selection-full-header">
          <FolderTopline
            activeFolder={activeFolder}
            analysisStarting={analysisStarting}
            onOpenExport={onOpenExport}
            onRelinkFolder={onRelinkFolder}
            onRenameFolder={onRenameFolder}
            onStartAnalysis={onStartAnalysis}
            progressEvent={progressEvent}
            relinking={relinkingFolderId === activeFolder.id}
            t={t}
          />
          <MetricStrip photos={folderPhotos} summary={activeFolderSummary} t={t} />
          <SelectionControls
            activeQuickFilters={activeQuickFilters}
            activeSort={activeSort}
            onlyFlying={onlyFlying}
            setActiveQuickFilter={setActiveQuickFilter}
            setOnlyFlying={setOnlyFlying}
            setActiveSort={setActiveSort}
            setViewMode={setViewMode}
            t={t}
            viewMode={viewMode}
          />
        </div>

        <div
          className="photo-flow"
          data-testid="selection-photo-flow"
          onPointerDown={handlePhotoFlowPointerDown}
        >
          {viewMode === 'grouped' ? (
            <PhotoGroupsList
              focusedPhotoId={focusedPhotoId}
              groups={filteredGroups}
              onFocusPhoto={setFocusedPhotoId}
              onOpenReview={onOpenReview}
              onThumbnailLoadStatus={onThumbnailLoadStatus}
              scrollElement={selectionScrollElement}
              t={t}
            />
          ) : (
            <VirtualizedPhotoGrid
              focusedPhotoId={focusedPhotoId}
              onFocusPhoto={setFocusedPhotoId}
              onOpenReview={onOpenReview}
              onThumbnailLoadStatus={onThumbnailLoadStatus}
              photos={flatPhotos}
              scrollElement={selectionScrollElement}
              t={t}
            />
          )}
        </div>
      </section>

      <SelectionCompactHeader
        activeFolder={activeFolder}
        activeQuickFilters={activeQuickFilters}
        activeSort={activeSort}
        analysisStarting={analysisStarting}
        compactMoreOpen={compactMoreOpen}
        compactMoreRef={compactMoreRef}
        onOpenExport={onOpenExport}
        onStartAnalysis={onStartAnalysis}
        onlyFlying={onlyFlying}
        progressEvent={progressEvent}
        setActiveQuickFilter={setActiveQuickFilter}
        setActiveSort={setActiveSort}
        setCompactMoreOpen={setCompactMoreOpen}
        setOnlyFlying={setOnlyFlying}
        setViewMode={setViewMode}
        summary={activeFolderSummary}
        t={t}
        visible={selectionChromeState.compact}
        viewMode={viewMode}
      />

      <button
        aria-label={t('selection.scrollTop')}
        className={cn(
          'selection-scroll-top',
          selectionChromeState.showScrollTop && 'selection-scroll-top--visible',
        )}
        onClick={scrollSelectionToTop}
        title={t('selection.scrollTop')}
        type="button"
      >
        <ArrowUp className="h-4 w-4" />
      </button>

      <InspectorPanel
        allPhotos={workspace.photos}
        folder={activeFolder}
        folderGroups={activeFolderGroups}
        folderPhotos={folderPhotos}
        folderSummary={activeFolderSummary}
        onOpenReview={onOpenReview}
        onSetDecision={onSetDecision}
        photo={focusedPhoto}
        setFocusedPhotoId={setFocusedPhotoId}
        sourceMissing={activeFolder.status === 'path_missing'}
        t={t}
      />

      <BackgroundTaskBar activeFolder={activeFolder} t={t} />
    </main>
  )
}

function FolderRail({
  activeFolderId,
  folders,
  onOpenFolderContextMenu,
  onSelectFolder,
  t,
  workspace,
}: {
  activeFolderId: string | null
  folders: FolderRecord[]
  onOpenFolderContextMenu: (folder: FolderRecord, event: ReactMouseEvent<HTMLElement>) => void
  onSelectFolder: (folderId: string) => void
  t: ReturnType<typeof useTranslation>['t']
  workspace: WorkspaceSnapshot
}) {
  const sections: Array<{ key: string; titleKey: string; statuses: FolderStatus[] }> = [
    {
      key: 'in_progress',
      titleKey: 'selection.sidebar.inProgress',
      statuses: ['scanning', 'hashing', 'analyzing_partial', 'updating', 'exporting'],
    },
    { key: 'recent', titleKey: 'selection.sidebar.recent', statuses: ['ready'] },
    {
      key: 'missing',
      titleKey: 'selection.sidebar.pathMissing',
      statuses: ['path_missing', 'error'],
    },
  ]
  const selectCountByFolderId = useMemo(() => {
    const counts = new Map<string, number>()
    for (const photo of workspace.photos) {
      if (photoCategory(photo) !== 'select') continue
      counts.set(photo.folderId, (counts.get(photo.folderId) ?? 0) + 1)
    }
    return counts
  }, [workspace.photos])

  return (
    <aside className="folder-rail selection-scroll">
      <div className="rail-title">
        <SectionLabel label={t('selection.sidebar.label')} />
        <h2>{t('selection.sidebar.title')}</h2>
      </div>
      {sections.map((section) => {
        const sectionFolders = folders.filter((folder) => section.statuses.includes(folder.status))
        if (sectionFolders.length === 0) return null
        return (
          <section className="rail-section" key={section.key}>
            <SectionLabel label={t(section.titleKey)} />
            {sectionFolders.map((folder) => {
              return (
                <button
                  className={cn(
                    'folder-rail-item',
                    folder.id === activeFolderId && 'folder-rail-item--active',
                  )}
                  key={folder.id}
                  onContextMenu={(event) => onOpenFolderContextMenu(folder, event)}
                  onClick={() => onSelectFolder(folder.id)}
                  type="button"
                >
                  <span className="folder-rail-item__main">
                    <strong>{folder.displayName}</strong>
                    <small>{folder.parentPath}</small>
                  </span>
                  <span className="folder-rail-item__meta">
                    <StatusDot tone={statusTone(folder.status)} />
                    <span>{formatRatio(folder.analyzedCount, folder.totalCount)}</span>
                    {folder.status === 'path_missing' ? (
                      <span>{t('selection.sourceMissing.short')}</span>
                    ) : null}
                    <span>{selectCountByFolderId.get(folder.id) ?? 0}</span>
                  </span>
                </button>
              )
            })}
          </section>
        )
      })}
    </aside>
  )
}

function SelectionCompactHeader({
  activeFolder,
  activeQuickFilters,
  activeSort,
  analysisStarting,
  compactMoreOpen,
  compactMoreRef,
  onOpenExport,
  onStartAnalysis,
  onlyFlying,
  progressEvent,
  setActiveQuickFilter,
  setActiveSort,
  setCompactMoreOpen,
  setOnlyFlying,
  setViewMode,
  summary,
  t,
  visible,
  viewMode,
}: {
  activeFolder: FolderRecord
  activeQuickFilters: QuickFilter[]
  activeSort: SortMode
  analysisStarting: boolean
  compactMoreOpen: boolean
  compactMoreRef: RefObject<HTMLDivElement | null>
  onOpenExport: () => void
  onStartAnalysis: () => void
  onlyFlying: boolean
  progressEvent: AnalysisProgressEvent | null
  setActiveQuickFilter: (filter: QuickFilter) => void
  setActiveSort: (sort: SortMode) => void
  setCompactMoreOpen: (open: boolean) => void
  setOnlyFlying: (enabled: boolean) => void
  setViewMode: (mode: ViewMode) => void
  summary: FolderSummary
  t: ReturnType<typeof useTranslation>['t']
  visible: boolean
  viewMode: ViewMode
}) {
  const sourceMissing = activeFolder.status === 'path_missing'
  const hasProgress = progressEvent !== null && progressEvent.total > 0
  const running = progressEvent ? progressEvent.pending + progressEvent.processing > 0 : false
  const ratio = hasProgress
    ? Math.min(1, progressEvent.completed / Math.max(progressEvent.total, 1))
    : 0
  const sourceDisabledTitle = sourceMissing
    ? t('selection.sourceMissing.disabledTooltip')
    : undefined

  return (
    <div
      aria-hidden={!visible}
      className={cn('selection-compact-header', visible && 'selection-compact-header--visible')}
      data-selection-compact-header
    >
      <div className="selection-compact-header__identity">
        <strong>{activeFolder.displayName}</strong>
        <span>
          {t('selection.compact.summary', {
            total: activeFolder.totalCount,
            bird: summary.birdPhotoCount,
          })}
        </span>
      </div>

      <div
        aria-label={t('selection.compact.keyMetrics')}
        className="selection-compact-header__metrics"
      >
        <span className="selection-compact-metric selection-compact-metric--select">
          {t('selection.metrics.selectPhotos')} <b>{summary.gradeCounts.select}</b>
        </span>
        <span className="selection-compact-metric selection-compact-metric--usable">
          {t('selection.metrics.usablePhotos')} <b>{summary.gradeCounts.usable}</b>
        </span>
        <span className="selection-compact-metric selection-compact-metric--record">
          {t('selection.metrics.recordPhotos')} <b>{summary.gradeCounts.record}</b>
        </span>
      </div>

      <div
        className="selection-compact-filter-row"
        aria-label={t('selection.compact.primaryFilters')}
      >
        {compactPrimaryFilters.map((filter) => (
          <button
            className={cn(
              'selection-compact-chip',
              activeQuickFilters.includes(filter) && 'selection-compact-chip--active',
            )}
            key={filter}
            onClick={() => setActiveQuickFilter(filter)}
            type="button"
          >
            {t(quickFilterLabelKey(filter))}
          </button>
        ))}
        <button
          aria-pressed={onlyFlying}
          className={cn(
            'selection-compact-chip selection-compact-chip--feature',
            onlyFlying && 'selection-compact-chip--feature-active',
          )}
          onClick={() => setOnlyFlying(!onlyFlying)}
          title={t('selection.featureFilters.onlyFlyingHint')}
          type="button"
        >
          <Feather className="h-3.5 w-3.5" />
          {t('selection.featureFilters.onlyFlying')}
        </button>
      </div>

      <div className="selection-compact-header__actions">
        <span className="selection-compact-status">
          <StatusDot tone={statusTone(activeFolder.status)} />
          {t(statusLabelKey(activeFolder.status))}
        </span>
        <button
          className="button-primary button-compact selection-compact-start"
          disabled={analysisStarting || running || sourceMissing}
          onClick={onStartAnalysis}
          title={sourceDisabledTitle}
          type="button"
        >
          <Sparkles className="h-4 w-4" />
          {running
            ? t('selection.folderHeader.analyzingPercent', { percent: Math.round(ratio * 100) })
            : analysisStarting
              ? t('selection.folderHeader.starting')
              : t('selection.folderHeader.startAnalysis')}
        </button>
        <div className="selection-compact-more" ref={compactMoreRef}>
          <button
            aria-expanded={compactMoreOpen}
            aria-haspopup="menu"
            className="button-ghost button-compact selection-compact-more__trigger"
            onClick={() => setCompactMoreOpen(!compactMoreOpen)}
            type="button"
          >
            <MoreHorizontal className="h-4 w-4" />
            {t('selection.compact.more')}
          </button>
          {compactMoreOpen ? (
            <div className="selection-compact-menu" role="menu">
              <div className="selection-compact-menu__section selection-compact-menu__primary">
                <span>{t('selection.compact.primaryFilters')}</span>
                <div className="selection-compact-menu__chips">
                  {compactPrimaryFilters.map((filter) => (
                    <button
                      className={cn(
                        'selection-compact-chip',
                        activeQuickFilters.includes(filter) && 'selection-compact-chip--active',
                      )}
                      key={filter}
                      onClick={() => setActiveQuickFilter(filter)}
                      type="button"
                    >
                      {t(quickFilterLabelKey(filter))}
                    </button>
                  ))}
                </div>
              </div>
              <div className="selection-compact-menu__section">
                <span>{t('selection.compact.moreFilters')}</span>
                <div className="selection-compact-menu__chips">
                  {compactMoreFilters.map((filter) => (
                    <button
                      className={cn(
                        'selection-compact-chip',
                        activeQuickFilters.includes(filter) && 'selection-compact-chip--active',
                      )}
                      key={filter}
                      onClick={() => setActiveQuickFilter(filter)}
                      type="button"
                    >
                      {t(quickFilterLabelKey(filter))}
                    </button>
                  ))}
                </div>
              </div>
              <div className="selection-compact-menu__section">
                <span>{t('selection.compact.featureFilters')}</span>
                <div className="selection-compact-menu__chips">
                  <button
                    aria-pressed={onlyFlying}
                    className={cn(
                      'selection-compact-chip selection-compact-chip--feature',
                      onlyFlying && 'selection-compact-chip--feature-active',
                    )}
                    onClick={() => setOnlyFlying(!onlyFlying)}
                    title={t('selection.featureFilters.onlyFlyingHint')}
                    type="button"
                  >
                    <Feather className="h-3.5 w-3.5" />
                    {t('selection.featureFilters.onlyFlying')}
                  </button>
                </div>
              </div>
              <div className="selection-compact-menu__section">
                <span>{t('selection.compact.sort')}</span>
                <div className="mini-segment selection-compact-menu__segment">
                  {sortModes.map((sort) => (
                    <button
                      className={cn(activeSort === sort && 'is-active')}
                      key={sort}
                      onClick={() => setActiveSort(sort)}
                      type="button"
                    >
                      {t(sortLabelKey(sort))}
                    </button>
                  ))}
                </div>
              </div>
              <div className="selection-compact-menu__section">
                <span>{t('selection.compact.view')}</span>
                <div className="mini-segment selection-compact-menu__segment">
                  {viewModes.map((mode) => (
                    <button
                      className={cn(viewMode === mode && 'is-active')}
                      key={mode}
                      onClick={() => setViewMode(mode)}
                      type="button"
                    >
                      {t(viewModeKey(mode))}
                    </button>
                  ))}
                </div>
              </div>
              <button
                className="button-ghost button-compact selection-compact-menu__action"
                disabled={sourceMissing}
                onClick={() => {
                  setCompactMoreOpen(false)
                  onOpenExport()
                }}
                title={sourceMissing ? t('selection.sourceMissing.exportDisabled') : undefined}
                type="button"
              >
                <Download className="h-4 w-4" />
                {t('common.export')}
              </button>
            </div>
          ) : null}
        </div>
      </div>
    </div>
  )
}

function FolderTopline({
  activeFolder,
  analysisStarting,
  onOpenExport,
  onRelinkFolder,
  onRenameFolder,
  onStartAnalysis,
  progressEvent,
  relinking,
  t,
}: {
  activeFolder: FolderRecord
  analysisStarting: boolean
  onOpenExport: () => void
  onRelinkFolder: (folderId: string) => Promise<void>
  onRenameFolder: (folderId: string, displayName: string) => Promise<void>
  onStartAnalysis: () => void
  progressEvent: AnalysisProgressEvent | null
  relinking: boolean
  t: ReturnType<typeof useTranslation>['t']
}) {
  const [aliasDraft, setAliasDraft] = useState(activeFolder.displayName)
  const [aliasEditing, setAliasEditing] = useState(false)
  const [aliasSaving, setAliasSaving] = useState(false)
  const [aliasError, setAliasError] = useState<string | null>(null)
  // 是否正在跑：pending/processing 还有任务
  const running = progressEvent ? progressEvent.pending + progressEvent.processing > 0 : false
  const hasProgress = progressEvent !== null && progressEvent.total > 0
  const ratio = hasProgress
    ? Math.min(1, progressEvent.completed / Math.max(progressEvent.total, 1))
    : 0
  const progressLabel = hasProgress ? `${progressEvent.completed} / ${progressEvent.total}` : null
  const sourceMissing = activeFolder.status === 'path_missing'
  const sourceDisabledTitle = sourceMissing
    ? t('selection.sourceMissing.disabledTooltip')
    : undefined
  const [relinkError, setRelinkError] = useState<string | null>(null)
  useEffect(() => {
    if (!aliasEditing) {
      setAliasDraft(activeFolder.displayName)
      setAliasError(null)
    }
  }, [activeFolder.displayName, activeFolder.id, aliasEditing])

  useEffect(() => {
    setRelinkError(null)
  }, [activeFolder.id, activeFolder.status])

  const startAliasEditing = () => {
    setAliasDraft(activeFolder.displayName)
    setAliasError(null)
    setAliasEditing(true)
  }

  const cancelAliasEditing = () => {
    setAliasDraft(activeFolder.displayName)
    setAliasError(null)
    setAliasEditing(false)
  }

  const submitAlias = async () => {
    const trimmed = aliasDraft.trim()
    if (!trimmed) {
      setAliasError(t('selection.folderHeader.aliasEmpty'))
      return
    }
    if (trimmed === activeFolder.displayName) {
      setAliasEditing(false)
      return
    }
    setAliasSaving(true)
    setAliasError(null)
    try {
      await onRenameFolder(activeFolder.id, trimmed)
      setAliasEditing(false)
    } catch (err) {
      logger.warn('Failed to update library display name:', err)
      setAliasError(t('selection.folderHeader.aliasFailed'))
    } finally {
      setAliasSaving(false)
    }
  }

  const submitRelink = async () => {
    setRelinkError(null)
    try {
      await onRelinkFolder(activeFolder.id)
    } catch {
      setRelinkError(t('selection.sourceMissing.relinkFailed'))
    }
  }

  return (
    <header className="folder-topline">
      <div className="folder-heading-main">
        <SectionLabel label={t('selection.currentFolder')} />
        {aliasEditing ? (
          <form
            className="folder-alias-form"
            onSubmit={(event) => {
              event.preventDefault()
              void submitAlias()
            }}
          >
            <input
              aria-invalid={Boolean(aliasError)}
              aria-label={t('selection.folderHeader.alias')}
              autoFocus
              className="folder-alias-input"
              disabled={aliasSaving}
              maxLength={120}
              onChange={(event) => setAliasDraft(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Escape') {
                  event.preventDefault()
                  cancelAliasEditing()
                }
              }}
              placeholder={t('selection.folderHeader.aliasPlaceholder')}
              value={aliasDraft}
            />
            <button
              aria-label={t('selection.folderHeader.saveAlias')}
              className="icon-button folder-alias-button"
              disabled={aliasSaving}
              type="submit"
            >
              {aliasSaving ? (
                <RefreshCw className="h-4 w-4 animate-spin" />
              ) : (
                <Check className="h-4 w-4" />
              )}
            </button>
            <button
              aria-label={t('selection.folderHeader.cancelAlias')}
              className="icon-button folder-alias-button"
              disabled={aliasSaving}
              onClick={cancelAliasEditing}
              type="button"
            >
              <X className="h-4 w-4" />
            </button>
          </form>
        ) : (
          <div className="folder-title-row">
            <h1>{activeFolder.displayName}</h1>
            <button
              aria-label={t('selection.folderHeader.editAlias')}
              className="icon-button folder-alias-button"
              onClick={startAliasEditing}
              title={t('selection.folderHeader.editAlias')}
              type="button"
            >
              <PencilLine className="h-4 w-4" />
            </button>
          </div>
        )}
        {aliasError ? (
          <span className="folder-alias-error" role="alert">
            {aliasError}
          </span>
        ) : null}
        <p>{activeFolder.rootPath}</p>
        {sourceMissing ? (
          <div className="source-link-warning" role="status">
            <span>
              <strong>{t('selection.sourceMissing.title')}</strong>
              <small>{relinkError ?? t('selection.sourceMissing.body')}</small>
            </span>
            <button
              className="button-ghost button-compact"
              disabled={relinking}
              onClick={() => void submitRelink()}
              type="button"
            >
              {relinking ? (
                <RefreshCw className="h-4 w-4 animate-spin" />
              ) : (
                <FolderSearch2 className="h-4 w-4" />
              )}
              {relinking
                ? t('selection.sourceMissing.relinking')
                : t('selection.sourceMissing.relinkAction')}
            </button>
          </div>
        ) : null}
      </div>
      <div className="folder-actions">
        <span className="folder-status">
          <StatusDot tone={statusTone(activeFolder.status)} />
          {t(statusLabelKey(activeFolder.status))}
        </span>
        {/* 进度只在分析进行中(pending+processing > 0)显示 — 老逻辑停止后仍展示
            "已分析 0 / 3" 会让用户误以为还有 N 张待分析,实际可能是 N 张全部永久失
            败 (broken_image / 解码错)。永久失败的照片由 metric-strip 的"失败"cell
            统一展示;quickFilter 切到"失败"能查看具体哪些。 */}
        {hasProgress && running ? (
          <span
            className="folder-status"
            style={{ minWidth: 120, justifyContent: 'flex-end' }}
            aria-label="analysis-progress"
          >
            <span className="text-[11px] text-white/60">
              {t('selection.folderHeader.analyzingProgress', { progress: progressLabel })}
            </span>
          </span>
        ) : null}
        <button
          className="button-primary button-compact"
          disabled={analysisStarting || running || sourceMissing}
          onClick={onStartAnalysis}
          title={sourceDisabledTitle}
          type="button"
        >
          <Sparkles className="h-4 w-4" />
          {running
            ? t('selection.folderHeader.analyzingPercent', { percent: Math.round(ratio * 100) })
            : analysisStarting
              ? t('selection.folderHeader.starting')
              : t('selection.folderHeader.startAnalysis')}
        </button>
        <button
          className="button-ghost button-compact"
          disabled={sourceMissing}
          onClick={onOpenExport}
          title={sourceDisabledTitle}
          type="button"
        >
          <Download className="h-4 w-4" />
          {t('common.export')}
        </button>
        <button
          className="button-ghost button-compact"
          disabled={sourceMissing}
          title={sourceDisabledTitle}
          type="button"
        >
          <RefreshCw className="h-4 w-4" />
          {activeFolder.status === 'ready'
            ? t('selection.folderHeader.update')
            : t('selection.folderHeader.resume')}
        </button>
      </div>
    </header>
  )
}

function MetricStrip({
  photos,
  summary,
  t,
}: {
  photos: PhotoRecord[]
  summary: FolderSummary
  t: ReturnType<typeof useTranslation>['t']
}) {
  const hasFailures = summary.failedCount > 0

  return (
    <section
      className={cn(
        'metric-strip',
        'metric-strip--selection',
        hasFailures && 'metric-strip--with-failed',
      )}
    >
      <MetricCell label={t('selection.metrics.totalPhotos')} value={photos.length} />
      <MetricCell
        label={t('selection.metrics.birdPhotos')}
        tone="success"
        value={summary.birdPhotoCount}
      />
      <MetricCell
        label={t('selection.metrics.selectPhotos')}
        tone="success"
        value={summary.gradeCounts.select}
      />
      <MetricCell label={t('selection.metrics.usablePhotos')} value={summary.gradeCounts.usable} />
      <MetricCell
        label={t('selection.metrics.recordPhotos')}
        tone="warning"
        value={summary.gradeCounts.record}
      />
      <MetricCell
        label={t('selection.metrics.rejectCount')}
        tone="accent"
        value={summary.gradeCounts.reject}
      />
      {/* 失败 cell 仅在有失败照片时显示 — 0 不占视觉位,避免常态噪音。
          tone='accent' 与"淘汰"同色调红警告;失败的源文件没法分析,本质是"硬错"。 */}
      {hasFailures ? (
        <MetricCell
          label={t('selection.metrics.failedPhotos')}
          tone="accent"
          value={summary.failedCount}
        />
      ) : null}
    </section>
  )
}

function SelectionControls({
  activeQuickFilters,
  activeSort,
  onlyFlying,
  setActiveQuickFilter,
  setOnlyFlying,
  setActiveSort,
  setViewMode,
  t,
  viewMode,
}: {
  activeQuickFilters: QuickFilter[]
  activeSort: SortMode
  onlyFlying: boolean
  setActiveQuickFilter: (filter: QuickFilter) => void
  setOnlyFlying: (enabled: boolean) => void
  setActiveSort: (sort: SortMode) => void
  setViewMode: (mode: ViewMode) => void
  t: ReturnType<typeof useTranslation>['t']
  viewMode: ViewMode
}) {
  return (
    <section className="selection-controls">
      <div className="filter-row">
        <div className="filter-row__grades" aria-label={t('selection.quickFilters.groupLabel')}>
          {quickFilters.map((filter) => (
            <button
              className={cn('chip', activeQuickFilters.includes(filter) && 'chip--active')}
              key={filter}
              onClick={() => setActiveQuickFilter(filter)}
              type="button"
            >
              {t(quickFilterLabelKey(filter))}
            </button>
          ))}
        </div>
        <span className="filter-row__divider" aria-hidden="true" />
        <button
          aria-pressed={onlyFlying}
          className={cn('chip chip--feature', onlyFlying && 'chip--feature-active')}
          onClick={() => setOnlyFlying(!onlyFlying)}
          title={t('selection.featureFilters.onlyFlyingHint')}
          type="button"
        >
          <Feather className="h-3.5 w-3.5" />
          {t('selection.featureFilters.onlyFlying')}
        </button>
      </div>
      <div className="control-row">
        <div className="mini-segment">
          {sortModes.map((sort) => (
            <button
              className={cn(activeSort === sort && 'is-active')}
              key={sort}
              onClick={() => setActiveSort(sort)}
              type="button"
            >
              {t(sortLabelKey(sort))}
            </button>
          ))}
        </div>
        <div className="mini-segment">
          {viewModes.map((mode) => (
            <button
              className={cn(viewMode === mode && 'is-active')}
              key={mode}
              onClick={() => setViewMode(mode)}
              type="button"
            >
              {t(viewModeKey(mode))}
            </button>
          ))}
        </div>
      </div>
    </section>
  )
}


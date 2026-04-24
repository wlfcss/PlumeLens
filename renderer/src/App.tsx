import {
  Aperture,
  ArrowRight,
  Check,
  Clock3,
  Download,
  Feather,
  FolderOpen,
  FolderSearch2,
  ImageIcon,
  LibraryBig,
  RefreshCw,
  Search,
  Settings2,
  Sparkles,
  Waypoints,
  X,
} from 'lucide-react'
import {
  startTransition,
  useDeferredValue,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react'
import { useTranslation } from 'react-i18next'

import { useBackendHealth } from '@/hooks/use-backend'
import { useImportLibrary, useLibraries } from '@/hooks/use-library'
import type {
  AnalysisStatus,
  ArchiveTab,
  AppRoute,
  FolderRecord,
  FolderStatus,
  PhotoGrade,
  PhotoGroupRecord,
  PhotoRecord,
  ProblemTagId,
  PoseTagId,
  SceneTagId,
  SelectionDecision,
  SpeciesRecord,
  WorkspaceSnapshot,
} from '@/lib/mock-workspace'
import { createImportedFolder, createInitialWorkspace } from '@/lib/mock-workspace'
import { cn } from '@/lib/utils'
import { useShallow, useUIStore, type QuickFilter, type ViewMode } from '@/stores/ui-store'

type Tone = 'neutral' | 'warning' | 'accent' | 'success' | 'muted'
type SortMode = 'score' | 'shot_at' | 'recent' | 'name'

type FolderSummary = {
  selectedCount: number
  maybeCount: number
  rejectedCount: number
  newSpeciesCount: number
  birdPhotoCount: number
  noBirdCount: number
  speciesCount: number
  gradeCounts: Record<PhotoGrade, number>
}

type ReviewDetail = {
  photo: PhotoRecord
  group: PhotoGroupRecord | null
}

const routeIcons: Record<AppRoute, typeof Aperture> = {
  start: Aperture,
  selection: Sparkles,
  archive: LibraryBig,
}

const quickFilters: QuickFilter[] = [
  'all',
  'unreviewed',
  'selected',
  'maybe',
  'rejected',
  'select',
  'new_species',
]

const archiveTabs: ArchiveTab[] = ['photos', 'species']
const viewModes: ViewMode[] = ['grouped', 'flat', 'selected_only']
const sortModes: SortMode[] = ['score', 'shot_at', 'recent', 'name']
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

function matchesQuery(parts: Array<string | null | undefined>, query: string): boolean {
  const normalized = query.trim().toLowerCase()
  if (!normalized) return true
  return parts.some((part) => part?.toLowerCase().includes(normalized))
}

function formatRatio(current: number, total: number): string {
  return `${current}/${total}`
}

function buildFolderSummary(photos: PhotoRecord[]): FolderSummary {
  return photos.reduce<FolderSummary>(
    (acc, photo) => {
      acc.gradeCounts[photo.grade] += 1
      if (photo.decision === 'selected') acc.selectedCount += 1
      if (photo.decision === 'maybe') acc.maybeCount += 1
      if (photo.decision === 'rejected') acc.rejectedCount += 1
      if (photo.isNewSpecies) acc.newSpeciesCount += 1
      if (photo.birdCount > 0) acc.birdPhotoCount += 1
      if (photo.birdCount === 0) acc.noBirdCount += 1
      return acc
    },
    {
      selectedCount: 0,
      maybeCount: 0,
      rejectedCount: 0,
      newSpeciesCount: 0,
      birdPhotoCount: 0,
      noBirdCount: 0,
      speciesCount: new Set(
        photos.flatMap((photo) => (photo.speciesName ? [photo.speciesName] : [])),
      ).size,
      gradeCounts: { reject: 0, record: 0, usable: 0, select: 0 },
    },
  )
}

function filterPhotoByQuickFilter(photo: PhotoRecord, filter: QuickFilter): boolean {
  switch (filter) {
    case 'unreviewed':
      return photo.decision === 'unreviewed'
    case 'selected':
      return photo.decision === 'selected'
    case 'maybe':
      return photo.decision === 'maybe'
    case 'rejected':
      return photo.decision === 'rejected'
    case 'select':
      return photo.grade === 'select'
    case 'new_species':
      return photo.isNewSpecies
    case 'bird':
      return photo.birdCount > 0
    case 'no_bird':
      return photo.birdCount === 0
    default:
      return true
  }
}

function sortPhotos(photos: PhotoRecord[], sortBy: SortMode): PhotoRecord[] {
  return photos.toSorted((left, right) => {
    if (sortBy === 'name') return left.fileName.localeCompare(right.fileName)
    if (sortBy === 'shot_at') return right.shotAt.localeCompare(left.shotAt)
    if (sortBy === 'recent') return right.id.localeCompare(left.id)
    return (right.finalScore ?? -1) - (left.finalScore ?? -1)
  })
}

function statusTone(status: FolderStatus): Tone {
  if (status === 'ready') return 'success'
  if (status === 'path_missing' || status === 'error') return 'accent'
  if (status === 'analyzing_partial' || status === 'scanning' || status === 'hashing')
    return 'warning'
  return 'neutral'
}

function gradeTone(grade: PhotoGrade): Tone {
  if (grade === 'select') return 'success'
  if (grade === 'record') return 'warning'
  if (grade === 'reject') return 'accent'
  return 'neutral'
}

function decisionTone(decision: SelectionDecision): Tone {
  if (decision === 'selected') return 'success'
  if (decision === 'maybe') return 'warning'
  if (decision === 'rejected') return 'accent'
  return 'muted'
}

function analysisTone(status: AnalysisStatus): Tone {
  if (status === 'done') return 'success'
  if (status === 'running') return 'warning'
  if (status === 'failed') return 'accent'
  return 'neutral'
}

function statusLabelKey(status: FolderStatus) {
  return `selection.folderStatus.${status}` as const
}

function decisionLabelKey(decision: SelectionDecision) {
  return `selection.decision.${decision}` as const
}

function gradeLabelKey(grade: PhotoGrade) {
  return `selection.grade.${grade}` as const
}

function poseTagKey(tag: PoseTagId) {
  return `selection.poseTags.${tag}` as const
}

function problemTagKey(tag: ProblemTagId) {
  return `selection.problemTags.${tag}` as const
}

function sceneTagKey(tag: SceneTagId) {
  return `selection.sceneTags.${tag}` as const
}

function routeLabelKey(route: AppRoute) {
  return `nav.${route}` as const
}

function archiveTabLabelKey(tab: ArchiveTab) {
  return `archive.tabs.${tab}` as const
}

function viewModeKey(mode: ViewMode) {
  return `selection.viewModes.${mode}` as const
}

function sortLabelKey(sort: SortMode) {
  return `selection.sort.${sort}` as const
}

function quickFilterLabelKey(filter: QuickFilter) {
  return `selection.quickFilters.${filter}` as const
}

function mergeWorkspace(current: WorkspaceSnapshot, patch: WorkspaceSnapshot): WorkspaceSnapshot {
  return {
    folders: [...patch.folders, ...current.folders],
    groups: [...patch.groups, ...current.groups],
    photos: [...patch.photos, ...current.photos],
    species: current.species,
  }
}

function photoReviewReason(photo: PhotoRecord): string {
  if (photo.problemTags.includes('no_bird')) return 'selection.reviewReasons.no_bird'
  if (photo.isNewSpecies) return 'selection.reviewReasons.new_species'
  if (photo.grade === 'select') return 'selection.reviewReasons.top_pick'
  if (photo.problemTags.length > 0) return 'selection.reviewReasons.has_issues'
  if (photo.decision === 'selected') return 'selection.reviewReasons.user_selected'
  return 'selection.reviewReasons.candidate'
}

function deriveSpeciesRecords(workspace: WorkspaceSnapshot): SpeciesRecord[] {
  return workspace.species.toSorted((left, right) => right.bestScore - left.bestScore)
}

function folderHasActiveTasks(status: FolderStatus): boolean {
  return ['scanning', 'hashing', 'analyzing_partial', 'updating', 'exporting'].includes(status)
}

export default function App() {
  const { t } = useTranslation()
  const { data: backendData, isReady, isError } = useBackendHealth()
  const [workspace, setWorkspace] = useState<WorkspaceSnapshot>(() => createInitialWorkspace())

  const {
    route,
    archiveTab,
    activeFolderId,
    activeSpeciesId,
    activeQuickFilter,
    activeSort,
    viewMode,
    searchQuery,
    focusedPhotoId,
    comparePhotoIds,
    reviewPhotoId,
    compareOpen,
    exportOpen,
    setRoute,
    setArchiveTab,
    setActiveFolderId,
    setActiveSpeciesId,
    setActiveQuickFilter,
    setActiveSort,
    setViewMode,
    setSearchQuery,
    setFocusedPhotoId,
    setReviewPhotoId,
    setCompareOpen,
    setExportOpen,
    toggleComparePhotoId,
    clearCompare,
  } = useUIStore(
    useShallow((state) => ({
      route: state.route,
      archiveTab: state.archiveTab,
      activeFolderId: state.activeFolderId,
      activeSpeciesId: state.activeSpeciesId,
      activeQuickFilter: state.activeQuickFilter,
      activeSort: state.activeSort,
      viewMode: state.viewMode,
      searchQuery: state.searchQuery,
      focusedPhotoId: state.focusedPhotoId,
      comparePhotoIds: state.comparePhotoIds,
      reviewPhotoId: state.reviewPhotoId,
      compareOpen: state.compareOpen,
      exportOpen: state.exportOpen,
      setRoute: state.setRoute,
      setArchiveTab: state.setArchiveTab,
      setActiveFolderId: state.setActiveFolderId,
      setActiveSpeciesId: state.setActiveSpeciesId,
      setActiveQuickFilter: state.setActiveQuickFilter,
      setActiveSort: state.setActiveSort,
      setViewMode: state.setViewMode,
      setSearchQuery: state.setSearchQuery,
      setFocusedPhotoId: state.setFocusedPhotoId,
      setReviewPhotoId: state.setReviewPhotoId,
      setCompareOpen: state.setCompareOpen,
      setExportOpen: state.setExportOpen,
      toggleComparePhotoId: state.toggleComparePhotoId,
      clearCompare: state.clearCompare,
    })),
  )

  const deferredSearch = useDeferredValue(searchQuery)
  const speciesRecords = useMemo(() => deriveSpeciesRecords(workspace), [workspace])

  // TODO: Replace mock workspace mutations with backend API + TanStack Query mutations
  // once scan, decision, compare, and export endpoints are wired.
  useEffect(() => {
    if (!activeFolderId && workspace.folders.length > 0) {
      setActiveFolderId(workspace.folders[0]?.id ?? null)
    }
  }, [activeFolderId, setActiveFolderId, workspace.folders])

  const visibleFolders = workspace.folders.filter((folder) =>
    matchesQuery([folder.displayName, folder.parentPath, folder.rootPath], deferredSearch),
  )
  const activeFolder =
    workspace.folders.find((folder) => folder.id === activeFolderId) ?? visibleFolders[0] ?? null
  const activeFolderPhotos = workspace.photos.filter((photo) => photo.folderId === activeFolder?.id)
  const activeFolderSummary = buildFolderSummary(activeFolderPhotos)
  const filteredSelectionPhotos = sortPhotos(
    activeFolderPhotos.filter(
      (photo) =>
        filterPhotoByQuickFilter(photo, activeQuickFilter) &&
        matchesQuery([photo.fileName, photo.speciesName, photo.caption], deferredSearch) &&
        (viewMode !== 'selected_only' || photo.decision === 'selected'),
    ),
    activeSort,
  )

  const folderGroups = workspace.groups
    .filter((group) => group.folderId === activeFolder?.id)
    .map((group) => ({
      group,
      photos: filteredSelectionPhotos.filter((photo) => photo.groupId === group.id),
    }))
    .filter((entry) => entry.photos.length > 0)
    .toSorted(
      (left, right) =>
        (right.photos[0]?.finalScore ?? -1) - (left.photos[0]?.finalScore ?? -1),
    )

  const flatSelectionPhotos =
    viewMode === 'flat' || viewMode === 'selected_only'
      ? filteredSelectionPhotos
      : folderGroups.flatMap((entry) => entry.photos)

  const focusedPhoto = workspace.photos.find((photo) => photo.id === focusedPhotoId) ?? null
  const reviewPhoto = workspace.photos.find((photo) => photo.id === reviewPhotoId) ?? null
  const reviewGroup = workspace.groups.find((group) => group.id === reviewPhoto?.groupId) ?? null
  const comparePhotos = comparePhotoIds
    .map((id) => workspace.photos.find((photo) => photo.id === id) ?? null)
    .filter((photo): photo is PhotoRecord => photo !== null)
  const activeSpecies =
    speciesRecords.find((species) => species.id === activeSpeciesId) ?? speciesRecords[0] ?? null

  const archivePhotos = sortPhotos(
    workspace.photos.filter((photo) =>
      matchesQuery([photo.fileName, photo.speciesName, photo.caption], deferredSearch),
    ),
    'score',
  )
  const archiveSpecies = speciesRecords.filter((species) =>
    matchesQuery([species.name, species.latinName, species.summary], deferredSearch),
  )

  const { data: realLibraries } = useLibraries()
  const importLibrary = useImportLibrary()

  // 后端真数据就绪时，用真 library 列表替换 mock 的 folders（仅 folders 层，
  // photos 等仍保留 mock 作为 UI 过渡，直到后端 analysis 结果字段齐全）
  useEffect(() => {
    if (!realLibraries || realLibraries.length === 0) return
    setWorkspace((current) => ({
      ...current,
      folders: realLibraries.map((lib) => ({
        id: lib.id,
        displayName: lib.display_name,
        parentPath: lib.parent_path,
        rootPath: lib.root_path,
        status: lib.status,
        totalCount: lib.total_count,
        analyzedCount: lib.analyzed_count,
        recursive: lib.recursive,
        lastOpenedAt: lib.last_opened_at,
        lastScannedAt: lib.last_scanned_at ?? lib.last_opened_at,
        lastAnalyzedAt: lib.last_analyzed_at,
      })),
    }))
  }, [realLibraries])

  async function handleChooseFolder() {
    const path = await window.plumelens?.openFolder?.()
    if (!path) return

    // 先乐观更新 UI（用 mock data generator）
    const imported = createImportedFolder(path)
    startTransition(() => {
      setWorkspace((current) => mergeWorkspace(current, imported))
      setRoute('selection')
      setActiveFolderId(imported.folders[0]?.id ?? null)
      setActiveQuickFilter('all')
      setViewMode('grouped')
    })

    // 同时触发真 API 导入（失败不影响 mock UI；成功后 useLibraries 会自动 refetch）
    try {
      await importLibrary.mutateAsync({ root_path: path })
    } catch (err) {
      // 后端不可用时保持 mock 体验，只记录不报错
      console.warn('Library import to backend failed:', err)
    }
  }

  function handleNavigate(nextRoute: AppRoute) {
    startTransition(() => {
      setRoute(nextRoute)
      if (nextRoute === 'selection' && activeFolder) {
        setActiveFolderId(activeFolder.id)
      }
    })
  }

  function handleSelectFolder(folderId: string) {
    startTransition(() => {
      setRoute('selection')
      setActiveFolderId(folderId)
    })
  }

  function handleSetDecision(photoId: string, decision: SelectionDecision) {
    startTransition(() => {
      setWorkspace((current) => ({
        ...current,
        photos: current.photos.map((photo) =>
          photo.id === photoId ? { ...photo, decision } : photo,
        ),
      }))
      setFocusedPhotoId(photoId)
    })
  }

  function handleOpenReview(photoId: string) {
    startTransition(() => {
      setFocusedPhotoId(photoId)
      setReviewPhotoId(photoId)
    })
  }

  function handleOpenCompare() {
    if (comparePhotos.length >= 2) {
      startTransition(() => setCompareOpen(true))
    }
  }

  function handleKeepBestOne() {
    const bestPhoto = comparePhotos.toSorted(
      (left, right) => (right.finalScore ?? -1) - (left.finalScore ?? -1),
    )[0]
    if (!bestPhoto) return

    startTransition(() => {
      setWorkspace((current) => ({
        ...current,
        photos: current.photos.map((photo) => {
          if (!comparePhotoIds.includes(photo.id)) return photo
          return {
            ...photo,
            decision: photo.id === bestPhoto.id ? 'selected' : 'rejected',
          }
        }),
      }))
      clearCompare()
    })
  }

  return (
    <AppShell
      backendConnected={isReady}
      isError={isError}
      onNavigate={handleNavigate}
      onOpenExport={() => setExportOpen(true)}
      onSearchChange={setSearchQuery}
      route={route}
      searchQuery={searchQuery}
      t={t}
    >
      {route === 'selection' ? (
        <SelectionScreen
          activeFolder={activeFolder}
          activeFolderSummary={activeFolderSummary}
          activeQuickFilter={activeQuickFilter}
          activeSort={activeSort}
          compareCount={comparePhotoIds.length}
          compareEnabled={comparePhotos.length >= 2}
          comparePhotoIds={comparePhotoIds}
          filteredGroups={folderGroups}
          flatPhotos={flatSelectionPhotos}
          focusedPhoto={focusedPhoto}
          focusedPhotoId={focusedPhotoId}
          folderPhotos={activeFolderPhotos}
          folders={visibleFolders}
          onOpenCompare={handleOpenCompare}
          onOpenExport={() => setExportOpen(true)}
          onOpenReview={handleOpenReview}
          onSelectFolder={handleSelectFolder}
          onSetDecision={handleSetDecision}
          onToggleCompare={toggleComparePhotoId}
          setActiveQuickFilter={setActiveQuickFilter}
          setActiveSort={setActiveSort}
          setFocusedPhotoId={setFocusedPhotoId}
          setRoute={setRoute}
          setViewMode={setViewMode}
          t={t}
          viewMode={viewMode}
          workspace={workspace}
        />
      ) : route === 'archive' ? (
        <ArchiveScreen
          activeSpecies={activeSpecies}
          archivePhotos={archivePhotos}
          archiveSpecies={archiveSpecies}
          archiveTab={archiveTab}
          onOpenReview={handleOpenReview}
          onSelectSpecies={setActiveSpeciesId}
          onSetArchiveTab={setArchiveTab}
          t={t}
        />
      ) : (
        <StartScreen
          backendData={backendData}
          folders={visibleFolders}
          isError={isError}
          isReady={isReady}
          onChooseFolder={handleChooseFolder}
          onContinueLatest={() => handleNavigate('selection')}
          onOpenFolder={handleSelectFolder}
          t={t}
        />
      )}

      {reviewPhoto ? (
        <ReviewModal
          detail={{ photo: reviewPhoto, group: reviewGroup }}
          onAddToCompare={toggleComparePhotoId}
          onClose={() => setReviewPhotoId(null)}
          onSetDecision={handleSetDecision}
          t={t}
        />
      ) : null}

      {compareOpen ? (
        <CompareModal
          onClose={clearCompare}
          onKeepBestOne={handleKeepBestOne}
          onSetDecision={handleSetDecision}
          photos={comparePhotos}
          t={t}
        />
      ) : null}

      {exportOpen ? (
        <ExportDrawer
          activeFolder={activeFolder}
          onClose={() => setExportOpen(false)}
          summary={activeFolderSummary}
          t={t}
        />
      ) : null}
    </AppShell>
  )
}

function AppShell({
  backendConnected,
  children,
  isError,
  onNavigate,
  onOpenExport,
  onSearchChange,
  route,
  searchQuery,
  t,
}: {
  backendConnected: boolean
  children: ReactNode
  isError: boolean
  onNavigate: (route: AppRoute) => void
  onOpenExport: () => void
  onSearchChange: (value: string) => void
  route: AppRoute
  searchQuery: string
  t: ReturnType<typeof useTranslation>['t']
}) {
  return (
    <div className="app-shell">
      <header className="command-bar">
        <button className="brand-mark" onClick={() => onNavigate('start')} type="button">
          <span className="brand-mark__icon">
            <Feather className="h-4 w-4" />
          </span>
          <span className="brand-mark__copy">
            <span>{t('app.title')}</span>
            <span>{t('app.tagline')}</span>
          </span>
        </button>

        <nav className="route-switcher" aria-label={t('nav.primary')}>
          {(['start', 'selection', 'archive'] as AppRoute[]).map((item) => {
            const Icon = routeIcons[item]
            return (
              <button
                className={cn('route-switcher__item', route === item && 'route-switcher__item--active')}
                key={item}
                onClick={() => onNavigate(item)}
                type="button"
              >
                <Icon className="h-4 w-4" />
                <span>{t(routeLabelKey(item))}</span>
              </button>
            )
          })}
        </nav>

        <div className="command-actions">
          <label className="search-pill">
            <Search className="h-4 w-4" />
            <input
              onChange={(event) => onSearchChange(event.target.value)}
              placeholder={t('nav.search')}
              value={searchQuery}
            />
          </label>
          <IconButton label={t('common.export')} onClick={onOpenExport}>
            <Download className="h-4 w-4" />
          </IconButton>
          <IconButton label={t('common.settings')}>
            <Settings2 className="h-4 w-4" />
          </IconButton>
          <span className="engine-pill">
            <StatusDot tone={backendConnected ? 'success' : isError ? 'accent' : 'warning'} />
            <span>{backendConnected ? t('status.connected') : isError ? t('status.error') : t('status.connecting')}</span>
          </span>
        </div>
      </header>

      <div className="app-body">{children}</div>
    </div>
  )
}

function StartScreen({
  backendData,
  folders,
  isError,
  isReady,
  onChooseFolder,
  onContinueLatest,
  onOpenFolder,
  t,
}: {
  backendData: ReturnType<typeof useBackendHealth>['data']
  folders: FolderRecord[]
  isError: boolean
  isReady: boolean
  onChooseFolder: () => void
  onContinueLatest: () => void
  onOpenFolder: (folderId: string) => void
  t: ReturnType<typeof useTranslation>['t']
}) {
  const recentFolders = folders.toSorted((left, right) =>
    right.lastOpenedAt.localeCompare(left.lastOpenedAt),
  )
  const pipelineModels = backendData?.pipeline?.models
  const hasRecentFolders = recentFolders.length > 0

  return (
    <main className={cn('start-screen selection-scroll', !hasRecentFolders && 'start-screen--empty-history')}>
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
            <div className="folder-stack">
              {recentFolders.slice(0, 3).map((folder) => (
                <button
                  className="folder-line"
                  key={folder.id}
                  onClick={() => onOpenFolder(folder.id)}
                  type="button"
                >
                  <span>
                    <strong>{folder.displayName}</strong>
                    <small>{folder.parentPath}</small>
                  </span>
                  <StatusDot tone={statusTone(folder.status)} />
                </button>
              ))}
            </div>
          </div>
        </section>
      ) : null}
      <EnginePanel
        detectorReady={Boolean(pipelineModels?.yolo?.loaded)}
        isError={isError}
        isReady={isReady}
        t={t}
      />
    </main>
  )
}

function EnginePanel({
  detectorReady,
  isError,
  isReady,
  t,
}: {
  detectorReady: boolean
  isError: boolean
  isReady: boolean
  t: ReturnType<typeof useTranslation>['t']
}) {
  const statusToneValue: Tone = isReady ? 'success' : isError ? 'accent' : 'warning'
  const pipelineItems = [
    {
      label: t('start.status.engine'),
      tone: statusToneValue,
      value: isReady ? t('start.status.ready') : t('start.status.pending'),
    },
    {
      label: t('start.status.detector'),
      tone: detectorReady ? 'success' : 'warning',
      value: detectorReady ? t('start.status.ready') : t('start.status.pending'),
    },
    {
      label: t('start.status.species'),
      tone: 'success',
      value: t('start.status.ready'),
    },
  ] satisfies Array<{ label: string; tone: Tone; value: string }>

  return (
    <aside className="pipeline-bar">
      <div className="pipeline-bar__summary">
        <StatusDot tone={statusToneValue} />
        <span>{t('start.pipelineState')}</span>
        <strong>{isReady ? t('status.connected') : isError ? t('status.error') : t('status.connecting')}</strong>
      </div>

      <div className="pipeline-bar__items">
        {pipelineItems.map((item) => (
          <PipelineStatusItem
            key={item.label}
            label={item.label}
            tone={item.tone}
            value={item.value}
          />
        ))}
      </div>

      <div className="pipeline-bar__note">{t('start.localOnly')}</div>
    </aside>
  )
}

function PipelineStatusItem({
  label,
  tone,
  value,
}: {
  label: string
  tone: Tone
  value: string
}) {
  return (
    <div className="pipeline-bar__item">
      <small>{label}</small>
      <strong>{value}</strong>
      <StatusDot tone={tone} />
    </div>
  )
}

function BirdGlyph() {
  return (
    <div className="start-glyph-bird" aria-hidden="true">
      {birdGlyphPattern.flatMap((row, rowIndex) =>
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
      )}
    </div>
  )
}

function SelectionScreen({
  activeFolder,
  activeFolderSummary,
  activeQuickFilter,
  activeSort,
  compareCount,
  compareEnabled,
  comparePhotoIds,
  filteredGroups,
  flatPhotos,
  focusedPhoto,
  focusedPhotoId,
  folderPhotos,
  folders,
  onOpenCompare,
  onOpenExport,
  onOpenReview,
  onSelectFolder,
  onSetDecision,
  onToggleCompare,
  setActiveQuickFilter,
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
  activeQuickFilter: QuickFilter
  activeSort: SortMode
  compareCount: number
  compareEnabled: boolean
  comparePhotoIds: string[]
  filteredGroups: Array<{ group: PhotoGroupRecord; photos: PhotoRecord[] }>
  flatPhotos: PhotoRecord[]
  focusedPhoto: PhotoRecord | null
  focusedPhotoId: string | null
  folderPhotos: PhotoRecord[]
  folders: FolderRecord[]
  onOpenCompare: () => void
  onOpenExport: () => void
  onOpenReview: (photoId: string) => void
  onSelectFolder: (folderId: string) => void
  onSetDecision: (photoId: string, decision: SelectionDecision) => void
  onToggleCompare: (photoId: string) => void
  setActiveQuickFilter: (filter: QuickFilter) => void
  setActiveSort: (sort: SortMode) => void
  setFocusedPhotoId: (photoId: string | null) => void
  setRoute: (route: AppRoute) => void
  setViewMode: (mode: ViewMode) => void
  t: ReturnType<typeof useTranslation>['t']
  viewMode: ViewMode
  workspace: WorkspaceSnapshot
}) {
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
        onSelectFolder={onSelectFolder}
        t={t}
        workspace={workspace}
      />

      <section className="selection-main selection-scroll">
        <FolderTopline activeFolder={activeFolder} onOpenExport={onOpenExport} t={t} />
        <MetricStrip photos={folderPhotos} summary={activeFolderSummary} t={t} />
        <SelectionControls
          activeQuickFilter={activeQuickFilter}
          activeSort={activeSort}
          compareCount={compareCount}
          compareEnabled={compareEnabled}
          onOpenCompare={onOpenCompare}
          setActiveQuickFilter={setActiveQuickFilter}
          setActiveSort={setActiveSort}
          setViewMode={setViewMode}
          t={t}
          viewMode={viewMode}
        />

        <div className="photo-flow">
          {viewMode === 'grouped'
            ? filteredGroups.map(({ group, photos }) => (
                <PhotoGroup
                  comparePhotoIds={comparePhotoIds}
                  focusedPhotoId={focusedPhotoId}
                  group={group}
                  key={group.id}
                  onFocusPhoto={setFocusedPhotoId}
                  onOpenReview={onOpenReview}
                  onSetDecision={onSetDecision}
                  onToggleCompare={onToggleCompare}
                  photos={photos}
                  t={t}
                />
              ))
            : (
                <PhotoGrid
                  comparePhotoIds={comparePhotoIds}
                  focusedPhotoId={focusedPhotoId}
                  onFocusPhoto={setFocusedPhotoId}
                  onOpenReview={onOpenReview}
                  onSetDecision={onSetDecision}
                  onToggleCompare={onToggleCompare}
                  photos={flatPhotos}
                  t={t}
                />
              )}
        </div>
      </section>

      <InspectorPanel
        onOpenReview={onOpenReview}
        onSetDecision={onSetDecision}
        onToggleCompare={onToggleCompare}
        photo={focusedPhoto}
        setFocusedPhotoId={setFocusedPhotoId}
        t={t}
      />

      <BackgroundTaskBar activeFolder={activeFolder} t={t} />
    </main>
  )
}

function FolderRail({
  activeFolderId,
  folders,
  onSelectFolder,
  t,
  workspace,
}: {
  activeFolderId: string | null
  folders: FolderRecord[]
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
    { key: 'missing', titleKey: 'selection.sidebar.pathMissing', statuses: ['path_missing', 'error'] },
  ]

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
              const photos = workspace.photos.filter((photo) => photo.folderId === folder.id)
              const summary = buildFolderSummary(photos)
              return (
                <button
                  className={cn('folder-rail-item', folder.id === activeFolderId && 'folder-rail-item--active')}
                  key={folder.id}
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
                    <span>{summary.selectedCount}</span>
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

function FolderTopline({
  activeFolder,
  onOpenExport,
  t,
}: {
  activeFolder: FolderRecord
  onOpenExport: () => void
  t: ReturnType<typeof useTranslation>['t']
}) {
  return (
    <header className="folder-topline">
      <div>
        <SectionLabel label={t('selection.currentFolder')} />
        <h1>{activeFolder.displayName}</h1>
        <p>{activeFolder.rootPath}</p>
      </div>
      <div className="folder-actions">
        <span className="folder-status">
          <StatusDot tone={statusTone(activeFolder.status)} />
          {t(statusLabelKey(activeFolder.status))}
        </span>
        <button className="button-primary button-compact" onClick={onOpenExport} type="button">
          <Download className="h-4 w-4" />
          {t('common.export')}
        </button>
        <button className="button-ghost button-compact" type="button">
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
  return (
    <section className="metric-strip">
      <MetricCell label={t('selection.metrics.totalPhotos')} value={photos.length} />
      <MetricCell label={t('selection.metrics.birdPhotos')} tone="success" value={summary.birdPhotoCount} />
      <MetricCell label={t('selection.metrics.selectPhotos')} tone="success" value={summary.gradeCounts.select} />
      <MetricCell label={t('selection.metrics.newSpeciesCount')} tone="accent" value={summary.newSpeciesCount} />
      <MetricCell label={t('selection.metrics.rejectedCount')} tone="accent" value={summary.rejectedCount} />
    </section>
  )
}

function SelectionControls({
  activeQuickFilter,
  activeSort,
  compareCount,
  compareEnabled,
  onOpenCompare,
  setActiveQuickFilter,
  setActiveSort,
  setViewMode,
  t,
  viewMode,
}: {
  activeQuickFilter: QuickFilter
  activeSort: SortMode
  compareCount: number
  compareEnabled: boolean
  onOpenCompare: () => void
  setActiveQuickFilter: (filter: QuickFilter) => void
  setActiveSort: (sort: SortMode) => void
  setViewMode: (mode: ViewMode) => void
  t: ReturnType<typeof useTranslation>['t']
  viewMode: ViewMode
}) {
  return (
    <section className="selection-controls">
      <div className="filter-row">
        {quickFilters.map((filter) => (
          <button
            className={cn('chip', activeQuickFilter === filter && 'chip--active')}
            key={filter}
            onClick={() => setActiveQuickFilter(filter)}
            type="button"
          >
            {t(quickFilterLabelKey(filter))}
          </button>
        ))}
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
        <button
          className="button-ghost button-compact"
          disabled={!compareEnabled}
          onClick={onOpenCompare}
          type="button"
        >
          <Waypoints className="h-4 w-4" />
          {t('selection.compare.action')}
          <span>{compareCount}</span>
        </button>
      </div>
    </section>
  )
}

function PhotoGroup({
  comparePhotoIds,
  focusedPhotoId,
  group,
  onFocusPhoto,
  onOpenReview,
  onSetDecision,
  onToggleCompare,
  photos,
  t,
}: {
  comparePhotoIds: string[]
  focusedPhotoId: string | null
  group: PhotoGroupRecord
  onFocusPhoto: (photoId: string | null) => void
  onOpenReview: (photoId: string) => void
  onSetDecision: (photoId: string, decision: SelectionDecision) => void
  onToggleCompare: (photoId: string) => void
  photos: PhotoRecord[]
  t: ReturnType<typeof useTranslation>['t']
}) {
  const bestScore = photos[0]?.finalScore ?? null

  return (
    <section className="photo-group">
      <div className="photo-group__header">
        <div>
          <SectionLabel label={t(sceneTagKey(group.sceneTag))} />
          <h2>{group.title}</h2>
          <p>
            {photos.length} {t('selection.group.photos')}
            {bestScore ? ` · ${t('selection.group.bestScore')} ${bestScore.toFixed(2)}` : ''}
          </p>
        </div>
        {group.containsNewSpecies ? (
          <span className="chip chip--accent">{t('selection.quickFilters.new_species')}</span>
        ) : null}
      </div>
      <PhotoGrid
        comparePhotoIds={comparePhotoIds}
        focusedPhotoId={focusedPhotoId}
        onFocusPhoto={onFocusPhoto}
        onOpenReview={onOpenReview}
        onSetDecision={onSetDecision}
        onToggleCompare={onToggleCompare}
        photos={photos}
        t={t}
      />
    </section>
  )
}

function PhotoGrid({
  comparePhotoIds,
  focusedPhotoId,
  onFocusPhoto,
  onOpenReview,
  onSetDecision,
  onToggleCompare,
  photos,
  t,
}: {
  comparePhotoIds: string[]
  focusedPhotoId: string | null
  onFocusPhoto: (photoId: string | null) => void
  onOpenReview: (photoId: string) => void
  onSetDecision: (photoId: string, decision: SelectionDecision) => void
  onToggleCompare: (photoId: string) => void
  photos: PhotoRecord[]
  t: ReturnType<typeof useTranslation>['t']
}) {
  return (
    <div className="photo-grid">
      {photos.map((photo) => (
        <PhotoTile
          compareSelected={comparePhotoIds.includes(photo.id)}
          focused={focusedPhotoId === photo.id}
          key={photo.id}
          onFocusPhoto={onFocusPhoto}
          onOpenReview={onOpenReview}
          onSetDecision={onSetDecision}
          onToggleCompare={onToggleCompare}
          photo={photo}
          t={t}
        />
      ))}
    </div>
  )
}

function PhotoTile({
  compareSelected,
  focused,
  onFocusPhoto,
  onOpenReview,
  onSetDecision,
  onToggleCompare,
  photo,
  t,
}: {
  compareSelected: boolean
  focused: boolean
  onFocusPhoto: (photoId: string | null) => void
  onOpenReview: (photoId: string) => void
  onSetDecision: (photoId: string, decision: SelectionDecision) => void
  onToggleCompare: (photoId: string) => void
  photo: PhotoRecord
  t: ReturnType<typeof useTranslation>['t']
}) {
  return (
    <article className={cn('photo-tile', focused && 'photo-tile--focused')}>
      <button
        className="photo-preview"
        onClick={() => onFocusPhoto(photo.id)}
        onDoubleClick={() => onOpenReview(photo.id)}
        style={{ backgroundImage: photo.previewGradient }}
        type="button"
      >
        <span className="photo-preview__top">
          <StatusPill label={t(gradeLabelKey(photo.grade))} tone={gradeTone(photo.grade)} />
          {photo.isNewSpecies ? <StatusPill label={t('selection.quickFilters.new_species')} tone="accent" /> : null}
        </span>
        <span className="photo-preview__bottom">
          <span>
            <strong>{photo.speciesName ?? t('selection.photo.noBird')}</strong>
            <small>{photo.fileName}</small>
          </span>
          <b>{photo.finalScore !== null ? photo.finalScore.toFixed(2) : '--'}</b>
        </span>
      </button>

      <div className="photo-tile__meta">
        <span>
          <StatusDot tone={decisionTone(photo.decision)} />
          {t(decisionLabelKey(photo.decision))}
        </span>
        <span>
          <StatusDot tone={analysisTone(photo.analysisStatus)} />
          {t(`selection.analysisStatus.${photo.analysisStatus}`)}
        </span>
      </div>

      <div className="photo-actions">
        <IconButton label={t('selection.review.label')} onClick={() => onOpenReview(photo.id)}>
          <ImageIcon className="h-4 w-4" />
        </IconButton>
        <IconButton
          active={compareSelected}
          label={t('selection.actions.compare')}
          onClick={() => onToggleCompare(photo.id)}
        >
          <Waypoints className="h-4 w-4" />
        </IconButton>
        <IconButton label={t('selection.actions.reject')} onClick={() => onSetDecision(photo.id, 'rejected')}>
          <X className="h-4 w-4" />
        </IconButton>
        <IconButton label={t('selection.actions.maybe')} onClick={() => onSetDecision(photo.id, 'maybe')}>
          <Clock3 className="h-4 w-4" />
        </IconButton>
        <IconButton label={t('selection.actions.select')} onClick={() => onSetDecision(photo.id, 'selected')}>
          <Check className="h-4 w-4" />
        </IconButton>
      </div>
    </article>
  )
}

function InspectorPanel({
  onOpenReview,
  onSetDecision,
  onToggleCompare,
  photo,
  setFocusedPhotoId,
  t,
}: {
  onOpenReview: (photoId: string) => void
  onSetDecision: (photoId: string, decision: SelectionDecision) => void
  onToggleCompare: (photoId: string) => void
  photo: PhotoRecord | null
  setFocusedPhotoId: (photoId: string | null) => void
  t: ReturnType<typeof useTranslation>['t']
}) {
  return (
    <aside className="inspector selection-scroll">
      <SectionLabel label={t('selection.inspector.label')} />
      {photo ? (
        <div className="inspector__content">
          <div className="inspector-preview" style={{ backgroundImage: photo.previewGradient }} />
          <div className="score-block">
            <span>{t('selection.inspector.score')}</span>
            <strong>{photo.finalScore !== null ? photo.finalScore.toFixed(2) : '--'}</strong>
            <small>{photo.speciesName ?? t('selection.photo.noBird')}</small>
          </div>
          <div className="stat-stack">
            <StatRow label={t('selection.metrics.semanticScore')} value={photo.semanticScore ? photo.semanticScore.toFixed(2) : '--'} />
            <StatRow label={t('selection.metrics.technicalScore')} value={photo.technicalScore ? photo.technicalScore.toFixed(2) : '--'} />
            <StatRow label={t('selection.metrics.poseScore')} value={photo.poseScore ? photo.poseScore.toFixed(2) : '--'} />
            <StatRow label={t('selection.metrics.birdCount')} value={photo.birdCount} />
          </div>
          <TagCluster photo={photo} t={t} />
          <div className="inspector-actions">
            <button className="button-primary" onClick={() => onSetDecision(photo.id, 'selected')} type="button">
              <Check className="h-4 w-4" />
              {t('selection.actions.select')}
            </button>
            <button className="button-ghost" onClick={() => onSetDecision(photo.id, 'maybe')} type="button">
              <Clock3 className="h-4 w-4" />
              {t('selection.actions.maybe')}
            </button>
            <button className="button-danger" onClick={() => onSetDecision(photo.id, 'rejected')} type="button">
              <X className="h-4 w-4" />
              {t('selection.actions.reject')}
            </button>
            <button className="button-ghost" onClick={() => onToggleCompare(photo.id)} type="button">
              <Waypoints className="h-4 w-4" />
              {t('selection.actions.compare')}
            </button>
            <button className="text-button" onClick={() => onOpenReview(photo.id)} type="button">
              {t('selection.review.label')}
            </button>
            <button className="text-button" onClick={() => setFocusedPhotoId(null)} type="button">
              {t('selection.inspector.clear')}
            </button>
          </div>
        </div>
      ) : (
        <div className="inspector-empty">
          <h2>{t('selection.inspector.idleTitle')}</h2>
          <p>{t('selection.inspector.idleBody')}</p>
        </div>
      )}
    </aside>
  )
}

function ArchiveScreen({
  activeSpecies,
  archivePhotos,
  archiveSpecies,
  archiveTab,
  onOpenReview,
  onSelectSpecies,
  onSetArchiveTab,
  t,
}: {
  activeSpecies: SpeciesRecord | null
  archivePhotos: PhotoRecord[]
  archiveSpecies: SpeciesRecord[]
  archiveTab: ArchiveTab
  onOpenReview: (photoId: string) => void
  onSelectSpecies: (speciesId: string | null) => void
  onSetArchiveTab: (tab: ArchiveTab) => void
  t: ReturnType<typeof useTranslation>['t']
}) {
  const selectedArchiveCount = archivePhotos.filter((photo) => photo.decision === 'selected').length
  const newSpeciesCount = archivePhotos.filter((photo) => photo.isNewSpecies).length

  return (
    <main className="archive-screen selection-scroll">
      <section className="archive-main">
        <div className="archive-heading">
          <div>
            <SectionLabel label={t('archive.label')} />
            <h1>{t('archive.title')}</h1>
          </div>
          <div className="mini-segment">
            {archiveTabs.map((tab) => (
              <button
                className={cn(archiveTab === tab && 'is-active')}
                key={tab}
                onClick={() => onSetArchiveTab(tab)}
                type="button"
              >
                {t(archiveTabLabelKey(tab))}
              </button>
            ))}
          </div>
        </div>

        <section className="metric-strip">
          <MetricCell label={t('archive.summary.photos')} value={archivePhotos.length} />
          <MetricCell label={t('archive.summary.species')} value={archiveSpecies.length} />
          <MetricCell label={t('archive.summary.selected')} tone="success" value={selectedArchiveCount} />
          <MetricCell label={t('archive.summary.newSpecies')} tone="accent" value={newSpeciesCount} />
        </section>

        {archiveTab === 'photos' ? (
          <div className="archive-grid">
            {archivePhotos.map((photo) => (
              <button
                className="archive-card"
                key={photo.id}
                onClick={() => onOpenReview(photo.id)}
                type="button"
              >
                <span className="archive-card__image" style={{ backgroundImage: photo.previewGradient }} />
                <span className="archive-card__copy">
                  <strong>{photo.speciesName ?? t('selection.photo.noBird')}</strong>
                  <small>{photo.caption}</small>
                </span>
                <b>{photo.finalScore !== null ? photo.finalScore.toFixed(2) : '--'}</b>
              </button>
            ))}
          </div>
        ) : (
          <div className="archive-grid">
            {archiveSpecies.map((species) => (
              <button
                className={cn('archive-card', activeSpecies?.id === species.id && 'archive-card--active')}
                key={species.id}
                onClick={() => onSelectSpecies(species.id)}
                type="button"
              >
                <span className="archive-card__image" style={{ backgroundImage: species.coverGradient }} />
                <span className="archive-card__copy">
                  <strong>{species.name}</strong>
                  <small>{species.latinName}</small>
                </span>
                <b>{species.bestScore.toFixed(2)}</b>
              </button>
            ))}
          </div>
        )}
      </section>

      <aside className="archive-detail">
        <SectionLabel label={t('archive.detail.label')} />
        {activeSpecies ? (
          <div className="archive-detail__content">
            <div className="inspector-preview" style={{ backgroundImage: activeSpecies.coverGradient }} />
            <h2>{activeSpecies.name}</h2>
            <small>{activeSpecies.latinName}</small>
            <p>{activeSpecies.summary}</p>
            <div className="stat-stack">
              <StatRow label={t('archive.species.photoCount')} value={activeSpecies.photoCount} />
              <StatRow label={t('archive.species.firstSeen')} value={activeSpecies.firstSeenAt.slice(0, 10)} />
              <StatRow label={t('archive.species.lastSeen')} value={activeSpecies.lastSeenAt.slice(0, 10)} />
              <StatRow label={t('archive.species.bestScore')} value={activeSpecies.bestScore.toFixed(2)} />
            </div>
          </div>
        ) : (
          <p>{t('archive.detail.empty')}</p>
        )}
      </aside>
    </main>
  )
}

function ReviewModal({
  detail,
  onAddToCompare,
  onClose,
  onSetDecision,
  t,
}: {
  detail: ReviewDetail
  onAddToCompare: (photoId: string) => void
  onClose: () => void
  onSetDecision: (photoId: string, decision: SelectionDecision) => void
  t: ReturnType<typeof useTranslation>['t']
}) {
  const { photo, group } = detail

  return (
    <div className="overlay-backdrop">
      <div className="review-panel">
        <div className="review-stage selection-scroll">
          <div className="modal-heading">
            <div>
              <SectionLabel label={t('selection.review.label')} />
              <h2>{photo.fileName}</h2>
            </div>
            <IconButton label={t('common.close')} onClick={onClose}>
              <X className="h-4 w-4" />
            </IconButton>
          </div>
          <div className="review-image" style={{ backgroundImage: photo.previewGradient }}>
            {photo.boxes.map((box, index) => (
              <span
                className="detect-box"
                key={`${photo.id}-box-${index + 1}`}
                style={{
                  left: `${box.x}%`,
                  top: `${box.y}%`,
                  width: `${box.w}%`,
                  height: `${box.h}%`,
                }}
              />
            ))}
          </div>
        </div>

        <aside className="review-detail selection-scroll">
          <SectionLabel label={t('selection.review.scoreBreakdown')} />
          <div className="score-block score-block--large">
            <strong>{photo.finalScore !== null ? photo.finalScore.toFixed(2) : '--'}</strong>
            <small>{photo.speciesName ?? t('selection.photo.noBird')}</small>
          </div>
          <div className="stat-stack">
            <StatRow label={t('selection.metrics.semanticScore')} value={photo.semanticScore ? photo.semanticScore.toFixed(2) : '--'} />
            <StatRow label={t('selection.metrics.technicalScore')} value={photo.technicalScore ? photo.technicalScore.toFixed(2) : '--'} />
            <StatRow label={t('selection.metrics.poseScore')} value={photo.poseScore ? photo.poseScore.toFixed(2) : '--'} />
            <StatRow label={t('selection.metrics.group')} value={group?.title ?? '--'} />
          </div>
          <div>
            <SectionLabel label={t('selection.review.species')} />
            <div className="species-candidates">
              {photo.speciesCandidates.map((candidate) => (
                <StatRow
                  key={`${photo.id}-${candidate.name}`}
                  label={candidate.name}
                  value={`${Math.round(candidate.confidence * 100)}%`}
                />
              ))}
            </div>
          </div>
          <div>
            <SectionLabel label={t('selection.review.why')} />
            <p className="review-reason">{t(photoReviewReason(photo))}</p>
          </div>
          <TagCluster photo={photo} t={t} />
          <div className="inspector-actions">
            <button className="button-primary" onClick={() => onSetDecision(photo.id, 'selected')} type="button">
              <Check className="h-4 w-4" />
              {t('selection.actions.select')}
            </button>
            <button className="button-ghost" onClick={() => onSetDecision(photo.id, 'maybe')} type="button">
              <Clock3 className="h-4 w-4" />
              {t('selection.actions.maybe')}
            </button>
            <button className="button-danger" onClick={() => onSetDecision(photo.id, 'rejected')} type="button">
              <X className="h-4 w-4" />
              {t('selection.actions.reject')}
            </button>
            <button className="button-ghost" onClick={() => onAddToCompare(photo.id)} type="button">
              <Waypoints className="h-4 w-4" />
              {t('selection.actions.compare')}
            </button>
          </div>
        </aside>
      </div>
    </div>
  )
}

function CompareModal({
  onClose,
  onKeepBestOne,
  onSetDecision,
  photos,
  t,
}: {
  onClose: () => void
  onKeepBestOne: () => void
  onSetDecision: (photoId: string, decision: SelectionDecision) => void
  photos: PhotoRecord[]
  t: ReturnType<typeof useTranslation>['t']
}) {
  return (
    <div className="overlay-backdrop">
      <div className="compare-panel">
        <div className="modal-heading">
          <div>
            <SectionLabel label={t('selection.compare.label')} />
            <h2>{t('selection.compare.title')}</h2>
          </div>
          <div className="action-row">
            <button className="button-primary button-compact" onClick={onKeepBestOne} type="button">
              <Check className="h-4 w-4" />
              {t('selection.compare.keepBest')}
            </button>
            <IconButton label={t('common.close')} onClick={onClose}>
              <X className="h-4 w-4" />
            </IconButton>
          </div>
        </div>
        <div className="compare-grid">
          {photos.map((photo) => (
            <article className="compare-card" key={photo.id}>
              <div className="archive-card__image" style={{ backgroundImage: photo.previewGradient }} />
              <div className="compare-card__body">
                <div>
                  <strong>{photo.speciesName ?? t('selection.photo.noBird')}</strong>
                  <small>{photo.fileName}</small>
                </div>
                <b>{photo.finalScore !== null ? photo.finalScore.toFixed(2) : '--'}</b>
                <div className="action-row">
                  <IconButton label={t('selection.actions.reject')} onClick={() => onSetDecision(photo.id, 'rejected')}>
                    <X className="h-4 w-4" />
                  </IconButton>
                  <IconButton label={t('selection.actions.maybe')} onClick={() => onSetDecision(photo.id, 'maybe')}>
                    <Clock3 className="h-4 w-4" />
                  </IconButton>
                  <IconButton label={t('selection.actions.select')} onClick={() => onSetDecision(photo.id, 'selected')}>
                    <Check className="h-4 w-4" />
                  </IconButton>
                </div>
              </div>
            </article>
          ))}
        </div>
      </div>
    </div>
  )
}

function ExportDrawer({
  activeFolder,
  onClose,
  summary,
  t,
}: {
  activeFolder: FolderRecord | null
  onClose: () => void
  summary: FolderSummary
  t: ReturnType<typeof useTranslation>['t']
}) {
  return (
    <div className="overlay-backdrop overlay-backdrop--bottom">
      <div className="export-drawer">
        <div>
          <SectionLabel label={t('export.label')} />
          <h2>{t('export.title')}</h2>
          <p>{activeFolder ? `${activeFolder.displayName} · ${activeFolder.rootPath}` : '--'}</p>
        </div>
        <div className="export-grid">
          <ExportOption title={t('export.scope.label')} value={t('export.scope.selected')} />
          <ExportOption title={t('export.structure.label')} value={t('export.structure.keep')} />
          <ExportOption title={t('export.bundle.label')} value={t('export.bundle.report')} />
        </div>
        <div className="metric-strip">
          <MetricCell label={t('selection.metrics.selectedCount')} tone="success" value={summary.selectedCount} />
          <MetricCell label={t('selection.metrics.maybeCount')} tone="warning" value={summary.maybeCount} />
          <MetricCell label={t('selection.metrics.newSpeciesCount')} tone="accent" value={summary.newSpeciesCount} />
        </div>
        <div className="action-row">
          <button className="button-primary" type="button">
            <Download className="h-4 w-4" />
            {t('export.confirm')}
          </button>
          <button className="button-ghost" onClick={onClose} type="button">
            {t('common.close')}
          </button>
        </div>
      </div>
    </div>
  )
}

function BackgroundTaskBar({
  activeFolder,
  t,
}: {
  activeFolder: FolderRecord | null
  t: ReturnType<typeof useTranslation>['t']
}) {
  if (!activeFolder || !folderHasActiveTasks(activeFolder.status)) return null

  return (
    <footer className="background-taskbar">
      <span>{t(statusLabelKey(activeFolder.status))}</span>
      <GlyphMatrix tone={statusTone(activeFolder.status)} value={Math.max(3, Math.round((activeFolder.analyzedCount / Math.max(activeFolder.totalCount, 1)) * 12))} />
      <span>{formatRatio(activeFolder.analyzedCount, activeFolder.totalCount)}</span>
    </footer>
  )
}

function TagCluster({
  photo,
  t,
}: {
  photo: PhotoRecord
  t: ReturnType<typeof useTranslation>['t']
}) {
  return (
    <div className="tag-cluster">
      {photo.problemTags.length === 0 ? (
        <span className="chip chip--success">{t('selection.inspector.cleanFrame')}</span>
      ) : (
        photo.problemTags.map((tag) => (
          <span className="chip chip--warning" key={tag}>
            {t(problemTagKey(tag))}
          </span>
        ))
      )}
      {photo.poseTags.map((tag) => (
        <span className="chip" key={tag}>
          {t(poseTagKey(tag))}
        </span>
      ))}
    </div>
  )
}

function GlyphMatrix({ tone, value }: { tone: Tone; value: number }) {
  return (
    <span className="glyph-matrix" aria-hidden="true">
      {Array.from({ length: 12 }, (_item, index) => (
        <i className={cn(index < value && `tone-${tone}`)} key={`glyph-${index + 1}`} />
      ))}
    </span>
  )
}

function SectionLabel({ label }: { label: string }) {
  return <div className="section-label">{label}</div>
}

function MetricCell({
  label,
  tone = 'neutral',
  value,
}: {
  label: string
  tone?: Tone
  value: number | string
}) {
  return (
    <div className="metric-cell">
      <span>{label}</span>
      <strong>{value}</strong>
      <StatusDot tone={tone} />
    </div>
  )
}

function StatRow({
  label,
  tone = 'neutral',
  value,
}: {
  label: string
  tone?: Tone
  value: number | string
}) {
  return (
    <div className="stat-row">
      <span>{label}</span>
      <strong className={`tone-text-${tone}`}>{value}</strong>
    </div>
  )
}

function StatusPill({ label, tone = 'neutral' }: { label: string; tone?: Tone }) {
  return <span className={cn('status-pill', `status-pill--${tone}`)}>{label}</span>
}

function StatusDot({ tone = 'neutral' }: { tone?: Tone }) {
  return <span className={cn('status-dot', `status-dot--${tone}`)} />
}

function IconButton({
  active,
  children,
  label,
  onClick,
}: {
  active?: boolean
  children: ReactNode
  label: string
  onClick?: () => void
}) {
  return (
    <button
      aria-label={label}
      className={cn('icon-button', active && 'icon-button--active')}
      onClick={onClick}
      type="button"
    >
      {children}
    </button>
  )
}

function ExportOption({ title, value }: { title: string; value: string }) {
  return (
    <div className="export-option">
      <SectionLabel label={title} />
      <strong>{value}</strong>
    </div>
  )
}

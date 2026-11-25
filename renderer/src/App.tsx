import { Aperture, Download, LibraryBig, Search, Settings2, Sparkles } from 'lucide-react'
import {
  Suspense,
  lazy,
  startTransition,
  useCallback,
  useDeferredValue,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
} from 'react'
import { useTranslation } from 'react-i18next'

import appIconUrl from '../../build/icon.png?url'
import { EngineStatusBanner } from '@/components/engine-status-banner'
import type { ReviewSaveFeedback } from '@/components/review/review-modal'
const ReviewModal = lazy(() =>
  import('@/components/review/review-modal').then((m) => ({ default: m.ReviewModal })),
)
// 选片随主界面装载，避免首次打开图库等待 Suspense 首屏提交。
// 羽迹、设置、导出和深度复核保持按需加载。
const SettingsModal = lazy(() =>
  import('@/components/settings-modal').then((m) => ({ default: m.SettingsModal })),
)
import { useAnalysisProgress, useStartBatch } from '@/hooks/use-analysis'
import { useBackendHealth } from '@/hooks/use-backend'
import { useSetDecision, useSetSpeciesOverride } from '@/hooks/use-decisions'
import {
  useLibraryWorkspaceSync,
  type LibraryWorkspaceSnapshot,
} from '@/hooks/use-library-workspace-sync'
import {
  LIBRARIES_KEY,
  LIBRARY_DETAIL_KEY,
  useAllLibraryDetails,
  useDeleteLibrary,
  useImportLibrary,
  useLibraries,
  useLibraryDetail,
  useLibraryEvents,
  useRelinkLibrary,
  useUpdateLibrary,
} from '@/hooks/use-library'
import { useThumbnailRepair } from '@/hooks/use-thumbnail-repair'
import { PHOTO_REVIEW_KEY } from '@/hooks/use-photo-review'
import { useCoherentSelection, type SelectionSnapshot } from '@/hooks/use-selection'
import type { SpeciesFilterProps } from '@/components/selection-chrome/species-filter'
import { SelectionScreen } from '@/components/selection-chrome/selection-screen'
import { useQueryClient } from '@tanstack/react-query'
import {
  api,
  ApiError,
  type SelectionQuery,
  type SpeciesOverrideBBox,
  type SpeciesOverrideValue,
} from '@/lib/api-client'

import type {
  AppRoute,
  FolderRecord,
  PhotoRecord,
  SelectionDecision,
  SpeciesRecord,
} from '@/lib/workspace-types'
import { cn } from '@/lib/utils'
import { useShallow, useUIStore, type SelectionSpeciesFilter } from '@/stores/ui-store'
import { subscribeEngineStatus, useEngineStore } from '@/stores/engine-store'
import { ErrorBoundary } from '@/components/common/error-boundary'
import { IconButton } from '@/components/common/icon-button'
import type { ExportSourceSnapshot } from '@/components/export-drawer'
const ExportDrawer = lazy(() =>
  import('@/components/export-drawer').then((m) => ({ default: m.ExportDrawer })),
)
const ArchiveScreen = lazy(() =>
  import('@/components/archive/archive-screen').then((m) => ({ default: m.ArchiveScreen })),
)
import {
  FolderContextMenu,
  RemoveFolderDialog,
  StartScreen,
  type FolderContextMenuState,
} from '@/components/start/start-screen'
import {
  buildGroupStartMsMap,
  buildPhotoSegments,
  buildReviewPhotoOrderForGroupedEntries,
  buildReviewSegmentPhotosByPhotoId,
  compareGroupStartDesc,
  EMPTY_STRING_ARRAY,
  sortPhotos,
} from '@/lib/photo-grid-helpers'
import { routeLabelKey } from '@/lib/i18n-keys'
import { isArchiveEligiblePhoto } from '@/lib/photo-display'
import { type FolderSummary } from '@/lib/photo-helpers'
import {
  archivePhotoSearchParts,
  buildFolderSummary,
  deriveSpeciesRecords,
} from '@/lib/workspace-projection'
import { logger } from '@/lib/logger'
import { benchmarkTrace } from '@/lib/benchmark-trace'
import { LoggingConsentModal } from '@/components/logging-consent-modal'

export {
  applyNewSpeciesMarkers,
  buildArchiveMapPins,
  deriveSpeciesRecords,
  extractPhotoGps,
  photoReviewReason,
} from '@/lib/workspace-projection'

type ExportSession = {
  id: string
  folderId: string
  initialSource: ExportSourceSnapshot
}

const FOLDER_CONTEXT_MENU_WIDTH = 188
// 菜单最多 3 项(在 Finder 打开 / 重新链接 / 移除),按此估高做贴边位置修正。
const FOLDER_CONTEXT_MENU_HEIGHT = 128

const EMPTY_PHOTOS: PhotoRecord[] = []
const DEFAULT_SPECIES_FILTER: SelectionSpeciesFilter = { keys: [], includeReview: true }
const EMPTY_SPECIES: SpeciesRecord[] = []
const EMPTY_FOLDER_SUMMARY: FolderSummary = {
  newSpeciesCount: 0,
  birdPhotoCount: 0,
  noBirdCount: 0,
  failedCount: 0,
  speciesCount: 0,
  gradeCounts: { reject: 0, record: 0, usable: 0, select: 0 },
}

const routeIcons: Record<AppRoute, typeof Aperture> = {
  start: Aperture,
  selection: Sparkles,
  archive: LibraryBig,
}

function SelectionCommitTrace({
  route,
  projectedDetail,
  selection,
}: {
  route: AppRoute
  projectedDetail: NonNullable<LibraryWorkspaceSnapshot['activeProjection']>['detail'] | undefined
  selection: SelectionSnapshot | undefined
}) {
  useLayoutEffect(() => {
    if (route === 'selection') benchmarkTrace?.mark('selection.route_commit')
  }, [route])
  useLayoutEffect(() => {
    if (projectedDetail) benchmarkTrace?.markFor('workspace.commit', projectedDetail)
  }, [projectedDetail])
  useLayoutEffect(() => {
    if (route === 'selection' && selection)
      benchmarkTrace?.markFor('selection.pair_commit', selection)
  }, [route, selection])
  return null
}

function matchesQuery(parts: Array<string | null | undefined>, query: string): boolean {
  const normalized = query.trim().toLowerCase()
  if (!normalized) return true
  return parts.some((part) => part?.toLowerCase().includes(normalized))
}

export function isPlainSpaceKey(event: KeyboardEvent): boolean {
  return (
    (event.key === ' ' || event.key === 'Spacebar' || event.code === 'Space') &&
    !event.metaKey &&
    !event.ctrlKey &&
    !event.altKey &&
    !event.shiftKey
  )
}

export function shouldIgnoreSelectionReviewShortcutTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false
  if (target.closest('[data-selection-review-shortcut="true"]')) return false
  if (target.isContentEditable) return true
  return (
    target.closest(
      'input, textarea, select, button, a, [role="button"], [contenteditable="true"]',
    ) !== null
  )
}

export default function App() {
  const { t } = useTranslation()
  const { data: backendData, isReady, isError } = useBackendHealth()
  const engineState = useEngineStore((s) => s.state)
  const appInteractive =
    (engineState === 'ready' || engineState === 'degraded') &&
    isReady &&
    Boolean(backendData?.pipeline.ready)
  // 起手用空 workspace，避免 useLibraries 还没 fetch 完时闪现历史 fixture 数据。
  // useLibraries effect 拿到真数据后会注入；fetch 失败的 fallback 在 handleChooseFolder 里。
  const [workspace, setWorkspace] = useState<LibraryWorkspaceSnapshot>(() => ({
    folders: [],
    groups: [],
    photos: [],
    species: [],
  }))
  const [exportSessions, setExportSessions] = useState<ExportSession[]>([])
  const [folderContextMenu, setFolderContextMenu] = useState<FolderContextMenuState>(null)
  const [relinkingFolderId, setRelinkingFolderId] = useState<string | null>(null)
  const [importError, setImportError] = useState<string | null>(null)
  const [pendingRemoval, setPendingRemoval] = useState<FolderRecord | null>(null)
  const [removeError, setRemoveError] = useState<string | null>(null)
  const [operationError, setOperationError] = useState<string | null>(null)
  const [refreshing, setRefreshing] = useState(false)
  const [reviewOrder, setReviewOrder] = useState<string[]>([])
  const [saveFeedback, setSaveFeedback] = useState<ReviewSaveFeedback | null>(null)
  const saveRequestSeqRef = useRef(0)
  const saveFeedbackTimerRef = useRef<number | null>(null)

  useEffect(() => {
    return () => {
      if (saveFeedbackTimerRef.current !== null) {
        window.clearTimeout(saveFeedbackTimerRef.current)
      }
    }
  }, [])
  const deleteLibrary = useDeleteLibrary()

  const {
    route,
    archiveTab,
    activeFolderId,
    activeSpeciesId,
    activeQuickFilters,
    selectionSpeciesByFolder,
    setSelectionSpeciesFilter,
    removeSelectionSpeciesFilter,
    setActiveQuickFilters,
    onlyFlying,
    activeSort,
    viewMode,
    searchQuery,
    focusedPhotoId,
    reviewPhotoId,
    setRoute,
    setArchiveTab,
    setActiveFolderId,
    setActiveSpeciesId,
    setActiveQuickFilter,
    setOnlyFlying,
    setActiveSort,
    setViewMode,
    setSearchQuery,
    setFocusedPhotoId,
    setReviewPhotoId,
    setSettingsOpen,
    settingsOpen,
  } = useUIStore(
    useShallow((state) => ({
      route: state.route,
      archiveTab: state.archiveTab,
      activeFolderId: state.activeFolderId,
      activeSpeciesId: state.activeSpeciesId,
      activeQuickFilters: state.activeQuickFilters,
      selectionSpeciesByFolder: state.selectionSpeciesByFolder,
      setSelectionSpeciesFilter: state.setSelectionSpeciesFilter,
      removeSelectionSpeciesFilter: state.removeSelectionSpeciesFilter,
      setActiveQuickFilters: state.setActiveQuickFilters,
      onlyFlying: state.onlyFlying,
      activeSort: state.activeSort,
      viewMode: state.viewMode,
      searchQuery: state.searchQuery,
      focusedPhotoId: state.focusedPhotoId,
      reviewPhotoId: state.reviewPhotoId,
      setRoute: state.setRoute,
      setArchiveTab: state.setArchiveTab,
      setActiveFolderId: state.setActiveFolderId,
      setActiveSpeciesId: state.setActiveSpeciesId,
      setActiveQuickFilter: state.setActiveQuickFilter,
      setOnlyFlying: state.setOnlyFlying,
      setActiveSort: state.setActiveSort,
      setViewMode: state.setViewMode,
      setSearchQuery: state.setSearchQuery,
      setFocusedPhotoId: state.setFocusedPhotoId,
      setReviewPhotoId: state.setReviewPhotoId,
      setSettingsOpen: state.setSettingsOpen,
      settingsOpen: state.settingsOpen,
    })),
  )

  const deferredSearch = useDeferredValue(searchQuery)
  const shouldLoadArchiveWorkspace = route === 'archive'
  const speciesRecords = useMemo(
    () => (shouldLoadArchiveWorkspace ? deriveSpeciesRecords(workspace) : EMPTY_SPECIES),
    [shouldLoadArchiveWorkspace, workspace],
  )

  // Workspace mutations stay at this orchestration boundary while scan, decision,
  // and export write paths finish consolidating behind backend API + TanStack Query.
  useEffect(() => {
    if (workspace.folders.length === 0) {
      if (activeFolderId !== null) setActiveFolderId(null)
      return
    }
    if (!activeFolderId || !workspace.folders.some((folder) => folder.id === activeFolderId)) {
      setActiveFolderId(workspace.folders[0]?.id ?? null)
    }
  }, [activeFolderId, setActiveFolderId, workspace.folders])

  const visibleFolders = workspace.folders.filter(
    (folder) =>
      route === 'selection' ||
      matchesQuery([folder.displayName, folder.parentPath, folder.rootPath], deferredSearch),
  )
  const openFolderContextMenu = useCallback(
    (folder: FolderRecord, event: ReactMouseEvent<HTMLElement>) => {
      event.preventDefault()
      event.stopPropagation()
      const maxX = window.innerWidth - FOLDER_CONTEXT_MENU_WIDTH - 8
      const maxY = window.innerHeight - FOLDER_CONTEXT_MENU_HEIGHT - 8
      setFolderContextMenu({
        folder,
        x: Math.max(8, Math.min(event.clientX, maxX)),
        y: Math.max(8, Math.min(event.clientY, maxY)),
      })
    },
    [],
  )
  const closeFolderContextMenu = useCallback(() => setFolderContextMenu(null), [])
  const requestRemoveFolder = useCallback((folder: FolderRecord) => {
    setRemoveError(null)
    setPendingRemoval(folder)
  }, [])
  const cancelRemoveFolder = useCallback(() => {
    if (deleteLibrary.isPending) return
    setPendingRemoval(null)
    setRemoveError(null)
  }, [deleteLibrary.isPending])
  const confirmRemoveFolder = useCallback(async () => {
    if (!pendingRemoval) return
    const removedId = pendingRemoval.id
    const nextFolderId = workspace.folders.find((f) => f.id !== removedId)?.id ?? null
    try {
      if (activeFolderId === removedId) {
        setActiveFolderId(nextFolderId)
      }
      await deleteLibrary.mutateAsync(removedId)
      removeSelectionSpeciesFilter(removedId)
      // 该文件夹的导出面板要一并收掉 —— 留着会指向一个已经不存在的图库。
      setExportSessions((current) => current.filter((session) => session.folderId !== removedId))
      setPendingRemoval(null)
      setRemoveError(null)
    } catch (err) {
      if (activeFolderId === removedId) {
        setActiveFolderId(removedId)
      }
      logger.warn('Failed to remove library:', err)
      setRemoveError(err instanceof Error ? err.message : String(err))
    }
  }, [
    activeFolderId,
    deleteLibrary,
    pendingRemoval,
    removeSelectionSpeciesFilter,
    setActiveFolderId,
    workspace.folders,
  ])
  const openFolderInFinder = useCallback(async (folder: FolderRecord) => {
    setFolderContextMenu(null)
    try {
      const result = await window.plumelens?.openPathInFinder?.(folder.rootPath)
      if (result && !result.ok) {
        logger.warn('Failed to open folder in Finder:', result.reason)
      }
    } catch (err) {
      logger.warn('Failed to open folder in Finder:', err)
    }
  }, [])
  const photosByFolder = useMemo(() => {
    const byFolder = new Map<string, PhotoRecord[]>()
    for (const photo of workspace.photos) {
      const bucket = byFolder.get(photo.folderId)
      if (bucket) bucket.push(photo)
      else byFolder.set(photo.folderId, [photo])
    }
    return byFolder
  }, [workspace.photos])
  const summariesByFolder = useMemo(() => {
    const byFolder = new Map<string, FolderSummary>()
    for (const [folderId, photos] of photosByFolder) {
      byFolder.set(folderId, buildFolderSummary(photos))
    }
    return byFolder
  }, [photosByFolder])
  const activeFolder =
    workspace.folders.find((folder) => folder.id === activeFolderId) ?? visibleFolders[0] ?? null
  const activeSourceMissing = activeFolder?.status === 'path_missing'
  const activeFolderPhotos = activeFolder
    ? (photosByFolder.get(activeFolder.id) ?? EMPTY_PHOTOS)
    : EMPTY_PHOTOS
  const activeFolderSummary = activeFolder
    ? (summariesByFolder.get(activeFolder.id) ?? EMPTY_FOLDER_SUMMARY)
    : EMPTY_FOLDER_SUMMARY
  const activeDetailQuery = useLibraryDetail(activeFolderId ?? activeFolder?.id)
  const activeDetail = activeDetailQuery.data
  const queryClient = useQueryClient()
  const speciesFilter =
    (activeFolder && selectionSpeciesByFolder[activeFolder.id]) ?? DEFAULT_SPECIES_FILTER
  const selectionQuery = useMemo<SelectionQuery>(
    () => ({
      species_keys: speciesFilter.keys,
      include_review: speciesFilter.includeReview,
      grades: activeQuickFilters.length
        ? activeQuickFilters.filter((filter): filter is 'select' | 'usable' | 'record' | 'reject' =>
            ['select', 'usable', 'record', 'reject'].includes(filter),
          )
        : ['select', 'usable', 'record', 'reject'],
      include_no_bird: !activeQuickFilters.length || activeQuickFilters.includes('no_bird'),
      include_failed: activeQuickFilters.includes('failed'),
      only_flying: onlyFlying,
      photo_query: deferredSearch,
      sort: activeSort === 'shot_at' ? 'time' : activeSort,
    }),
    [activeQuickFilters, activeSort, deferredSearch, onlyFlying, speciesFilter],
  )
  const coherentSelection = useCoherentSelection(
    activeFolder?.id ?? null,
    selectionQuery,
    activeDetailQuery,
    route === 'selection',
  )
  const appliedSelection = workspace.activeProjection?.selection
  const selectionSnapshot =
    appliedSelection?.detail.library.id === activeFolder?.id ? appliedSelection : undefined
  const selectionResult = selectionSnapshot?.selection
  const selectionExportable = selectionSnapshot?.query === selectionQuery
  const speciesFilterProps: SpeciesFilterProps = {
    facets: selectionResult?.facets ?? [],
    filter: speciesFilter,
    onChange: (filter) => {
      if (activeFolder) {
        benchmarkTrace?.mark('selection.filter_change')
        setSelectionSpeciesFilter(activeFolder.id, filter)
      }
    },
    loading:
      coherentSelection.loading ||
      (!coherentSelection.error && selectionSnapshot?.query !== selectionQuery),
    error: coherentSelection.error,
    onRetry: coherentSelection.onRetry,
  }
  const openExportForActiveFolder = useCallback(() => {
    if (!activeFolder || activeFolder.status === 'path_missing') return
    if (route === 'selection' && !selectionExportable) return
    setExportSessions((current) => [
      ...current,
      {
        id: `${activeFolder.id}-${Date.now()}-${Math.random().toString(36).slice(2)}`,
        folderId: activeFolder.id,
        initialSource: {
          folder: activeFolder,
          photos: activeFolderPhotos,
          summary: activeFolderSummary,
          selection:
            route === 'selection' && selectionResult
              ? {
                  query: selectionQuery,
                  revision: selectionResult.projection_revision,
                  photoIds: selectionResult.matched_photo_ids,
                  photos: activeFolderPhotos,
                  defaultSelected: speciesFilter.keys.length > 0,
                  labels: speciesFilter.keys.map(
                    (key) =>
                      selectionResult.facets.find((facet) => facet.key === key)?.name ??
                      key.replace(/^sci:/, ''),
                  ),
                }
              : undefined,
        },
      },
    ])
  }, [
    activeFolder,
    activeFolderPhotos,
    activeFolderSummary,
    route,
    selectionResult,
    selectionExportable,
    selectionQuery,
    speciesFilter.keys,
  ])
  const closeExportSession = useCallback((sessionId: string) => {
    setExportSessions((current) => current.filter((session) => session.id !== sessionId))
  }, [])
  const getExportSource = useCallback(
    (session: ExportSession): ExportSourceSnapshot => {
      const folder =
        workspace.folders.find((item) => item.id === session.folderId) ??
        session.initialSource.folder
      const folderStillExists = workspace.folders.some((item) => item.id === session.folderId)
      if (!folderStillExists) {
        return session.initialSource
      }
      const folderPhotos = photosByFolder.get(session.folderId) ?? EMPTY_PHOTOS
      return {
        folder,
        photos: folderPhotos,
        summary: summariesByFolder.get(session.folderId) ?? EMPTY_FOLDER_SUMMARY,
        selection: session.initialSource.selection,
      }
    },
    [photosByFolder, summariesByFolder, workspace.folders],
  )
  const filteredSelectionPhotos = useMemo(() => {
    const ids = new Set(selectionResult?.matched_photo_ids ?? [])
    return sortPhotos(
      activeFolderPhotos.filter((photo) => ids.has(photo.id)),
      activeSort,
    )
  }, [activeFolderPhotos, activeSort, selectionResult])
  const groupStartMs = useMemo(() => buildGroupStartMsMap(activeFolderPhotos), [activeFolderPhotos])

  const folderGroups = useMemo(() => {
    const photosByGroup = new Map<string, PhotoRecord[]>()
    for (const photo of filteredSelectionPhotos) {
      const bucket = photosByGroup.get(photo.groupId)
      if (bucket) bucket.push(photo)
      else photosByGroup.set(photo.groupId, [photo])
    }
    return workspace.groups
      .filter((group) => group.folderId === activeFolder?.id)
      .map((group) => ({
        group,
        photos: photosByGroup.get(group.id) ?? EMPTY_PHOTOS,
      }))
      .filter((entry) => entry.photos.length > 0)
      .toSorted((left, right) => compareGroupStartDesc(left, right, groupStartMs))
  }, [activeFolder?.id, filteredSelectionPhotos, groupStartMs, workspace.groups])
  const groupedSelectionPhotos = useMemo(
    () => buildReviewPhotoOrderForGroupedEntries(folderGroups),
    [folderGroups],
  )

  const flatSelectionPhotos = useMemo(
    () => (viewMode === 'flat' ? filteredSelectionPhotos : groupedSelectionPhotos),
    [filteredSelectionPhotos, groupedSelectionPhotos, viewMode],
  )

  const photoById = useMemo(
    () => new Map(workspace.photos.map((photo) => [photo.id, photo])),
    [workspace.photos],
  )
  const groupById = useMemo(
    () => new Map(workspace.groups.map((group) => [group.id, group])),
    [workspace.groups],
  )
  const focusedPhoto = focusedPhotoId ? (photoById.get(focusedPhotoId) ?? null) : null
  const reviewPhoto = reviewPhotoId ? (photoById.get(reviewPhotoId) ?? null) : null
  const reviewGroup = reviewPhoto?.groupId ? (groupById.get(reviewPhoto.groupId) ?? null) : null
  const activeSpecies = useMemo(
    () =>
      speciesRecords.find((species) => species.id === activeSpeciesId) ??
      speciesRecords.find((species) => species.collected) ??
      speciesRecords[0] ??
      null,
    [activeSpeciesId, speciesRecords],
  )

  useEffect(() => {
    if (!shouldLoadArchiveWorkspace) return
    if (speciesRecords.length === 0) {
      if (activeSpeciesId !== null) setActiveSpeciesId(null)
      return
    }
    if (!activeSpeciesId || !speciesRecords.some((species) => species.id === activeSpeciesId)) {
      setActiveSpeciesId(
        speciesRecords.find((species) => species.collected)?.id ?? speciesRecords[0]?.id ?? null,
      )
    }
  }, [activeSpeciesId, setActiveSpeciesId, shouldLoadArchiveWorkspace, speciesRecords])

  const archivePhotos = useMemo(() => {
    if (!shouldLoadArchiveWorkspace) return EMPTY_PHOTOS
    return sortPhotos(
      workspace.photos.filter(
        (photo) =>
          isArchiveEligiblePhoto(photo) &&
          matchesQuery(archivePhotoSearchParts(photo), deferredSearch),
      ),
      'score',
    )
  }, [deferredSearch, shouldLoadArchiveWorkspace, workspace.photos])
  const archiveSpecies = useMemo(() => {
    if (!shouldLoadArchiveWorkspace) return EMPTY_SPECIES
    return speciesRecords.filter((species) =>
      matchesQuery(
        [species.name, species.latinName, species.englishName, species.familyName, species.summary],
        deferredSearch,
      ),
    )
  }, [deferredSearch, shouldLoadArchiveWorkspace, speciesRecords])
  const reviewSourcePhotos = route === 'archive' ? archivePhotos : flatSelectionPhotos
  const reviewAllowedIds = useMemo(
    () => new Set(reviewSourcePhotos.map((photo) => photo.id)),
    [reviewSourcePhotos],
  )
  const reviewPhotoOutsideSelection =
    route === 'selection' && reviewPhoto !== null && !reviewAllowedIds.has(reviewPhoto.id)
  const reviewPhotos = useMemo(() => {
    if (!reviewPhoto) return []
    const baseOrder = reviewOrder.length ? reviewOrder : reviewSourcePhotos.map((photo) => photo.id)
    const seen = new Set(baseOrder)
    const extraIds = reviewOrder.length
      ? reviewSourcePhotos.map((photo) => photo.id).filter((id) => !seen.has(id))
      : EMPTY_STRING_ARRAY
    const order = extraIds.length ? [...baseOrder, ...extraIds] : baseOrder
    return order.flatMap((id) => {
      const photo = photoById.get(id)
      return photo && (id === reviewPhoto.id || reviewAllowedIds.has(id)) ? [photo] : []
    })
  }, [photoById, reviewAllowedIds, reviewOrder, reviewPhoto, reviewSourcePhotos])
  const reviewSegmentPhotosByPhotoId = useMemo(
    () => (reviewPhoto ? buildReviewSegmentPhotosByPhotoId(reviewSourcePhotos) : new Map<string, PhotoRecord[]>()),
    [reviewPhoto, reviewSourcePhotos],
  )
  const reviewGroupPhotos = useMemo(() => {
    if (!reviewPhoto || reviewPhotoOutsideSelection) return EMPTY_PHOTOS
    return reviewSegmentPhotosByPhotoId.get(reviewPhoto.id) ?? EMPTY_PHOTOS
  }, [reviewPhoto, reviewPhotoOutsideSelection, reviewSegmentPhotosByPhotoId])
  const reviewSequenceTotalCount = useMemo(() => {
    if (!reviewPhoto || route !== 'selection' || reviewPhotoOutsideSelection) return null
    const unfilteredGroupPhotos = activeFolderPhotos.filter(
      (photo) => photo.groupId === reviewPhoto.groupId,
    )
    const fullSegment = buildPhotoSegments(unfilteredGroupPhotos).find((segment) =>
      segment.photos.some((photo) => photo.id === reviewPhoto.id),
    )
    return fullSegment ? fullSegment.photos.length : null
  }, [activeFolderPhotos, reviewPhoto, reviewPhotoOutsideSelection, route])

  const { data: realLibraries } = useLibraries()
  const allLibraryIds = useMemo(() => (realLibraries ?? []).map((l) => l.id), [realLibraries])
  const allDetails = useAllLibraryDetails(allLibraryIds, shouldLoadArchiveWorkspace)
  const engineSseKey = useEngineStore((s) => s.sseRestartKey)
  useLibraryEvents(activeFolderId, Boolean(activeFolderId), engineSseKey)
  const importLibrary = useImportLibrary()
  const { mutateAsync: updateLibraryDisplayName } = useUpdateLibrary()
  const { mutateAsync: relinkLibrary } = useRelinkLibrary()
  const startBatch = useStartBatch()
  const handleThumbnailLoadStatus = useThumbnailRepair({
    libraryId: activeFolderId,
    photos: workspace.photos,
  })
  useLibraryWorkspaceSync({
    activeDetail: route === 'selection' ? coherentSelection.displayed?.detail : activeDetail,
    activeSelection: coherentSelection.displayed,
    allDetails,
    libraries: realLibraries,
    setWorkspace,
    t,
  })

  // 引擎状态订阅 — 只在 App mount 时挂一次,IPC 推送通过 zustand store 全局可见。
  useEffect(() => {
    const unsubscribe = subscribeEngineStatus()
    return unsubscribe
  }, [])

  // SSE 重连 key：startBatch 成功后 bump，强制 useAnalysisProgress 重建连接。
  // 应对 SSE idle close（v0.1.0 后端 bug）/ 网络抖动 / 老连接卡住等场景，
  // 确保用户点「开始分析」后立刻能看到 pending 数变化。
  const [sseRestartKey, setSseRestartKey] = useState(0)

  // 引擎 cold-start 时 useLibraries 等 query 在 ~5s 模型加载窗口内多次失败 → 永远
  // 卡在 error state,recent folders 不显示。engineSseKey 在 engine 每次 'ready'
  // 事件都自增,作触发器把所有可能受冷启影响的 query 强制 invalidate 让 react-query
  // 重 fetch。libraries / decisions / archive / geocoding 都没自带 refetchInterval
  // (SSE 不轮询原则),这里是它们"engine 就绪后回血"的唯一机会。
  // 'library' 也包了一份是为了 useLibraryDetail(activeFolderId 持久化时,选片屏挂载
  // 立即触发 detail fetch 也会冷启失败)。
  useEffect(() => {
    if (engineSseKey === 0) return // initial render,engine 还没发过 'ready' 事件
    queryClient.invalidateQueries({ queryKey: ['backend-health'] })
    queryClient.invalidateQueries({ queryKey: LIBRARIES_KEY })
    queryClient.invalidateQueries({ queryKey: ['library'] })
    queryClient.invalidateQueries({ queryKey: ['decisions'] })
    queryClient.invalidateQueries({ queryKey: ['archive'] })
    queryClient.invalidateQueries({ queryKey: ['geocoding'] })
    queryClient.invalidateQueries({ queryKey: ['selection'] })
  }, [engineSseKey, queryClient])
  const progressEvent = useAnalysisProgress(
    activeFolderId,
    Boolean(activeFolderId),
    sseRestartKey + engineSseKey,
  )
  const setDecisionMutation = useSetDecision(activeFolderId)
  const setSpeciesOverrideMutation = useSetSpeciesOverride(activeFolderId)

  async function handleChooseFolder() {
    const path = await window.plumelens?.openFolder?.()
    if (!path) return

    setImportError(null)
    // 先切到 selection 路由，给用户即时视觉反馈
    startTransition(() => {
      setRoute('selection')
      setViewMode('grouped')
    })

    // 调用真后端 import；成功后用返回的 library_id 作为 activeFolderId
    // → useLibraryDetail 自动拉详情 → useEffect 把真 photos 注入 workspace
    try {
      const lib = await importLibrary.mutateAsync({ root_path: path })
      setImportError(null)
      setActiveFolderId(lib.id)
    } catch (err) {
      // 后端不可用 / 路径无效 / 库已存在等失败,**绝不**降级到 fixture 数据
      // (历史 fixture 的 createImportedFolder 会注入"池鹭/翠鸟/崇明东滩"等假种子,
      // 用户当真照片处理 → 快捷键 1234 命中不存在的 photo_id → 错乱)。
      // 切回 start 页,用应用内错误条把 backend 错误透传给用户。
      logger.error('Library import to backend failed:', err)
      const detail = err instanceof Error ? err.message : String(err)
      setImportError(detail)
      startTransition(() => {
        setRoute('start')
      })
    }
  }

  const handleRenameFolder = useCallback(
    async (folderId: string, displayName: string) => {
      const updated = await updateLibraryDisplayName({ libraryId: folderId, displayName })
      setWorkspace((current) => ({
        ...current,
        folders: current.folders.map((folder) =>
          folder.id === updated.id ? { ...folder, displayName: updated.display_name } : folder,
        ),
      }))
    },
    [updateLibraryDisplayName],
  )

  const handleRelinkFolder = useCallback(
    async (folderId: string) => {
      const path = await window.plumelens?.openFolder?.()
      if (!path) return
      setRelinkingFolderId(folderId)
      try {
        const response = await relinkLibrary({ libraryId: folderId, rootPath: path })
        const updated = response.library
        setWorkspace((current) => ({
          ...current,
          folders: current.folders.map((folder) =>
            folder.id === updated.id
              ? {
                  ...folder,
                  parentPath: updated.parent_path,
                  rootPath: updated.root_path,
                  status: updated.status,
                  totalCount: updated.total_count,
                  analyzedCount: updated.analyzed_count,
                  recursive: updated.recursive,
                  lastOpenedAt: updated.last_opened_at,
                  lastScannedAt: updated.last_scanned_at ?? updated.last_opened_at,
                  lastAnalyzedAt: updated.last_analyzed_at,
                }
              : folder,
          ),
        }))
        void queryClient.refetchQueries({ queryKey: LIBRARY_DETAIL_KEY(folderId), type: 'active' })
      } catch (err) {
        logger.warn('Failed to relink library source folder:', err)
        throw err
      } finally {
        setRelinkingFolderId(null)
      }
    },
    [queryClient, relinkLibrary],
  )

  async function handleStartAnalysis() {
    if (!activeFolderId || activeSourceMissing) return
    setOperationError(null)
    try {
      await startBatch.mutateAsync({ libraryId: activeFolderId })
      // bump key 让 useAnalysisProgress 重建 SSE 连接（如果上一个 idle 死了）
      setSseRestartKey((k) => k + 1)
    } catch (err) {
      logger.error('Failed to start batch analysis:', err)
      const detail =
        err instanceof ApiError && err.detail && typeof err.detail === 'object'
          ? (err.detail as { code?: string; detail?: { code?: string } })
          : null
      setOperationError(
        t(
          (detail?.detail?.code ?? detail?.code) === 'source_changed'
            ? 'selection.analysisError.source_changed'
            : 'selection.operationFailed',
        ),
      )
    }
  }

  async function handleRefreshFolder() {
    if (!activeFolder || activeSourceMissing || refreshing) return
    const folderId = activeFolder.id
    setOperationError(null)
    setRefreshing(true)
    try {
      await api.importLibrary({
        root_path: activeFolder.rootPath,
        recursive: activeFolder.recursive,
      })
      await queryClient.invalidateQueries({ queryKey: ['library', folderId] })
      await queryClient.invalidateQueries({ queryKey: ['selection', folderId] })
      await queryClient.invalidateQueries({ queryKey: LIBRARIES_KEY })
    } catch (err) {
      logger.warn('Failed to refresh folder:', err)
      setOperationError(t('selection.operationFailed'))
    } finally {
      setRefreshing(false)
    }
  }

  function handleNavigate(nextRoute: AppRoute) {
    if (nextRoute === 'selection') benchmarkTrace?.mark('selection.navigate')
    startTransition(() => {
      setRoute(nextRoute)
      if (nextRoute === 'selection' && activeFolder) {
        setActiveFolderId(activeFolder.id)
      }
    })
  }

  function handleSelectFolder(folderId: string) {
    benchmarkTrace?.mark('selection.navigate')
    startTransition(() => {
      setRoute('selection')
      setActiveFolderId(folderId)
    })
  }

  function handleSetDecision(photoId: string, decision: SelectionDecision) {
    setOperationError(null)
    // Only authoritative detail updates workspace; failures cannot leave an optimistic copy behind.
    setFocusedPhotoId(photoId)
    const requestId = ++saveRequestSeqRef.current
    if (saveFeedbackTimerRef.current !== null) {
      window.clearTimeout(saveFeedbackTimerRef.current)
      saveFeedbackTimerRef.current = null
    }
    setSaveFeedback({
      photoId,
      requestId,
      status: 'saving',
      grade: decision ?? undefined,
    })
    void setDecisionMutation
      .mutateAsync({
        photoId,
        decision,
        libraryId: photoById.get(photoId)?.folderId,
      })
      .then(() => {
        refreshUnversionedReview(photoId)
        if (saveRequestSeqRef.current !== requestId) return
        setSaveFeedback({
          photoId,
          requestId,
          status: 'saved',
          grade: decision ?? undefined,
        })
        if (saveFeedbackTimerRef.current !== null) {
          window.clearTimeout(saveFeedbackTimerRef.current)
        }
        saveFeedbackTimerRef.current = window.setTimeout(() => {
          setSaveFeedback((current) => (current?.requestId === requestId ? null : current))
          saveFeedbackTimerRef.current = null
        }, 1800)
      })
      .catch((err: unknown) => {
        logger.warn('Failed to persist decision:', err)
        const message = t('selection.savePhotoFailed', {
          file: photoById.get(photoId)?.fileName ?? photoId,
        })
        setOperationError(message)
        if (saveRequestSeqRef.current !== requestId) return
        setSaveFeedback({ photoId, requestId, status: 'error', message })
      })
  }

  function handleSetSpeciesOverride(
    photoId: string,
    birdIndex: number,
    species: SpeciesOverrideValue | null,
    bbox?: SpeciesOverrideBBox | null,
  ) {
    setOperationError(null)
    setFocusedPhotoId(photoId)
    const requestId = ++saveRequestSeqRef.current
    if (saveFeedbackTimerRef.current !== null) {
      window.clearTimeout(saveFeedbackTimerRef.current)
      saveFeedbackTimerRef.current = null
    }
    setSaveFeedback({ photoId, requestId, status: 'saving' })
    void setSpeciesOverrideMutation
      .mutateAsync({
        photoId,
        birdIndex,
        species,
        bbox: bbox ?? null,
        libraryId: photoById.get(photoId)?.folderId,
      })
      .then(() => {
        refreshUnversionedReview(photoId)
        if (saveRequestSeqRef.current !== requestId) return
        setSaveFeedback({ photoId, requestId, status: 'saved' })
        if (saveFeedbackTimerRef.current !== null) {
          window.clearTimeout(saveFeedbackTimerRef.current)
        }
        saveFeedbackTimerRef.current = window.setTimeout(() => {
          setSaveFeedback((current) => (current?.requestId === requestId ? null : current))
          saveFeedbackTimerRef.current = null
        }, 1800)
      })
      .catch((err: unknown) => {
        logger.warn('Failed to persist species override:', err)
        const message = t('selection.savePhotoFailed', {
          file: photoById.get(photoId)?.fileName ?? photoId,
        })
        setOperationError(message)
        if (saveRequestSeqRef.current !== requestId) return
        setSaveFeedback({ photoId, requestId, status: 'error', message })
      })
  }

  function refreshUnversionedReview(photoId: string) {
    if (!photoById.get(photoId)?.reviewRevision) {
      void queryClient.invalidateQueries({ queryKey: PHOTO_REVIEW_KEY(photoId) })
    }
  }

  const reviewOrderContextRef = useRef({
    reviewPhotoId,
    route,
    archivePhotos,
    flatSelectionPhotos,
  })
  reviewOrderContextRef.current = { reviewPhotoId, route, archivePhotos, flatSelectionPhotos }

  const handleOpenReview = useCallback(
    (photoId: string) => {
      const ctx = reviewOrderContextRef.current
      if (!ctx.reviewPhotoId) {
        setReviewOrder(
          (ctx.route === 'archive' ? ctx.archivePhotos : ctx.flatSelectionPhotos).map(
            (photo) => photo.id,
          ),
        )
      }
      startTransition(() => {
        setFocusedPhotoId(photoId)
        setReviewPhotoId(photoId)
      })
    },
    [setFocusedPhotoId, setReviewPhotoId],
  )

  useEffect(() => {
    if (route !== 'selection' || reviewPhotoId !== null) return
    if (!focusedPhotoId || !flatSelectionPhotos.some((photo) => photo.id === focusedPhotoId)) return

    const handleKeyDown = (event: KeyboardEvent) => {
      let popoverOpen = false
      try {
        popoverOpen = Boolean(document.querySelector(':popover-open'))
      } catch {
        popoverOpen = false
      }
      if (event.defaultPrevented || !isPlainSpaceKey(event) || popoverOpen) return
      if (shouldIgnoreSelectionReviewShortcutTarget(event.target)) return
      event.preventDefault()
      const targetPhotoId =
        event.target instanceof HTMLElement
          ? event.target.closest<HTMLElement>('[data-photo-id]')?.dataset.photoId
          : null
      handleOpenReview(targetPhotoId ?? focusedPhotoId)
    }

    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [flatSelectionPhotos, focusedPhotoId, reviewPhotoId, route])

  const routeErrorResetKey = [
    route,
    activeFolderId ?? '',
    archiveTab,
    activeSpeciesId ?? '',
    viewMode,
    activeSort,
    onlyFlying ? 'flying' : 'all',
    activeQuickFilters.join(','),
    deferredSearch,
    visibleFolders.length,
    folderGroups.length,
    flatSelectionPhotos.length,
    archivePhotos.length,
    archiveSpecies.length,
  ].join(':')
  const exportErrorResetKey = exportSessions.map((session) => session.id).join('|')

  const exportDisabledReason = !activeFolder || activeFolderPhotos.length === 0
    ? t('export.disabled.noPhotos')
    : activeSourceMissing
      ? t('selection.sourceMissing.exportDisabled')
      : route === 'selection' && !selectionExportable
        ? t('export.disabled.updating')
        : undefined
  const searchDisabledOnMap = route === 'archive' && archiveTab === 'map'

  return (
    <AppShell
      onNavigate={handleNavigate}
      onOpenExport={openExportForActiveFolder}
      onOpenSettings={() => setSettingsOpen(true)}
      onSearchChange={setSearchQuery}
      route={route}
      searchDisabled={searchDisabledOnMap}
      searchQuery={searchQuery}
      settingsOpen={settingsOpen}
      t={t}
      controlsDisabled={!appInteractive}
      exportDisabled={Boolean(exportDisabledReason)}
      exportDisabledTitle={exportDisabledReason}
    >
      {benchmarkTrace && (
        <SelectionCommitTrace
          route={route}
          projectedDetail={workspace.activeProjection?.detail}
          selection={selectionSnapshot}
        />
      )}
      {isError ? (
        <div className="engine-banner engine-banner--fatal" role="alert">
          <span>{t('engineBanner.healthFailed')}</span>
          <button
            className="engine-banner__action"
            type="button"
            onClick={() => {
              void queryClient.invalidateQueries({ queryKey: ['backend-health'] })
            }}
          >
            {t('common.retry')}
          </button>
          {window.plumelens?.openLogsDir ? (
            <button
              className="engine-banner__action"
              type="button"
              onClick={() => {
                void window.plumelens?.openLogsDir?.()
              }}
            >
              {t('engineBanner.openLogs')}
            </button>
          ) : null}
        </div>
      ) : null}
      {(operationError || setDecisionMutation.isPending || setSpeciesOverrideMutation.isPending) &&
      !reviewPhoto ? (
        <div className="operation-feedback-stack">
          {operationError ? (
            <div className="operation-feedback" role="alert">
              <span>{operationError}</span>
              <button
                type="button"
                className="button-ghost button-compact"
                onClick={() => setOperationError(null)}
              >
                {t('common.close')}
              </button>
            </div>
          ) : null}
          {setDecisionMutation.isPending || setSpeciesOverrideMutation.isPending ? (
            <div className="operation-feedback" role="status">
              {t('selection.saving')}
            </div>
          ) : null}
        </div>
      ) : null}
      <ErrorBoundary resetKey={routeErrorResetKey} t={t}>
        <Suspense fallback={null}>
          {route === 'selection' ? (
            <SelectionScreen
              speciesFilterProps={speciesFilterProps}
              selectionCount={selectionResult?.matched_count ?? 0}
              selectionPending={selectionResult?.pending_count ?? 0}
              onClearFilters={() => {
                setActiveQuickFilters([])
                setOnlyFlying(false)
                setSearchQuery('')
                if (activeFolder) setSelectionSpeciesFilter(activeFolder.id, DEFAULT_SPECIES_FILTER)
              }}
              filtersAreDefault={
                activeQuickFilters.length === 3 &&
                ['select', 'usable', 'record'].every((grade) =>
                  activeQuickFilters.includes(grade as 'select' | 'usable' | 'record'),
                ) &&
                !onlyFlying &&
                !searchQuery &&
                speciesFilter.keys.length === 0 &&
                speciesFilter.includeReview
              }
              onRestoreFilters={() => {
                setActiveQuickFilters(['select', 'usable', 'record'])
                setOnlyFlying(false)
                setSearchQuery('')
                if (activeFolder) setSelectionSpeciesFilter(activeFolder.id, DEFAULT_SPECIES_FILTER)
              }}
              onRefreshFolder={handleRefreshFolder}
              refreshing={refreshing}
              activeFolder={activeFolder}
              activeFolderSummary={activeFolderSummary}
              activeQuickFilters={activeQuickFilters}
              onlyFlying={onlyFlying}
              activeSort={activeSort}
              analysisStarting={startBatch.isPending}
              filteredGroups={folderGroups}
              flatPhotos={flatSelectionPhotos}
              focusedPhoto={focusedPhoto}
              focusedPhotoId={focusedPhotoId}
              folderPhotos={activeFolderPhotos}
              folders={visibleFolders}
              onThumbnailLoadStatus={handleThumbnailLoadStatus}
              onOpenFolderContextMenu={openFolderContextMenu}
              onOpenExport={openExportForActiveFolder}
              onOpenReview={handleOpenReview}
              onRelinkFolder={handleRelinkFolder}
              onRenameFolder={handleRenameFolder}
              onSelectFolder={handleSelectFolder}
              onSetDecision={handleSetDecision}
              onStartAnalysis={handleStartAnalysis}
              progressEvent={progressEvent}
              relinkingFolderId={relinkingFolderId}
              setActiveQuickFilter={setActiveQuickFilter}
              setOnlyFlying={setOnlyFlying}
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
              archiveSearchKey={deferredSearch}
              onOpenReview={handleOpenReview}
              onSelectSpecies={setActiveSpeciesId}
              onSetArchiveTab={setArchiveTab}
              t={t}
            />
          ) : (
            <StartScreen
              backendData={backendData}
              controlsDisabled={!appInteractive}
              folders={visibleFolders}
              hasAnyFolders={workspace.folders.length > 0}
              importError={importError}
              isError={isError}
              isReady={isReady}
              onChooseFolder={handleChooseFolder}
              onClearSearch={() => setSearchQuery('')}
              onContinueLatest={() => handleNavigate('selection')}
              onDismissImportError={() => setImportError(null)}
              onOpenFolderContextMenu={openFolderContextMenu}
              onOpenFolder={handleSelectFolder}
              searchQuery={deferredSearch}
              t={t}
            />
          )}
        </Suspense>
      </ErrorBoundary>

      {reviewPhoto ? (
        <ErrorBoundary resetKey={`review:${reviewPhoto.id}`} t={t}>
          <Suspense fallback={null}>
            {/* ReviewModal 自带 backdrop,fallback 用 null 避免双重 overlay */}
            <ReviewModal
              detail={{ photo: reviewPhoto, group: reviewGroup }}
              groupPhotos={reviewGroupPhotos}
              onClose={() => {
                setReviewPhotoId(null)
                setReviewOrder([])
              }}
              onSelectPhoto={handleOpenReview}
              onSetDecision={handleSetDecision}
              onSetSpeciesOverride={handleSetSpeciesOverride}
              onThumbnailLoadStatus={handleThumbnailLoadStatus}
              photos={reviewPhotos}
              outsideSelection={reviewPhotoOutsideSelection}
              sequenceTotalCount={reviewSequenceTotalCount}
              saveError={operationError}
              saving={setDecisionMutation.isPending || setSpeciesOverrideMutation.isPending}
              saveFeedback={saveFeedback}
              onDismissError={() => {
                setOperationError(null)
                setSaveFeedback((current) => (current?.status === 'error' ? null : current))
              }}
              t={t}
            />
          </Suspense>
        </ErrorBoundary>
      ) : null}

      {exportSessions.length > 0 ? (
        <ErrorBoundary resetKey={`exports:${exportErrorResetKey}`} t={t}>
          <Suspense fallback={null}>
            <div className="export-session-stack">
              {exportSessions.map((session) => (
                <ExportDrawer
                  key={session.id}
                  onClose={() => closeExportSession(session.id)}
                  source={getExportSource(session)}
                  t={t}
                />
              ))}
            </div>
          </Suspense>
        </ErrorBoundary>
      ) : null}

      <FolderContextMenu
        menu={folderContextMenu}
        onClose={closeFolderContextMenu}
        onOpenFolder={openFolderInFinder}
        onRelinkFolder={handleRelinkFolder}
        onRequestRemove={requestRemoveFolder}
        t={t}
      />

      <RemoveFolderDialog
        busy={deleteLibrary.isPending}
        error={removeError}
        folder={pendingRemoval}
        onCancel={cancelRemoveFolder}
        onConfirm={() => {
          void confirmRemoveFolder()
        }}
        t={t}
      />
    </AppShell>
  )
}

function AppShell({
  children,
  controlsDisabled,
  exportDisabled,
  exportDisabledTitle,
  onNavigate,
  onOpenExport,
  onOpenSettings,
  onSearchChange,
  route,
  searchDisabled,
  searchQuery,
  settingsOpen,
  t,
}: {
  children: ReactNode
  controlsDisabled: boolean
  exportDisabled: boolean
  exportDisabledTitle?: string
  onNavigate: (route: AppRoute) => void
  onOpenExport: () => void
  onOpenSettings: () => void
  onSearchChange: (value: string) => void
  route: AppRoute
  searchDisabled: boolean
  searchQuery: string
  settingsOpen: boolean
  t: ReturnType<typeof useTranslation>['t']
}) {
  const disabledTitle = controlsDisabled ? t('nav.loadingDisabled') : undefined
  const isSearchDisabled = controlsDisabled || searchDisabled
  const searchPlaceholder = searchDisabled
    ? t('nav.searchMapDisabled')
    : t(
        route === 'selection'
          ? 'nav.searchSelection'
          : route === 'archive'
            ? 'nav.searchArchive'
            : 'nav.searchStart',
      )
  return (
    <div className="app-shell">
      <header className="command-bar">
        <button
          className="brand-mark"
          disabled={controlsDisabled}
          onClick={() => onNavigate('start')}
          title={disabledTitle}
          type="button"
        >
          <span className="brand-mark__icon brand-mark__icon--app">
            <img alt="" aria-hidden="true" className="brand-mark__logo" src={appIconUrl} />
          </span>
          <span className="brand-mark__copy">
            <span>{t('app.title')}</span>
          </span>
        </button>

        <nav className="route-switcher" aria-label={t('nav.primary')}>
          {(['start', 'selection', 'archive'] as AppRoute[]).map((item) => {
            const Icon = routeIcons[item]
            return (
              <button
                aria-current={route === item ? 'page' : undefined}
                className={cn(
                  'route-switcher__item',
                  route === item && 'route-switcher__item--active',
                )}
                disabled={controlsDisabled}
                key={item}
                onClick={() => onNavigate(item)}
                title={disabledTitle}
                type="button"
              >
                <Icon className="h-4 w-4" />
                <span>{t(routeLabelKey(item))}</span>
              </button>
            )
          })}
        </nav>

        <div className="command-actions">
          <label
            className={cn('search-pill', isSearchDisabled && 'search-pill--disabled')}
            title={disabledTitle ?? (searchDisabled ? t('nav.searchMapDisabled') : undefined)}
          >
            <Search className="h-4 w-4" />
            <span className="sr-only">{searchPlaceholder}</span>
            <input
              type="search"
              name="photo-search"
              autoComplete="off"
              spellCheck={false}
              onChange={(event) => onSearchChange(event.target.value)}
              disabled={isSearchDisabled}
              placeholder={searchPlaceholder}
              value={searchQuery}
            />
          </label>
          <IconButton
            disabled={controlsDisabled || exportDisabled}
            label={t('common.export')}
            onClick={onOpenExport}
            title={disabledTitle ?? exportDisabledTitle}
          >
            <Download className="h-4 w-4" />
          </IconButton>
          <IconButton label={t('common.settings')} onClick={onOpenSettings}>
            <Settings2 className="h-4 w-4" />
          </IconButton>
          {/* 引擎状态在左下角 status bar 已有完整展示，此处不重复 */}
        </div>
      </header>

      <EngineStatusBanner />
      <div className="app-body">{children}</div>
      {settingsOpen ? (
        <ErrorBoundary resetKey="settings" t={t}>
          <Suspense fallback={null}>
            <SettingsModal />
          </Suspense>
        </ErrorBoundary>
      ) : null}
      <ErrorBoundary resetKey="logging-consent" t={t}>
        <LoggingConsentModal />
      </ErrorBoundary>
    </div>
  )
}

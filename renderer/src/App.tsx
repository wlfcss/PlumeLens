import { Aperture, Download, LibraryBig, Search, Settings2, Sparkles } from 'lucide-react'
import {
  Suspense,
  lazy,
  startTransition,
  useCallback,
  useDeferredValue,
  useEffect,
  useMemo,
  useState,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
} from 'react'
import { useTranslation } from 'react-i18next'

import appIconUrl from '../../build/icon.png?url'
import { EngineStatusBanner } from '@/components/engine-status-banner'
const ReviewModal = lazy(() =>
  import('@/components/review/review-modal').then((m) => ({ default: m.ReviewModal })),
)
// SettingsModal / ExportDrawer / ReviewModal / ArchiveScreen / SelectionScreen
// 全部 lazy — 起始页只下载 StartScreen + AppShell + EngineStatusBanner 子集,
// 主 bundle 从 4.4MB 起步显著缩水(实测见构建 stat)。
const SettingsModal = lazy(() =>
  import('@/components/settings-modal').then((m) => ({ default: m.SettingsModal })),
)
import { useAnalysisProgress, useStartBatch } from '@/hooks/use-analysis'
import { useBackendHealth } from '@/hooks/use-backend'
import { useSetDecision, useSetSpeciesOverride } from '@/hooks/use-decisions'
import { useLibraryWorkspaceSync } from '@/hooks/use-library-workspace-sync'
import {
  LIBRARIES_KEY,
  LIBRARY_DETAIL_KEY,
  useAllLibraryDetails,
  useImportLibrary,
  useLibraries,
  useLibraryDetail,
  useLibraryEvents,
  useRelinkLibrary,
  useUpdateLibrary,
} from '@/hooks/use-library'
import { useThumbnailRepair } from '@/hooks/use-thumbnail-repair'
import { useQueryClient } from '@tanstack/react-query'
import type { DecisionValue, SpeciesOverrideBBox, SpeciesOverrideValue } from '@/lib/api-client'

import type {
  AppRoute,
  FolderRecord,
  PhotoRecord,
  SelectionDecision,
  SpeciesRecord,
  WorkspaceSnapshot,
} from '@/lib/workspace-types'
import { cn } from '@/lib/utils'
import { useShallow, useUIStore, type QuickFilter } from '@/stores/ui-store'
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
const SelectionScreen = lazy(() =>
  import('@/components/selection-chrome/selection-screen').then((m) => ({
    default: m.SelectionScreen,
  })),
)
import {
  FolderContextMenu,
  StartScreen,
  type FolderContextMenuState,
} from '@/components/start/start-screen'
import {
  buildGroupStartMsMap,
  buildReviewPhotoOrderForGroupedEntries,
  buildReviewSegmentPhotosByPhotoId,
  compareGroupStartDesc,
  sortPhotos,
} from '@/lib/photo-grid-helpers'
import { routeLabelKey } from '@/lib/i18n-keys'
import { isArchiveEligiblePhoto, photoCategory } from '@/lib/photo-display'
import { type FolderSummary } from '@/lib/photo-helpers'
import {
  archivePhotoSearchParts,
  buildFolderSummary,
  deriveSpeciesRecords,
} from '@/lib/workspace-projection'
import { logger } from '@/lib/logger'

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
const FOLDER_CONTEXT_MENU_HEIGHT = 88

const EMPTY_PHOTOS: PhotoRecord[] = []
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

function filterPhotoByQuickFilters(photo: PhotoRecord, filters: QuickFilter[]): boolean {
  // 失败照片:仅在显式包含 'failed' filter 时显示。源文件损坏 / 解码错的照片
  // 没有有效分析结果(birdCount=0 / grade 默认),混在场景组里只会让用户困惑("为
  // 什么这张是空的"),默认隐藏,quickFilter 切到"失败"才查看。
  if (photo.analysisStatus === 'failed') return filters.includes('failed')
  // 还在分析中(pending / running): 始终显示,用户能看到分析进度。
  if (photo.analysisStatus !== 'done') return true
  // 空 filter = "未应用任何过滤" = 显示全部(行业惯例 + 用户取消所有 chip 的直觉)。
  // 旧实现 `return false` 让"全清 chip"变成"全部隐藏",对用户语义反转。
  if (filters.length === 0) return true
  return filters.includes(photoCategory(photo))
}

function photoHasFlyingPosture(photo: PhotoRecord): boolean {
  const bestDetectionPose = photo.birdDetections?.find((detection) => detection.isBest)?.pose
  const pose = photo.bestPose ?? bestDetectionPose ?? null
  if (pose?.posture === 'flying') return true
  return photo.poseTags.includes('wings_open')
}

function filterPhotoByFeatureConstraints(photo: PhotoRecord, onlyFlying: boolean): boolean {
  if (!onlyFlying) return true
  return photo.analysisStatus === 'done' && photoHasFlyingPosture(photo)
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
  const [workspace, setWorkspace] = useState<WorkspaceSnapshot>(() => ({
    folders: [],
    groups: [],
    photos: [],
    species: [],
  }))
  const [exportSessions, setExportSessions] = useState<ExportSession[]>([])
  const [folderContextMenu, setFolderContextMenu] = useState<FolderContextMenuState>(null)
  const [relinkingFolderId, setRelinkingFolderId] = useState<string | null>(null)
  const [importError, setImportError] = useState<string | null>(null)

  const {
    route,
    archiveTab,
    activeFolderId,
    activeSpeciesId,
    activeQuickFilters,
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

  const visibleFolders = workspace.folders.filter((folder) =>
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
  const openExportForActiveFolder = useCallback(() => {
    if (!activeFolder || activeFolder.status === 'path_missing') return
    setExportSessions((current) => [
      ...current,
      {
        id: `${activeFolder.id}-${Date.now()}-${Math.random().toString(36).slice(2)}`,
        folderId: activeFolder.id,
        initialSource: {
          folder: activeFolder,
          photos: activeFolderPhotos,
          summary: activeFolderSummary,
        },
      },
    ])
  }, [activeFolder, activeFolderPhotos, activeFolderSummary])
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
      }
    },
    [photosByFolder, summariesByFolder, workspace.folders],
  )
  const filteredSelectionPhotos = useMemo(
    () =>
      sortPhotos(
        activeFolderPhotos.filter(
          (photo) =>
            filterPhotoByQuickFilters(photo, activeQuickFilters) &&
            filterPhotoByFeatureConstraints(photo, onlyFlying) &&
            matchesQuery([photo.fileName, photo.speciesName, photo.caption], deferredSearch),
        ),
        activeSort,
      ),
    [activeFolderPhotos, activeQuickFilters, activeSort, deferredSearch, onlyFlying],
  )
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
      matchesQuery([species.name, species.latinName, species.summary], deferredSearch),
    )
  }, [deferredSearch, shouldLoadArchiveWorkspace, speciesRecords])
  const reviewPhotos = useMemo(() => {
    if (!reviewPhoto) return []
    const source = route === 'archive' ? archivePhotos : flatSelectionPhotos
    if (source.some((photo) => photo.id === reviewPhoto.id)) return source
    return [reviewPhoto, ...source.filter((photo) => photo.id !== reviewPhoto.id)]
  }, [archivePhotos, flatSelectionPhotos, reviewPhoto, route])
  const reviewSegmentPhotosByPhotoId = useMemo(
    () => buildReviewSegmentPhotosByPhotoId(reviewPhotos),
    [reviewPhotos],
  )
  const reviewGroupPhotos = useMemo(() => {
    if (!reviewPhoto) return EMPTY_PHOTOS
    return reviewSegmentPhotosByPhotoId.get(reviewPhoto.id) ?? EMPTY_PHOTOS
  }, [reviewSegmentPhotosByPhotoId, reviewPhoto])

  const { data: realLibraries } = useLibraries()
  const allLibraryIds = useMemo(() => (realLibraries ?? []).map((l) => l.id), [realLibraries])
  const allDetails = useAllLibraryDetails(allLibraryIds, shouldLoadArchiveWorkspace)
  const { data: activeDetail } = useLibraryDetail(activeFolderId)
  useLibraryEvents(activeFolderId, Boolean(activeFolderId))
  const importLibrary = useImportLibrary()
  const { mutateAsync: updateLibraryDisplayName } = useUpdateLibrary()
  const { mutateAsync: relinkLibrary } = useRelinkLibrary()
  const startBatch = useStartBatch()
  const queryClient = useQueryClient()
  const handleThumbnailLoadStatus = useThumbnailRepair({
    libraryId: activeFolderId,
    photos: workspace.photos,
  })
  useLibraryWorkspaceSync({
    activeDetail,
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
  // engine 重启后端口可能变 — engineStore 在 'ready' 事件时也 bump 一次,两边相加。
  const engineSseKey = useEngineStore((s) => s.sseRestartKey)

  // 引擎 cold-start 时 useLibraries 等 query 在 ~5s 模型加载窗口内多次失败 → 永远
  // 卡在 error state,recent folders 不显示。engineSseKey 在 engine 每次 'ready'
  // 事件都自增,作触发器把所有可能受冷启影响的 query 强制 invalidate 让 react-query
  // 重 fetch。libraries / decisions / archive / geocoding 都没自带 refetchInterval
  // (SSE 不轮询原则),这里是它们"engine 就绪后回血"的唯一机会。
  // 'library' 也包了一份是为了 useLibraryDetail(activeFolderId 持久化时,选片屏挂载
  // 立即触发 detail fetch 也会冷启失败)。
  useEffect(() => {
    if (engineSseKey === 0) return // initial render,engine 还没发过 'ready' 事件
    queryClient.invalidateQueries({ queryKey: LIBRARIES_KEY })
    queryClient.invalidateQueries({ queryKey: ['library'] })
    queryClient.invalidateQueries({ queryKey: ['decisions'] })
    queryClient.invalidateQueries({ queryKey: ['archive'] })
    queryClient.invalidateQueries({ queryKey: ['geocoding'] })
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
    try {
      await startBatch.mutateAsync({ libraryId: activeFolderId })
      // bump key 让 useAnalysisProgress 重建 SSE 连接（如果上一个 idle 死了）
      setSseRestartKey((k) => k + 1)
    } catch (err) {
      logger.error('Failed to start batch analysis:', err)
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
    // 乐观更新本地 state（即时反馈）
    startTransition(() => {
      setWorkspace((current) => ({
        ...current,
        photos: current.photos.map((photo) =>
          photo.id === photoId ? { ...photo, decision } : photo,
        ),
      }))
      setFocusedPhotoId(photoId)
    })
    // 异步落库。失败时 useSetDecision 内部会 invalidate library detail → refetch
    // → 同步 useEffect 把后端真值重新注入 workspace,自动回滚乐观写入。
    setDecisionMutation.mutate(
      { photoId, decision: decision as DecisionValue },
      {
        onError: (err) => {
          logger.warn('Failed to persist decision (will rollback via refetch):', err)
        },
      },
    )
  }

  function handleSetSpeciesOverride(
    photoId: string,
    birdIndex: number,
    species: SpeciesOverrideValue | null,
    bbox?: SpeciesOverrideBBox | null,
  ) {
    const displayName =
      species?.canonical_zh ?? species?.canonical_en ?? species?.canonical_sci ?? null
    startTransition(() => {
      setWorkspace((current) => ({
        ...current,
        photos: current.photos.map((photo) => {
          if (photo.id !== photoId) return photo
          const detections = (photo.birdDetections ?? []).map((bird) =>
            bird.index === birdIndex
              ? {
                  ...bird,
                  speciesName: displayName,
                  speciesLatinName: species?.canonical_sci ?? null,
                  speciesEnglishName: species?.canonical_en ?? null,
                  manualSpecies: species !== null,
                }
              : bird,
          )
          const isBest = detections.find((bird) => bird.index === birdIndex)?.isBest ?? false
          return {
            ...photo,
            birdDetections: detections,
            ...(isBest
              ? {
                  speciesName: displayName,
                  speciesLatinName: species?.canonical_sci ?? null,
                  speciesEnglishName: species?.canonical_en ?? null,
                  manualSpecies: species !== null,
                }
              : {}),
          }
        }),
      }))
      setFocusedPhotoId(photoId)
    })

    // 失败时 useSetSpeciesOverride 内部 invalidate → refetch → 同步 useEffect
    // 把乐观写入回滚到后端真实状态。
    setSpeciesOverrideMutation.mutate(
      { photoId, birdIndex, species, bbox: bbox ?? null },
      {
        onError: (err) => {
          logger.warn('Failed to persist species override (will rollback via refetch):', err)
        },
      },
    )
  }

  function handleOpenReview(photoId: string) {
    startTransition(() => {
      setFocusedPhotoId(photoId)
      setReviewPhotoId(photoId)
    })
  }

  useEffect(() => {
    if (route !== 'selection' || reviewPhotoId !== null) return
    if (!focusedPhotoId || !flatSelectionPhotos.some((photo) => photo.id === focusedPhotoId)) return

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || !isPlainSpaceKey(event)) return
      if (shouldIgnoreSelectionReviewShortcutTarget(event.target)) return
      event.preventDefault()
      handleOpenReview(focusedPhotoId)
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

  return (
    <AppShell
      onNavigate={handleNavigate}
      onOpenExport={openExportForActiveFolder}
      onOpenSettings={() => setSettingsOpen(true)}
      onSearchChange={setSearchQuery}
      route={route}
      searchQuery={searchQuery}
      settingsOpen={settingsOpen}
      t={t}
      controlsDisabled={!appInteractive}
      exportDisabled={Boolean(activeSourceMissing)}
    >
      <ErrorBoundary resetKey={routeErrorResetKey} t={t}>
        <Suspense fallback={null}>
          {route === 'selection' ? (
            <SelectionScreen
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
              folders={visibleFolders}
              importError={importError}
              isError={isError}
              isReady={isReady}
              onChooseFolder={handleChooseFolder}
              onContinueLatest={() => handleNavigate('selection')}
              onDismissImportError={() => setImportError(null)}
              onOpenFolderContextMenu={openFolderContextMenu}
              onOpenFolder={handleSelectFolder}
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
              onClose={() => setReviewPhotoId(null)}
              onSelectPhoto={handleOpenReview}
              onSetDecision={handleSetDecision}
              onSetSpeciesOverride={handleSetSpeciesOverride}
              onThumbnailLoadStatus={handleThumbnailLoadStatus}
              photos={reviewPhotos}
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
        t={t}
      />
    </AppShell>
  )
}

function AppShell({
  children,
  controlsDisabled,
  exportDisabled,
  onNavigate,
  onOpenExport,
  onOpenSettings,
  onSearchChange,
  route,
  searchQuery,
  settingsOpen,
  t,
}: {
  children: ReactNode
  controlsDisabled: boolean
  exportDisabled: boolean
  onNavigate: (route: AppRoute) => void
  onOpenExport: () => void
  onOpenSettings: () => void
  onSearchChange: (value: string) => void
  route: AppRoute
  searchQuery: string
  settingsOpen: boolean
  t: ReturnType<typeof useTranslation>['t']
}) {
  const disabledTitle = controlsDisabled ? t('nav.loadingDisabled') : undefined
  const exportDisabledTitle = exportDisabled
    ? t('selection.sourceMissing.exportDisabled')
    : undefined
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
            className={cn('search-pill', controlsDisabled && 'search-pill--disabled')}
            title={disabledTitle}
          >
            <Search className="h-4 w-4" />
            <input
              onChange={(event) => onSearchChange(event.target.value)}
              disabled={controlsDisabled}
              placeholder={t('nav.search')}
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
          <IconButton
            disabled={controlsDisabled}
            label={t('common.settings')}
            onClick={onOpenSettings}
          >
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
    </div>
  )
}

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
  useRef,
  useState,
  type ReactNode,
} from 'react'
import { useTranslation } from 'react-i18next'

import { useAnalysisProgress, useStartBatch } from '@/hooks/use-analysis'
import { useBackendHealth } from '@/hooks/use-backend'
import { useBatchSetDecisions, useSetDecision } from '@/hooks/use-decisions'
import {
  useAllLibraryDetails,
  useImportLibrary,
  useLibraries,
  useLibraryDetail,
} from '@/hooks/use-library'
import { buildFragmentFromDetail, computeIqaCropBox } from '@/lib/backend-adapter'
import type { AnalysisProgressEvent, DecisionValue } from '@/lib/api-client'

type AnalysisProgressEventLite = AnalysisProgressEvent
import { getSpeciesWiki } from '@/lib/species-wiki'
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
import { createImportedFolder } from '@/lib/mock-workspace'
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

// 档位优先级：精选(3) > 可用(2) > 记录(1) > 淘汰(0)
const GRADE_RANK: Record<PhotoGrade, number> = {
  select: 3,
  usable: 2,
  record: 1,
  reject: 0,
}

function sortPhotos(photos: PhotoRecord[], sortBy: SortMode): PhotoRecord[] {
  return photos.toSorted((left, right) => {
    if (sortBy === 'name') return left.fileName.localeCompare(right.fileName)
    if (sortBy === 'shot_at') return right.shotAt.localeCompare(left.shotAt)
    if (sortBy === 'recent') return right.id.localeCompare(left.id)
    // 综合评分（默认）：先按档位降序（精选 → 可用 → 记录 → 淘汰），
    // 同档内按 quality_score 降序
    const gradeDiff = GRADE_RANK[right.grade] - GRADE_RANK[left.grade]
    if (gradeDiff !== 0) return gradeDiff
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
  // 从真实分析结果聚合：扫所有 photos，按物种分组
  const groups = new Map<
    string,
    {
      photos: PhotoRecord[]
      bestScore: number
      firstSeenAt: string
      lastSeenAt: string
    }
  >()
  for (const photo of workspace.photos) {
    const name = photo.speciesName
    if (!name || photo.analysisStatus !== 'done') continue
    const score = photo.finalScore ?? 0
    const existing = groups.get(name)
    if (existing) {
      existing.photos.push(photo)
      if (score > existing.bestScore) existing.bestScore = score
      if (photo.shotAt < existing.firstSeenAt) existing.firstSeenAt = photo.shotAt
      if (photo.shotAt > existing.lastSeenAt) existing.lastSeenAt = photo.shotAt
    } else {
      groups.set(name, {
        photos: [photo],
        bestScore: score,
        firstSeenAt: photo.shotAt,
        lastSeenAt: photo.shotAt,
      })
    }
  }
  // 渐变封面：用物种名 hash 给每个物种一个稳定色相
  const hueOf = (s: string): number => {
    let h = 0
    for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0
    return h % 360
  }
  const aggregated: SpeciesRecord[] = Array.from(groups.entries()).map(([name, g]) => {
    const hue = hueOf(name)
    const latinName = g.photos[0]?.speciesLatinName ?? ''
    return {
      id: `species-real-${name}`,
      name,
      latinName,
      coverGradient: `linear-gradient(135deg, hsl(${hue}, 45%, 32%), hsl(${(hue + 40) % 360}, 38%, 16%))`,
      photoCount: g.photos.length,
      firstSeenAt: g.firstSeenAt,
      lastSeenAt: g.lastSeenAt,
      bestScore: g.bestScore,
      newSightings: 0,
      regions: [],
      summary: `${g.photos.length} 张照片`,
    }
  })
  // 真后端聚合优先；如果完全没有真数据（启动初期），fallback 到 mock seeds
  if (aggregated.length === 0) {
    return workspace.species.toSorted((left, right) => right.bestScore - left.bestScore)
  }
  return aggregated.toSorted((left, right) => right.bestScore - left.bestScore)
}

function folderHasActiveTasks(status: FolderStatus): boolean {
  return ['scanning', 'hashing', 'analyzing_partial', 'updating', 'exporting'].includes(status)
}

export default function App() {
  const { t } = useTranslation()
  const { data: backendData, isReady, isError } = useBackendHealth()
  // 起手用空 workspace，避免 useLibraries 还没 fetch 完时闪现 mock 数据。
  // useLibraries effect 拿到真数据后会注入；fetch 失败的 fallback 在 handleChooseFolder 里。
  const [workspace, setWorkspace] = useState<WorkspaceSnapshot>(() => ({
    folders: [],
    groups: [],
    photos: [],
    species: [],
  }))

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
    .toSorted((left, right) => {
      // 组间排序与组内排序口径一致：先看"组的最佳档位"（精选 > 可用 > 记录 > 淘汰），
      // 同档位再比"组的最佳分数"。group.photos[0] 因为已经经过 sortPhotos 档位优先排序，
      // 所以就是组内最佳那张。
      const lp = left.photos[0]
      const rp = right.photos[0]
      const lRank = lp ? GRADE_RANK[lp.grade] : -1
      const rRank = rp ? GRADE_RANK[rp.grade] : -1
      if (lRank !== rRank) return rRank - lRank
      return (rp?.finalScore ?? -1) - (lp?.finalScore ?? -1)
    })

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
  const allLibraryIds = useMemo(
    () => (realLibraries ?? []).map((l) => l.id),
    [realLibraries],
  )
  const allDetails = useAllLibraryDetails(allLibraryIds)
  const { data: activeDetail } = useLibraryDetail(activeFolderId)
  const importLibrary = useImportLibrary()
  const startBatch = useStartBatch()
  const progressEvent = useAnalysisProgress(activeFolderId, Boolean(activeFolderId))
  const setDecisionMutation = useSetDecision(activeFolderId)
  const batchSetDecisionsMutation = useBatchSetDecisions(activeFolderId)

  // 后端 library 列表就绪时：用真 folders 替换 mock seeds，
  // 同时**清空 mock photos/groups/species**（避免 archive 页 / 物种墙混入"池鹭/翠鸟"等假数据）。
  // useLibraryDetail 后续会按需注入每个 folder 的真 photos。
  useEffect(() => {
    // 后端列表 fetch 完成（哪怕空数组）就用真数据替换。空数组也要清掉 mock seeds，
    // 否则全新安装时"最近文件夹"会显示崇明东滩/南汇嘴这种假数据。
    if (!realLibraries) return
    const realFolderIds = new Set(realLibraries.map((l) => l.id))
    setWorkspace((current) => ({
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
      // 只保留真 folder 的 photos/groups（mock seeds 的 folderId 不在真集合里 → 被剔除）
      photos: current.photos.filter((p) => realFolderIds.has(p.folderId)),
      groups: current.groups.filter((g) => realFolderIds.has(g.folderId)),
      // 物种列表清空 — deriveSpeciesRecords 会从真 photos 聚合
      species: [],
    }))
  }, [realLibraries])

  // useAllLibraryDetails 每次 render 返回新数组引用，但内容大多数时候没变。
  // 用稳定字符串 key 描述"内容是否真变化"，再用 useMemo 把派生 fragments 引用绑定到这个 key。
  const allDetailsKey = useMemo(
    () =>
      allDetails
        .map(
          (d) =>
            `${d.library.id}:${d.library.last_analyzed_at ?? ''}:${d.photos.length}:${d.library.analyzed_count}`,
        )
        .join('|'),
    [allDetails],
  )
  // 所有 library 的详情就绪后，把真照片注入 workspace（archive 页跨 library 聚合需要）。
  // useAllLibraryDetails 每次 render 返回新数组引用 → 用 allDetailsKey（稳定字符串）作为
  // useEffect 唯一依赖，allDetails 通过闭包读最新值。避免引用变化触发死循环。
  useEffect(() => {
    if (allDetails.length === 0) return
    const fragments = allDetails.map(buildFragmentFromDetail)
    const realFolderIdsInDetails = new Set(fragments.map((f) => f.folder.id))
    setWorkspace((current) => ({
      folders: current.folders.map((f) => {
        const updated = fragments.find((fr) => fr.folder.id === f.id)
        return updated ? updated.folder : f
      }),
      photos: [
        ...current.photos.filter((p) => !realFolderIdsInDetails.has(p.folderId)),
        ...fragments.flatMap((f) => f.photos),
      ],
      groups: [
        ...current.groups.filter((g) => !realFolderIdsInDetails.has(g.folderId)),
        ...fragments.flatMap((f) => f.groups),
      ],
      species: [],
    }))
  }, [allDetailsKey])

  // 单 library detail 就绪（active folder 切换时优先级更高，立即注入）
  useEffect(() => {
    if (!activeDetail) return
    const fragment = buildFragmentFromDetail(activeDetail)
    setWorkspace((current) => ({
      ...current,
      folders: current.folders.map((f) =>
        f.id === fragment.folder.id ? fragment.folder : f,
      ),
      photos: [
        ...current.photos.filter((p) => p.folderId !== fragment.folder.id),
        ...fragment.photos,
      ],
      groups: [
        ...current.groups.filter((g) => g.folderId !== fragment.folder.id),
        ...fragment.groups,
      ],
    }))
  }, [activeDetail])

  async function handleChooseFolder() {
    const path = await window.plumelens?.openFolder?.()
    if (!path) return

    // 先切到 selection 路由，给用户即时视觉反馈
    startTransition(() => {
      setRoute('selection')
      setActiveQuickFilter('all')
      setViewMode('grouped')
    })

    // 调用真后端 import；成功后用返回的 library_id 作为 activeFolderId
    // → useLibraryDetail 自动拉详情 → useEffect 把真 photos 注入 workspace
    try {
      const lib = await importLibrary.mutateAsync({ root_path: path })
      setActiveFolderId(lib.id)
    } catch (err) {
      console.warn('Library import to backend failed:', err)
      // 后端不可用时降级到 mock，避免空白屏
      const imported = createImportedFolder(path)
      setWorkspace((current) => mergeWorkspace(current, imported))
      setActiveFolderId(imported.folders[0]?.id ?? null)
    }
  }

  async function handleStartAnalysis() {
    if (!activeFolderId) return
    try {
      await startBatch.mutateAsync({ libraryId: activeFolderId })
    } catch (err) {
      console.error('Failed to start batch analysis:', err)
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
    // 异步落库（后端不可用时保持 mock 体验）
    setDecisionMutation.mutate(
      { photoId, decision: decision as DecisionValue },
      {
        onError: (err) => {
          // 仅记录 — 乐观 UI 不回滚，下次 refetch 会纠正
          console.warn('Failed to persist decision:', err)
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

    const updates: Array<[string, DecisionValue]> = comparePhotoIds.map((pid) => [
      pid,
      pid === bestPhoto.id ? 'selected' : 'rejected',
    ])

    // 乐观更新
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
    // 批量落库
    batchSetDecisionsMutation.mutate(updates, {
      onError: (err) => {
        console.warn('Failed to persist batch decisions:', err)
      },
    })
  }

  return (
    <AppShell
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
          analysisStarting={startBatch.isPending}
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
          onStartAnalysis={handleStartAnalysis}
          onToggleCompare={toggleComparePhotoId}
          progressEvent={progressEvent}
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
  children,
  onNavigate,
  onOpenExport,
  onSearchChange,
  route,
  searchQuery,
  t,
}: {
  children: ReactNode
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
          {/* 引擎状态在左下角 status bar 已有完整展示，此处不重复 */}
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
  analysisStarting,
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
  onStartAnalysis,
  onToggleCompare,
  progressEvent,
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
  analysisStarting: boolean
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
  onStartAnalysis: () => void
  onToggleCompare: (photoId: string) => void
  progressEvent: AnalysisProgressEventLite | null
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
        <FolderTopline
          activeFolder={activeFolder}
          analysisStarting={analysisStarting}
          onOpenExport={onOpenExport}
          onStartAnalysis={onStartAnalysis}
          progressEvent={progressEvent}
          t={t}
        />
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
  analysisStarting,
  onOpenExport,
  onStartAnalysis,
  progressEvent,
  t,
}: {
  activeFolder: FolderRecord
  analysisStarting: boolean
  onOpenExport: () => void
  onStartAnalysis: () => void
  progressEvent: AnalysisProgressEventLite | null
  t: ReturnType<typeof useTranslation>['t']
}) {
  // 是否正在跑：pending/processing 还有任务
  const running = progressEvent
    ? progressEvent.pending + progressEvent.processing > 0
    : false
  const hasProgress = progressEvent !== null && progressEvent.total > 0
  const ratio = hasProgress
    ? Math.min(1, progressEvent.completed / Math.max(progressEvent.total, 1))
    : 0
  const progressLabel = hasProgress
    ? `${progressEvent.completed} / ${progressEvent.total}`
    : null

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
        {hasProgress ? (
          <span
            className="folder-status"
            style={{ minWidth: 120, justifyContent: 'flex-end' }}
            aria-label="analysis-progress"
          >
            <span className="text-[11px] text-white/60">
              {running
                ? `分析中 ${progressLabel}`
                : `已分析 ${progressLabel}`}
            </span>
          </span>
        ) : null}
        <button
          className="button-primary button-compact"
          disabled={analysisStarting || running}
          onClick={onStartAnalysis}
          type="button"
        >
          <Sparkles className="h-4 w-4" />
          {running
            ? `分析中… ${Math.round(ratio * 100)}%`
            : analysisStarting
              ? '启动中…'
              : '开始分析'}
        </button>
        <button className="button-ghost button-compact" onClick={onOpenExport} type="button">
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
    <article
      className={cn(
        'photo-tile',
        focused && 'photo-tile--focused',
        (photo.analysisStatus === 'pending' || photo.analysisStatus === 'running') &&
          'photo-tile--analyzing',
      )}
    >
      <button
        className="photo-preview"
        onClick={() => onFocusPhoto(photo.id)}
        onDoubleClick={() => onOpenReview(photo.id)}
        style={{ backgroundImage: photo.previewGradient }}
        type="button"
      >
        <span className="photo-preview__top">
          {photo.analysisStatus === 'pending' || photo.analysisStatus === 'running' ? (
            <StatusPill
              label={photo.analysisStatus === 'pending' ? '等待分析' : '分析中'}
              tone="muted"
            />
          ) : (
            <StatusPill label={t(gradeLabelKey(photo.grade))} tone={gradeTone(photo.grade)} />
          )}
          {photo.isNewSpecies ? (
            <StatusPill label={t('selection.quickFilters.new_species')} tone="accent" />
          ) : null}
        </span>
        <span className="photo-preview__bottom">
          <span>
            <strong>
              {photo.speciesName ??
                (photo.analysisStatus === 'pending'
                  ? '等待分析'
                  : photo.analysisStatus === 'running'
                    ? '分析中…'
                    : photo.analysisStatus === 'failed'
                      ? '分析失败'
                      : photo.birdCount === 0
                        ? t('selection.photo.noBird')
                        : '未识别物种')}
            </strong>
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
          (() => {
            const wiki = getSpeciesWiki(activeSpecies.latinName)
            const extract = wiki?.zh_extract ?? wiki?.en_extract ?? activeSpecies.summary
            const sourceUrl = wiki?.zh_url ?? wiki?.en_url ?? null
            const imageUrl = wiki?.image_url ?? null
            return (
              <div className="archive-detail__content">
                {imageUrl ? (
                  <div
                    className="inspector-preview"
                    style={{
                      backgroundImage: `url(${imageUrl})`,
                      backgroundSize: 'cover',
                      backgroundPosition: 'center',
                    }}
                  />
                ) : (
                  <div
                    className="inspector-preview"
                    style={{ backgroundImage: activeSpecies.coverGradient }}
                  />
                )}
                <h2>{activeSpecies.name}</h2>
                <small>{activeSpecies.latinName}</small>
                <p className="archive-detail__extract">{extract}</p>
                {sourceUrl ? (
                  <a
                    className="archive-detail__source"
                    href={sourceUrl}
                    target="_blank"
                    rel="noreferrer"
                  >
                    Wikipedia →
                  </a>
                ) : null}
                <div className="stat-stack">
                  <StatRow label={t('archive.species.photoCount')} value={activeSpecies.photoCount} />
                  <StatRow label={t('archive.species.firstSeen')} value={activeSpecies.firstSeenAt.slice(0, 10)} />
                  <StatRow label={t('archive.species.lastSeen')} value={activeSpecies.lastSeenAt.slice(0, 10)} />
                  <StatRow label={t('archive.species.bestScore')} value={activeSpecies.bestScore.toFixed(2)} />
                </div>
              </div>
            )
          })()
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
  const [showBbox, setShowBbox] = useState(true)
  const [showPose, setShowPose] = useState(false)

  // 计算图片实际渲染区域（letterbox 后），用于把原图坐标系的 bbox/pose 映射到 DOM 百分比
  const imgW = photo.imageWidth ?? null
  const imgH = photo.imageHeight ?? null
  const aspect = imgW && imgH && imgW > 0 && imgH > 0 ? imgW / imgH : null

  // bbox / pose 关键点已经在原图坐标系（pixels），渲染时转成百分比
  const bbox = photo.bestBbox ?? null
  const pose = photo.bestPose ?? null

  const previewSrc = photo.thumbPreviewUrl ?? null

  // IQA 裁切框（与后端 expand_for_iqa 一致：2.5× + 比例约束 + cap + shift）
  const iqaCrop = useMemo(() => {
    if (!bbox || !imgW || !imgH) return null
    return computeIqaCropBox(imgW, imgH, bbox)
  }, [bbox, imgW, imgH])

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

          {/* 覆盖层 toggle 行 */}
          <div className="review-toggles">
            <label className="review-toggle">
              <input
                type="checkbox"
                checked={showBbox}
                onChange={(e) => setShowBbox(e.target.checked)}
              />
              <span>检测框</span>
            </label>
            <label className="review-toggle">
              <input
                type="checkbox"
                checked={showPose}
                onChange={(e) => setShowPose(e.target.checked)}
              />
              <span>姿态点</span>
            </label>
          </div>

          {/* 双图布局：左原图 (loupe) + 右 IQA 裁切 */}
          <div className="review-stage__images">
            <ReviewImageStage
              label="原图"
              hint="按住放大 · 拖动平移"
              previewSrc={previewSrc}
              fallbackGradient={photo.previewGradient}
              aspect={aspect}
              imgW={imgW}
              imgH={imgH}
              bbox={showBbox ? bbox : null}
              pose={showPose ? pose : null}
              photoId={photo.id}
              loupeEnabled
              cropRect={null}
            />
            <ReviewImageStage
              label={`IQA 裁切 · 2.5×`}
              hint={iqaCrop ? '画质评分依据' : '需先识别'}
              previewSrc={previewSrc}
              fallbackGradient={photo.previewGradient}
              aspect={aspect}
              imgW={imgW}
              imgH={imgH}
              bbox={showBbox ? bbox : null}
              pose={showPose ? pose : null}
              photoId={photo.id}
              loupeEnabled={false}
              cropRect={iqaCrop}
            />
          </div>
        </div>

        <aside className="review-detail review-detail--compact selection-scroll">
          {/* 顶部：分数 + 物种 + 分级 */}
          <ScoreHeader photo={photo} t={t} />

          {/* 关键指标紧凑网格 */}
          <div className="review-stats-grid">
            <CompactStat
              label="语义"
              value={photo.semanticScore !== null ? photo.semanticScore.toFixed(2) : '--'}
            />
            <CompactStat
              label="技术"
              value={photo.technicalScore !== null ? photo.technicalScore.toFixed(2) : '--'}
            />
            <CompactStat
              label="头"
              value={pose ? (pose.head_visible ? '✓' : '✗') : '--'}
              tone={pose ? (pose.head_visible ? 'ok' : 'warn') : 'muted'}
            />
            <CompactStat
              label="眼"
              value={pose ? (pose.eye_visible ? '✓' : '✗') : '--'}
              tone={pose ? (pose.eye_visible ? 'ok' : 'warn') : 'muted'}
            />
            <CompactStat label="鸟数" value={String(photo.birdCount ?? 0)} />
            <CompactStat
              label="置信"
              value={bbox ? `${Math.round((bbox.confidence ?? 0) * 100)}%` : '--'}
            />
          </div>

          <CompactKV label="场景" value={group?.title ?? '--'} />

          {photo.speciesCandidates.length > 0 ? (
            <div>
              <SectionLabel label={t('selection.review.species')} />
              <div className="species-candidates species-candidates--compact">
                {photo.speciesCandidates.slice(0, 5).map((candidate) => (
                  <div className="species-row" key={`${photo.id}-${candidate.name}`}>
                    <span className="species-row__name">{candidate.name}</span>
                    <span className="species-row__pct">
                      {Math.round(candidate.confidence * 100)}%
                    </span>
                  </div>
                ))}
              </div>
            </div>
          ) : null}

          <ExifPanel exif={photo.exif} />

          <p className="review-reason">{t(photoReviewReason(photo))}</p>
          <TagCluster photo={photo} t={t} />

          <div className="inspector-actions inspector-actions--compact">
            <button
              className="button-primary"
              onClick={() => onSetDecision(photo.id, 'selected')}
              type="button"
            >
              <Check className="h-4 w-4" />
              {t('selection.actions.select')}
            </button>
            <button
              className="button-ghost"
              onClick={() => onSetDecision(photo.id, 'maybe')}
              type="button"
            >
              <Clock3 className="h-4 w-4" />
              {t('selection.actions.maybe')}
            </button>
            <button
              className="button-danger"
              onClick={() => onSetDecision(photo.id, 'rejected')}
              type="button"
            >
              <X className="h-4 w-4" />
              {t('selection.actions.reject')}
            </button>
            <button
              className="button-ghost"
              onClick={() => onAddToCompare(photo.id)}
              type="button"
            >
              <Waypoints className="h-4 w-4" />
              {t('selection.actions.compare')}
            </button>
          </div>
        </aside>
      </div>
    </div>
  )
}

/**
 * 单独的图片舞台组件：
 * - cropRect 为 null → 显示完整原图（支持 loupe 按住放大）
 * - cropRect 给定 → 用 background-position/size 缩放出该区域（IQA 裁切预览，不做 loupe）
 *
 * Loupe 交互：
 *   mousedown 切到放大模式 → 跟随鼠标平移
 *   mouseup / mouseleave 还原
 *   放大倍数 = 2.5×（与 IQA expand 一致，方便对比）
 */
function ReviewImageStage({
  label,
  hint,
  previewSrc,
  fallbackGradient,
  aspect,
  imgW,
  imgH,
  bbox,
  pose,
  photoId,
  loupeEnabled,
  cropRect,
}: {
  label: string
  hint: string
  previewSrc: string | null
  fallbackGradient: string
  aspect: number | null
  imgW: number | null
  imgH: number | null
  bbox: { x1: number; y1: number; x2: number; y2: number } | null
  pose: PhotoRecord['bestPose']
  photoId: string
  loupeEnabled: boolean
  cropRect: { x1: number; y1: number; x2: number; y2: number } | null
}) {
  const containerRef = useRef<HTMLDivElement | null>(null)
  const [loupeActive, setLoupeActive] = useState(false)
  const [loupePos, setLoupePos] = useState<{ xPct: number; yPct: number }>({
    xPct: 50,
    yPct: 50,
  })
  const LOUPE_SCALE = 2.5

  const handlePointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!loupeEnabled || !previewSrc) return
    e.preventDefault()
    const rect = e.currentTarget.getBoundingClientRect()
    const xPct = ((e.clientX - rect.left) / rect.width) * 100
    const yPct = ((e.clientY - rect.top) / rect.height) * 100
    setLoupePos({ xPct, yPct })
    setLoupeActive(true)
    e.currentTarget.setPointerCapture(e.pointerId)
  }
  const handlePointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!loupeActive) return
    const rect = e.currentTarget.getBoundingClientRect()
    const xPct = ((e.clientX - rect.left) / rect.width) * 100
    const yPct = ((e.clientY - rect.top) / rect.height) * 100
    setLoupePos({
      xPct: Math.max(0, Math.min(100, xPct)),
      yPct: Math.max(0, Math.min(100, yPct)),
    })
  }
  const handlePointerEnd = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!loupeActive) return
    setLoupeActive(false)
    if (e.currentTarget.hasPointerCapture(e.pointerId)) {
      e.currentTarget.releasePointerCapture(e.pointerId)
    }
  }

  // 算 background：cropRect 给定就放大显示该区域；否则按 contain（普通预览）或 loupe
  const cropStyle = useMemo<React.CSSProperties>(() => {
    if (!previewSrc) return {}
    if (cropRect && imgW && imgH) {
      // 显示 cropRect 内容：把原图缩放，使 cropRect 充满容器
      const cw = cropRect.x2 - cropRect.x1
      const ch = cropRect.y2 - cropRect.y1
      if (cw <= 0 || ch <= 0) return {}
      const sizeX = (imgW / cw) * 100
      const sizeY = (imgH / ch) * 100
      // background-position 百分比：(crop 中心 / (原图 - crop)) * 100
      const posX = imgW > cw ? ((cropRect.x1 + cw / 2 - cw / 2) / (imgW - cw)) * 100 : 50
      const posY = imgH > ch ? ((cropRect.y1 + ch / 2 - ch / 2) / (imgH - ch)) * 100 : 50
      return {
        backgroundImage: `url("${previewSrc}")`,
        backgroundPosition: `${posX}% ${posY}%`,
        backgroundSize: `${sizeX}% ${sizeY}%`,
        backgroundRepeat: 'no-repeat',
      }
    }
    if (loupeActive) {
      return {
        backgroundImage: `url("${previewSrc}")`,
        backgroundPosition: `${loupePos.xPct}% ${loupePos.yPct}%`,
        backgroundSize: `${LOUPE_SCALE * 100}% ${LOUPE_SCALE * 100}%`,
        backgroundRepeat: 'no-repeat',
      }
    }
    return {
      backgroundImage: `url("${previewSrc}")`,
      backgroundPosition: 'center',
      backgroundSize: 'cover',
      backgroundRepeat: 'no-repeat',
    }
  }, [previewSrc, cropRect, imgW, imgH, loupeActive, loupePos.xPct, loupePos.yPct])

  // 计算覆盖层在该 stage 上的相对百分比
  // - 完整图模式：直接 bbox/pose / 原图尺寸
  // - 裁切模式：先转换到 cropRect 局部坐标，再 / cropRect 尺寸
  const renderOverlays = (): ReactNode => {
    if (!imgW || !imgH) return null
    const toLocalRect = (
      x1: number,
      y1: number,
      x2: number,
      y2: number,
    ): { left: number; top: number; width: number; height: number } | null => {
      if (cropRect) {
        const cw = cropRect.x2 - cropRect.x1
        const ch = cropRect.y2 - cropRect.y1
        if (cw <= 0 || ch <= 0) return null
        const left = ((x1 - cropRect.x1) / cw) * 100
        const top = ((y1 - cropRect.y1) / ch) * 100
        const width = ((x2 - x1) / cw) * 100
        const height = ((y2 - y1) / ch) * 100
        // crop 之外的覆盖层不画
        if (left + width < 0 || left > 100 || top + height < 0 || top > 100) return null
        return { left, top, width, height }
      }
      return {
        left: (x1 / imgW) * 100,
        top: (y1 / imgH) * 100,
        width: ((x2 - x1) / imgW) * 100,
        height: ((y2 - y1) / imgH) * 100,
      }
    }
    const toLocalPoint = (
      x: number,
      y: number,
    ): { left: number; top: number } | null => {
      if (cropRect) {
        const cw = cropRect.x2 - cropRect.x1
        const ch = cropRect.y2 - cropRect.y1
        if (cw <= 0 || ch <= 0) return null
        const left = ((x - cropRect.x1) / cw) * 100
        const top = ((y - cropRect.y1) / ch) * 100
        if (left < -2 || left > 102 || top < -2 || top > 102) return null
        return { left, top }
      }
      return { left: (x / imgW) * 100, top: (y / imgH) * 100 }
    }

    const overlays: ReactNode[] = []
    // bbox（黄色高亮，IQA 裁切图上更显眼）
    if (bbox) {
      const r = toLocalRect(bbox.x1, bbox.y1, bbox.x2, bbox.y2)
      if (r) {
        overlays.push(
          <span
            className={cn(
              'detect-box',
              cropRect && 'detect-box--accent',
            )}
            key="bbox"
            style={{
              left: `${r.left}%`,
              top: `${r.top}%`,
              width: `${r.width}%`,
              height: `${r.height}%`,
            }}
          />,
        )
      }
    }
    // pose 关键点
    if (pose) {
      const keys = ['bill', 'crown', 'nape', 'left_eye', 'right_eye'] as const
      for (const key of keys) {
        const kp = pose[key]
        if (kp.confidence < 0.05) continue
        const p = toLocalPoint(kp.x, kp.y)
        if (!p) continue
        overlays.push(
          <span
            className={cn(
              'pose-point',
              (key === 'left_eye' || key === 'right_eye') && 'pose-point--eye',
            )}
            key={`pose-${key}`}
            style={{ left: `${p.left}%`, top: `${p.top}%` }}
            title={`${key}  ${(kp.confidence * 100).toFixed(0)}%`}
          />,
        )
      }
    }
    return overlays
  }

  // 容器的 aspect-ratio：原图模式用原图比例；裁切模式用裁切框比例（避免黑边）
  const stageAspect = useMemo<string | undefined>(() => {
    if (cropRect) {
      const cw = cropRect.x2 - cropRect.x1
      const ch = cropRect.y2 - cropRect.y1
      if (cw > 0 && ch > 0) return `${cw} / ${ch}`
    }
    if (aspect && imgW && imgH) return `${imgW} / ${imgH}`
    return '4 / 3'
  }, [cropRect, aspect, imgW, imgH])

  return (
    <div className="review-stage__pane">
      <div className="review-stage__head">
        <span className="review-stage__label">{label}</span>
        <span className="review-stage__hint">{hint}</span>
      </div>
      <div
        ref={containerRef}
        className={cn(
          'review-image',
          loupeEnabled && previewSrc && 'review-image--loupe',
          loupeActive && 'review-image--loupe-active',
        )}
        style={{
          ...cropStyle,
          aspectRatio: stageAspect,
          ...(previewSrc ? {} : { backgroundImage: fallbackGradient }),
        }}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerEnd}
        onPointerCancel={handlePointerEnd}
        onLostPointerCapture={() => setLoupeActive(false)}
        data-photo-id={photoId}
      >
        {!loupeActive ? renderOverlays() : null}
      </div>
    </div>
  )
}

/** 顶部：大字号分数 + 分级胶囊 + 物种名（颜色按 grade 区分） */
function ScoreHeader({
  photo,
  t,
}: {
  photo: PhotoRecord
  t: ReturnType<typeof useTranslation>['t']
}) {
  void t
  const score = photo.finalScore
  return (
    <div className={cn('score-header', `score-header--${photo.grade}`)}>
      <div className="score-header__score">
        <strong>{score !== null ? score.toFixed(2) : '--'}</strong>
        <span className={cn('grade-pill', `grade-pill--${photo.grade}`)}>
          {gradeLabel(photo.grade)}
        </span>
      </div>
      <div className="score-header__species">
        {photo.speciesName ?? '未识别物种'}
        {photo.speciesLatinName ? (
          <em>{photo.speciesLatinName}</em>
        ) : null}
      </div>
    </div>
  )
}

function gradeLabel(g: PhotoGrade): string {
  switch (g) {
    case 'select':
      return '精选'
    case 'usable':
      return '可用'
    case 'record':
      return '记录'
    case 'reject':
      return '淘汰'
  }
}

/** 紧凑指标格：1 行 label + value，颜色 tone */
function CompactStat({
  label,
  value,
  tone,
}: {
  label: string
  value: string
  tone?: 'ok' | 'warn' | 'muted'
}) {
  return (
    <div className={cn('compact-stat', tone && `compact-stat--${tone}`)}>
      <span className="compact-stat__label">{label}</span>
      <span className="compact-stat__value">{value}</span>
    </div>
  )
}

/** 紧凑 key-value：单行，标签灰、值白 */
function CompactKV({ label, value }: { label: string; value: string }) {
  return (
    <div className="compact-kv">
      <span className="compact-kv__label">{label}</span>
      <span className="compact-kv__value">{value}</span>
    </div>
  )
}

/** EXIF 信息面板（相机 / 镜头 / 曝光参数） */
function ExifPanel({
  exif,
}: {
  exif?: Record<string, string | number | null> | null
}) {
  if (!exif) return null

  // 格式化辅助
  const fmt = (key: string): string => {
    const v = exif[key]
    if (v === null || v === undefined || v === '') return '--'
    return String(v)
  }
  const fmtShutter = (): string => {
    const t = exif['ExposureTime']
    if (typeof t !== 'number' || t <= 0) return '--'
    if (t >= 1) return `${t.toFixed(1)} s`
    return `1/${Math.round(1 / t)} s`
  }
  const fmtAperture = (): string => {
    const f = exif['FNumber']
    if (typeof f !== 'number' || f <= 0) return '--'
    return `f/${f.toFixed(1)}`
  }
  const fmtFocal = (): string => {
    const f = exif['FocalLength']
    if (typeof f !== 'number' || f <= 0) return '--'
    return `${Math.round(f)} mm`
  }
  const fmtIso = (): string => {
    const v = exif['ISOSpeedRatings']
    if (v === null || v === undefined) return '--'
    if (typeof v === 'number') return `ISO ${v}`
    return `ISO ${v}`
  }

  const camera = `${fmt('Make')} ${fmt('Model')}`.trim() || '--'
  const lens = fmt('LensModel')
  const dt = fmt('DateTimeOriginal') !== '--' ? fmt('DateTimeOriginal') : fmt('DateTime')

  return (
    <div className="exif-panel">
      <SectionLabel label="EXIF" />
      {/* 曝光参数：4 列横排，重点突出 */}
      <div className="exif-exposure">
        <div className="exif-exposure__cell">
          <span className="exif-exposure__label">快门</span>
          <span className="exif-exposure__value">{fmtShutter()}</span>
        </div>
        <div className="exif-exposure__cell">
          <span className="exif-exposure__label">光圈</span>
          <span className="exif-exposure__value">{fmtAperture()}</span>
        </div>
        <div className="exif-exposure__cell">
          <span className="exif-exposure__label">ISO</span>
          <span className="exif-exposure__value">{fmtIso()}</span>
        </div>
        <div className="exif-exposure__cell">
          <span className="exif-exposure__label">焦距</span>
          <span className="exif-exposure__value">{fmtFocal()}</span>
        </div>
      </div>
      {/* 机身/镜头/时间：紧凑单行 */}
      <div className="exif-meta">
        <CompactKV label="机身" value={camera} />
        <CompactKV label="镜头" value={lens} />
        <CompactKV label="时间" value={dt} />
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

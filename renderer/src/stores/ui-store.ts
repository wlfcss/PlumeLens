import { create } from 'zustand'

import type { AppRoute, ArchiveTab, PhotoGrade } from '@/lib/mock-workspace'

export { useShallow } from 'zustand/react/shallow'

export type ViewMode = 'grouped' | 'flat'
// QuickFilter = 4 个质量档位 + "无鸟" + "失败" 独立筛选维度。"无鸟" / "失败" 都
// 不是档位,与档位正交;显式从 PhotoGrade 派生避免未来漂移。
// "失败"是分析永久失败(broken_image / 解码错等)的照片,默认不放进 active filters,
// 选片屏不展示;用户主动 toggle 才查看。
export type QuickFilter = PhotoGrade | 'no_bird' | 'failed'

interface UIState {
  route: AppRoute
  archiveTab: ArchiveTab
  activeFolderId: string | null
  activeSpeciesId: string | null
  activeQuickFilters: QuickFilter[]
  onlyFlying: boolean
  activeSort: 'score' | 'shot_at' | 'name'
  viewMode: ViewMode
  searchQuery: string
  focusedPhotoId: string | null
  reviewPhotoId: string | null
  inspectorOpen: boolean
  settingsOpen: boolean
  reportExpanded: boolean
  setRoute: (route: AppRoute) => void
  setArchiveTab: (tab: ArchiveTab) => void
  setActiveFolderId: (folderId: string | null) => void
  setActiveSpeciesId: (speciesId: string | null) => void
  setActiveQuickFilter: (filter: QuickFilter) => void
  setActiveQuickFilters: (filters: QuickFilter[]) => void
  setOnlyFlying: (enabled: boolean) => void
  setActiveSort: (sort: UIState['activeSort']) => void
  setViewMode: (mode: ViewMode) => void
  setSearchQuery: (value: string) => void
  setFocusedPhotoId: (photoId: string | null) => void
  setReviewPhotoId: (photoId: string | null) => void
  setInspectorOpen: (open: boolean) => void
  setSettingsOpen: (open: boolean) => void
  toggleReportExpanded: () => void
}

export const useUIStore = create<UIState>()((set) => ({
  route: 'start',
  archiveTab: 'species',
  activeFolderId: null,
  activeSpeciesId: null,
  activeQuickFilters: ['select', 'usable', 'record'],
  onlyFlying: false,
  activeSort: 'score',
  viewMode: 'grouped',
  searchQuery: '',
  focusedPhotoId: null,
  reviewPhotoId: null,
  inspectorOpen: true,
  settingsOpen: false,
  reportExpanded: false,
  setRoute: (route) => set({ route }),
  setArchiveTab: (archiveTab) => set({ archiveTab }),
  setActiveFolderId: (activeFolderId) =>
    set({
      activeFolderId,
      focusedPhotoId: null,
      reviewPhotoId: null,
    }),
  setActiveSpeciesId: (activeSpeciesId) => set({ activeSpeciesId }),
  setActiveQuickFilter: (filter) =>
    set((state) => {
      const active = state.activeQuickFilters.includes(filter)
        ? state.activeQuickFilters.filter((item) => item !== filter)
        : [...state.activeQuickFilters, filter]
      return { activeQuickFilters: active }
    }),
  setActiveQuickFilters: (activeQuickFilters) => set({ activeQuickFilters }),
  setOnlyFlying: (onlyFlying) => set({ onlyFlying }),
  setActiveSort: (activeSort) => set({ activeSort }),
  setViewMode: (viewMode) => set({ viewMode }),
  setSearchQuery: (searchQuery) => set({ searchQuery }),
  setFocusedPhotoId: (focusedPhotoId) => set({ focusedPhotoId }),
  setReviewPhotoId: (reviewPhotoId) => set({ reviewPhotoId }),
  setInspectorOpen: (inspectorOpen) => set({ inspectorOpen }),
  setSettingsOpen: (settingsOpen) => set({ settingsOpen }),
  toggleReportExpanded: () => set((state) => ({ reportExpanded: !state.reportExpanded })),
}))

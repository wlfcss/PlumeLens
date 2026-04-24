import { create } from 'zustand'

import type { AppRoute, ArchiveTab } from '@/lib/mock-workspace'

export { useShallow } from 'zustand/react/shallow'

export type ViewMode = 'grouped' | 'flat' | 'selected_only'
export type QuickFilter =
  | 'all'
  | 'unreviewed'
  | 'selected'
  | 'maybe'
  | 'rejected'
  | 'select'
  | 'new_species'
  | 'bird'
  | 'no_bird'

interface UIState {
  route: AppRoute
  archiveTab: ArchiveTab
  activeFolderId: string | null
  activeSpeciesId: string | null
  activeQuickFilter: QuickFilter
  activeSort: 'score' | 'shot_at' | 'recent' | 'name'
  viewMode: ViewMode
  searchQuery: string
  focusedPhotoId: string | null
  comparePhotoIds: string[]
  reviewPhotoId: string | null
  inspectorOpen: boolean
  compareOpen: boolean
  exportOpen: boolean
  reportExpanded: boolean
  setRoute: (route: AppRoute) => void
  setArchiveTab: (tab: ArchiveTab) => void
  setActiveFolderId: (folderId: string | null) => void
  setActiveSpeciesId: (speciesId: string | null) => void
  setActiveQuickFilter: (filter: QuickFilter) => void
  setActiveSort: (sort: UIState['activeSort']) => void
  setViewMode: (mode: ViewMode) => void
  setSearchQuery: (value: string) => void
  setFocusedPhotoId: (photoId: string | null) => void
  setReviewPhotoId: (photoId: string | null) => void
  setInspectorOpen: (open: boolean) => void
  setCompareOpen: (open: boolean) => void
  setExportOpen: (open: boolean) => void
  toggleReportExpanded: () => void
  toggleComparePhotoId: (photoId: string) => void
  clearCompare: () => void
}

export const useUIStore = create<UIState>()((set) => ({
  route: 'start',
  archiveTab: 'photos',
  activeFolderId: 'folder-chongming-dawn',
  activeSpeciesId: 'species-whiskered-tern',
  activeQuickFilter: 'all',
  activeSort: 'score',
  viewMode: 'grouped',
  searchQuery: '',
  focusedPhotoId: null,
  comparePhotoIds: [],
  reviewPhotoId: null,
  inspectorOpen: true,
  compareOpen: false,
  exportOpen: false,
  reportExpanded: false,
  setRoute: (route) => set({ route }),
  setArchiveTab: (archiveTab) => set({ archiveTab }),
  setActiveFolderId: (activeFolderId) =>
    set({
      activeFolderId,
      focusedPhotoId: null,
      reviewPhotoId: null,
      comparePhotoIds: [],
      compareOpen: false,
    }),
  setActiveSpeciesId: (activeSpeciesId) => set({ activeSpeciesId }),
  setActiveQuickFilter: (activeQuickFilter) => set({ activeQuickFilter }),
  setActiveSort: (activeSort) => set({ activeSort }),
  setViewMode: (viewMode) => set({ viewMode }),
  setSearchQuery: (searchQuery) => set({ searchQuery }),
  setFocusedPhotoId: (focusedPhotoId) => set({ focusedPhotoId }),
  setReviewPhotoId: (reviewPhotoId) => set({ reviewPhotoId }),
  setInspectorOpen: (inspectorOpen) => set({ inspectorOpen }),
  setCompareOpen: (compareOpen) => set({ compareOpen }),
  setExportOpen: (exportOpen) => set({ exportOpen }),
  toggleReportExpanded: () => set((state) => ({ reportExpanded: !state.reportExpanded })),
  toggleComparePhotoId: (photoId) =>
    set((state) => ({
      comparePhotoIds: state.comparePhotoIds.includes(photoId)
        ? state.comparePhotoIds.filter((id) => id !== photoId)
        : [...state.comparePhotoIds, photoId].slice(-4),
    })),
  clearCompare: () => set({ comparePhotoIds: [], compareOpen: false }),
}))

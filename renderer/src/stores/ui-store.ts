import { create } from 'zustand'

// Re-export useShallow — all object-returning selectors MUST use this (Zustand v5 requirement)
export { useShallow } from 'zustand/react/shallow'

interface UIState {
  sidebarOpen: boolean
  toggleSidebar: () => void
}

export const useUIStore = create<UIState>()((set) => ({
  sidebarOpen: true,
  toggleSidebar: () => set((s) => ({ sidebarOpen: !s.sidebarOpen })),
}))

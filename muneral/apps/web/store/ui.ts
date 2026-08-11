import { create } from 'zustand';
import { persist } from 'zustand/middleware';

export type ActiveView = 'kanban' | 'backlog' | 'list';

export interface UiState {
  sidebarCollapsed: boolean;
  activeView: ActiveView;
  setSidebarCollapsed: (collapsed: boolean) => void;
  toggleSidebar: () => void;
  setActiveView: (view: ActiveView) => void;
}

export const useUiStore = create<UiState>()(
  persist(
    (set) => ({
      sidebarCollapsed: false,
      activeView: 'kanban' as ActiveView,

      setSidebarCollapsed: (collapsed) => set({ sidebarCollapsed: collapsed }),

      toggleSidebar: () =>
        set((state) => ({ sidebarCollapsed: !state.sidebarCollapsed })),

      setActiveView: (view) => set({ activeView: view }),
    }),
    {
      name: 'muneral-ui',
    },
  ),
);

import { create } from 'zustand';
import { persist } from 'zustand/middleware';

export interface WorkspaceState {
  currentSlug: string | null;
  workspaceList: Array<{ id: string; slug: string; name: string }>;
  setCurrentSlug: (slug: string | null) => void;
  setWorkspaceList: (list: Array<{ id: string; slug: string; name: string }>) => void;
  clearWorkspace: () => void;
}

export const useWorkspaceStore = create<WorkspaceState>()(
  persist(
    (set) => ({
      currentSlug: null,
      workspaceList: [],

      setCurrentSlug: (slug) => set({ currentSlug: slug }),

      setWorkspaceList: (list) => set({ workspaceList: list }),

      clearWorkspace: () =>
        set({
          currentSlug: null,
          workspaceList: [],
        }),
    }),
    {
      name: 'muneral-workspace',
      partialize: (state) => ({
        currentSlug: state.currentSlug,
      }),
    },
  ),
);

import { create } from 'zustand';

export interface SprintContext {
  id: string;
  name: string;
  startDate: string;
  endDate: string;
}

export interface ProjectState {
  currentProjectSlug: string | null;
  currentProjectId: string | null;
  activeSprint: SprintContext | null;
  setCurrentProject: (slug: string | null, id: string | null) => void;
  setActiveSprint: (sprint: SprintContext | null) => void;
  clearProject: () => void;
}

export const useProjectStore = create<ProjectState>()((set) => ({
  currentProjectSlug: null,
  currentProjectId: null,
  activeSprint: null,

  setCurrentProject: (slug, id) =>
    set({ currentProjectSlug: slug, currentProjectId: id }),

  setActiveSprint: (sprint) => set({ activeSprint: sprint }),

  clearProject: () =>
    set({
      currentProjectSlug: null,
      currentProjectId: null,
      activeSprint: null,
    }),
}));

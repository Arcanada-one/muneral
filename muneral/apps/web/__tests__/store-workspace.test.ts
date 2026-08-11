import { describe, it, expect, beforeEach } from 'vitest';
import { useWorkspaceStore } from '@/store/workspace';

describe('useWorkspaceStore', () => {
  beforeEach(() => {
    // Reset store to initial state before each test
    useWorkspaceStore.setState({
      currentSlug: null,
      workspaceList: [],
    });
  });

  it('initializes with null currentSlug', () => {
    const { currentSlug } = useWorkspaceStore.getState();
    expect(currentSlug).toBeNull();
  });

  it('initializes with empty workspaceList', () => {
    const { workspaceList } = useWorkspaceStore.getState();
    expect(workspaceList).toEqual([]);
  });

  it('setCurrentSlug updates currentSlug', () => {
    useWorkspaceStore.getState().setCurrentSlug('my-workspace');
    expect(useWorkspaceStore.getState().currentSlug).toBe('my-workspace');
  });

  it('setCurrentSlug accepts null to deselect', () => {
    useWorkspaceStore.getState().setCurrentSlug('ws-1');
    useWorkspaceStore.getState().setCurrentSlug(null);
    expect(useWorkspaceStore.getState().currentSlug).toBeNull();
  });

  it('setWorkspaceList updates the list', () => {
    const list = [
      { id: '1', slug: 'ws-1', name: 'Workspace 1' },
      { id: '2', slug: 'ws-2', name: 'Workspace 2' },
    ];
    useWorkspaceStore.getState().setWorkspaceList(list);
    expect(useWorkspaceStore.getState().workspaceList).toEqual(list);
  });

  it('clearWorkspace resets currentSlug to null', () => {
    useWorkspaceStore.getState().setCurrentSlug('ws-1');
    useWorkspaceStore.getState().clearWorkspace();
    expect(useWorkspaceStore.getState().currentSlug).toBeNull();
  });

  it('clearWorkspace resets workspaceList to empty', () => {
    useWorkspaceStore.getState().setWorkspaceList([
      { id: '1', slug: 'ws-1', name: 'WS1' },
    ]);
    useWorkspaceStore.getState().clearWorkspace();
    expect(useWorkspaceStore.getState().workspaceList).toEqual([]);
  });
});

// Project store tests
import { useProjectStore } from '@/store/project';

describe('useProjectStore', () => {
  beforeEach(() => {
    useProjectStore.setState({
      currentProjectSlug: null,
      currentProjectId: null,
      activeSprint: null,
    });
  });

  it('initializes with null values', () => {
    const state = useProjectStore.getState();
    expect(state.currentProjectSlug).toBeNull();
    expect(state.currentProjectId).toBeNull();
    expect(state.activeSprint).toBeNull();
  });

  it('setCurrentProject updates slug and id', () => {
    useProjectStore.getState().setCurrentProject('my-project', 'proj-uuid');
    const { currentProjectSlug, currentProjectId } = useProjectStore.getState();
    expect(currentProjectSlug).toBe('my-project');
    expect(currentProjectId).toBe('proj-uuid');
  });

  it('setActiveSprint stores sprint context', () => {
    const sprint = {
      id: 'sprint-1',
      name: 'Sprint 1',
      startDate: '2026-01-01',
      endDate: '2026-01-14',
    };
    useProjectStore.getState().setActiveSprint(sprint);
    expect(useProjectStore.getState().activeSprint).toEqual(sprint);
  });

  it('clearProject resets all fields', () => {
    useProjectStore.getState().setCurrentProject('slug', 'id');
    useProjectStore.getState().clearProject();
    const state = useProjectStore.getState();
    expect(state.currentProjectSlug).toBeNull();
    expect(state.currentProjectId).toBeNull();
    expect(state.activeSprint).toBeNull();
  });
});

// UI store tests
import { useUiStore } from '@/store/ui';

describe('useUiStore', () => {
  beforeEach(() => {
    useUiStore.setState({
      sidebarCollapsed: false,
      activeView: 'kanban',
    });
  });

  it('initializes with sidebar expanded', () => {
    expect(useUiStore.getState().sidebarCollapsed).toBe(false);
  });

  it('toggleSidebar collapses expanded sidebar', () => {
    useUiStore.getState().toggleSidebar();
    expect(useUiStore.getState().sidebarCollapsed).toBe(true);
  });

  it('toggleSidebar expands collapsed sidebar', () => {
    useUiStore.getState().setSidebarCollapsed(true);
    useUiStore.getState().toggleSidebar();
    expect(useUiStore.getState().sidebarCollapsed).toBe(false);
  });

  it('setActiveView updates the active view', () => {
    useUiStore.getState().setActiveView('backlog');
    expect(useUiStore.getState().activeView).toBe('backlog');
  });

  it('setActiveView accepts list view', () => {
    useUiStore.getState().setActiveView('list');
    expect(useUiStore.getState().activeView).toBe('list');
  });
});

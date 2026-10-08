import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import DashboardPage from '@/app/(app)/workspaces/[wsSlug]/dashboard/page';
import { AgentActivityFeed } from '@/components/dashboard/AgentActivityFeed';

const state = vi.hoisted(() => ({
  query: { data: undefined as unknown, isLoading: false, isError: false },
  velocity: [] as unknown[],
}));
vi.mock('next/navigation', () => ({ useParams: () => ({ wsSlug: 'synthetic-workspace' }) }));
vi.mock('@/store/project', () => ({
  useProjectStore: () => ({ currentProjectId: null, currentProjectSlug: null }),
}));
vi.mock('@/lib/api/agents', () => ({ useAgentActivity: () => state.query }));
vi.mock('@/components/dashboard/BlockersList', () => ({ BlockersList: () => null }));
vi.mock('recharts', () => ({
  ResponsiveContainer: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  BarChart: ({ data }: { data: unknown[] }) => {
    state.velocity = data;
    return <div data-testid="synthetic-chart" />;
  },
  Bar: () => null, XAxis: () => null, YAxis: () => null,
  CartesianGrid: () => null, Tooltip: () => null, Legend: () => null,
}));
beforeEach(() => {
  state.query = { data: undefined, isLoading: false, isError: false };
  state.velocity = [];
});
afterEach(cleanup);

describe('MUN-0006 dashboard read states', () => {
  it('does not display unmeasured demo sprint values as project velocity', () => {
    render(<DashboardPage />);
    expect(state.velocity).toEqual([]);
    expect(screen.getByText('No sprint data available')).toBeInTheDocument();
  });
  it('reports unavailable activity on a failed read rather than empty success', () => {
    state.query.isError = true;
    render(<AgentActivityFeed wsSlug="synthetic-workspace" />);
    expect(screen.getByRole('alert')).toHaveTextContent('Agent activity is unavailable');
    expect(screen.queryByText('No agent activity yet')).not.toBeInTheDocument();
  });
  it('suppresses cached activity after a failed refresh', () => {
    state.query = { isLoading: false, isError: true, data: [{
      id: 'synthetic-event', agentName: 'Synthetic cached agent',
      action: 'task:created', taskTitle: 'Synthetic cached task',
      createdAt: '2026-10-08T00:00:00Z',
    }] };
    render(<AgentActivityFeed wsSlug="synthetic-workspace" />);
    expect(screen.queryByText('Synthetic cached agent')).not.toBeInTheDocument();
    expect(screen.getByRole('alert')).toHaveTextContent('Agent activity is unavailable');
  });
  it('preserves a successful empty activity response', () => {
    state.query.data = [];
    render(<AgentActivityFeed wsSlug="synthetic-workspace" />);
    expect(screen.getByText('No agent activity yet')).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });
  it('preserves a successful populated activity response', () => {
    state.query.data = [{ id: 'synthetic-event', agentName: 'Synthetic agent',
      action: 'task:created', taskTitle: 'Synthetic task', createdAt: new Date().toISOString() }];
    render(<AgentActivityFeed wsSlug="synthetic-workspace" />);
    expect(screen.getByText('Synthetic agent')).toBeInTheDocument();
    expect(screen.getByText(/Synthetic task/)).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });
  it('preserves the loading state', () => {
    state.query.isLoading = true;
    render(<AgentActivityFeed wsSlug="synthetic-workspace" />);
    expect(screen.getByText('Loading...')).toBeInTheDocument();
    expect(screen.queryByText('No agent activity yet')).not.toBeInTheDocument();
  });
  it('prioritizes a failed read over loading', () => {
    state.query.isLoading = true;
    state.query.isError = true;
    render(<AgentActivityFeed wsSlug="synthetic-workspace" />);
    expect(screen.getByRole('alert')).toHaveTextContent('Agent activity is unavailable');
    expect(screen.queryByText('Loading...')).not.toBeInTheDocument();
  });

});

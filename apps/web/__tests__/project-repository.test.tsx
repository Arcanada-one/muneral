import { describe, expect, it, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { ProjectRepository } from '@/components/project/ProjectRepository';
afterEach(cleanup);
import { readProjects } from '@/lib/api/read-contract';
const project = {id:'10000000-0000-4000-8000-000000000001',workspaceId:'10000000-0000-4000-8000-000000000002',slug:'synthetic',name:'Synthetic project',createdAt:'2026-10-08T00:00:00.000Z'};
describe('native repository read fidelity', () => {
  it('preserves the exact persisted repository URL', () => {
    const repoUrl = 'https://github.com/Arcanada-one/muneral';
    expect(readProjects([{...project,repoUrl}])[0]).toHaveProperty('repoUrl',repoUrl);
  });
  it('preserves explicit absence separately from omitted legacy field', () => {
    expect(readProjects([{...project,repoUrl:null}])[0]).toHaveProperty('repoUrl',null);
    expect(readProjects([project])[0]).not.toHaveProperty('repoUrl');
  });
});

describe('operator repository link', () => {
  it.each(['https://github.com/Arcanada-one/muneral','https://gitlab.com/synthetic/project.git'])('shows the exact safe HTTPS href %s', repoUrl => {
    const [read] = readProjects([{...project,repoUrl}]);
    render(<ProjectRepository repoUrl={read.repoUrl} />);
    const link=screen.getByRole('link',{name:'Open repository'});
    expect(link).toHaveAttribute('href',repoUrl);
    expect(link).toHaveAttribute('rel','noopener noreferrer');
  });
  it.each([undefined,null,''])('reports no linked repository for %s', repoUrl => {
    render(<ProjectRepository repoUrl={repoUrl} />);
    expect(screen.getByText('No repository linked')).toBeVisible();
    expect(screen.queryByRole('link')).toBeNull();
  });
  it.each(['javascript:alert(1)','http://example.invalid/repo','//example.invalid/repo','https:example.invalid/repo','https:/example.invalid/repo','https://user:pass@example.invalid/repo','https://example.invalid/repo?token=synthetic','https://example.invalid/repo#synthetic','https://example.invalid/\\repo','https://example.invalid/ repo'])('refuses an unsafe URL without reflecting its value %s', repoUrl => {
    render(<ProjectRepository repoUrl={repoUrl} />);
    expect(screen.getByRole('alert')).toHaveTextContent('Repository link unavailable');
    expect(screen.queryByRole('link')).toBeNull();
    expect(document.body).not.toHaveTextContent(repoUrl);
  });
});

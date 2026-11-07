import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { ProjectRepository } from './ProjectRepository';

afterEach(cleanup);

describe('repository destination disclosure', () => {
  it('shows the full accepted host and path while preserving the exact safe link', () => {
    const repoUrl = 'https://GitHub.com:8443/Arcanada-one/muneral';
    render(<ProjectRepository repoUrl={repoUrl} />);

    const destination = screen.getByText('github.com:8443/Arcanada-one/muneral');
    expect(destination).toBeVisible();
    expect(destination).toHaveClass('break-words');
    expect(destination).toHaveStyle({ overflowWrap: 'anywhere' });
    expect(screen.getByRole('link', { name: 'Open repository' })).toHaveAttribute('href', repoUrl);
    expect(screen.getByRole('link', { name: 'Open repository' })).toHaveAttribute('target', '_blank');
    expect(screen.getByRole('link', { name: 'Open repository' })).toHaveAttribute('rel', 'noopener noreferrer');
  });

  it('renders encoded HTML-looking path text without creating elements', () => {
    const repoUrl = 'https://example.test/org/%3Cimg%20src%3Dx%20onerror%3Dalert(1)%3E';
    render(<ProjectRepository repoUrl={repoUrl} />);

    expect(screen.getByText('example.test/org/%3Cimg%20src%3Dx%20onerror%3Dalert(1)%3E')).toBeVisible();
    expect(document.querySelector('img')).toBeNull();
  });

  it.each([
    'javascript:alert(1)',
    'http://example.test/repo',
    'https://user:pass@example.test/repo',
    'https://example.test/repo?token=synthetic',
    'https://example.test/repo#private',
  ])('does not disclose or link a rejected URL (%s)', (repoUrl) => {
    render(<ProjectRepository repoUrl={repoUrl} />);

    expect(screen.getByRole('alert')).toHaveTextContent('Repository link unavailable');
    expect(screen.queryByRole('link')).toBeNull();
    expect(document.body).not.toHaveTextContent(repoUrl);
  });

  it.each([undefined, null, ''])('keeps the missing-URL state (%s)', (repoUrl) => {
    render(<ProjectRepository repoUrl={repoUrl} />);

    expect(screen.getByText('No repository linked')).toBeVisible();
    expect(screen.queryByRole('link')).toBeNull();
  });

  it('replaces the destination immediately when the prop changes', () => {
    const { rerender } = render(<ProjectRepository repoUrl="https://first.test/old" />);
    expect(screen.getByText('first.test/old')).toBeVisible();

    rerender(<ProjectRepository repoUrl="https://second.test/new/path" />);
    expect(screen.getByText('second.test/new/path')).toBeVisible();
    expect(screen.queryByText('first.test/old')).toBeNull();

    rerender(<ProjectRepository repoUrl="https://user:pass@rejected.test/secret" />);
    expect(screen.getByRole('alert')).toHaveTextContent('Repository link unavailable');
    expect(screen.queryByText('second.test/new/path')).toBeNull();

    rerender(<ProjectRepository repoUrl={null} />);
    expect(screen.getByText('No repository linked')).toBeVisible();
    expect(screen.queryByRole('alert')).toBeNull();
  });
});

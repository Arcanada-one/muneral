import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { ProjectRepository } from './ProjectRepository';

const originalClipboard = Object.getOwnPropertyDescriptor(navigator, 'clipboard');

function installClipboard(writeText: ReturnType<typeof vi.fn>) {
  Object.defineProperty(navigator, 'clipboard', {
    configurable: true,
    value: { writeText },
  });
  return writeText;
}

function removeClipboard() {
  Reflect.deleteProperty(navigator, 'clipboard');
}

afterEach(() => {
  cleanup();
  if (originalClipboard) {
    Object.defineProperty(navigator, 'clipboard', originalClipboard);
  } else {
    removeClipboard();
  }
});

describe('ProjectRepository copy repository URL', () => {
  it('copies the exact accepted URL once beside the unchanged open-repository anchor', async () => {
    const repoUrl = 'https://GitHub.com:8443/Arcanada-one/muneral';
    const writeText = installClipboard(vi.fn().mockResolvedValue(undefined));
    render(<ProjectRepository repoUrl={repoUrl} />);

    const open = screen.getByRole('link', { name: 'Open repository' });
    expect(open).toHaveAttribute('href', repoUrl);
    expect(open).toHaveAttribute('target', '_blank');
    expect(open).toHaveAttribute('rel', 'noopener noreferrer');
    expect(screen.getByText('github.com:8443/Arcanada-one/muneral')).toBeVisible();

    expect(writeText).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Copy repository URL' }));

    expect(writeText).toHaveBeenCalledTimes(1);
    expect(writeText).toHaveBeenCalledWith(repoUrl);
    expect(await screen.findByRole('status')).toHaveTextContent('Repository URL copied.');
    expect(open).toHaveAttribute('href', repoUrl);
  });

  it('disables duplicate clicks while the clipboard write is pending', async () => {
    let resolveClipboard!: () => void;
    const writeText = installClipboard(vi.fn(() => new Promise<void>((resolve) => {
      resolveClipboard = resolve;
    })));
    render(<ProjectRepository repoUrl="https://example.test/org/repo" />);
    const button = screen.getByRole('button', { name: 'Copy repository URL' });

    fireEvent.click(button);
    expect(button).toBeDisabled();
    fireEvent.click(button);
    expect(writeText).toHaveBeenCalledTimes(1);

    await act(async () => {
      resolveClipboard();
    });
    expect(await screen.findByRole('status')).toHaveTextContent('Repository URL copied.');
    expect(button).not.toBeDisabled();
  });

  it('reports generic failure without reflecting clipboard details', async () => {
    installClipboard(vi.fn().mockRejectedValue(new Error('private clipboard detail')));
    render(<ProjectRepository repoUrl="https://example.test/org/repo" />);

    fireEvent.click(screen.getByRole('button', { name: 'Copy repository URL' }));

    const failure = await screen.findByRole('alert');
    expect(failure).toHaveTextContent('Could not copy repository URL. Try copying it manually.');
    expect(failure).not.toHaveTextContent('private clipboard detail');
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
  });

  it('treats a missing clipboard API as a generic retry/manual-copy failure', async () => {
    removeClipboard();
    render(<ProjectRepository repoUrl="https://example.test/org/repo" />);

    fireEvent.click(screen.getByRole('button', { name: 'Copy repository URL' }));

    const failure = await screen.findByRole('alert');
    expect(failure).toHaveTextContent('Could not copy repository URL. Try copying it manually.');
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
  });

  it.each([
    'javascript:alert(1)',
    'http://example.test/repo',
    'https://user:pass@example.test/repo',
    'https://example.test/repo?token=synthetic',
    'https://example.test/repo#private',
  ])('keeps rejected URLs non-actionable without a copy control (%s)', (repoUrl) => {
    installClipboard(vi.fn().mockResolvedValue(undefined));
    render(<ProjectRepository repoUrl={repoUrl} />);

    expect(screen.getByRole('alert')).toHaveTextContent('Repository link unavailable');
    expect(screen.queryByRole('button', { name: 'Copy repository URL' })).not.toBeInTheDocument();
    expect(screen.queryByRole('link')).toBeNull();
  });

  it.each([undefined, null, ''])('keeps missing URL props non-actionable without a copy control (%s)', (repoUrl) => {
    installClipboard(vi.fn().mockResolvedValue(undefined));
    render(<ProjectRepository repoUrl={repoUrl} />);

    expect(screen.getByText('No repository linked')).toBeVisible();
    expect(screen.queryByRole('button', { name: 'Copy repository URL' })).not.toBeInTheDocument();
    expect(screen.queryByRole('link')).toBeNull();
  });

  it('resets copy state when the URL identity changes and ignores stale completion', async () => {
    let resolveClipboard!: () => void;
    const writeText = installClipboard(vi.fn(() => new Promise<void>((resolve) => {
      resolveClipboard = resolve;
    })));
    const firstUrl = 'https://first.test/old';
    const secondUrl = 'https://second.test/new/path';
    const { rerender } = render(<ProjectRepository repoUrl={firstUrl} />);

    fireEvent.click(screen.getByRole('button', { name: 'Copy repository URL' }));
    expect(writeText).toHaveBeenCalledWith(firstUrl);

    rerender(<ProjectRepository repoUrl={secondUrl} />);
    expect(screen.getByRole('link', { name: 'Open repository' })).toHaveAttribute('href', secondUrl);
    expect(screen.getByText('second.test/new/path')).toBeVisible();
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();

    await act(async () => {
      resolveClipboard();
    });
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();

    const secondWrite = installClipboard(vi.fn().mockResolvedValue(undefined));
    fireEvent.click(screen.getByRole('button', { name: 'Copy repository URL' }));
    expect(secondWrite).toHaveBeenCalledTimes(1);
    expect(secondWrite).toHaveBeenCalledWith(secondUrl);
    expect(await screen.findByRole('status')).toHaveTextContent('Repository URL copied.');
  });
});

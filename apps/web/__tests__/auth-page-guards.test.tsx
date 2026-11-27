// The two server components that act on sign-in state.
import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PreferencesProvider } from '@/components/preferences/PreferencesProvider';

const mocks = vi.hoisted(() => ({
  auth: vi.fn(),
  redirect: vi.fn((to: string): never => { throw new Error(`redirect ${to}`); }),
}));
vi.mock('@/lib/auth/nextauth', () => ({ auth: mocks.auth }));
vi.mock('next/navigation', () => ({ redirect: mocks.redirect, useRouter: () => ({ refresh: () => {} }) }));
vi.mock('next-auth/react', () => ({ signIn: vi.fn() }));
vi.mock('@/components/layout/Sidebar', () => ({ Sidebar: () => null }));
vi.mock('@/components/layout/Header', () => ({ Header: () => null }));
vi.mock('@/lib/auth/oidc-config', () => ({ loadOidcConfig: async () => ({}) }));

import AppLayout from '@/app/(app)/layout';
import LoginPage from '@/app/(auth)/login/page';

beforeEach(() => {
  mocks.auth.mockReset();
  mocks.redirect.mockClear();
});

describe('signed-in pages', () => {
  it.each([
    ['there is no session', null],
    ['the session is over', { user: { name: null }, error: 'SessionExpired' }],
  ])('send the visitor to the login page when %s', async (_label, session) => {
    mocks.auth.mockResolvedValue(session);
    await expect(AppLayout({ children: null })).rejects.toThrow('redirect /login');
  });

  it.each([
    ['live', { user: { name: null }, accessToken: 'a' }],
    ['temporarily unable to refresh', { user: { name: null }, error: 'TemporarilyUnavailable' }],
  ])('stay open for a session that is %s', async (_label, session) => {
    mocks.auth.mockResolvedValue(session);
    await expect(AppLayout({ children: null })).resolves.toBeTruthy();
    expect(mocks.redirect).not.toHaveBeenCalled();
  });
});

describe('login page', () => {
  const open = async (query: { error?: string }) =>
    render(
      <PreferencesProvider initialLocale="en" initialTheme="light">
        {await LoginPage({ searchParams: Promise.resolve(query) })}
      </PreferencesProvider>,
    );

  it('reports a sign-in that failed, without showing the error text', async () => {
    await open({ error: 'synthetic-error-code' });
    expect(screen.getByRole('alert').textContent).toBe('Sign-in did not complete. Try again.');
    expect(document.body.innerHTML).not.toContain('synthetic-error-code');
  });

  it('reports nothing on a plain visit', async () => {
    await open({});
    expect(screen.queryByRole('alert')).toBeNull();
  });
});

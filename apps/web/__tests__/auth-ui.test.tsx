import { useState } from 'react';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { signIn } from 'next-auth/react';
import { LoginForm } from '@/app/(auth)/login/LoginForm';
import { PreferencesProvider } from '@/components/preferences/PreferencesProvider';
import { TaskDetailSessionProvider, useDetailSession } from '@/lib/api/task-detail-session';

const state = vi.hoisted(() => ({ data: null as Record<string, unknown> | null }));
vi.mock('next-auth/react', () => ({
  signIn: vi.fn(),
  useSession: () => ({ data: state.data, status: 'authenticated' }),
}));

const login = (locale: 'en' | 'ru' | 'zh', props: { enabled: boolean; failed: boolean }) =>
  render(
    <PreferencesProvider initialLocale={locale} initialTheme="light">
      <LoginForm {...props} />
    </PreferencesProvider>,
  );

describe('login form', () => {
  beforeEach(() => vi.mocked(signIn).mockReset());

  it.each([['en', 'Sign in with Arcana'], ['ru', 'Войти через Arcana'], ['zh', '使用 Arcana 登录']] as const)(
    'offers only Auth Arcana and passes the %s language on', (locale, label) => {
      login(locale, { enabled: true, failed: false });
      expect(screen.getAllByRole('button')).toHaveLength(1);
      fireEvent.click(screen.getByRole('button', { name: label }));
      expect(signIn).toHaveBeenCalledWith('arcanada', { callbackUrl: '/workspaces' }, { ui_locales: locale });
      expect(document.body.innerHTML).not.toMatch(/github|telegram/i);
    });

  it.each([['en', 'Sign-in is not available yet.'], ['ru', 'Вход пока недоступен.'], ['zh', '登录功能暂不可用。']] as const)(
    'shows no button when sign-in is off (%s)', (locale, text) => {
      login(locale, { enabled: false, failed: false });
      expect(screen.queryByRole('button')).toBeNull();
      expect(screen.getByRole('status').textContent).toBe(text);
    });

  it('reports a failed sign-in', () => {
    login('en', { enabled: true, failed: true });
    expect(screen.getByRole('alert').textContent).toBe('Sign-in did not complete. Try again.');
  });
});

describe('a refreshed access token', () => {
  it('keeps the mounted page for the same login and remounts it for another', () => {
    let mounts = 0;
    function Probe() {
      useDetailSession();
      const [id] = useState(() => ++mounts);
      return <p data-testid="mount">{id}</p>;
    }
    const tree = () => <TaskDetailSessionProvider><Probe /></TaskDetailSessionProvider>;
    state.data = { accessToken: 'first', loginSessionId: 'login-a' };
    const view = render(tree());
    state.data = { accessToken: 'refreshed', loginSessionId: 'login-a' };
    act(() => view.rerender(tree()));
    expect(screen.getByTestId('mount').textContent).toBe('1');
    state.data = { accessToken: 'refreshed', loginSessionId: 'login-b' };
    act(() => view.rerender(tree()));
    expect(screen.getByTestId('mount').textContent).toBe('2');
  });
});

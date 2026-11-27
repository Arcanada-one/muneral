import { Component, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildAuthConfig } from '@/lib/auth/config';
import ErrorPage from '@/app/error';
import GlobalError from '@/app/global-error';
import { SignOutPanel } from '@/app/(auth)/signout/SignOutPanel';
import { PreferencesProvider } from '@/components/preferences/PreferencesProvider';
import type { Locale, Theme } from '@/lib/preferences/preferences';

vi.mock('next/font/google', () => ({ Inter: () => ({ className: 'font' }) }));

class Boundary extends Component<{ children: ReactNode }, { error?: Error }> {
  state: { error?: Error } = {};
  static getDerivedStateFromError(error: Error) {
    return { error };
  }
  render() {
    return this.state.error
      ? <ErrorPage error={this.state.error} reset={() => this.setState({ error: undefined })} />
      : this.props.children;
  }
}
function Throws(): ReactNode {
  throw new Error('synthetic secret detail');
}

const cases: [Locale, Theme, string, string, string][] = [
  ['ru', 'dark', 'Что-то пошло не так', 'Повторить попытку', 'Включить светлую тему'],
  ['zh', 'light', '出错了', '重试', '切换到深色主题'],
];

afterEach(() => {
  document.cookie = 'mn_locale=; Max-Age=0';
  document.cookie = 'mn_theme=; Max-Age=0';
  vi.restoreAllMocks();
});

describe.each(cases)('error pages in %s %s', (locale, theme, title, retry, themeSwitch) => {
  it('a render error shows the localized page with both switchers', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    render(
      <PreferencesProvider initialLocale={locale} initialTheme={theme}>
        <Boundary><Throws /></Boundary>
      </PreferencesProvider>,
    );
    expect(screen.getByRole('alert').textContent).toBe(title);
    expect(screen.getByRole('button', { name: retry })).toBeTruthy();
    expect(screen.getByRole('button', { name: themeSwitch })).toBeTruthy();
    for (const name of ['EN', 'RU', '中文']) expect(screen.getByRole('button', { name })).toBeTruthy();
    expect(document.body.textContent).not.toContain('synthetic secret detail');
  });

  it('the global error page restores lang, theme and text from the cookies', () => {
    document.cookie = `mn_locale=${locale}`;
    document.cookie = `mn_theme=${theme}`;
    const html = renderToStaticMarkup(<GlobalError error={new Error('synthetic secret detail')} reset={() => {}} />);
    expect(html).toContain(`<html lang="${locale === 'zh' ? 'zh-CN' : locale}"${theme === 'dark' ? ' class="dark"' : ''}>`);
    expect(html).toContain(title);
    expect(html).toContain(`aria-label="${themeSwitch}"`);
    for (const code of ['en', 'ru', 'zh']) expect(html).toContain(`lang="${code}" title=`);
    expect(html).not.toContain('synthetic secret detail');
  });
});

describe('Auth.js pages', () => {
  it('are all pages of this app', () => {
    expect(buildAuthConfig(null).pages).toEqual({
      signIn: '/login', signOut: '/signout', error: '/auth-error', verifyRequest: '/auth-error',
    });
  });

  it.each([['ru', 'Выйти из Muneral?', 'Выйти'], ['zh', '要退出 Muneral 吗？', '退出登录']] as const)(
    'the sign-out page is localized (%s) and posts to the server logout', (locale, title, button) => {
      render(
        <PreferencesProvider initialLocale={locale} initialTheme="light">
          <SignOutPanel />
        </PreferencesProvider>,
      );
      expect(screen.getByRole('heading').textContent).toBe(title);
      const submit = screen.getByRole('button', { name: button }) as HTMLButtonElement;
      expect(submit.type).toBe('submit');
      expect(submit.form?.getAttribute('action')).toBe('/api/logout');
      expect(submit.form?.method).toBe('post');
    });
});

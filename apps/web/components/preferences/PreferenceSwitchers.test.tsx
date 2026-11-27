import { render, screen, fireEvent } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { parseLocale, parseTheme, preferenceCookie } from '@/lib/preferences/preferences';
import { PreferencesProvider } from './PreferencesProvider';
import { PreferenceSwitchers } from './PreferenceSwitchers';
import { T } from './T';

const refresh = vi.fn();
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh }) }));

const renderSwitchers = () =>
  render(
    <PreferencesProvider initialLocale="en" initialTheme="light">
      <PreferenceSwitchers />
      <p>
        <T k="Sign out" />
      </p>
    </PreferencesProvider>,
  );

describe('language and theme switchers', () => {
  beforeEach(() => {
    refresh.mockClear();
    document.documentElement.className = '';
    document.documentElement.lang = 'en';
  });

  it('switches the text, the lang attribute and the persisted language', () => {
    renderSwitchers();
    for (const [button, lang, text, cookie] of [
      ['RU', 'ru', 'Выйти', 'mn_locale=ru'],
      ['中文', 'zh-CN', '退出登录', 'mn_locale=zh'],
      ['EN', 'en', 'Sign out', 'mn_locale=en'],
    ]) {
      fireEvent.click(screen.getByRole('button', { name: button }));
      expect(screen.getByText(text)).toBeTruthy();
      expect(document.documentElement.lang).toBe(lang);
      expect(document.cookie).toContain(cookie);
      expect(screen.getByRole('button', { name: button }).getAttribute('aria-pressed')).toBe('true');
    }
    expect(refresh).toHaveBeenCalledTimes(3);
  });

  it('toggles the dark class and persists the theme', () => {
    renderSwitchers();
    fireEvent.click(screen.getByRole('button', { name: 'Switch to dark theme' }));
    expect(document.documentElement.classList.contains('dark')).toBe(true);
    expect(document.cookie).toContain('mn_theme=dark');
    fireEvent.click(screen.getByRole('button', { name: 'Switch to light theme' }));
    expect(document.documentElement.classList.contains('dark')).toBe(false);
    expect(document.cookie).toContain('mn_theme=light');
  });

  it('falls back to English and light for unknown stored values', () => {
    expect([parseLocale('ru'), parseLocale('tr'), parseLocale(undefined)]).toEqual(['ru', 'en', 'en']);
    expect([parseTheme('dark'), parseTheme('<x>')]).toEqual(['dark', 'light']);
    expect(preferenceCookie('mn_theme', 'dark', true)).toBe(
      'mn_theme=dark; Path=/; Max-Age=31536000; SameSite=Lax; Secure',
    );
  });
});

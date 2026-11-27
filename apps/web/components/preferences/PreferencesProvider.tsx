'use client';

import { createContext, useCallback, useContext, useMemo, useState } from 'react';
import {
  DEFAULT_LOCALE,
  DEFAULT_THEME,
  HTML_LANG,
  LOCALE_COOKIE,
  THEME_COOKIE,
  preferenceCookie,
  type Locale,
  type Theme,
} from '@/lib/preferences/preferences';

interface Preferences {
  locale: Locale;
  theme: Theme;
  setLocale: (locale: Locale) => void;
  setTheme: (theme: Theme) => void;
}

// Without a provider (isolated component tests and browser fixtures) the UI is English and light.
const PreferencesContext = createContext<Preferences>({
  locale: DEFAULT_LOCALE,
  theme: DEFAULT_THEME,
  setLocale: () => {},
  setTheme: () => {},
});

function persist(name: string, value: string) {
  document.cookie = preferenceCookie(name, value, window.location.protocol === 'https:');
}

export function PreferencesProvider({
  initialLocale,
  initialTheme,
  children,
}: {
  initialLocale: Locale;
  initialTheme: Theme;
  children: React.ReactNode;
}) {
  const [locale, setLocaleState] = useState(initialLocale);
  const [theme, setThemeState] = useState(initialTheme);

  const setLocale = useCallback((next: Locale) => {
    setLocaleState(next);
    persist(LOCALE_COOKIE, next);
    document.documentElement.lang = HTML_LANG[next];
  }, []);

  const setTheme = useCallback((next: Theme) => {
    setThemeState(next);
    persist(THEME_COOKIE, next);
    document.documentElement.classList.toggle('dark', next === 'dark');
  }, []);

  const value = useMemo(
    () => ({ locale, theme, setLocale, setTheme }),
    [locale, theme, setLocale, setTheme],
  );

  return <PreferencesContext.Provider value={value}>{children}</PreferencesContext.Provider>;
}

export function usePreferences() {
  return useContext(PreferencesContext);
}

/** Language and theme choice. Persisted in cookies so the server renders the first paint. */
export const LOCALES = ['en', 'ru', 'zh'] as const;
export type Locale = (typeof LOCALES)[number];

export const THEMES = ['light', 'dark'] as const;
export type Theme = (typeof THEMES)[number];

export const DEFAULT_LOCALE: Locale = 'en';
export const DEFAULT_THEME: Theme = 'light';

export const LOCALE_COOKIE = 'mn_locale';
export const THEME_COOKIE = 'mn_theme';

/** Value of the <html lang> attribute. */
export const HTML_LANG: Record<Locale, string> = { en: 'en', ru: 'ru', zh: 'zh-CN' };

/** Locale used for dates and times. */
export const DATE_LOCALE: Record<Locale, string> = { en: 'en-US', ru: 'ru-RU', zh: 'zh-CN' };

export function parseLocale(value: string | undefined): Locale {
  return LOCALES.find((locale) => locale === value) ?? DEFAULT_LOCALE;
}

export function parseTheme(value: string | undefined): Theme {
  return THEMES.find((theme) => theme === value) ?? DEFAULT_THEME;
}

const ONE_YEAR_SECONDS = 60 * 60 * 24 * 365;

export function preferenceCookie(name: string, value: string, secure: boolean): string {
  return `${name}=${value}; Path=/; Max-Age=${ONE_YEAR_SECONDS}; SameSite=Lax${secure ? '; Secure' : ''}`;
}

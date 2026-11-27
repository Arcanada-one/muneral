import { cookies } from 'next/headers';
import { LOCALE_COOKIE, THEME_COOKIE, parseLocale, parseTheme } from './preferences';

export async function readPreferences() {
  const store = await cookies();
  return {
    locale: parseLocale(store.get(LOCALE_COOKIE)?.value),
    theme: parseTheme(store.get(THEME_COOKIE)?.value),
  };
}

'use client';

import { useState } from 'react';
import { Inter } from 'next/font/google';
import './globals.css';
import { ErrorView } from '@/components/errors/ErrorView';
import { PreferencesProvider } from '@/components/preferences/PreferencesProvider';
import {
  HTML_LANG,
  LOCALE_COOKIE,
  THEME_COOKIE,
  parseLocale,
  parseTheme,
} from '@/lib/preferences/preferences';

const inter = Inter({ subsets: ['latin'] });

function cookieValue(name: string): string | undefined {
  if (typeof document === 'undefined') return undefined;
  const prefix = `${name}=`;
  return document.cookie
    .split(';')
    .map((part) => part.trim())
    .find((part) => part.startsWith(prefix))
    ?.slice(prefix.length);
}

/**
 * Replaces the root layout when that layout itself fails, so it restores the stylesheet, the
 * language, the theme class and the stored choice on its own.
 */
export default function GlobalError({ reset }: { error: Error; reset: () => void }) {
  const [{ locale, theme }] = useState(() => ({
    locale: parseLocale(cookieValue(LOCALE_COOKIE)),
    theme: parseTheme(cookieValue(THEME_COOKIE)),
  }));

  return (
    <html
      lang={HTML_LANG[locale]}
      className={theme === 'dark' ? 'dark' : undefined}
      suppressHydrationWarning
    >
      <body className={inter.className}>
        <PreferencesProvider initialLocale={locale} initialTheme={theme}>
          <ErrorView reset={reset} />
        </PreferencesProvider>
      </body>
    </html>
  );
}

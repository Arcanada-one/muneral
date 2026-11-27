import type { Metadata } from 'next';
import { Inter } from 'next/font/google';
import './globals.css';
import { PreferencesProvider } from '@/components/preferences/PreferencesProvider';
import { HTML_LANG } from '@/lib/preferences/preferences';
import { readPreferences } from '@/lib/preferences/server';
import { translate } from '@/lib/i18n/translate';
import { Providers } from './providers';

const inter = Inter({ subsets: ['latin'] });

export async function generateMetadata(): Promise<Metadata> {
  const { locale } = await readPreferences();
  return {
    title: translate(locale, 'Muneral Arcana — AI Task Tracker'),
    description: translate(locale, 'Task tracking platform for AI agents and human teams'),
  };
}

export default async function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  // Read on the server so that language and theme are right in the first HTML response.
  const { locale, theme } = await readPreferences();

  return (
    <html
      lang={HTML_LANG[locale]}
      className={theme === 'dark' ? 'dark' : undefined}
      suppressHydrationWarning
    >
      <body className={inter.className}>
        <PreferencesProvider initialLocale={locale} initialTheme={theme}>
          <Providers>{children}</Providers>
        </PreferencesProvider>
      </body>
    </html>
  );
}

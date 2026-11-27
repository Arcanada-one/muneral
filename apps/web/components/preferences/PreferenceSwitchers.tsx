'use client';

import { useRouter } from 'next/navigation';
import { Moon, Sun } from 'lucide-react';
import { usePreferences } from './PreferencesProvider';
import { useI18n } from '@/lib/i18n/useI18n';
import { LOCALES, type Locale } from '@/lib/preferences/preferences';
import { cn } from '@/lib/utils';

const LOCALE_NAMES: Record<Locale, { short: string; own: string }> = {
  en: { short: 'EN', own: 'English' },
  ru: { short: 'RU', own: 'Русский' },
  zh: { short: '中文', own: '简体中文' },
};

const CONTROL =
  'rounded-md px-2 py-1 text-xs font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring';

/** The switchers without the router, for pages that must work when the app has failed. */
export function PreferenceToggles({
  className,
  onLocaleChange,
}: {
  className?: string;
  onLocaleChange?: () => void;
}) {
  const { locale, theme, setLocale, setTheme } = usePreferences();
  const { t } = useI18n();
  const nextTheme = theme === 'dark' ? 'light' : 'dark';
  const themeLabel = nextTheme === 'dark' ? t('Switch to dark theme') : t('Switch to light theme');

  return (
    <div className={cn('flex items-center gap-2', className)}>
      <div role="group" aria-label={t('Language')} className="flex rounded-md border p-0.5">
        {LOCALES.map((code) => (
          <button
            key={code}
            type="button"
            lang={code}
            title={LOCALE_NAMES[code].own}
            aria-pressed={locale === code}
            onClick={() => {
              setLocale(code);
              onLocaleChange?.();
            }}
            className={cn(
              CONTROL,
              locale === code
                ? 'bg-primary text-primary-foreground'
                : 'text-muted-foreground hover:bg-accent hover:text-foreground',
            )}
          >
            {LOCALE_NAMES[code].short}
          </button>
        ))}
      </div>
      <button
        type="button"
        aria-label={themeLabel}
        title={themeLabel}
        data-theme-toggle={theme}
        onClick={() => setTheme(nextTheme)}
        className={cn(CONTROL, 'border p-1.5 text-muted-foreground hover:bg-accent hover:text-foreground')}
      >
        {theme === 'dark' ? (
          <Sun className="h-4 w-4" aria-hidden="true" />
        ) : (
          <Moon className="h-4 w-4" aria-hidden="true" />
        )}
      </button>
    </div>
  );
}

export function PreferenceSwitchers({ className }: { className?: string }) {
  const router = useRouter();
  // Re-render server components (page titles) with the new cookie.
  return <PreferenceToggles className={className} onLocaleChange={() => router.refresh()} />;
}

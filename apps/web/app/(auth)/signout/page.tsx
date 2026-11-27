import type { Metadata } from 'next';
import { PreferenceSwitchers } from '@/components/preferences/PreferenceSwitchers';
import { readPreferences } from '@/lib/preferences/server';
import { translate } from '@/lib/i18n/translate';
import { SignOutPanel } from './SignOutPanel';

export async function generateMetadata(): Promise<Metadata> {
  const { locale } = await readPreferences();
  return { title: translate(locale, 'Sign out of Muneral?') };
}

/** Where Auth.js sends a visit to its sign-out address. */
export default function SignOutPage() {
  return (
    <main className="flex min-h-screen flex-col items-center justify-center gap-4 p-6 text-center">
      <PreferenceSwitchers className="absolute right-4 top-4" />
      <SignOutPanel />
    </main>
  );
}

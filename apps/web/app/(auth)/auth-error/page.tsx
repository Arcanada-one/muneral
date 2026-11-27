import type { Metadata } from 'next';
import Link from 'next/link';
import { PreferenceSwitchers } from '@/components/preferences/PreferenceSwitchers';
import { T } from '@/components/preferences/T';
import { readPreferences } from '@/lib/preferences/server';
import { translate } from '@/lib/i18n/translate';

export async function generateMetadata(): Promise<Metadata> {
  const { locale } = await readPreferences();
  return { title: translate(locale, 'Sign-in did not complete. Try again.') };
}

/** Where Auth.js sends a failed sign-in. The error code in the address is not shown. */
export default function AuthErrorPage() {
  return (
    <main className="flex min-h-screen flex-col items-center justify-center gap-4 p-6 text-center">
      <PreferenceSwitchers className="absolute right-4 top-4" />
      <h1 role="alert" className="text-2xl font-bold">
        <T k="Sign-in did not complete. Try again." />
      </h1>
      <Link href="/login" className="text-sm font-medium underline underline-offset-4">
        <T k="Back to sign-in" />
      </Link>
    </main>
  );
}

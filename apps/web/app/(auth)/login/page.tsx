import { Metadata } from 'next';
import { PreferenceSwitchers } from '@/components/preferences/PreferenceSwitchers';
import { T } from '@/components/preferences/T';
import { readPreferences } from '@/lib/preferences/server';
import { translate } from '@/lib/i18n/translate';
import { LoginForm } from './LoginForm';

export async function generateMetadata(): Promise<Metadata> {
  const { locale } = await readPreferences();
  return { title: translate(locale, 'Sign In — Muneral Arcana') };
}

export default function LoginPage() {
  return (
    <div className="flex min-h-screen items-center justify-center bg-gradient-to-br from-slate-50 to-slate-100 dark:from-slate-950 dark:to-slate-900">
      <PreferenceSwitchers className="absolute right-4 top-4" />
      <div className="w-full max-w-sm space-y-6 rounded-xl border bg-card p-8 shadow-lg">
        <div className="text-center">
          <h1 className="text-2xl font-bold tracking-tight">Muneral Arcana</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            <T k="AI-powered task tracking" />
          </p>
        </div>
        <LoginForm />
      </div>
    </div>
  );
}

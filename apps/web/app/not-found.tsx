import Link from 'next/link';
import { PreferenceSwitchers } from '@/components/preferences/PreferenceSwitchers';
import { T } from '@/components/preferences/T';

export default function NotFound() {
  return (
    <main className="flex min-h-screen flex-col items-center justify-center gap-4 p-6 text-center">
      <PreferenceSwitchers className="absolute right-4 top-4" />
      <h1 className="text-2xl font-bold">
        <T k="Page not found" />
      </h1>
      <Link href="/workspaces" className="text-sm font-medium underline underline-offset-4">
        <T k="Back to workspaces" />
      </Link>
    </main>
  );
}

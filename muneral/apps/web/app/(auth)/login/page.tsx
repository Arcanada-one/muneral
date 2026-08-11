import { Metadata } from 'next';
import { LoginForm } from './LoginForm';

export const metadata: Metadata = {
  title: 'Sign In — Muneral Arcana',
};

export default function LoginPage() {
  return (
    <div className="flex min-h-screen items-center justify-center bg-gradient-to-br from-slate-50 to-slate-100">
      <div className="w-full max-w-sm space-y-6 rounded-xl border bg-card p-8 shadow-lg">
        <div className="text-center">
          <h1 className="text-2xl font-bold tracking-tight">Muneral Arcana</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            AI-powered task tracking
          </p>
        </div>
        <LoginForm />
      </div>
    </div>
  );
}

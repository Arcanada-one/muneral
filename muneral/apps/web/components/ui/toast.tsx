import * as React from 'react';
import { cn } from '@/lib/utils';

export interface ToastProps {
  id: string;
  title?: string;
  description?: string;
  variant?: 'default' | 'destructive';
  onDismiss: (id: string) => void;
}

export function Toast({ id, title, description, variant = 'default', onDismiss }: ToastProps) {
  return (
    <div
      role="alert"
      className={cn(
        'pointer-events-auto relative flex w-full items-center justify-between space-x-4 overflow-hidden rounded-md border p-6 pr-8 shadow-lg transition-all',
        variant === 'destructive' &&
          'destructive border-destructive bg-destructive text-destructive-foreground',
        variant === 'default' && 'border bg-background text-foreground',
      )}
    >
      <div className="grid gap-1">
        {title && <p className="text-sm font-semibold">{title}</p>}
        {description && <p className="text-sm opacity-90">{description}</p>}
      </div>
      <button
        onClick={() => onDismiss(id)}
        className="absolute right-2 top-2 rounded-md p-1 text-foreground/50 opacity-0 transition-opacity hover:text-foreground focus:opacity-100 focus:outline-none focus:ring-2 group-hover:opacity-100"
        aria-label="Dismiss"
      >
        <span aria-hidden>×</span>
      </button>
    </div>
  );
}

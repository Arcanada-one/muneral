'use client';

import Link from 'next/link';
import { useParams, usePathname } from 'next/navigation';
import {
  LayoutDashboard,
  Folder,
  Flag,
  Zap,
  Settings,
  ChevronLeft,
  ChevronRight,
  Bot,
} from 'lucide-react';
import { WorkspaceSelector } from './WorkspaceSelector';
import { useUiStore } from '@/store/ui';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';

interface NavItem {
  label: string;
  href: string;
  icon: React.ComponentType<{ className?: string }>;
}

export function Sidebar() {
  const { wsSlug } = useParams<{ wsSlug?: string }>();
  const pathname = usePathname();
  const { sidebarCollapsed, toggleSidebar } = useUiStore();

  const navItems: NavItem[] = wsSlug
    ? [
        {
          label: 'Dashboard',
          href: `/workspaces/${wsSlug}/dashboard`,
          icon: LayoutDashboard,
        },
        {
          label: 'Projects',
          href: `/workspaces/${wsSlug}`,
          icon: Folder,
        },
        {
          label: 'Milestones',
          href: `/workspaces/${wsSlug}/milestones`,
          icon: Flag,
        },
        {
          label: 'Sprints',
          href: `/workspaces/${wsSlug}/sprints`,
          icon: Zap,
        },
        {
          label: 'Settings',
          href: `/workspaces/${wsSlug}/settings`,
          icon: Settings,
        },
      ]
    : [];

  return (
    <aside
      className={cn(
        'relative flex flex-col border-r bg-muted/30 transition-all duration-200',
        sidebarCollapsed ? 'w-14' : 'w-56',
      )}
    >
      {/* Logo */}
      <div className="flex h-14 items-center border-b px-3">
        <Link href="/workspaces" className="flex items-center gap-2">
          <Bot className="h-6 w-6 text-primary flex-shrink-0" />
          {!sidebarCollapsed && (
            <span className="font-bold tracking-tight">Muneral</span>
          )}
        </Link>
      </div>

      {/* Workspace selector */}
      {!sidebarCollapsed && (
        <div className="border-b px-2 py-2">
          <WorkspaceSelector />
        </div>
      )}

      {/* Nav */}
      <nav className="flex-1 space-y-1 p-2">
        {navItems.map((item) => {
          const Icon = item.icon;
          const active = pathname === item.href || pathname.startsWith(item.href + '/');
          return (
            <Link
              key={item.href}
              href={item.href}
              className={cn(
                'flex items-center gap-3 rounded-md px-2 py-2 text-sm transition-colors',
                active
                  ? 'bg-primary text-primary-foreground'
                  : 'text-muted-foreground hover:bg-accent hover:text-foreground',
                sidebarCollapsed && 'justify-center',
              )}
              title={sidebarCollapsed ? item.label : undefined}
            >
              <Icon className="h-4 w-4 flex-shrink-0" />
              {!sidebarCollapsed && item.label}
            </Link>
          );
        })}
      </nav>

      {/* Toggle button */}
      <Button
        variant="ghost"
        size="icon"
        onClick={toggleSidebar}
        className="absolute -right-3 top-16 h-6 w-6 rounded-full border bg-background shadow-sm"
        aria-label={sidebarCollapsed ? 'Expand sidebar' : 'Collapse sidebar'}
      >
        {sidebarCollapsed ? (
          <ChevronRight className="h-3 w-3" />
        ) : (
          <ChevronLeft className="h-3 w-3" />
        )}
      </Button>
    </aside>
  );
}

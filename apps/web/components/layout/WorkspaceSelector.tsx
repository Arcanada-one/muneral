'use client';

import { ChevronDown, Plus } from 'lucide-react';
import Link from 'next/link';
import { useWorkspaces } from '@/lib/api/workspaces';
import { useWorkspaceStore } from '@/store/workspace';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Button } from '@/components/ui/button';
import { useI18n } from '@/lib/i18n/useI18n';

export function WorkspaceSelector() {
  const { t } = useI18n();
  const { data: workspaces = [] } = useWorkspaces();
  const { currentSlug, setCurrentSlug } = useWorkspaceStore();
  const current = workspaces.find((w) => w.slug === currentSlug);

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" className="w-full justify-between px-2">
          <span className="truncate font-semibold">
            {current?.name ?? t('Select workspace')}
          </span>
          <ChevronDown className="h-4 w-4 opacity-50 flex-shrink-0" />
        </Button>
      </DropdownMenuTrigger>

      <DropdownMenuContent className="w-56">
        <DropdownMenuLabel>{t('Workspaces')}</DropdownMenuLabel>
        <DropdownMenuSeparator />

        {workspaces.map((ws) => (
          <DropdownMenuItem key={ws.id} asChild>
            <Link
              href={`/workspaces/${ws.slug}`}
              onClick={() => setCurrentSlug(ws.slug)}
              className="cursor-pointer"
            >
              {ws.name}
            </Link>
          </DropdownMenuItem>
        ))}

        <DropdownMenuSeparator />
        <DropdownMenuItem asChild>
          <Link href="/workspaces" className="flex items-center gap-2 cursor-pointer">
            <Plus className="h-4 w-4" />
            {t('New workspace')}
          </Link>
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

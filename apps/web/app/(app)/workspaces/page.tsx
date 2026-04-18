'use client';

import Link from 'next/link';
import { Plus, Users, FolderOpen } from 'lucide-react';
import { useWorkspaces } from '@/lib/api/workspaces';
import { useWorkspaceStore } from '@/store/workspace';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';

export default function WorkspacesPage() {
  const { data: workspaces = [], isLoading } = useWorkspaces();
  const { setCurrentSlug } = useWorkspaceStore();

  if (isLoading) {
    return (
      <div className="flex h-64 items-center justify-center">
        <p className="text-muted-foreground">Loading workspaces...</p>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold">Workspaces</h1>
          <p className="text-muted-foreground">Select a workspace to get started</p>
        </div>
        <Button>
          <Plus className="mr-2 h-4 w-4" />
          New Workspace
        </Button>
      </div>

      {workspaces.length === 0 ? (
        <div className="rounded-xl border-2 border-dashed p-12 text-center">
          <FolderOpen className="mx-auto h-10 w-10 text-muted-foreground" />
          <h3 className="mt-4 text-lg font-medium">No workspaces yet</h3>
          <p className="mt-1 text-sm text-muted-foreground">
            Create your first workspace to start tracking tasks
          </p>
          <Button className="mt-4">
            <Plus className="mr-2 h-4 w-4" />
            Create Workspace
          </Button>
        </div>
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {workspaces.map((ws) => (
            <Link
              key={ws.id}
              href={`/workspaces/${ws.slug}`}
              onClick={() => setCurrentSlug(ws.slug)}
            >
              <Card className="cursor-pointer transition-shadow hover:shadow-md">
                <CardHeader>
                  <CardTitle className="text-base">{ws.name}</CardTitle>
                  {ws.description && (
                    <CardDescription className="line-clamp-2">
                      {ws.description}
                    </CardDescription>
                  )}
                </CardHeader>
                <CardContent>
                  <div className="flex items-center gap-1 text-xs text-muted-foreground">
                    <Users className="h-3 w-3" />
                    {ws.memberCount} member{ws.memberCount !== 1 ? 's' : ''}
                  </div>
                </CardContent>
              </Card>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}

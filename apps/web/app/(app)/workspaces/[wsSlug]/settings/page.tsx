'use client';

import { useParams } from 'next/navigation';
import Link from 'next/link';
import { Settings, Key, Webhook } from 'lucide-react';
import { useWorkspaceMembers } from '@/lib/api/workspaces';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Avatar, AvatarFallback } from '@/components/ui/avatar';

const ROLE_COLORS = {
  owner: 'destructive' as const,
  manager: 'warning' as const,
  developer: 'info' as const,
  viewer: 'secondary' as const,
};

export default function SettingsPage() {
  const { wsSlug } = useParams<{ wsSlug: string }>();
  const { data: members = [], isLoading } = useWorkspaceMembers(wsSlug);

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <div className="flex items-center gap-2">
        <Settings className="h-6 w-6" />
        <h1 className="text-2xl font-bold">Settings</h1>
      </div>

      {/* Quick links to sub-pages */}
      <div className="grid gap-4 sm:grid-cols-2">
        <Link href={`/workspaces/${wsSlug}/settings/api-keys`}>
          <Card className="cursor-pointer transition-shadow hover:shadow-md">
            <CardHeader>
              <CardTitle className="flex items-center gap-2 text-base">
                <Key className="h-4 w-4" />
                API Keys
              </CardTitle>
              <CardDescription>Manage API keys for agent access</CardDescription>
            </CardHeader>
          </Card>
        </Link>

        <Link href={`/workspaces/${wsSlug}/settings/webhooks`}>
          <Card className="cursor-pointer transition-shadow hover:shadow-md">
            <CardHeader>
              <CardTitle className="flex items-center gap-2 text-base">
                <Webhook className="h-4 w-4" />
                Webhooks
              </CardTitle>
              <CardDescription>Configure event webhooks</CardDescription>
            </CardHeader>
          </Card>
        </Link>
      </div>

      {/* RBAC — Members */}
      <Card>
        <CardHeader>
          <CardTitle>Members & Roles</CardTitle>
          <CardDescription>Manage workspace access and permissions</CardDescription>
        </CardHeader>
        <CardContent>
          {isLoading ? (
            <p className="text-sm text-muted-foreground">Loading members...</p>
          ) : (
            <ul className="divide-y">
              {members.map((member) => {
                const initials = member.userName
                  .split(' ')
                  .slice(0, 2)
                  .map((n) => n[0])
                  .join('')
                  .toUpperCase();

                return (
                  <li key={member.id} className="flex items-center gap-3 py-3">
                    <Avatar className="h-8 w-8">
                      <AvatarFallback className="text-xs">{initials}</AvatarFallback>
                    </Avatar>
                    <div className="flex-1">
                      <p className="text-sm font-medium">{member.userName}</p>
                      <p className="text-xs text-muted-foreground">
                        Joined {new Date(member.joinedAt).toLocaleDateString()}
                      </p>
                    </div>
                    <Badge variant={ROLE_COLORS[member.role as keyof typeof ROLE_COLORS] ?? 'secondary'}>
                      {member.role}
                    </Badge>
                  </li>
                );
              })}
            </ul>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

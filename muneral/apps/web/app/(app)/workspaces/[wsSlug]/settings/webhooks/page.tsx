'use client';

import { useParams } from 'next/navigation';
import { Webhook, Plus, Trash2, CheckCircle2, XCircle } from 'lucide-react';
import { useWebhooks } from '@/lib/api/agents';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';

export default function WebhooksPage() {
  const { wsSlug } = useParams<{ wsSlug: string }>();
  const { data: webhooks = [], isLoading } = useWebhooks(wsSlug);

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Webhook className="h-6 w-6" />
          <h1 className="text-2xl font-bold">Webhooks</h1>
        </div>
        <Button>
          <Plus className="mr-2 h-4 w-4" />
          Add Webhook
        </Button>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Configured Webhooks</CardTitle>
          <CardDescription>
            Webhooks deliver event notifications to external URLs
          </CardDescription>
        </CardHeader>
        <CardContent>
          {isLoading ? (
            <p className="text-sm text-muted-foreground">Loading webhooks...</p>
          ) : webhooks.length === 0 ? (
            <div className="rounded-xl border-2 border-dashed p-8 text-center text-sm text-muted-foreground">
              No webhooks configured
            </div>
          ) : (
            <ul className="divide-y">
              {webhooks.map((wh) => (
                <li key={wh.id} className="flex items-start gap-3 py-3">
                  <div className="mt-0.5 flex-shrink-0">
                    {wh.active ? (
                      <CheckCircle2 className="h-4 w-4 text-green-500" />
                    ) : (
                      <XCircle className="h-4 w-4 text-muted-foreground" />
                    )}
                  </div>
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-mono truncate">{wh.url}</p>
                    <div className="mt-1 flex flex-wrap gap-1">
                      {wh.events.map((ev) => (
                        <Badge key={ev} variant="outline" className="text-xs">
                          {ev}
                        </Badge>
                      ))}
                    </div>
                  </div>
                  <Button
                    variant="ghost"
                    size="icon"
                    aria-label="Delete webhook"
                    className="text-destructive hover:text-destructive flex-shrink-0"
                  >
                    <Trash2 className="h-4 w-4" />
                  </Button>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

'use client';

import { useState } from 'react';
import { useParams } from 'next/navigation';
import { Key, Copy, Trash2, RefreshCw, Eye, EyeOff, Plus } from 'lucide-react';
import { useApiKeys, useRevokeApiKey, useCreateApiKey } from '@/lib/api/agents';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';

export default function ApiKeysPage() {
  const { wsSlug } = useParams<{ wsSlug: string }>();
  const { data: apiKeys = [], isLoading } = useApiKeys(wsSlug);
  const revoke = useRevokeApiKey(wsSlug);
  const create = useCreateApiKey(wsSlug);

  const [newKeyName, setNewKeyName] = useState('');
  const [plaintext, setPlaintext] = useState<string | null>(null);
  const [showKey, setShowKey] = useState(false);
  const [copied, setCopied] = useState(false);

  const handleCreate = async () => {
    if (!newKeyName.trim()) return;
    const result = await create.mutateAsync({ name: newKeyName.trim() });
    setPlaintext(result.plaintext);
    setNewKeyName('');
  };

  const handleCopy = async (text: string) => {
    await navigator.clipboard.writeText(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <div className="flex items-center gap-2">
        <Key className="h-6 w-6" />
        <h1 className="text-2xl font-bold">API Keys</h1>
      </div>

      {/* New key revealed */}
      {plaintext && (
        <div className="rounded-lg border border-green-200 bg-green-50 p-4">
          <p className="mb-2 text-sm font-medium text-green-800">
            New API key created — copy it now, it will not be shown again
          </p>
          <div className="flex items-center gap-2">
            <div className="flex-1 font-mono text-sm bg-white rounded border px-3 py-2 truncate">
              {showKey ? plaintext : '•'.repeat(40)}
            </div>
            <Button
              variant="ghost"
              size="icon"
              onClick={() => setShowKey((v) => !v)}
              aria-label="Toggle visibility"
            >
              {showKey ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
            </Button>
            <Button
              variant="ghost"
              size="icon"
              onClick={() => handleCopy(plaintext)}
              aria-label="Copy key"
            >
              <Copy className="h-4 w-4" />
            </Button>
          </div>
          {copied && (
            <p className="mt-1 text-xs text-green-700">Copied to clipboard!</p>
          )}
          <Button
            variant="ghost"
            size="sm"
            className="mt-2"
            onClick={() => setPlaintext(null)}
          >
            Dismiss
          </Button>
        </div>
      )}

      {/* Create new key */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Create API Key</CardTitle>
          <CardDescription>Generate a new key for agent access</CardDescription>
        </CardHeader>
        <CardContent>
          <div className="flex gap-3">
            <div className="flex-1 space-y-1.5">
              <Label htmlFor="key-name">Key name</Label>
              <Input
                id="key-name"
                placeholder="e.g. my-agent-key"
                value={newKeyName}
                onChange={(e) => setNewKeyName(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && handleCreate()}
              />
            </div>
            <div className="flex items-end">
              <Button
                onClick={handleCreate}
                disabled={!newKeyName.trim() || create.isPending}
              >
                <Plus className="mr-2 h-4 w-4" />
                Create
              </Button>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Existing keys */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Active Keys</CardTitle>
        </CardHeader>
        <CardContent>
          {isLoading ? (
            <p className="text-sm text-muted-foreground">Loading keys...</p>
          ) : apiKeys.length === 0 ? (
            <p className="text-sm text-muted-foreground">No API keys yet</p>
          ) : (
            <ul className="divide-y">
              {apiKeys.map((key) => (
                <li key={key.id} className="flex items-center gap-3 py-3">
                  <Key className="h-4 w-4 text-muted-foreground flex-shrink-0" />
                  <div className="flex-1">
                    <p className="text-sm font-medium">{key.name}</p>
                    <div className="flex items-center gap-2 mt-0.5">
                      <code className="text-xs text-muted-foreground font-mono">
                        {key.prefix}•••
                      </code>
                      {key.lastUsedAt && (
                        <span className="text-xs text-muted-foreground">
                          Last used {new Date(key.lastUsedAt).toLocaleDateString()}
                        </span>
                      )}
                    </div>
                  </div>
                  {key.expiresAt && (
                    <Badge variant="outline" className="text-xs">
                      Expires {new Date(key.expiresAt).toLocaleDateString()}
                    </Badge>
                  )}
                  <Button
                    variant="ghost"
                    size="icon"
                    onClick={() => revoke.mutate(key.id)}
                    disabled={revoke.isPending}
                    aria-label="Revoke key"
                    className="text-destructive hover:text-destructive"
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

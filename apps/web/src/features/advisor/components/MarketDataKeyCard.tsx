// MarketDataKeyCard — Unusual Whales (market-data) BYOK key surface
// (design §Component 9; REQ-10.1, REQ-10.4). Mirrors `ProviderKeyCard`:
// add/replace/delete, masked, verification status + CTA, never plaintext.
//
// Status is DERIVED from the GET status + the latest save outcome:
//   - `unconfigured` when no key is stored;
//   - `verified` / `unverified` from the GET `verified` flag or the latest save;
//   - `rejected` when a save returns code MARKET_DATA_KEY_INVALID.
//
// SECURITY: the plaintext key lives only in the controlled form field and is
// reset out of React state immediately after the save fires. It is never
// rendered back, logged, or cached.

import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { toast } from 'sonner';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  useDeleteMarketDataKey,
  useMarketDataKey,
  useSaveMarketDataKey,
} from '@/features/advisor/hooks/useMarketDataKey';

type SaveOutcome = { kind: 'verified' } | { kind: 'unverified' } | { kind: 'rejected' };

type Status = 'unconfigured' | 'configured' | 'verified' | 'unverified' | 'rejected';

interface ApiErrorShape {
  status?: number;
  error?: { code?: string; message?: string };
}

function isMarketDataKeyRejected(err: unknown): boolean {
  if (typeof err !== 'object' || err === null) return false;
  const e = err as ApiErrorShape;
  return e.error?.code === 'MARKET_DATA_KEY_INVALID';
}

interface KeyFormValues {
  apiKey: string;
}

export function MarketDataKeyCard() {
  const { data: status, isLoading, isError } = useMarketDataKey();
  const saveKey = useSaveMarketDataKey();
  const deleteKey = useDeleteMarketDataKey();

  const [outcome, setOutcome] = useState<SaveOutcome | null>(null);
  const [confirmingDelete, setConfirmingDelete] = useState(false);

  const configured = status?.configured ?? false;
  const keyHintTail = status?.configured ? status.keyHintTail : undefined;

  // Derive the displayed state: a fresh save outcome wins; otherwise fall back
  // to the persisted GET status (verified/unverified) or unconfigured.
  let derived: Status;
  if (outcome) {
    derived = outcome.kind;
  } else if (status?.configured) {
    derived = status.verified ? 'verified' : 'unverified';
  } else {
    derived = 'unconfigured';
  }

  const form = useForm<KeyFormValues>({ defaultValues: { apiKey: '' } });

  const onSubmit = form.handleSubmit(async (values) => {
    if (!values.apiKey.trim()) {
      form.setError('apiKey', { message: 'Enter an API key' });
      return;
    }
    try {
      const result = await saveKey.mutateAsync(values.apiKey);
      // Wipe the plaintext out of React state immediately after the save fires.
      form.reset({ apiKey: '' });
      if (result.verified) {
        setOutcome({ kind: 'verified' });
        toast.success('Key verified');
      } else {
        setOutcome({ kind: 'unverified' });
        toast.warning(
          'Key saved but could not be verified — Unusual Whales may be temporarily unavailable.',
        );
      }
    } catch (err) {
      if (isMarketDataKeyRejected(err)) {
        setOutcome({ kind: 'rejected' });
        form.reset({ apiKey: '' });
        toast.error(
          'API key rejected by Unusual Whales. Check that the key is current and has not been revoked.',
        );
        return;
      }
      toast.error("Couldn't save key. Try again.");
    }
  });

  const onDelete = async () => {
    try {
      await deleteKey.mutateAsync();
      setConfirmingDelete(false);
      setOutcome(null);
      form.reset({ apiKey: '' });
      toast.success('Key removed');
    } catch {
      toast.error("Couldn't remove key. Try again.");
    }
  };

  return (
    <Card data-testid="market-data-key-card">
      <CardHeader>
        <div className="flex items-center justify-between">
          <CardTitle>Unusual Whales (market data)</CardTitle>
          {configured ? (
            <Badge variant="secondary">Configured</Badge>
          ) : (
            <Badge variant="outline">Not configured</Badge>
          )}
        </div>
        {keyHintTail && <CardDescription>Key ••••••••{keyHintTail}</CardDescription>}
      </CardHeader>

      <CardContent className="space-y-4">
        {isLoading && <p className="text-sm text-muted-foreground">Loading…</p>}
        {isError && (
          <p className="text-sm text-destructive">Couldn't load key status. Try again.</p>
        )}

        {derived === 'verified' && <p className="text-sm text-success">Key verified</p>}
        {derived === 'unverified' && (
          <p className="text-sm text-warning">
            Key saved but could not be verified — Unusual Whales may be temporarily unavailable.
          </p>
        )}
        {derived === 'rejected' && (
          <p className="text-sm text-destructive">
            API key rejected by Unusual Whales. Check that the key is current and has not been
            revoked.
          </p>
        )}

        {derived === 'unconfigured' && !isLoading && outcome === null ? (
          <p className="text-sm text-muted-foreground">
            Add an Unusual Whales API key to enable market-data tools.
          </p>
        ) : null}

        <form onSubmit={onSubmit} className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="market-data-api-key">API key</Label>
            <Input
              id="market-data-api-key"
              type="password"
              autoComplete="off"
              placeholder="Paste your Unusual Whales API key"
              {...form.register('apiKey')}
            />
            {form.formState.errors.apiKey && (
              <p className="text-sm text-destructive">{form.formState.errors.apiKey.message}</p>
            )}
          </div>

          <div className="flex items-center gap-2">
            <Button type="submit" className="cursor-pointer" disabled={saveKey.isPending}>
              {saveKey.isPending ? 'Saving...' : configured ? 'Replace key' : 'Save key'}
            </Button>

            {configured &&
              (confirmingDelete ? (
                <>
                  <Button
                    type="button"
                    variant="destructive"
                    className="cursor-pointer"
                    onClick={onDelete}
                    disabled={deleteKey.isPending}
                  >
                    Confirm remove
                  </Button>
                  <Button
                    type="button"
                    variant="outline"
                    className="cursor-pointer"
                    onClick={() => setConfirmingDelete(false)}
                  >
                    Cancel
                  </Button>
                </>
              ) : (
                <Button
                  type="button"
                  variant="outline"
                  className="cursor-pointer"
                  onClick={() => setConfirmingDelete(true)}
                >
                  Remove key
                </Button>
              ))}
          </div>
        </form>
      </CardContent>
    </Card>
  );
}

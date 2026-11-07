// IbkrConnectionCard — IBKR Flex connection surface, one per Tradr account
// (design C10; Req 1.9, 1.10, 7.2). Mirrors MarketDataKeyCard: add/replace/
// delete, masked, last-fetch record, never plaintext.
//
// SECURITY: the plaintext token and query id live only in the controlled
// form fields and are reset out of React state immediately after the save
// fires, whether it resolves or rejects. Neither value is ever rendered
// back, logged, or cached (Req 1.10).

import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { toast } from 'sonner';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  useDeleteIbkrConnection,
  useIbkrConnections,
  useSaveIbkrConnection,
} from '@/features/ibkr/hooks/useIbkrConnections';

interface IbkrConnectionCardProps {
  accountId: string;
  accountName: string;
}

interface ConnectionFormValues {
  token: string;
  queryId: string;
}

export function IbkrConnectionCard({ accountId, accountName }: IbkrConnectionCardProps) {
  const { data: connections, isLoading, isError } = useIbkrConnections();
  const saveConnection = useSaveIbkrConnection();
  const deleteConnection = useDeleteIbkrConnection();

  const [confirmingRemove, setConfirmingRemove] = useState(false);

  const connection = connections?.find((c) => c.accountId === accountId);

  const form = useForm<ConnectionFormValues>({ defaultValues: { token: '', queryId: '' } });

  const tokenFieldId = `ibkr-token-${accountId}`;
  const queryIdFieldId = `ibkr-query-id-${accountId}`;

  const onSubmit = form.handleSubmit(async (values) => {
    if (!values.token.trim()) {
      form.setError('token', { message: 'Enter the Flex token' });
      return;
    }
    if (!values.queryId.trim()) {
      form.setError('queryId', { message: 'Enter the Flex query id' });
      return;
    }
    try {
      await saveConnection.mutateAsync({
        accountId,
        input: { token: values.token, queryId: values.queryId },
      });
      toast.success('Connection saved');
    } catch {
      toast.error("Couldn't save connection. Try again.");
    } finally {
      // Wipe the plaintext out of React state as soon as the save settles,
      // whether it resolved or rejected (Req 1.10).
      form.reset({ token: '', queryId: '' });
    }
  });

  const onRemove = async () => {
    try {
      await deleteConnection.mutateAsync(accountId);
      setConfirmingRemove(false);
      toast.success('Connection removed');
    } catch {
      toast.error("Couldn't remove connection. Try again.");
    }
  };

  // The card's content (masked tail, last-fetch record, inputs) depends on
  // the connections list, so nothing with the stable testid renders until
  // that first load settles — a consumer that awaits the testid never sees a
  // stale, loading-state snapshot of it.
  if (isLoading) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>{accountName}</CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-muted-foreground">Loading…</p>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card data-testid="ibkr-connection-card">
      <CardHeader>
        <div className="flex items-center justify-between">
          <CardTitle>{accountName}</CardTitle>
          {connection ? (
            <Badge variant="secondary">Connected</Badge>
          ) : (
            <Badge variant="outline">Not connected</Badge>
          )}
        </div>
        {connection && <CardDescription>Token ••••••••{connection.tokenHintTail}</CardDescription>}
      </CardHeader>

      <CardContent className="space-y-4">
        {isError && (
          <p className="text-sm text-destructive">Couldn't load connection status. Try again.</p>
        )}

        {connection &&
          (connection.lastFetchedAt ? (
            <p className="text-sm text-muted-foreground">
              Last fetched {connection.lastFetchedAt} — report {connection.lastPeriodStart} to{' '}
              {connection.lastPeriodEnd}
            </p>
          ) : (
            <p className="text-sm text-muted-foreground">No fetch yet</p>
          ))}

        {!connection && (
          <p className="text-sm text-muted-foreground">
            Add a Flex Web Service token and query id to import this account's trades from IBKR.
          </p>
        )}

        <form onSubmit={onSubmit} className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor={tokenFieldId}>Token</Label>
            <Input
              id={tokenFieldId}
              type="password"
              autoComplete="off"
              placeholder="Flex Web Service token"
              {...form.register('token')}
            />
            {form.formState.errors.token && (
              <p className="text-sm text-destructive">{form.formState.errors.token.message}</p>
            )}
          </div>

          <div className="space-y-2">
            <Label htmlFor={queryIdFieldId}>Query ID</Label>
            <Input
              id={queryIdFieldId}
              type="password"
              autoComplete="off"
              placeholder="Flex query id"
              {...form.register('queryId')}
            />
            {form.formState.errors.queryId && (
              <p className="text-sm text-destructive">{form.formState.errors.queryId.message}</p>
            )}
          </div>

          <div className="flex items-center gap-2">
            <Button type="submit" className="cursor-pointer" disabled={saveConnection.isPending}>
              {saveConnection.isPending
                ? 'Saving...'
                : connection
                  ? 'Replace connection'
                  : 'Save connection'}
            </Button>

            {connection &&
              (confirmingRemove ? (
                <>
                  <Button
                    type="button"
                    variant="destructive"
                    className="cursor-pointer"
                    onClick={onRemove}
                    disabled={deleteConnection.isPending}
                  >
                    Confirm remove
                  </Button>
                  <Button
                    type="button"
                    variant="outline"
                    className="cursor-pointer"
                    onClick={() => setConfirmingRemove(false)}
                  >
                    Cancel
                  </Button>
                </>
              ) : (
                <Button
                  type="button"
                  variant="outline"
                  className="cursor-pointer"
                  onClick={() => setConfirmingRemove(true)}
                >
                  Remove connection
                </Button>
              ))}
          </div>
        </form>
      </CardContent>
    </Card>
  );
}

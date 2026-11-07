// FlexFetchButton — the import page's one-button fetch (design C11; Req 2.1,
// 7.2). Sits beside FileUpload in the file step and shows the last-fetch
// record for the connection, mirroring IbkrConnectionCard's own line.

import type { IbkrConnectionStatus } from '@tradr/shared';

import { Button } from '@/components/ui/button';

interface FlexFetchButtonProps {
  connection: IbkrConnectionStatus;
  onFetch: () => void;
  isFetching: boolean;
}

export function FlexFetchButton({ connection, onFetch, isFetching }: FlexFetchButtonProps) {
  return (
    <div className="space-y-2">
      <Button type="button" className="cursor-pointer" onClick={onFetch} disabled={isFetching}>
        {isFetching ? 'Fetching…' : 'Fetch my Flex report'}
      </Button>
      {connection.lastFetchedAt ? (
        <p className="text-sm text-muted-foreground">
          Last fetched {connection.lastFetchedAt} — report {connection.lastPeriodStart} to{' '}
          {connection.lastPeriodEnd}
        </p>
      ) : (
        <p className="text-sm text-muted-foreground">No fetch yet</p>
      )}
    </div>
  );
}

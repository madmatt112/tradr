/**
 * The staleness statement every surface shows beside a displayed price
 * (design C9, D14; Req 8.1). Renders nothing when there is no price to be
 * stale, otherwise states the provider delay and the local time of the
 * oldest price shown.
 */
export function QuoteStaleness({ oldestFetchedAt }: { oldestFetchedAt: string | null }) {
  if (oldestFetchedAt === null) return null;

  const localTime = new Date(oldestFetchedAt).toLocaleTimeString(undefined, {
    hour: 'numeric',
    minute: '2-digit',
  });

  return (
    <span className="text-sm text-muted-foreground">
      Prices are delayed about 15 minutes; oldest as of {localTime}.
    </span>
  );
}

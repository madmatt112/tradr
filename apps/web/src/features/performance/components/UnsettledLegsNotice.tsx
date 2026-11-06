import { Link } from '@tanstack/react-router';

export interface UnsettledLegsNoticeProps {
  pastExpiryUnsettledLegs?: number;
}

/**
 * UnsettledLegsNotice (design C10, Req 1.5): the count of past-expiry,
 * unsettled legs across all accounts, rendered beside `DataQualityBanner`.
 * The key is absent at zero (`packages/shared/src/schemas/performance.ts:225-240`),
 * so an absent prop means "nothing to flag", not "zero legs" — render nothing.
 * The `warning` status role, never `gain`/`loss` or brand amber (design System
 * Status roles), matching `PastExpiryChip`.
 */
export function UnsettledLegsNotice({ pastExpiryUnsettledLegs }: UnsettledLegsNoticeProps) {
  if (pastExpiryUnsettledLegs === undefined) return null;

  return (
    <div
      data-testid="unsettled-legs-notice"
      className="flex items-center gap-2 rounded-lg border border-warning/50 px-4 py-3 text-sm text-warning"
    >
      <span>
        {pastExpiryUnsettledLegs} past-expiry {pastExpiryUnsettledLegs === 1 ? 'leg' : 'legs'}{' '}
        unsettled.
      </span>
      <Link
        to="/positions"
        className="cursor-pointer underline underline-offset-2 hover:text-warning/80"
      >
        View positions
      </Link>
    </div>
  );
}

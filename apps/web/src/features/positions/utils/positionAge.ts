const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * The position's age for the list's Age column: whole days from `openedAt` to
 * `closedAt` (for closed positions) or to now. `null` when it never opened —
 * a draft has no age. Rendered as the mock's compact "48d".
 */
export function positionAgeDays(
  openedAt: string | null,
  closedAt: string | null,
  now: Date = new Date(),
): number | null {
  if (openedAt === null) return null;
  const opened = new Date(openedAt).getTime();
  if (Number.isNaN(opened)) return null;
  const end = closedAt !== null ? new Date(closedAt).getTime() : now.getTime();
  if (Number.isNaN(end)) return null;
  return Math.max(0, Math.floor((end - opened) / DAY_MS));
}

/** Compact fill-date label for the inspect ledger ("Jul 4"). */
export function formatFillDate(filledAt: string): string {
  const date = new Date(filledAt);
  if (Number.isNaN(date.getTime())) return '—';
  return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

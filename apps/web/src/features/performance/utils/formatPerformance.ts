import { formatInTimeZone } from 'date-fns-tz';

import type { Granularity } from '@tradr/shared';

import {
  EM_DASH,
  formatMoney,
  formatPercent,
  formatProfitFactor,
  NULL_PLACEHOLDER,
} from '@/lib/format';

// Re-export the shared formatting home's symbols so callers in this feature
// import everything from one place. Re-export — DO NOT redefine.
// `formatPercent`/`formatProfitFactor` and the `EM_DASH`/`NULL_PLACEHOLDER`
// absent markers were consolidated into `@/lib/format` (visual-design Task 4).
export { EM_DASH, formatMoney, formatPercent, formatProfitFactor, NULL_PLACEHOLDER };

/**
 * Format a bucket-start ISO timestamp for display, using a label appropriate
 * for the granularity:
 *
 *   - `day`   → `Mar 15`
 *   - `week`  → `Mar 15–21`           (en dash, U+2013)
 *   - `month` → `Mar 2026`
 *   - `year`  → `2026`
 *
 * All formatting honors the resolved IANA timezone (`tz`) so a UTC bucket-start
 * such as `2026-03-15T05:00:00.000Z` may render as `Mar 15` in `America/New_York`
 * even though the UTC date is the same hour-window.
 *
 * Week labels span the bucket's seven days (start + 6); we don't trim trailing
 * days when the bucket is short — the API contract makes every bucket a full
 * week-on-week-off boundary, so 6 is always correct.
 */
export function formatBucketLabel(
  bucketStart: string,
  granularity: Granularity,
  tz: string,
): string {
  const start = new Date(bucketStart);
  switch (granularity) {
    case 'day':
      return formatInTimeZone(start, tz, 'MMM d');
    case 'week': {
      // End of the week-bucket = start + 6 days. Add the offset in UTC ms; the
      // formatter then shifts to `tz` for display, which is correct because we
      // want "the day six wall-clock days after start" — not "six 24h windows
      // after start" with DST drift. For week granularity this distinction is
      // immaterial (always 7 × 24h = 168h between week boundaries), but using
      // formatInTimeZone keeps everything in the same tz-aware code path.
      const end = new Date(start.getTime() + 6 * 24 * 60 * 60 * 1000);
      const startLabel = formatInTimeZone(start, tz, 'MMM d');
      const endDay = formatInTimeZone(end, tz, 'd');
      return `${startLabel}–${endDay}`;
    }
    case 'month':
      return formatInTimeZone(start, tz, 'MMM yyyy');
    case 'year':
      return formatInTimeZone(start, tz, 'yyyy');
  }
}

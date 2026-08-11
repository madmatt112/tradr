// The one record of "the server rejected this reporting timezone".
//
// It exists so a performance request that failed on an unrecognised IANA zone
// can be retried ONCE with `tz` omitted (the server then uses its own default)
// without that retry looping. Previously this was a bare "seen it" boolean that
// was written once and never cleared, which pinned the whole tab to UTC for the
// rest of its session: every later request kept dropping `tz`, so correcting the
// preference changed nothing.
//
// So the record is keyed by the zone that was actually rejected, and it has a
// lifecycle:
//   - written when a request carrying that zone fails with INVALID_TIMEZONE;
//   - cleared when a request that CARRIED a zone succeeds;
//   - cleared when the user changes their reporting timezone.
// A zone that is not the recorded one is always sent, so a corrected preference
// takes effect on the next request — no page reload involved.
//
// It lives in `lib/` rather than inside the performance feature because three
// unrelated callers need it: the performance query (which reads and writes it),
// the route loader that prefetches that query (which reads it), and the
// reporting-timezone preference (which clears it). A feature module cannot own
// state a global preference hook has to reset.

const REJECTED_TZ_KEY = 'perf.invalid_tz';

// Safari private browsing throws on sessionStorage access. Reads and writes
// must agree in that mode or the UI disagrees with the request it is
// describing, so BOTH sides consult this fallback.
let rejectedTzFallback: string | null = null;
// Reads prefer sessionStorage because it survives a reload, but that preference
// is only safe while sessionStorage is in step with us. A write that throws
// leaves the previous value behind — a failed `removeItem` in particular would
// let reads keep returning the very zone the clear was meant to forget, which
// is the session-sticky fallback this module exists to end. Once a write fails,
// the in-memory record is the only truthful one.
let rejectedTzStorageStale = false;
let storageWarned = false;

function warnStorageOnce(err: unknown): void {
  if (storageWarned) return;
  storageWarned = true;
  console.warn('[invalidTimezone] sessionStorage unavailable; using in-memory fallback', err);
}

/** The IANA zone the server most recently rejected, or `null`. */
export function readRejectedTimezone(): string | null {
  if (!rejectedTzStorageStale) {
    try {
      const stored = sessionStorage.getItem(REJECTED_TZ_KEY);
      if (stored) return stored;
    } catch (err) {
      warnStorageOnce(err);
    }
  }
  return rejectedTzFallback;
}

/** True when `tz` is the zone the server rejected — so requests must omit it. */
export function isTimezoneRejected(tz: string | null | undefined): boolean {
  if (!tz) return false;
  return readRejectedTimezone() === tz;
}

export function recordRejectedTimezone(tz: string): void {
  rejectedTzFallback = tz;
  try {
    sessionStorage.setItem(REJECTED_TZ_KEY, tz);
    rejectedTzStorageStale = false;
  } catch (err) {
    warnStorageOnce(err);
    rejectedTzStorageStale = true;
  }
}

/**
 * Forget the rejected zone. Called on a successful performance request that
 * carried a zone, and whenever the reporting timezone changes — both mean the
 * recorded zone is no longer the one being asked for.
 */
export function clearRejectedTimezone(): void {
  rejectedTzFallback = null;
  try {
    sessionStorage.removeItem(REJECTED_TZ_KEY);
    rejectedTzStorageStale = false;
  } catch (err) {
    warnStorageOnce(err);
    rejectedTzStorageStale = true;
  }
}

/** Test seam — clears the module-local fallback so test runs are isolated. */
export function __resetInvalidTimezoneState(): void {
  rejectedTzFallback = null;
  rejectedTzStorageStale = false;
  storageWarned = false;
}

// The one record of "the stored reporting zone the app last reconciled the
// performance URL against".
//
// It exists so a stored-zone change made on Settings → Profile re-buckets the
// calendar and the breakdown when the user returns to the performance route or
// reloads its stale complete URL. Neither a per-mount previous-zone comparison
// (a fresh mount on return has no in-session predecessor) nor the mutation's
// `onSuccess` (it cannot navigate a route that is not mounted) fires for that
// flow, so the resync is driven off the zone the URL `tz` was last written
// under: when the stored zone differs from the recorded one, the URL is
// rewritten.
//
// The durable tier is `sessionStorage`, so the record survives BOTH a route
// unmount and a full page reload — a same-tab reload after the change resyncs
// too, not only a route unmount (R1.9). The module-level `let` is only the
// in-memory fallback for when `sessionStorage` throws (Safari private mode); it
// resets to `null` on a reload and MUST NOT be the durable tier.
//
// It lives in `lib/` rather than inside the performance feature because the
// route reads it (the resync effect) and the session teardown clears it. A
// feature module cannot own state a global teardown has to reset.

const TZ_PROVENANCE_KEY = 'perf.tz_provenance';

// Safari private browsing throws on sessionStorage access. Reads and writes
// must agree in that mode or the resync compares against the wrong zone, so
// BOTH sides consult this fallback.
let tzProvenanceFallback: string | null = null;
// Reads prefer sessionStorage because it survives a reload, but that preference
// is only safe while sessionStorage is in step with us. A write that throws
// leaves the previous value behind, so once a write fails the in-memory record
// is the only truthful one.
let tzProvenanceStorageStale = false;
let storageWarned = false;

function warnStorageOnce(err: unknown): void {
  if (storageWarned) return;
  storageWarned = true;
  console.warn('[reportingTzProvenance] sessionStorage unavailable; using in-memory fallback', err);
}

/** The reporting zone the performance URL was last reconciled to, or `null`. */
export function readTzProvenance(): string | null {
  if (!tzProvenanceStorageStale) {
    try {
      const stored = sessionStorage.getItem(TZ_PROVENANCE_KEY);
      if (stored) return stored;
    } catch (err) {
      warnStorageOnce(err);
    }
  }
  return tzProvenanceFallback;
}

/** Record the reporting zone the URL `tz` was just reconciled to. */
export function writeTzProvenance(zone: string): void {
  tzProvenanceFallback = zone;
  try {
    sessionStorage.setItem(TZ_PROVENANCE_KEY, zone);
    tzProvenanceStorageStale = false;
  } catch (err) {
    warnStorageOnce(err);
    tzProvenanceStorageStale = true;
  }
}

/**
 * Forget the recorded zone. Called from `clearClientSessionState` so a second
 * user on the same tab starts with an empty store.
 */
export function clearTzProvenance(): void {
  tzProvenanceFallback = null;
  try {
    sessionStorage.removeItem(TZ_PROVENANCE_KEY);
    tzProvenanceStorageStale = false;
  } catch (err) {
    warnStorageOnce(err);
    tzProvenanceStorageStale = true;
  }
}

/** Test seam — clears the module-local fallback so test runs are isolated. */
export function __resetTzProvenanceState(): void {
  tzProvenanceFallback = null;
  tzProvenanceStorageStale = false;
  storageWarned = false;
}

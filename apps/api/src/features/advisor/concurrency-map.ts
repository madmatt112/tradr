// Per-user single-in-flight-stream concurrency cap (REQ-3.5).
//
// Each user may hold at most one streaming slot at a time. `acquire` throws
// StreamInProgressError if the user already holds a slot. The returned
// `combinedSignal` is derived from the caller's `externalSignal` (client
// disconnect) and an internal AbortController (wall-clock / inactivity timers),
// so the route can abort the stream via either path. `release` removes the slot
// synchronously — no setTimeout deferral.

import { StreamInProgressError } from './advisor.errors';

export class ConcurrencyMap {
  private byUser = new Map<string, AbortController>();

  acquire(
    userId: string,
    externalSignal: AbortSignal,
  ): { release: () => void; combinedSignal: AbortSignal } {
    if (this.byUser.has(userId)) {
      throw new StreamInProgressError();
    }

    const internal = new AbortController();
    this.byUser.set(userId, internal);

    // Fold the external signal into the internal controller so both abort paths
    // surface through one combinedSignal.
    const onExternalAbort = () => internal.abort();
    if (externalSignal.aborted) {
      internal.abort();
    } else {
      externalSignal.addEventListener('abort', onExternalAbort, { once: true });
    }

    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      externalSignal.removeEventListener('abort', onExternalAbort);
      // Only remove the slot if it is still the one we created — never silently
      // overwrite or clobber a slot a later acquire may own.
      if (this.byUser.get(userId) === internal) {
        this.byUser.delete(userId);
      }
    };

    return { release, combinedSignal: internal.signal };
  }
}

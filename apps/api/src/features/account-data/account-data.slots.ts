/**
 * Per-process, one-at-a-time slots for the export and import flows (design D5).
 * Each slot is a FIFO async mutex: `acquire`/`run` queue later requests behind
 * the current holder and run them in the order they arrived, while `tryAcquire`
 * takes a free slot without queueing. The export flow queues; the import flow
 * uses `tryAcquire` to refuse at once when its slot is held (design C2). The
 * whole memory envelope assumes exactly one export and one import in flight per
 * process.
 */

export type AccountDataSlotKind = 'export' | 'import';

export interface Slot {
  /**
   * Wait for the slot, then return an idempotent `release`. The holder MUST call
   * it on both success and failure (a stream that releases in its close handler,
   * a restore that releases in a `finally`). Calling it twice is a no-op.
   */
  acquire(): Promise<() => void>;
  /**
   * Take the slot only when it is free — no holder and no waiter — and return an
   * idempotent `release`, or return `null` at once without queueing when it is
   * held. Like `acquire`'s release, the holder MUST call it on success and
   * failure, and calling it twice is a no-op.
   */
  tryAcquire(): (() => void) | null;
  /**
   * Run `fn` while holding the slot, releasing on success or throw. The next
   * queued caller proceeds even when `fn` rejects.
   */
  run<T>(fn: () => Promise<T> | T): Promise<T>;
}

export function createSlot(): Slot {
  // Chained-promise mutex: `tail` resolves when the current holder releases, so
  // the next acquire waits on it before taking the slot. FIFO by construction.
  let tail: Promise<void> = Promise.resolve();
  // Outstanding holders and waiters. Zero means the slot is free; `tryAcquire`
  // checks it synchronously to refuse without queueing when it is non-zero.
  let holders = 0;

  const acquire = (): Promise<() => void> => {
    holders += 1;
    let releaseNext!: () => void;
    const held = new Promise<void>((resolve) => {
      releaseNext = resolve;
    });
    const acquired = tail.then(() => {
      let released = false;
      return () => {
        if (released) return;
        released = true;
        holders -= 1;
        releaseNext();
      };
    });
    tail = held;
    return acquired;
  };

  const tryAcquire = (): (() => void) | null => {
    if (holders > 0) return null;
    holders += 1;
    let releaseNext!: () => void;
    const held = new Promise<void>((resolve) => {
      releaseNext = resolve;
    });
    tail = held;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      holders -= 1;
      releaseNext();
    };
  };

  const run = async <T>(fn: () => Promise<T> | T): Promise<T> => {
    const release = await acquire();
    try {
      return await fn();
    } finally {
      release();
    }
  };

  return { acquire, tryAcquire, run };
}

const slots: Record<AccountDataSlotKind, Slot> = {
  export: createSlot(),
  import: createSlot(),
};

/** The process-wide slot for a kind. */
export function accountDataSlot(kind: AccountDataSlotKind): Slot {
  return slots[kind];
}

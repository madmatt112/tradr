/**
 * Per-process, one-at-a-time slots for the export and import flows (design D8).
 * Each slot is a FIFO async mutex: later requests queue behind the current
 * holder and run in the order they arrived. The whole memory envelope assumes
 * exactly one export and one import in flight per process.
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
   * Run `fn` while holding the slot, releasing on success or throw. The next
   * queued caller proceeds even when `fn` rejects.
   */
  run<T>(fn: () => Promise<T> | T): Promise<T>;
}

export function createSlot(): Slot {
  // Chained-promise mutex: `tail` resolves when the current holder releases, so
  // the next acquire waits on it before taking the slot. FIFO by construction.
  let tail: Promise<void> = Promise.resolve();

  const acquire = (): Promise<() => void> => {
    let releaseNext!: () => void;
    const held = new Promise<void>((resolve) => {
      releaseNext = resolve;
    });
    const acquired = tail.then(() => {
      let released = false;
      return () => {
        if (released) return;
        released = true;
        releaseNext();
      };
    });
    tail = held;
    return acquired;
  };

  const run = async <T>(fn: () => Promise<T> | T): Promise<T> => {
    const release = await acquire();
    try {
      return await fn();
    } finally {
      release();
    }
  };

  return { acquire, run };
}

const slots: Record<AccountDataSlotKind, Slot> = {
  export: createSlot(),
  import: createSlot(),
};

/** The process-wide slot for a kind. */
export function accountDataSlot(kind: AccountDataSlotKind): Slot {
  return slots[kind];
}

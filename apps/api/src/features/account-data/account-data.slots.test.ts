import { describe, expect, it } from 'vitest';

import { accountDataSlot, createSlot } from './account-data.slots';

const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

function deferred<T = void>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

describe('createSlot', () => {
  it('serializes two holders in FIFO order', async () => {
    const slot = createSlot();
    const order: string[] = [];
    const aStarted = deferred();
    const aRelease = deferred();

    const aDone = slot.run(async () => {
      order.push('a-start');
      aStarted.resolve();
      await aRelease.promise;
      order.push('a-end');
    });

    await aStarted.promise;

    let bRan = false;
    const bDone = slot.run(async () => {
      bRan = true;
      order.push('b');
    });

    await tick();
    expect(bRan).toBe(false); // b waits while a holds the slot

    aRelease.resolve();
    await Promise.all([aDone, bDone]);
    expect(order).toEqual(['a-start', 'a-end', 'b']);
  });

  it('frees the slot when a holder throws', async () => {
    const slot = createSlot();

    await expect(
      slot.run(async () => {
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');

    // the next holder still gets the slot
    await expect(slot.run(async () => 'ok')).resolves.toBe('ok');
  });

  it('acquire() returns an idempotent release that unblocks the next waiter', async () => {
    const slot = createSlot();
    const release = await slot.acquire();

    let secondAcquired = false;
    const second = slot.acquire().then((r) => {
      secondAcquired = true;
      return r;
    });

    await tick();
    expect(secondAcquired).toBe(false);

    release();
    release(); // idempotent, no throw and no double-unblock
    const releaseSecond = await second;
    expect(secondAcquired).toBe(true);
    releaseSecond();
  });
});

/**
 * Contract — createSlot().tryAcquire() (design C2; Requirements 4.1, 4.2, 4.3)
 *
 * | Criterion (task 4 Success)                                           | Pre-condition                                    | Call (seam)           | Observable result                              | Expected-value source |
 * | --------------------------------------------------------------------- | ------------------------------------------------- | ---------------------- | ------------------------------------------------ | ---------------------- |
 * | null while held by `acquire()`                                       | holder took the slot via `acquire()`              | `slot.tryAcquire()`    | returns `null`, no queueing                     | design C2: "returning `null` when there is a holder or waiter" |
 * | null while held by an earlier `tryAcquire()`                         | holder took the slot via `tryAcquire()`           | `slot.tryAcquire()`    | returns `null`                                  | design C2: same |
 * | returns a release after the holder releases                         | prior holder's release has run                    | `slot.tryAcquire()`    | returns a function, not `null`                  | design C2: "an idempotent release" |
 * | a second call of that release is a no-op                            | release already called once                       | `release()` again      | no further effect: the slot is not freed twice  | task 4 _Prompt Success: "a second call of that release is a no-op" |
 * | a queued `acquire()` still runs after a `tryAcquire` holder releases | `tryAcquire` holds; `acquire()` queued behind it  | holder's `release()`   | the queued `acquire()` promise resolves         | task 4 _Prompt Success + Requirement 4.3: `acquire`/`run` FIFO order unchanged |
 */
describe('createSlot().tryAcquire()', () => {
  it('returns null while the slot is held by acquire()', async () => {
    const slot = createSlot();
    const release = await slot.acquire();

    expect(slot.tryAcquire()).toBeNull();

    release();
  });

  it('returns null while the slot is held by an earlier tryAcquire()', () => {
    const slot = createSlot();
    const firstRelease = slot.tryAcquire();
    expect(firstRelease).not.toBeNull();

    expect(slot.tryAcquire()).toBeNull();

    firstRelease!();
  });

  it('returns a release after the holder releases', () => {
    const slot = createSlot();
    const firstRelease = slot.tryAcquire();
    expect(firstRelease).not.toBeNull();
    firstRelease!();

    const secondRelease = slot.tryAcquire();
    expect(secondRelease).not.toBeNull();
    secondRelease!();
  });

  it('a second call of that release is a no-op', () => {
    const slot = createSlot();
    const release = slot.tryAcquire();
    expect(release).not.toBeNull();

    release!();
    release!(); // idempotent: must not throw and must not free the slot a second time

    const next = slot.tryAcquire();
    expect(next).not.toBeNull(); // the single real release freed the slot exactly once

    const whileNextHolds = slot.tryAcquire();
    expect(whileNextHolds).toBeNull(); // the second release() call above did not free it again

    next!();
  });

  it('a queued acquire still runs after a tryAcquire holder releases', async () => {
    const slot = createSlot();
    const holderRelease = slot.tryAcquire();
    expect(holderRelease).not.toBeNull();

    let queuedAcquired = false;
    const queued = slot.acquire().then((release) => {
      queuedAcquired = true;
      return release;
    });

    await tick();
    expect(queuedAcquired).toBe(false);

    holderRelease!();

    const queuedRelease = await queued;
    expect(queuedAcquired).toBe(true);
    queuedRelease();
  });
});

describe('accountDataSlot', () => {
  it('gives a distinct, independent slot per kind', async () => {
    expect(accountDataSlot('export')).not.toBe(accountDataSlot('import'));

    const releaseExport = await accountDataSlot('export').acquire();
    // A different kind is not blocked by the export holder.
    await expect(accountDataSlot('import').run(async () => 'import-ran')).resolves.toBe(
      'import-ran',
    );
    releaseExport();
  });
});

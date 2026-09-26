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

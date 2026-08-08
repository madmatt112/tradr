// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render } from '@testing-library/react';
import { afterEach, describe, expect, it, type MockInstance, vi } from 'vitest';

import { eventBus } from './event-bus.store';
import { EventBusBridge } from './EventBusBridge';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function mountBridge(): { qc: QueryClient; unmount: () => void } {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const { unmount } = render(
    <QueryClientProvider client={qc}>
      <EventBusBridge />
    </QueryClientProvider>,
  );
  return { qc, unmount };
}

function invalidatedKeys(spy: MockInstance): unknown[][] {
  return spy.mock.calls.map((call) => {
    const [filters] = call;
    return (filters as { queryKey: unknown[] }).queryKey;
  });
}

afterEach(() => {
  eventBus.__resetForTests();
  vi.restoreAllMocks();
});

describe('EventBusBridge', () => {
  it('invalidates accounts, dashboard totals, and performance on reason=closed', () => {
    const { qc, unmount } = mountBridge();
    const spy = vi.spyOn(qc, 'invalidateQueries');

    eventBus.publish('positions:cache-invalidate', { reason: 'closed' });

    expect(spy).toHaveBeenCalledTimes(3);
    expect(invalidatedKeys(spy)).toEqual([['accounts'], ['dashboard', 'totals'], ['performance']]);

    unmount();
  });

  it('invalidates accounts, dashboard totals, and performance on reason=reopened', () => {
    const { qc, unmount } = mountBridge();
    const spy = vi.spyOn(qc, 'invalidateQueries');

    eventBus.publish('positions:cache-invalidate', { reason: 'reopened' });

    expect(spy).toHaveBeenCalledTimes(3);
    expect(invalidatedKeys(spy)).toEqual([['accounts'], ['dashboard', 'totals'], ['performance']]);

    unmount();
  });

  it('invalidates performance only on reason=opened', () => {
    const { qc, unmount } = mountBridge();
    const spy = vi.spyOn(qc, 'invalidateQueries');

    eventBus.publish('positions:cache-invalidate', { reason: 'opened' });

    expect(spy).toHaveBeenCalledTimes(1);
    expect(invalidatedKeys(spy)).toEqual([['performance']]);

    unmount();
  });

  it('invalidates performance only on reason=updated', () => {
    const { qc, unmount } = mountBridge();
    const spy = vi.spyOn(qc, 'invalidateQueries');

    eventBus.publish('positions:cache-invalidate', { reason: 'updated' });

    expect(spy).toHaveBeenCalledTimes(1);
    expect(invalidatedKeys(spy)).toEqual([['performance']]);

    unmount();
  });

  it('invalidates performance only on reason=fill-added', () => {
    const { qc, unmount } = mountBridge();
    const spy = vi.spyOn(qc, 'invalidateQueries');

    eventBus.publish('positions:cache-invalidate', { reason: 'fill-added' });

    expect(spy).toHaveBeenCalledTimes(1);
    expect(invalidatedKeys(spy)).toEqual([['performance']]);

    unmount();
  });

  it('invalidates performance only on reason=fill-updated', () => {
    const { qc, unmount } = mountBridge();
    const spy = vi.spyOn(qc, 'invalidateQueries');

    eventBus.publish('positions:cache-invalidate', { reason: 'fill-updated' });

    expect(spy).toHaveBeenCalledTimes(1);
    expect(invalidatedKeys(spy)).toEqual([['performance']]);

    unmount();
  });

  it('invalidates performance only on reason=fill-deleted', () => {
    const { qc, unmount } = mountBridge();
    const spy = vi.spyOn(qc, 'invalidateQueries');

    eventBus.publish('positions:cache-invalidate', { reason: 'fill-deleted' });

    expect(spy).toHaveBeenCalledTimes(1);
    expect(invalidatedKeys(spy)).toEqual([['performance']]);

    unmount();
  });

  it('invalidates nothing on reason=created (draft create is a no-op)', () => {
    const { qc, unmount } = mountBridge();
    const spy = vi.spyOn(qc, 'invalidateQueries');

    eventBus.publish('positions:cache-invalidate', { reason: 'created' });

    expect(spy).not.toHaveBeenCalled();

    unmount();
  });

  it('refreshes every derived surface when sample data is seeded', () => {
    const { qc, unmount } = mountBridge();
    const spy = vi.spyOn(qc, 'invalidateQueries');

    // A whole account's worth of positions, fills and ledger rows appears in
    // one call, so the dashboard, the lists and performance are all stale at
    // once — and the seeding hook names none of these keys.
    eventBus.publish('accounts:cache-invalidate', { reason: 'demo-seeded' });

    expect(invalidatedKeys(spy)).toEqual([
      ['accounts'],
      ['positions'],
      ['dashboard', 'totals'],
      ['performance'],
    ]);

    unmount();
  });

  it('refreshes the same surfaces when sample data is removed', () => {
    const { qc, unmount } = mountBridge();
    const spy = vi.spyOn(qc, 'invalidateQueries');

    eventBus.publish('accounts:cache-invalidate', { reason: 'demo-removed' });

    expect(invalidatedKeys(spy)).toEqual([
      ['accounts'],
      ['positions'],
      ['dashboard', 'totals'],
      ['performance'],
    ]);

    unmount();
  });

  it('invalidates nothing on an account create', () => {
    const { qc, unmount } = mountBridge();
    const spy = vi.spyOn(qc, 'invalidateQueries');

    // `useCreateAccount` invalidates its own queries; this event exists for the
    // walkthrough's advance-on-action step, not for cache work.
    eventBus.publish('accounts:cache-invalidate', { reason: 'created' });

    expect(spy).not.toHaveBeenCalled();

    unmount();
  });

  it('invalidates accounts, dashboard totals, and performance on reason=deleted', () => {
    const { qc, unmount } = mountBridge();
    const spy = vi.spyOn(qc, 'invalidateQueries');

    // Deleting a CLOSED position reverses its realized P&L via a ledger row, moving the
    // derived account balance — so balance-bearing queries must refresh.
    eventBus.publish('positions:cache-invalidate', { reason: 'deleted' });

    expect(spy).toHaveBeenCalledTimes(3);
    expect(invalidatedKeys(spy)).toEqual([['accounts'], ['dashboard', 'totals'], ['performance']]);

    unmount();
  });
});

// Isolated from performance.test.ts so the week-start-flip case can use
// `vi.resetModules() + vi.doMock(@/lib/config)` without poisoning the
// top-level `import app from '@/app'` shared by every other case in the
// main file (r5 pre-submit note (C)).

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { db } from '@/db';
import { accounts, users } from '@/db/schema';

let counter = 0;

async function seedUserAndAccount() {
  const [user] = await db
    .insert(users)
    .values({
      email: `perf-ws-${Date.now()}-${++counter}@example.com`,
      passwordHash: 'x'.repeat(60),
    })
    .returning();
  const [account] = await db
    .insert(accounts)
    .values({ userId: user!.id, name: `Acc-${counter}`, currency: 'USD' })
    .returning();
  return { userId: user!.id, accountId: account!.id };
}

async function loadServiceWithWeekStartDay(weekStartDay: 0 | 1) {
  vi.doMock('@/lib/config', async () => {
    const actual = await vi.importActual<typeof import('@/lib/config')>('@/lib/config');
    return { ...actual, config: { ...actual.config, WEEK_START_DAY: weekStartDay } };
  });
  const mod = await import('./performance.service');
  return mod.getPerformance;
}

describe('GET /api/performance — resolvedWeekStartDay reflects WEEK_START_DAY config', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    vi.doUnmock('@/lib/config');
    vi.resetModules();
  });

  it('echoes resolvedWeekStartDay=0 when WEEK_START_DAY=0', async () => {
    const getPerformance = await loadServiceWithWeekStartDay(0);
    const { userId } = await seedUserAndAccount();

    const result = await getPerformance(
      db,
      userId,
      {
        granularity: 'week',
        start: '2026-01-04T00:00:00.000Z',
        end: '2026-02-01T00:00:00.000Z',
        tz: 'UTC',
      },
      new AbortController().signal,
      Date.now(),
    );
    expect(result.resolvedWeekStartDay).toBe(0);
  });

  it('echoes resolvedWeekStartDay=1 when WEEK_START_DAY=1', async () => {
    const getPerformance = await loadServiceWithWeekStartDay(1);
    const { userId } = await seedUserAndAccount();

    const result = await getPerformance(
      db,
      userId,
      {
        granularity: 'week',
        start: '2026-01-05T00:00:00.000Z',
        end: '2026-02-02T00:00:00.000Z',
        tz: 'UTC',
      },
      new AbortController().signal,
      Date.now(),
    );
    expect(result.resolvedWeekStartDay).toBe(1);
  });
});

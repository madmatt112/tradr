import { describe, it, expect } from 'vitest';

import { db } from '@/db';
import { accounts, users } from '@/db/schema';
import { seedPositions as seedPositionsRows } from '@/db/seed';
import { selectAccountSummaries } from '@/features/accounts/accounts.query';
import {
  selectOpenPositionsSummary,
  selectRecentClosedSummary,
  OPEN_POSITIONS_SUMMARY_CAP,
  RECENT_CLOSED_SUMMARY_CAP,
} from '@/features/positions/positions.query';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let counter = 0;
function uniqueEmail(): string {
  return `tradedata-${Date.now()}-${++counter}@example.com`;
}

async function seedUser(): Promise<{ id: string }> {
  const [user] = await db
    .insert(users)
    .values({ email: uniqueEmail(), passwordHash: 'x'.repeat(60), displayCurrency: 'USD' })
    .returning();
  return { id: user!.id };
}

async function seedAccount(userId: string, name: string): Promise<{ id: string }> {
  const [account] = await db.insert(accounts).values({ userId, name, currency: 'USD' }).returning();
  return { id: account!.id };
}

// Seed through the shared positions seed helper (which sets openedAt/closedAt
// consistently with the status/closed_at CHECK constraint) rather than a direct
// db.insert(positions), which bypasses the positions feature's invariant layer.
async function seedPositions(
  userId: string,
  accountId: string,
  status: 'open' | 'closed',
  count: number,
): Promise<void> {
  await seedPositionsRows(db, { userId, accountId, status, count });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('selectOpenPositionsSummary', () => {
  it("is userId-scoped — never returns another user's positions", async () => {
    const owner = await seedUser();
    const intruder = await seedUser();
    const ownerAcct = await seedAccount(owner.id, 'Owner');
    const intruderAcct = await seedAccount(intruder.id, 'Intruder');
    await seedPositions(owner.id, ownerAcct.id, 'open', 2);
    await seedPositions(intruder.id, intruderAcct.id, 'open', 3);

    const rows = await selectOpenPositionsSummary(db, owner.id);
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r.accountName === 'Owner')).toBe(true);
  });

  it('only returns open positions (excludes closed/draft)', async () => {
    const user = await seedUser();
    const acct = await seedAccount(user.id, 'Acct');
    await seedPositions(user.id, acct.id, 'open', 1);
    await seedPositions(user.id, acct.id, 'closed', 4);

    const rows = await selectOpenPositionsSummary(db, user.id);
    expect(rows).toHaveLength(1);
  });

  it('caps at OPEN_POSITIONS_SUMMARY_CAP (50)', async () => {
    const user = await seedUser();
    const acct = await seedAccount(user.id, 'Acct');
    await seedPositions(user.id, acct.id, 'open', OPEN_POSITIONS_SUMMARY_CAP + 5);

    const rows = await selectOpenPositionsSummary(db, user.id);
    expect(rows).toHaveLength(OPEN_POSITIONS_SUMMARY_CAP);
  });
});

describe('selectRecentClosedSummary', () => {
  it('is userId-scoped', async () => {
    const owner = await seedUser();
    const intruder = await seedUser();
    const ownerAcct = await seedAccount(owner.id, 'Owner');
    const intruderAcct = await seedAccount(intruder.id, 'Intruder');
    await seedPositions(owner.id, ownerAcct.id, 'closed', 2);
    await seedPositions(intruder.id, intruderAcct.id, 'closed', 3);

    const rows = await selectRecentClosedSummary(db, owner.id, 20);
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r.accountName === 'Owner')).toBe(true);
  });

  it('clamps the requested limit to RECENT_CLOSED_SUMMARY_CAP (20)', async () => {
    const user = await seedUser();
    const acct = await seedAccount(user.id, 'Acct');
    await seedPositions(user.id, acct.id, 'closed', RECENT_CLOSED_SUMMARY_CAP + 5);

    const rows = await selectRecentClosedSummary(db, user.id, 1000);
    expect(rows).toHaveLength(RECENT_CLOSED_SUMMARY_CAP);
  });

  it('honors a smaller requested limit', async () => {
    const user = await seedUser();
    const acct = await seedAccount(user.id, 'Acct');
    await seedPositions(user.id, acct.id, 'closed', 10);

    const rows = await selectRecentClosedSummary(db, user.id, 3);
    expect(rows).toHaveLength(3);
  });
});

describe('selectAccountSummaries', () => {
  it('is userId-scoped and returns the compact shape with derived balance', async () => {
    const owner = await seedUser();
    const intruder = await seedUser();
    await seedAccount(owner.id, 'Owner A');
    await seedAccount(owner.id, 'Owner B');
    await seedAccount(intruder.id, 'Intruder');

    const rows = await selectAccountSummaries(db, owner.id);
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r.name.startsWith('Owner'))).toBe(true);
    expect(rows.every((r) => typeof r.balance === 'string')).toBe(true);
  });
});

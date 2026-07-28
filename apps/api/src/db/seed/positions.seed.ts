import type { Database, Transaction } from '@/db';
import { positions } from '@/db/schema';

import { mulberry32 } from './rng';

const SYMBOLS = ['AAPL', 'MSFT', 'GOOGL', 'AMZN', 'NVDA', 'TSLA', 'META', 'SPY'];
const SIDES = ['long', 'short'] as const;
const ASSET_TYPES = ['stock', 'option'] as const;

// Currency is intentionally not on this interface — the positions table has no
// currency column; callers set the desired currency on the account before
// seeding positions against it.
export interface SeedPositionsOptions {
  userId: string;
  accountId: string;
  count: number;
  status?: 'draft' | 'open' | 'closed';
  closedAtRange?: { start: Date; end: Date };
  rngSeed?: number;
}

export async function seedPositions(db: Database | Transaction, opts: SeedPositionsOptions) {
  if (opts.count <= 0) return [];

  const rng = mulberry32(opts.rngSeed ?? 1);
  const status = opts.status ?? 'closed';
  const start = (opts.closedAtRange?.start ?? new Date('2026-01-01T00:00:00.000Z')).getTime();
  const end = (opts.closedAtRange?.end ?? new Date('2026-04-01T00:00:00.000Z')).getTime();
  const range = Math.max(1, end - start);

  const values = Array.from({ length: opts.count }, () => {
    const symbol = SYMBOLS[Math.floor(rng() * SYMBOLS.length)];
    const side = SIDES[Math.floor(rng() * SIDES.length)];
    const assetType = ASSET_TYPES[Math.floor(rng() * ASSET_TYPES.length)];

    let openedAt: Date | null = null;
    let closedAt: Date | null = null;
    if (status === 'closed') {
      const closedMs = start + Math.floor(rng() * range);
      closedAt = new Date(closedMs);
      openedAt = new Date(closedMs - 24 * 60 * 60 * 1000);
    } else if (status === 'open') {
      openedAt = new Date(start + Math.floor(rng() * range));
    }

    return {
      userId: opts.userId,
      accountId: opts.accountId,
      symbol,
      side,
      assetType,
      status,
      openedAt,
      closedAt,
    };
  });

  return db.insert(positions).values(values).returning();
}

import type { Database, Transaction } from '@/db';
import { fills } from '@/db/schema';

import { mulberry32 } from './rng';

export interface SeedFillsOptions {
  positionId: string;
  count: number;
  typeDistribution?: { entry: number; exit: number };
  rngSeed?: number;
  baseTime?: Date;
}

export async function seedFills(db: Database | Transaction, opts: SeedFillsOptions) {
  if (opts.count <= 0) return [];

  const rng = mulberry32(opts.rngSeed ?? 1);
  const dist = opts.typeDistribution ?? { entry: 0.5, exit: 0.5 };
  const total = Math.max(0, dist.entry + dist.exit);
  const entryCount =
    total === 0
      ? 0
      : Math.max(1, Math.min(opts.count - 1, Math.round((opts.count * dist.entry) / total)));
  const exitCount = opts.count - entryCount;
  const baseMs = (opts.baseTime ?? new Date('2026-01-01T00:00:00.000Z')).getTime();
  const minute = 60_000;

  const values: Array<{
    positionId: string;
    type: string;
    price: string;
    quantity: string;
    fees: string;
    filledAt: Date;
  }> = [];

  for (let i = 0; i < entryCount; i++) {
    values.push({
      positionId: opts.positionId,
      type: 'entry',
      price: (50 + rng() * 50).toFixed(8),
      quantity: (10 + Math.floor(rng() * 90)).toString(),
      fees: '0',
      filledAt: new Date(baseMs + i * minute),
    });
  }
  for (let i = 0; i < exitCount; i++) {
    values.push({
      positionId: opts.positionId,
      type: 'exit',
      price: (50 + rng() * 50).toFixed(8),
      quantity: (10 + Math.floor(rng() * 90)).toString(),
      fees: '0',
      filledAt: new Date(baseMs + (entryCount + i) * minute),
    });
  }

  return db.insert(fills).values(values).returning();
}

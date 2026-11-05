import { eq } from 'drizzle-orm';

import type { Database, Transaction } from '@/db';
import { positionEntryGreeks } from '@/db/schema';

export interface EntryGreeksData {
  delta: string;
  gamma: string;
  thetaPerDay: string;
  vegaPerPct: string;
  rhoPerPct: string | null;
  source: 'black_scholes' | 'chain';
  volatility: string | null;
  spot: string | null;
  rate: string | null;
  dividendYield: string | null;
  capturedAt: Date;
}

/**
 * One row per position (design C7 post-condition): an upsert on `position_id`
 * replaces the prior capture rather than appending a history.
 */
export function upsertEntryGreeks(tx: Transaction, positionId: string, data: EntryGreeksData) {
  return tx
    .insert(positionEntryGreeks)
    .values({ positionId, ...data })
    .onConflictDoUpdate({
      target: positionEntryGreeks.positionId,
      set: { ...data },
    })
    .returning();
}

export function findEntryGreeksByPosition(db: Database | Transaction, positionId: string) {
  return db
    .select()
    .from(positionEntryGreeks)
    .where(eq(positionEntryGreeks.positionId, positionId))
    .limit(1);
}

import type { Database } from '@/db';

import { seedExchangeRates, seedLedger } from './accounting.seed';
import { seedBrokerages } from './brokerages.seed';
import { dashboardSeed } from './dashboard.seed';

export { seedPositions } from './positions.seed';
export type { SeedPositionsOptions } from './positions.seed';
export { seedFills } from './fills.seed';
export type { SeedFillsOptions } from './fills.seed';
export { seedLedger, seedExchangeRates } from './accounting.seed';
export { dashboardSeed } from './dashboard.seed';
export { mulberry32 } from './rng';

export async function seed(db: Database, userId: string) {
  const brokerages = await seedBrokerages(db, userId);
  await seedLedger();
  await seedExchangeRates();
  await dashboardSeed(db);

  return { brokerages };
}

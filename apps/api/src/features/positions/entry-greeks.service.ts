import Decimal from 'decimal.js';

import {
  blackScholes,
  BlackScholesInputSchema,
  expiryInstant,
  parseOccSymbol,
} from '@tradr/shared';

import type { Database } from '@/db';
import { getContractGreeks } from '@/features/advisor/options-chain.handler';
import { NotFoundError, ValidationError } from '@/lib/errors';
import { withTransaction } from '@/lib/transaction';

import { upsertEntryGreeks } from './entry-greeks.query';
import { findFillsByPosition, findPositionById, findPositionForUpdate } from './positions.query';

const MS_PER_YEAR = 365 * 24 * 60 * 60 * 1000;

export type CaptureEntryGreeksInput =
  | {
      source: 'black_scholes';
      volatility: number;
      spot: number;
      rate: number;
      dividendYield?: number;
    }
  | { source: 'chain' };

interface ResolvedGreeks {
  delta: string;
  gamma: string;
  thetaPerDay: string;
  vegaPerPct: string;
  rhoPerPct: string | null;
  volatility: string | null;
  spot: string | null;
  rate: string | null;
  dividendYield: string | null;
}

/**
 * Captures a leg's entry Greeks (design C7). Black-Scholes computes `T` as
 * the leg's own expiry instant less its first entry fill's `filledAt`, over
 * 365 days, then prices under `BlackScholesInputSchema` — a non-positive `T`
 * or an out-of-bounds input is a 400, no write. Chain fetches the live
 * contract through the advisor's Unusual Whales client, entirely outside any
 * transaction. Either way, the write is a single upsert under
 * `findPositionForUpdate`: a second capture replaces the first.
 */
export async function captureEntryGreeks(
  db: Database,
  userId: string,
  legId: string,
  input: CaptureEntryGreeksInput,
) {
  const positionRows = await findPositionById(db, legId, userId);
  if (positionRows.length === 0) {
    throw new NotFoundError('Position', legId);
  }
  const position = positionRows[0]!;

  const parsed = parseOccSymbol(position.symbol);
  if (!parsed.ok) {
    throw new ValidationError('The leg is not a valid OCC contract');
  }

  const resolved: ResolvedGreeks =
    input.source === 'black_scholes'
      ? await resolveBlackScholesGreeks(db, legId, parsed.value, input)
      : await resolveChainGreeks(userId, position.symbol);

  return withTransaction(db, async (tx) => {
    const lockRows = await findPositionForUpdate(tx, legId, userId);
    if ((lockRows as unknown[]).length === 0) {
      throw new NotFoundError('Position', legId);
    }

    const [row] = await upsertEntryGreeks(tx, legId, {
      ...resolved,
      source: input.source,
      capturedAt: new Date(),
    });
    return row;
  });
}

async function resolveBlackScholesGreeks(
  db: Database,
  legId: string,
  contract: { expiration: string; type: 'call' | 'put'; strike: string },
  input: { volatility: number; spot: number; rate: number; dividendYield?: number },
): Promise<ResolvedGreeks> {
  const fills = await findFillsByPosition(db, legId);
  const firstEntry = fills.find((f) => f.type === 'entry');
  if (!firstEntry) {
    throw new ValidationError('The leg has no entry fill');
  }

  const T =
    (expiryInstant(contract.expiration).getTime() - firstEntry.filledAt.getTime()) / MS_PER_YEAR;

  const parsedInput = BlackScholesInputSchema.safeParse({
    S: input.spot,
    K: Number(contract.strike),
    T,
    sigma: input.volatility,
    r: input.rate,
    q: input.dividendYield ?? 0,
    type: contract.type,
  });
  if (!parsedInput.success) {
    const details: Record<string, string> = {};
    for (const issue of parsedInput.error.issues) {
      details[issue.path.join('.') || '_root'] = issue.message;
    }
    throw new ValidationError('Invalid Black-Scholes input', details);
  }

  const out = blackScholes(parsedInput.data);
  return {
    delta: new Decimal(out.delta).toFixed(12),
    gamma: new Decimal(out.gamma).toFixed(12),
    thetaPerDay: new Decimal(out.thetaPerDay).toFixed(12),
    vegaPerPct: new Decimal(out.vegaPerPct).toFixed(12),
    rhoPerPct: new Decimal(out.rhoPerPct).toFixed(12),
    volatility: new Decimal(input.volatility).toFixed(8),
    spot: new Decimal(input.spot).toFixed(8),
    rate: new Decimal(input.rate).toFixed(8),
    dividendYield:
      input.dividendYield !== undefined ? new Decimal(input.dividendYield).toFixed(8) : null,
  };
}

async function resolveChainGreeks(userId: string, occSymbol: string): Promise<ResolvedGreeks> {
  const contract = await getContractGreeks(userId, occSymbol);
  return {
    delta: new Decimal(contract.delta).toFixed(12),
    gamma: new Decimal(contract.gamma).toFixed(12),
    thetaPerDay: new Decimal(contract.thetaPerDay).toFixed(12),
    vegaPerPct: new Decimal(contract.vegaPerPct).toFixed(12),
    rhoPerPct: null,
    volatility: null,
    spot: null,
    rate: null,
    dividendYield: null,
  };
}

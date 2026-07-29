import { calculateFees, type FeeSchedule } from '@tradr/shared';

/**
 * A fill's buy/sell side, which is the position side crossed with the fill
 * direction: exiting a long is a sell, exiting a short is a buy. Mirrors the
 * mapping `listPositions` uses server-side so the preview and the server's
 * own `brokerageFees` agree.
 */
export function fillSide(positionSide: 'long' | 'short', type: 'entry' | 'exit'): 'buy' | 'sell' {
  if (type === 'entry') return positionSide === 'long' ? 'buy' : 'sell';
  return positionSide === 'long' ? 'sell' : 'buy';
}

/**
 * What the account's brokerage will charge for a prospective fill, using the
 * same shared `calculateFees` the API applies — so the number shown while
 * typing is the number the position will later report.
 *
 * Returns null when price or quantity is not yet a usable positive number,
 * which is the normal state of a half-typed form; callers render a placeholder
 * rather than a misleading 0.00.
 */
export function computeFillFee(args: {
  schedule: FeeSchedule;
  assetType: 'stock' | 'option';
  positionSide: 'long' | 'short';
  type: 'entry' | 'exit';
  price: string;
  quantity: string;
}): string | null {
  const price = Number(args.price);
  const quantity = Number(args.quantity);
  if (!Number.isFinite(price) || !Number.isFinite(quantity)) return null;
  if (price <= 0 || quantity <= 0) return null;

  const { totalFees } = calculateFees(
    [
      {
        quantity: args.quantity,
        price: args.price,
        type: args.assetType,
        side: fillSide(args.positionSide, args.type),
      },
    ],
    args.schedule,
  );
  return totalFees;
}

/**
 * Prefill helpers for the add-fill dialog.
 *
 * Both exist so the dialog opens with useful values instead of empty inputs and
 * a 0.00 fee, and so that behavior is testable without mounting React.
 */

/** The quantity shortcut buttons, as fractions of currently-open size. */
export const QUANTITY_PRESETS = [
  { label: '¼', fraction: 1 / 4 },
  { label: '⅓', fraction: 1 / 3 },
  { label: '½', fraction: 1 / 2 },
  { label: '¾', fraction: 3 / 4 },
  { label: 'All', fraction: 1 },
] as const;

/**
 * A preset's quantity against the currently-open size.
 *
 * Always rounds DOWN: an exit whose quantity exceeds the open size is a 400
 * from the server (R5-AC4), so ⅓ of 100 must land on 33, never 33.34. `All`
 * bypasses the rounding to return the open size exactly, which is the one case
 * that must hit the boundary rather than fall short of it. Option quantities
 * are whole contracts; stocks may be fractional.
 */
export function presetQuantity(
  openUnits: number,
  fraction: number,
  assetType: 'stock' | 'option',
): string {
  if (!Number.isFinite(openUnits) || openUnits <= 0) return '0';
  if (fraction >= 1) return String(openUnits);
  const raw = openUnits * fraction;
  if (assetType === 'option') return String(Math.floor(raw));
  return String(Math.floor(raw * 1e8) / 1e8);
}

/**
 * The price an add-fill dialog should open with, by direction.
 *
 * Exit prefers the target (you exit into your target, falling back to the stop,
 * then to what you paid). Entry prefers the average entry (a scale-in happens
 * near your existing average, not at the target you have not reached yet).
 * Returns '' when the position carries none of them — a draft with no fills and
 * no trade plan has nothing meaningful to offer, and a wrong guess is worse
 * than an empty field.
 */
export function defaultFillPrice(
  type: 'entry' | 'exit',
  plan: { avgEntryPrice: number | null; stopLoss: number | null; targetPrice: number | null },
): string {
  const order =
    type === 'exit'
      ? [plan.targetPrice, plan.stopLoss, plan.avgEntryPrice]
      : [plan.avgEntryPrice, plan.stopLoss, plan.targetPrice];
  const first = order.find((v) => v !== null && Number.isFinite(v) && v > 0);
  return first === undefined ? '' : String(first);
}

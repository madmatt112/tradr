export type LotMethod = 'fifo' | 'average';
export type EffectiveLotMethod = LotMethod | 'acb';

export function defaultLotMethod(jurisdiction: 'US' | 'CA' | 'other' | null): LotMethod {
  return jurisdiction === 'CA' ? 'average' : 'fifo';
}

export function resolveLotMethod(
  stored: LotMethod | null,
  jurisdiction: 'US' | 'CA' | 'other' | null,
): { method: EffectiveLotMethod; isDefault: boolean } {
  // CA always resolves to acb regardless of the stored value (AC 2.1); the
  // stored value is kept but never surfaced as the effective method (AC 2.2).
  if (jurisdiction === 'CA') return { method: 'acb', isDefault: stored === null };
  if (stored !== null) return { method: stored, isDefault: false };
  return { method: defaultLotMethod(jurisdiction), isDefault: true };
}

// US hold period: 365 days or less (inclusive) is short-term; a negative span is short.
export function holdTerm(openedAt: Date | string, realisedAt: Date | string): 'short' | 'long' {
  const THREE_HUNDRED_SIXTY_FIVE_DAYS_MS = 365 * 24 * 60 * 60 * 1000;
  const held = new Date(realisedAt).getTime() - new Date(openedAt).getTime();
  return held <= THREE_HUNDRED_SIXTY_FIVE_DAYS_MS ? 'short' : 'long';
}

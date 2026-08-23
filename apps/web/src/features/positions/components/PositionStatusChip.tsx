import { cn } from '@/lib/utils';

// The desk chips (visual-redesign task 7). Both are NEUTRAL by design:
// amber never encodes data, and green/red stay reserved for P&L figures.

/** Status as a mono pill: open reads strongest, closed recedes, draft is a
 * dashed plan. */
export function PositionStatusChip({ status }: { status: 'draft' | 'open' | 'closed' }) {
  return (
    <span
      className={cn(
        'inline-flex items-center rounded-full border px-2 py-px font-mono text-xs tracking-[0.06em]',
        status === 'open' && 'border-border text-foreground',
        status === 'closed' && 'border-hairline text-muted-foreground',
        status === 'draft' && 'border-dashed border-border text-muted-foreground',
      )}
    >
      {status}
    </span>
  );
}

/** L / S side chip — a squared mono tag, deliberately colourless. The old
 * table spent amber on "long" pills, which broke the accent's scarcity. */
export function PositionSideChip({ side }: { side: 'long' | 'short' }) {
  return (
    <span
      aria-label={side}
      title={side}
      className="inline-flex items-center rounded-sm border border-border px-1.5 font-mono text-xs font-semibold tracking-[0.08em] text-muted-foreground"
    >
      {side === 'long' ? 'L' : 'S'}
    </span>
  );
}

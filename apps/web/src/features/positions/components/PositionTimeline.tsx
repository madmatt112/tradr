import { Link } from '@tanstack/react-router';

import type { PositionSettlementDetail } from '@tradr/shared';

import { Numeric } from '@/components/Numeric';

import { buildTimeline, type TimelineEntry, type TimelineSource } from '../utils/timeline';

interface Props {
  position: TimelineSource & { id: string };
}

// The detail endpoint carries no account currency (known limitation, same gap
// PositionDetail.tsx works around); the timeline only ever shows USD-shaped
// premium and net-credit figures, never a gain/loss one, so this is cosmetic.
const CURRENCY = 'USD';

function formatTimelineDate(iso: string | undefined): string {
  const time = iso === undefined ? NaN : Date.parse(iso);
  return Number.isNaN(time) ? '' : new Date(time).toLocaleDateString();
}

// Fills are stored as numeric(18,8) decimal strings (same display rule as
// `FillTable.formatFillValue`, not reused directly — several `PositionDetail`
// suites mock the whole `./FillTable` module, which would strip this helper).
function formatFillValue(value: string | undefined): string {
  const n = Number(value);
  if (!Number.isFinite(n)) return value ?? '';
  return n.toFixed(3).replace(/\.?0+$/, '');
}

function settlementLinkIds(settlement: PositionSettlementDetail): string[] {
  return settlement.role === 'leg' ? settlement.stockPositionIds : [settlement.legPositionId];
}

function PositionLink({ positionId, children }: { positionId: string; children: React.ReactNode }) {
  return (
    <Link
      to="/positions/$positionId"
      params={{ positionId }}
      href={`/positions/${positionId}`}
      className="hover:underline"
    >
      {children}
    </Link>
  );
}

function entryKey(entry: TimelineEntry): string {
  switch (entry.kind) {
    case 'fill':
      return `fill-${entry.fill.id}`;
    case 'settlement':
      return `settlement-${entry.settlement.settlementId}`;
    case 'roll':
      return 'roll';
    case 'greeks':
      return 'greeks';
  }
}

function TimelineEntryRow({
  entry,
  viewedPositionId,
}: {
  entry: TimelineEntry;
  viewedPositionId: string;
}) {
  switch (entry.kind) {
    case 'fill':
      return (
        <span>
          {entry.fill.type === 'entry' ? 'Entry fill' : 'Exit fill'} —{' '}
          {formatFillValue(entry.fill.price)} × {formatFillValue(entry.fill.quantity)} on{' '}
          {formatTimelineDate(entry.fill.filledAt)}
        </span>
      );
    case 'settlement': {
      const linkedIds = settlementLinkIds(entry.settlement);
      return (
        <span>
          Settled {entry.settlement.outcome} on {formatTimelineDate(entry.settlement.settledAt)} —
          premium{' '}
          <Numeric
            value={entry.settlement.premium}
            kind="money"
            currency={CURRENCY}
            direction="none"
            className="inline"
          />
          {linkedIds.map((id) => (
            <span key={id} className="ml-2">
              <PositionLink positionId={id}>view position</PositionLink>
            </span>
          ))}
        </span>
      );
    }
    case 'roll': {
      const otherLegs = entry.rollChain.legs.filter((leg) => leg.positionId !== viewedPositionId);
      return (
        <span>
          Rolled, net credit{' '}
          <Numeric
            value={entry.rollChain.netCredit}
            kind="money"
            currency={CURRENCY}
            direction="none"
            className="inline"
          />
          {otherLegs.map((leg) => (
            <span key={leg.positionId} className="ml-2">
              <PositionLink positionId={leg.positionId}>{leg.symbol}</PositionLink>
            </span>
          ))}
        </span>
      );
    }
    case 'greeks':
      return (
        <span>
          {entry.entryGreeks.source === 'chain'
            ? 'Greeks captured from chain data'
            : 'Entry Greeks captured'}{' '}
          on {formatTimelineDate(entry.entryGreeks.capturedAt)}
        </span>
      );
  }
}

/**
 * PositionTimeline — the one date-ordered history of a position (design C10,
 * D17; Requirement 8): fills, settlements, a roll chain and an entry-Greeks
 * capture, merged by `utils/timeline.ts` and rendered here. Links to the
 * stock row a settlement touches, the leg it settles against, and the other
 * leg of a roll chain (AC 8.1). `FillTable` keeps the fill edit/remove
 * actions — this is read-only history.
 */
export function PositionTimeline({ position }: Props) {
  const entries = buildTimeline(position);

  if (entries.length === 0) {
    return <p className="text-sm text-muted-foreground">No history yet</p>;
  }

  return (
    <ol className="space-y-2 text-sm">
      {entries.map((entry) => (
        <li key={entryKey(entry)}>
          <TimelineEntryRow entry={entry} viewedPositionId={position.id} />
        </li>
      ))}
    </ol>
  );
}

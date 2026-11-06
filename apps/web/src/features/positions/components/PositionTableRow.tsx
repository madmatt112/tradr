import { Link } from '@tanstack/react-router';

import type { PositionListItem } from '@tradr/shared';

import { Numeric } from '@/components/Numeric';
import { TableCell, TableRow } from '@/components/ui/table';
import { TagChipList } from '@/features/tags/components/TagChip';
import { cn } from '@/lib/utils';

import { decodeOptionContract } from '../utils/optionContract';
import { positionAgeDays } from '../utils/positionAge';
import { shouldNavigateFromRowClick } from '../utils/rowNavigation';

import { BreakevenBadge } from './BreakevenBadge';
import { PastExpiryChip } from './PastExpiryChip';
import { PositionRowActions } from './PositionRowActions';
import { PositionSideChip, PositionStatusChip } from './PositionStatusChip';

interface Props {
  pos: PositionListItem & { groupId?: string | null };
  drawerOpen: boolean;
  selected: boolean;
  isPhone: boolean;
  onInspect: (pos: PositionListItem) => void;
  onNavigate: (positionId: string) => void;
}

/**
 * One position row (design C12: unchanged for an ungrouped item). Shared by
 * `PositionList`'s own rows and, as a leg row, `PositionGroupRows` — both pass
 * the same click wiring so a leg behaves exactly like a standalone position.
 */
export function PositionTableRow({
  pos,
  drawerOpen,
  selected,
  isPhone,
  onInspect,
  onNavigate,
}: Props) {
  const optionContract = pos.assetType === 'option' ? decodeOptionContract(pos.symbol) : null;
  const qty = pos.status === 'closed' ? pos.closedUnits : pos.openUnits;
  const age = positionAgeDays(pos.openedAt, pos.closedAt);

  return (
    <TableRow
      className={cn(
        'h-[31px] cursor-pointer border-hairline',
        // The selected row wears the same amber tick as the active
        // nav item — one selection language everywhere.
        selected && 'bg-secondary shadow-[inset_2px_0_0_var(--color-primary)] hover:bg-secondary',
      )}
      data-state={selected ? 'selected' : undefined}
      onClick={(e) => {
        if (!shouldNavigateFromRowClick(e)) return;
        if (isPhone) {
          onNavigate(pos.id);
          return;
        }
        onInspect(pos);
      }}
    >
      <TableCell className="py-0 font-medium">
        {/* The symbol link stays the keyboard/deep-link path to the
            full detail page; the row click is the drawer inspect. */}
        <Link
          to="/positions/$positionId"
          params={{ positionId: pos.id }}
          className="hover:underline max-md:inline-flex max-md:min-h-6 max-md:min-w-6 max-md:items-center"
          title={pos.symbol}
        >
          {optionContract ? optionContract.underlying : pos.symbol}
        </Link>
        {optionContract && (
          <span className="block text-xs leading-none text-muted-foreground">
            {optionContract.compactLabel}
          </span>
        )}
      </TableCell>
      <TableCell className="py-0">
        <PositionSideChip side={pos.side} />
      </TableCell>
      <TableCell className="py-0">
        <div className="flex items-center gap-2">
          <PositionStatusChip status={pos.status} />
          {pos.classification === 'breakeven' && <BreakevenBadge />}
          {pos.pastExpiryUnsettled && <PastExpiryChip />}
        </div>
      </TableCell>
      {!drawerOpen && (
        <TableCell className="hidden py-0 md:table-cell">
          <TagChipList tags={pos.tags ?? []} max={3} />
        </TableCell>
      )}
      {!drawerOpen && <TableCell className="py-0 max-md:hidden">{pos.accountName}</TableCell>}
      <TableCell className="py-0 text-right max-md:hidden">
        <Numeric
          value={qty === 0 && pos.status === 'draft' ? null : qty}
          kind="integer"
          direction="none"
        />
      </TableCell>
      {!drawerOpen && (
        <TableCell className="py-0 text-right max-md:hidden">
          <Numeric
            value={pos.avgEntryPrice}
            kind="money"
            currency={pos.accountCurrency}
            direction="none"
          />
        </TableCell>
      )}
      {!drawerOpen && (
        <TableCell className="py-0 text-right max-md:hidden">
          <Numeric
            value={pos.avgExitPrice}
            kind="money"
            currency={pos.accountCurrency}
            direction="none"
          />
        </TableCell>
      )}
      <TableCell className="py-0 text-right" data-testid="position-pnl">
        <Numeric value={pos.netPnl} kind="money" currency={pos.accountCurrency} direction="auto" />
      </TableCell>
      <TableCell className="py-0 text-right max-md:hidden">
        <Numeric value={pos.actualRR} kind="decimal" direction="auto" />
      </TableCell>
      {!drawerOpen && (
        <TableCell className="py-0 text-right max-md:hidden">
          <Numeric
            value={pos.brokerageFees > 0 ? pos.brokerageFees : null}
            kind="money"
            currency={pos.accountCurrency}
            direction="none"
          />
        </TableCell>
      )}
      {!drawerOpen && (
        <TableCell className="py-0 text-right max-md:hidden">
          {age !== null ? (
            <span className="font-mono text-xs text-muted-foreground">{age}d</span>
          ) : (
            <span className="text-muted-foreground">—</span>
          )}
        </TableCell>
      )}
      <TableCell className="py-0">
        <PositionRowActions position={pos} />
      </TableCell>
    </TableRow>
  );
}

import { ChevronRightIcon } from 'lucide-react';
import { useState } from 'react';

import type { PositionGroupEntry, PositionListItem } from '@tradr/shared';

import { Numeric } from '@/components/Numeric';
import { TableCell, TableRow } from '@/components/ui/table';
import { TagChipList } from '@/features/tags/components/TagChip';
import { EM_DASH } from '@/lib/format';
import { cn } from '@/lib/utils';

import { positionAgeDays } from '../utils/positionAge';
import { shouldNavigateFromRowClick } from '../utils/rowNavigation';

import { BreakevenBadge } from './BreakevenBadge';
import { PositionGroupRowActions } from './PositionGroupRowActions';
import { PositionStatusChip } from './PositionStatusChip';
import { PositionTableRow } from './PositionTableRow';

interface Props {
  group: PositionGroupEntry;
  drawerOpen: boolean;
  isPhone: boolean;
  inspectedId: string | null;
  onInspect: (pos: PositionListItem) => void;
  onNavigate: (positionId: string) => void;
}

/**
 * One group row (design C12/D18): the group's own summary row, and, when
 * expanded, one `PositionTableRow` per leg. Expanded state is local — it is
 * a view concern, not something another row or a refetch should reset.
 */
export function PositionGroupRows({
  group,
  drawerOpen,
  isPhone,
  inspectedId,
  onInspect,
  onNavigate,
}: Props) {
  const [expanded, setExpanded] = useState(false);
  const age = positionAgeDays(group.openedAt, group.closedAt);
  const isCredit = group.netEntry < 0;

  return (
    <>
      <TableRow
        className="h-[31px] cursor-pointer border-hairline"
        onClick={(e) => {
          // A group row click toggles — it never opens the inspect drawer
          // (design D18). A click on the toggle button itself is excluded
          // here, so the button's own handler is the only thing that fires.
          if (!shouldNavigateFromRowClick(e)) return;
          setExpanded((v) => !v);
        }}
      >
        <TableCell className="py-0 font-medium">
          <button
            type="button"
            aria-expanded={expanded}
            aria-label={`${expanded ? 'Collapse' : 'Expand'} ${group.label} legs`}
            className="inline-flex cursor-pointer items-center gap-1"
            onClick={() => setExpanded((v) => !v)}
          >
            <ChevronRightIcon
              className={cn('h-3 w-3 shrink-0 transition-transform', expanded && 'rotate-90')}
              aria-hidden="true"
            />
            {group.underlying}
          </button>
          <span className="block text-xs leading-none text-muted-foreground">{group.label}</span>
        </TableCell>
        <TableCell className="py-0">
          <span className="text-muted-foreground">{EM_DASH}</span>
        </TableCell>
        <TableCell className="py-0">
          <div className="flex items-center gap-2">
            <PositionStatusChip status={group.status} />
            {group.classification === 'breakeven' && <BreakevenBadge />}
          </div>
        </TableCell>
        {!drawerOpen && (
          <TableCell className="hidden py-0 md:table-cell">
            <TagChipList tags={group.tags} max={3} />
          </TableCell>
        )}
        {!drawerOpen && <TableCell className="py-0 max-md:hidden">{group.accountName}</TableCell>}
        <TableCell className="py-0 text-right max-md:hidden">
          <span className="text-muted-foreground">{EM_DASH}</span>
        </TableCell>
        {!drawerOpen && (
          <TableCell className="py-0 text-right max-md:hidden">
            <span className="mr-1 text-xs text-muted-foreground">
              {isCredit ? 'credit' : 'debit'}
            </span>
            <Numeric
              value={Math.abs(group.netEntry)}
              kind="money"
              currency={group.accountCurrency}
              direction="none"
            />
          </TableCell>
        )}
        {!drawerOpen && (
          <TableCell className="py-0 text-right max-md:hidden">
            <span className="text-muted-foreground">{EM_DASH}</span>
          </TableCell>
        )}
        <TableCell className="py-0 text-right" data-testid="position-pnl">
          <Numeric
            value={group.netPnl}
            kind="money"
            currency={group.accountCurrency}
            direction="auto"
          />
        </TableCell>
        <TableCell className="py-0 text-right max-md:hidden">
          <span className="text-muted-foreground">{EM_DASH}</span>
        </TableCell>
        {!drawerOpen && (
          <TableCell className="py-0 text-right max-md:hidden">
            <Numeric
              value={group.brokerageFees > 0 ? group.brokerageFees : null}
              kind="money"
              currency={group.accountCurrency}
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
          <PositionGroupRowActions group={group} />
        </TableCell>
      </TableRow>
      {expanded &&
        group.legs.map((leg) => (
          <PositionTableRow
            key={leg.id}
            pos={leg}
            drawerOpen={drawerOpen}
            selected={leg.id === inspectedId}
            isPhone={isPhone}
            onInspect={onInspect}
            onNavigate={onNavigate}
          />
        ))}
    </>
  );
}

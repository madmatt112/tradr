import { Link } from '@tanstack/react-router';
import { PanelRightClose } from 'lucide-react';

import type { PositionListItem } from '@tradr/shared';

import { Numeric } from '@/components/Numeric';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { PositionStatusChip } from '@/features/positions/components/PositionStatusChip';
import { usePosition } from '@/features/positions/hooks/usePosition';
import { formatFillDate } from '@/features/positions/utils/positionAge';

// The drawer's INSPECT surface (visual-redesign task 7): a row click on the
// positions list opens the drawer straight onto this — the position unfolded
// into its fill-by-fill ledger, with the risk figures beneath. Reuses the
// detail page's data (usePosition) in a drawer-sized surface; the full detail
// page stays the deep-link/a11y path via the list's symbol link and the
// "Open full view" link below.
//
// DATA ONLY, deliberately: the mock also drew Add fill / Close position
// buttons here, but every action already lives in the row's ⋯ menu and on the
// detail page, and a third mutation surface would triple the gating logic
// this drawer has no room to explain. Money is formatted with the LIST row's
// accountCurrency — the detail endpoint does not return it.
export function PositionInspectPanel({
  position,
  onClose,
}: {
  position: PositionListItem;
  onClose: () => void;
}) {
  const { data: detail, isLoading } = usePosition(position.id);
  const currency = position.accountCurrency;

  return (
    <div className="flex h-full min-h-0 flex-col" data-testid="position-inspect">
      <div className="flex items-center gap-2.5 border-b border-hairline p-3">
        <h2 className="flex items-center gap-2.5 text-base font-semibold">
          {position.symbol}
          <PositionStatusChip status={position.status} />
        </h2>
        <Button
          variant="ghost"
          size="icon-sm"
          className="ml-auto shrink-0 cursor-pointer"
          data-slot="inspect-close"
          onClick={onClose}
          aria-label="Close side drawer"
        >
          <PanelRightClose className="h-4 w-4" />
        </Button>
      </div>

      <div className="min-h-0 flex-1 space-y-4 overflow-y-auto p-3">
        <div className="flex items-baseline justify-between text-sm">
          <span className="text-muted-foreground">
            {position.status === 'closed' ? 'Net P&L' : 'P&L'}
          </span>
          <span className="font-semibold" data-testid="inspect-pnl">
            <Numeric value={position.netPnl} kind="money" currency={currency} direction="auto" />
          </span>
        </div>

        <section aria-label="Fills">
          <h3 className="mb-1.5 font-mono text-xs font-medium uppercase tracking-[0.1em] text-muted-foreground">
            Fills
          </h3>
          {isLoading ? (
            <div className="space-y-2">
              <Skeleton className="h-7 w-full" />
              <Skeleton className="h-7 w-full" />
            </div>
          ) : !detail?.fills.length ? (
            <p className="text-sm text-muted-foreground">No fills recorded yet.</p>
          ) : (
            <table className="w-full text-xs">
              <thead>
                <tr className="border-b border-hairline text-left font-mono uppercase tracking-[0.08em] text-muted-foreground">
                  <th className="py-1 pr-2 font-medium">Fill</th>
                  <th className="py-1 pr-2 text-right font-medium">Date</th>
                  <th className="py-1 pr-2 text-right font-medium">Qty</th>
                  <th className="py-1 pr-2 text-right font-medium">Price</th>
                  <th className="py-1 text-right font-medium">Fee</th>
                </tr>
              </thead>
              <tbody>
                {detail.fills.map((fill) => (
                  <tr key={fill.id} className="h-7 border-b border-hairline last:border-b-0">
                    <td className="pr-2">
                      {fill.type === 'entry' ? 'Buy — entry' : 'Sell — exit'}
                    </td>
                    <td className="pr-2 text-right">
                      <span className="font-mono">{formatFillDate(fill.filledAt)}</span>
                    </td>
                    <td className="pr-2 text-right">
                      <Numeric value={Number(fill.quantity)} kind="decimal" direction="none" />
                    </td>
                    <td className="pr-2 text-right">
                      <Numeric value={Number(fill.price)} kind="decimal" direction="none" />
                    </td>
                    <td className="text-right">
                      <Numeric value={Number(fill.fees)} kind="decimal" direction="none" />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </section>

        <section aria-label="Risk">
          <h3 className="mb-1.5 font-mono text-xs font-medium uppercase tracking-[0.1em] text-muted-foreground">
            Risk
          </h3>
          <dl className="text-sm">
            <div className="flex justify-between border-b border-hairline py-1.5">
              <dt className="text-muted-foreground">Stop</dt>
              <dd>
                <Numeric value={position.stopLoss} kind="decimal" direction="none" />
              </dd>
            </div>
            <div className="flex justify-between border-b border-hairline py-1.5">
              <dt className="text-muted-foreground">Target</dt>
              <dd>
                <Numeric value={position.targetPrice} kind="decimal" direction="none" />
              </dd>
            </div>
            <div className="flex justify-between border-b border-hairline py-1.5">
              <dt className="text-muted-foreground">R multiple</dt>
              <dd>
                <Numeric value={position.actualRR} kind="decimal" direction="auto" />
              </dd>
            </div>
            <div className="flex justify-between py-1.5">
              <dt className="text-muted-foreground">Fees to date</dt>
              <dd>
                <Numeric
                  value={position.brokerageFees}
                  kind="money"
                  currency={currency}
                  direction="none"
                />
              </dd>
            </div>
          </dl>
        </section>

        {/* The deep-link/a11y path — inspect is a mouse convenience over it. */}
        <Link
          to="/positions/$positionId"
          params={{ positionId: position.id }}
          className="inline-block text-sm font-medium underline underline-offset-4 hover:text-foreground"
        >
          Open full view
        </Link>
      </div>
    </div>
  );
}

export default PositionInspectPanel;

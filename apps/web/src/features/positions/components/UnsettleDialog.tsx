import { useState } from 'react';

import type { PositionSettlementDetail } from '@tradr/shared';

import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';

import { useUnsettleLeg } from '../hooks/useOptionLifecycle';

function getErrorMessage(err: unknown, fallback: string): string {
  if (typeof err === 'object' && err !== null && 'error' in err) {
    const e = err as { error?: { message?: string } };
    if (e.error?.message) return e.error.message;
  }
  return fallback;
}

interface Props {
  settlement: PositionSettlementDetail;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

/**
 * Confirms undoing a settlement (design C10, Requirement 4). Always posts to
 * the settlement's own leg (`legPositionId`), never the viewed position's id,
 * so the same dialog works mounted from the leg's timeline or a stock row's
 * (task 26 Prompt). Only a `stock_opened` row is ever deleted by the undo
 * (design C5 step 6), so the tags/screenshots/lots warning (AC 4.3) shows
 * only then.
 */
export function UnsettleDialog({ settlement, open, onOpenChange }: Props) {
  const unsettleLeg = useUnsettleLeg(settlement.legPositionId);
  const [error, setError] = useState<string | null>(null);

  const warnsAboutOpenedRow = settlement.role === 'stock_opened';

  async function handleUnsettle() {
    setError(null);
    try {
      await unsettleLeg.mutateAsync({ settlementId: settlement.settlementId });
      onOpenChange(false);
    } catch (err) {
      setError(getErrorMessage(err, 'Failed to unsettle'));
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Undo settlement</DialogTitle>
        </DialogHeader>
        <div className="space-y-2 text-sm text-muted-foreground">
          <p>This flips the settled row back to open and removes its recorded fills.</p>
          {warnsAboutOpenedRow && <p>Its tags, screenshots and lots go with it.</p>}
          {error && <p className="text-destructive">{error}</p>}
        </div>
        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            className="cursor-pointer"
            onClick={() => onOpenChange(false)}
          >
            Cancel
          </Button>
          <Button
            type="button"
            className="cursor-pointer"
            disabled={unsettleLeg.isPending}
            onClick={handleUnsettle}
          >
            {unsettleLeg.isPending ? 'Unsettling...' : 'Unsettle'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

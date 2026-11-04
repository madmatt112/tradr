import { Link } from '@tanstack/react-router';
import { useState } from 'react';

import type { PositionGroupEntry } from '@tradr/shared';

import { Numeric } from '@/components/Numeric';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';

import { useSetGroupLabel, useUnlinkGroupLeg } from '../hooks/usePositionGroups';
import { maxLossReasonText } from '../utils/listEntries';

import { CloseGroupDialog } from './CloseGroupDialog';

interface Props {
  positionId: string;
  group: PositionGroupEntry;
}

/**
 * Shown on `PositionDetail` when the viewed position carries a group
 * (design C13): the label with an override control, sibling legs, group
 * figures, max loss or its reason, close-all and unlink.
 */
export function PositionGroupPanel({ positionId, group }: Props) {
  const setLabel = useSetGroupLabel(group.id);
  const unlinkLeg = useUnlinkGroupLeg(group.id);
  const [overrideValue, setOverrideValue] = useState(group.labelOverride ?? '');
  const [closeOpen, setCloseOpen] = useState(false);

  const siblings = group.legs.filter((leg) => leg.id !== positionId);
  const isOpen = group.status === 'open';
  const reasonText = maxLossReasonText(group.maxLossReason);

  function handleSave() {
    const trimmed = overrideValue.trim();
    setLabel.mutate({ labelOverride: trimmed === '' ? null : trimmed });
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>{group.label}</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        {siblings.length > 0 && (
          <div>
            <h3 className="text-sm font-medium text-muted-foreground">Legs</h3>
            <ul className="mt-1 space-y-1">
              {siblings.map((leg) => (
                <li key={leg.id}>
                  <Link
                    to="/positions/$positionId"
                    params={{ positionId: leg.id }}
                    href={`/positions/${leg.id}`}
                    className="hover:underline"
                  >
                    {leg.symbol}
                  </Link>
                </li>
              ))}
            </ul>
          </div>
        )}

        <div className="grid grid-cols-2 gap-4 md:grid-cols-4">
          <div>
            <p className="text-xs text-muted-foreground">Net entry</p>
            <Numeric
              value={group.netEntry}
              kind="money"
              currency={group.accountCurrency}
              direction="none"
            />
          </div>
          <div>
            <p className="text-xs text-muted-foreground">Net P&L</p>
            <Numeric
              value={group.netPnl}
              kind="money"
              currency={group.accountCurrency}
              direction="auto"
            />
          </div>
          <div>
            <p className="text-xs text-muted-foreground">Fees</p>
            <Numeric
              value={group.brokerageFees}
              kind="money"
              currency={group.accountCurrency}
              direction="none"
            />
          </div>
          <div>
            <p className="text-xs text-muted-foreground">Max loss</p>
            {group.maxLoss !== null ? (
              <Numeric
                value={group.maxLoss}
                kind="money"
                currency={group.accountCurrency}
                direction="none"
              />
            ) : (
              <p className="text-sm font-semibold">{reasonText}</p>
            )}
          </div>
        </div>

        <div className="space-y-2">
          <Label htmlFor={`group-label-override-${group.id}`}>Label override</Label>
          <div className="flex gap-2">
            <Input
              id={`group-label-override-${group.id}`}
              value={overrideValue}
              onChange={(e) => setOverrideValue(e.target.value)}
            />
            <Button
              type="button"
              className="cursor-pointer"
              onClick={handleSave}
              disabled={setLabel.isPending}
            >
              Save
            </Button>
          </div>
        </div>

        <div className="flex items-center gap-2">
          {isOpen && (
            <Button type="button" className="cursor-pointer" onClick={() => setCloseOpen(true)}>
              Close all
            </Button>
          )}
          <Button
            type="button"
            variant="outline"
            className="cursor-pointer"
            onClick={() => unlinkLeg.mutate(positionId)}
            disabled={unlinkLeg.isPending}
          >
            Unlink
          </Button>
        </div>
      </CardContent>

      <CloseGroupDialog group={group} open={closeOpen} onOpenChange={setCloseOpen} />
    </Card>
  );
}

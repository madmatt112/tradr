import { legUnderlying } from '@tradr/shared';
import type { PositionListEntry, PositionListItem } from '@tradr/shared';

import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';

import { useAddGroupLeg, useLinkPositions } from '../hooks/usePositionGroups';
import { usePositions } from '../hooks/usePositions';
import { isGroupEntry } from '../utils/listEntries';

interface ViewedPosition {
  id: string;
  accountId: string;
  symbol: string;
  assetType: 'stock' | 'option';
  status: 'draft' | 'open' | 'closed';
  groupId: string | null | undefined;
}

interface Props {
  position: ViewedPosition;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

function isUngroupedCandidate(entry: PositionListEntry): entry is PositionListItem {
  return !isGroupEntry(entry);
}

/**
 * Opened from the detail page of a non-draft position (design C13): links
 * same-account, same-underlying candidates that are ungrouped non-drafts.
 * Calls link for an ungrouped viewed position, or add when it already
 * carries a group.
 */
export function LinkLegsDialog({ position, open, onOpenChange }: Props) {
  const { data } = usePositions({ accountId: position.accountId });
  const linkPositions = useLinkPositions();
  const addGroupLeg = useAddGroupLeg(position.groupId ?? '');

  const viewedUnderlying = legUnderlying({
    symbol: position.symbol,
    assetType: position.assetType,
  });

  const candidates =
    position.status === 'draft'
      ? []
      : (data ?? [])
          .filter(isUngroupedCandidate)
          .filter(
            (entry) =>
              entry.id !== position.id &&
              entry.status !== 'draft' &&
              entry.accountId === position.accountId &&
              legUnderlying(entry) === viewedUnderlying,
          );

  function handleLink(candidateId: string) {
    if (position.groupId) {
      addGroupLeg.mutate({ positionId: candidateId });
    } else {
      linkPositions.mutate({ positionIds: [position.id, candidateId] });
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex max-h-[80vh] flex-col">
        <DialogHeader>
          <DialogTitle>Link legs</DialogTitle>
        </DialogHeader>
        <div className="min-h-0 flex-1 space-y-2 overflow-y-auto">
          {candidates.length === 0 && (
            <p className="text-sm text-muted-foreground">No matching positions to link.</p>
          )}
          {candidates.map((candidate) => (
            <div
              key={candidate.id}
              data-testid={`candidate-${candidate.id}`}
              className="flex items-center justify-between gap-2 rounded-md border p-2"
            >
              <span>{candidate.symbol}</span>
              <Button
                type="button"
                size="sm"
                className="cursor-pointer"
                onClick={() => handleLink(candidate.id)}
              >
                {position.groupId ? 'Add' : 'Link'}
              </Button>
            </div>
          ))}
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
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

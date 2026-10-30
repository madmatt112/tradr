import { useState } from 'react';
import { toast } from 'sonner';

import type { TransferCandidate, TransferLinkView } from '@tradr/shared';

import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';

function getErrorMessage(err: unknown, fallback: string): string {
  if (typeof err === 'object' && err !== null && 'error' in err) {
    const e = err as { error?: { message?: string } };
    if (e.error?.message) return e.error.message;
  }
  return fallback;
}

interface Props {
  link: TransferLinkView | null;
  candidates: TransferCandidate[];
  onLink: (entryFillId: string) => Promise<unknown>;
  onRemove: () => Promise<unknown>;
}

/** The current link with "Remove link", or a candidate picker (design C7 web bullet). */
export function TransferLinkSection({ link, candidates, onLink, onRemove }: Props) {
  const [selected, setSelected] = useState<string>(candidates[0]?.entryFillId ?? '');

  if (!link && candidates.length === 0) return null;

  if (link) {
    return (
      <div className="space-y-2">
        <p className="text-sm">Linked transfer: {link.entryAccountName}</p>
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="cursor-pointer"
          onClick={() => onRemove()}
        >
          Remove link
        </Button>
      </div>
    );
  }

  return (
    <div className="space-y-2">
      <Label htmlFor="transfer-candidate">Transfer candidate</Label>
      <Select value={selected} onValueChange={setSelected}>
        <SelectTrigger id="transfer-candidate">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {candidates.map((candidate) => (
            <SelectItem key={candidate.entryFillId} value={candidate.entryFillId}>
              {`${candidate.accountName} · ${candidate.filledAt} · ${candidate.quantity} @ ${candidate.price}`}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <Button
        type="button"
        variant="outline"
        size="sm"
        className="cursor-pointer"
        onClick={async () => {
          try {
            await onLink(selected);
          } catch (err) {
            toast.error(getErrorMessage(err, 'Failed to link transfer'));
          }
        }}
      >
        Link transfer
      </Button>
    </div>
  );
}

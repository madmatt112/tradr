import { MoreHorizontal, X } from 'lucide-react';
import { useState } from 'react';

import type { PositionGroupEntry } from '@tradr/shared';

import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';

import { CloseGroupDialog } from './CloseGroupDialog';

interface Props {
  group: PositionGroupEntry;
}

/**
 * Row-level actions for a position group (design C12): close-all only while
 * the group is open, same `data-slot="row-actions"` as `PositionRowActions`
 * so the list's row-navigation click guard treats both the same way.
 */
export function PositionGroupRowActions({ group }: Props) {
  const [closeOpen, setCloseOpen] = useState(false);
  const isOpen = group.status === 'open';

  return (
    <>
      <div data-slot="row-actions" className="flex items-center justify-end">
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              variant="ghost"
              size="icon-sm"
              className="cursor-pointer text-muted-foreground"
              aria-label={`Actions for ${group.label}`}
            >
              <MoreHorizontal className="h-4 w-4" aria-hidden="true" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            {isOpen && (
              <DropdownMenuItem className="cursor-pointer" onSelect={() => setCloseOpen(true)}>
                <X className="h-4 w-4" aria-hidden="true" />
                Close all
              </DropdownMenuItem>
            )}
          </DropdownMenuContent>
        </DropdownMenu>
      </div>

      <CloseGroupDialog group={group} open={closeOpen} onOpenChange={setCloseOpen} />
    </>
  );
}

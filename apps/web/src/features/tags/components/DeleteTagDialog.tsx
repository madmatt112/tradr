import type { TagWithCount } from '@tradr/shared';

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';

// The confirmation copy names the tag and how many positions carry it (REQ-5.4);
// the positions keep their other tags. Singular for one, and a distinct line when
// the tag is on nothing.
function deletionText(tag: TagWithCount): string {
  const n = tag.positionCount;
  if (n === 0) return `Delete «${tag.name}»? It is not on any position.`;
  if (n === 1) return `Delete «${tag.name}»? It will be removed from 1 position.`;
  return `Delete «${tag.name}»? It will be removed from ${n} positions.`;
}

/**
 * Confirm deleting a tag (design Component 15; REQ-5.4). A tag delete is
 * irreversible data loss, so the confirm action carries the design system's
 * destructive styling (the `DeleteBrokerageDialog` shape).
 */
export function DeleteTagDialog({
  open,
  onOpenChange,
  tag,
  onConfirm,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  tag: TagWithCount;
  onConfirm: () => void;
}) {
  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Delete tag</AlertDialogTitle>
          <AlertDialogDescription>{deletionText(tag)}</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel className="cursor-pointer">Cancel</AlertDialogCancel>
          <AlertDialogAction className="cursor-pointer" variant="destructive" onClick={onConfirm}>
            Delete
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

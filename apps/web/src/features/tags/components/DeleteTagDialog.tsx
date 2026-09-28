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
// the tag is on nothing. When rules are scoped to the tag they are deleted with it
// (C12), so the copy names how many — singular for one, nothing when there are none.
function deletionText(tag: TagWithCount, ruleCount = 0): string {
  const n = tag.positionCount;
  const rules =
    ruleCount > 0
      ? ` It also deletes ${ruleCount} ${ruleCount === 1 ? 'rule' : 'rules'} scoped to it.`
      : '';
  if (n === 0) return `Delete «${tag.name}»? It is not on any position.${rules}`;
  if (n === 1) return `Delete «${tag.name}»? It will be removed from 1 position.${rules}`;
  return `Delete «${tag.name}»? It will be removed from ${n} positions.${rules}`;
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
  ruleCount,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  tag: TagWithCount;
  onConfirm: () => void;
  ruleCount?: number;
}) {
  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Delete tag</AlertDialogTitle>
          <AlertDialogDescription>{deletionText(tag, ruleCount)}</AlertDialogDescription>
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

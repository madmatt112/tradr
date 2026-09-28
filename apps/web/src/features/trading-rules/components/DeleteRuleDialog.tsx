import type { TradingRule } from '@tradr/shared';

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

/**
 * Confirm deleting a rule (design C9; REQ-1.2). A rule delete is irreversible,
 * so the confirm action carries the design system's destructive styling (the
 * `DeleteTagDialog` shape). The copy names the rule by its generated
 * description; deleting a rule never touches a position.
 */
export function DeleteRuleDialog({
  open,
  onOpenChange,
  rule,
  onConfirm,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  rule: TradingRule;
  onConfirm: () => void;
}) {
  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Delete rule</AlertDialogTitle>
          <AlertDialogDescription>
            Delete «{rule.description}»? Your positions keep every fill and note; only this check
            stops being scored.
          </AlertDialogDescription>
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

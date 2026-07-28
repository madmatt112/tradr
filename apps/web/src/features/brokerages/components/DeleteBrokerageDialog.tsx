import type { Brokerage } from '@tradr/shared';

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

interface DeleteBrokerageDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  brokerage: Brokerage;
  referencedAccountNames?: string[];
  onConfirm: () => void;
}

export function DeleteBrokerageDialog({
  open,
  onOpenChange,
  brokerage,
  referencedAccountNames = [],
  onConfirm,
}: DeleteBrokerageDialogProps) {
  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Delete Brokerage</AlertDialogTitle>
          <AlertDialogDescription>
            Are you sure you want to delete &ldquo;{brokerage.name}&rdquo;? This action cannot be
            undone.
            {referencedAccountNames.length > 0 && (
              <>
                {' '}
                The following accounts reference this brokerage and will need to be reassigned:{' '}
                <span className="font-medium">{referencedAccountNames.join(', ')}</span>.
              </>
            )}
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

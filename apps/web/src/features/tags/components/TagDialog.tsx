import { zodResolver } from '@hookform/resolvers/zod';
import { useEffect, useState } from 'react';
import { Controller, useForm } from 'react-hook-form';

import {
  CreateTagSchema,
  TAG_CATEGORIES,
  TAG_CATEGORY_LABELS,
  TAG_LIMITS,
  TAG_NAME_MAX_LENGTH,
  type CreateTagInput,
  type Tag,
} from '@tradr/shared';

import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';

import { getTagErrorCode, useCreateTag, useUpdateTag } from '../hooks/useTags';

import { TagColorPicker } from './TagColorPicker';

// The two 409 codes the name field renders inline (branch on the CODE only,
// never message text). Anything else is toasted by the mutation hook.
function nameErrorText(code: string): string | undefined {
  switch (code) {
    case 'TAG_NAME_TAKEN':
      return 'A tag with this name already exists — names are unique across categories';
    case 'TAG_LIMIT_REACHED':
      return `You have reached the limit of ${TAG_LIMITS.perUser} tags`;
    default:
      return undefined;
  }
}

/**
 * Create or edit a tag (design Component 15; REQ-5.2/5.3). React Hook Form over
 * `CreateTagSchema` (the `BrokerageDialog` pattern): a name `Input`, a category
 * `Select` and the `TagColorPicker`. `TAG_NAME_TAKEN` and `TAG_LIMIT_REACHED`
 * render under the name field by code; the dialog closes on success.
 */
export function TagDialog({
  open,
  onOpenChange,
  tag,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  tag?: Tag | null;
}) {
  const isEdit = !!tag;
  const createTag = useCreateTag();
  const updateTag = useUpdateTag();
  const [errorCode, setErrorCode] = useState<string | undefined>(undefined);

  const form = useForm<CreateTagInput>({
    resolver: zodResolver(CreateTagSchema),
    defaultValues: { name: '', category: 'setup', color: null },
  });

  // Re-seed each time the dialog (re)opens so a cancelled edit does not leak into
  // the next open. Deps are intentionally just `open`.
  useEffect(() => {
    if (!open) return;
    form.reset({
      name: tag?.name ?? '',
      category: tag?.category ?? 'setup',
      color: tag?.color ?? null,
    });
    setErrorCode(undefined);
  }, [open]);

  const isPending = createTag.isPending || updateTag.isPending;

  const onSubmit = form.handleSubmit(async (values) => {
    setErrorCode(undefined);
    try {
      if (isEdit) {
        await updateTag.mutateAsync({ id: tag.id, data: values });
      } else {
        await createTag.mutateAsync(values);
      }
      onOpenChange(false);
      form.reset();
    } catch (err) {
      setErrorCode(getTagErrorCode(err) ?? 'UNKNOWN');
    }
  });

  const codeText = errorCode ? nameErrorText(errorCode) : undefined;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{isEdit ? 'Edit tag' : 'New tag'}</DialogTitle>
        </DialogHeader>
        <form onSubmit={onSubmit} className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="tag-name">Name</Label>
            <Input id="tag-name" {...form.register('name')} maxLength={TAG_NAME_MAX_LENGTH} />
            {form.formState.errors.name && (
              <p className="text-sm text-destructive">{form.formState.errors.name.message}</p>
            )}
            {codeText && <p className="text-sm text-destructive">{codeText}</p>}
          </div>

          <div className="space-y-2">
            <Label htmlFor="tag-category">Category</Label>
            <Controller
              control={form.control}
              name="category"
              render={({ field }) => (
                <Select value={field.value} onValueChange={field.onChange}>
                  <SelectTrigger id="tag-category" className="cursor-pointer">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {TAG_CATEGORIES.map((category) => (
                      <SelectItem key={category} value={category} className="cursor-pointer">
                        {TAG_CATEGORY_LABELS[category]}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              )}
            />
          </div>

          <div className="space-y-2">
            <Label>Colour</Label>
            <Controller
              control={form.control}
              name="color"
              render={({ field }) => (
                <TagColorPicker value={field.value ?? null} onChange={field.onChange} />
              )}
            />
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
            <Button type="submit" className="cursor-pointer" disabled={isPending}>
              {isPending ? 'Saving...' : isEdit ? 'Save' : 'Create'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

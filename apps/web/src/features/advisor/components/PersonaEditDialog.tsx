// PersonaEditDialog — create/edit modal for advisor personas (REQ-7.7–7.10).
//
// Two modes: 'create' POSTs a new user-owned persona via usePersonas.create;
// 'edit' PATCHes an existing one via usePersonas.update. Built-in personas are
// rendered read-only with no Save button — a client-side guard mirroring the
// server's 403 (REQ-12.2). Validation is driven by PersonaInputSchema.

import { zodResolver } from '@hookform/resolvers/zod';
import { useEffect } from 'react';
import { useForm } from 'react-hook-form';

import { PersonaInputSchema, type Persona, type PersonaInput } from '@tradr/shared/schemas/advisor';

import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';

import { usePersonas } from '../hooks/usePersonas';

export interface PersonaEditDialogProps {
  open: boolean;
  mode: 'create' | 'edit';
  persona?: Persona;
  onClose: () => void;
}

function toDefaults(persona?: Persona): PersonaInput {
  return {
    name: persona?.name ?? '',
    description: persona?.description ?? '',
    systemPrompt: persona?.systemPrompt ?? '',
  };
}

export function PersonaEditDialog({ open, mode, persona, onClose }: PersonaEditDialogProps) {
  const create = usePersonas.create();
  const update = usePersonas.update();

  const isBuiltin = persona?.isBuiltin === true;
  const readOnly = mode === 'edit' && isBuiltin;

  const form = useForm<PersonaInput>({
    resolver: zodResolver(PersonaInputSchema),
    defaultValues: toDefaults(persona),
  });

  // Keep the form in sync with the persona prop without mutating it.
  useEffect(() => {
    form.reset(toDefaults(persona));
  }, [form, persona]);

  const onSubmit = form.handleSubmit(async (data) => {
    if (readOnly) return;
    if (mode === 'create') {
      await create.mutateAsync(data);
    } else if (persona) {
      await update.mutateAsync({ persona, input: data });
    }
    onClose();
  });

  const isPending = create.isPending || update.isPending;

  return (
    <Dialog open={open} onOpenChange={(next) => (next ? undefined : onClose())}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{mode === 'create' ? 'New Persona' : 'Edit Persona'}</DialogTitle>
          {readOnly && (
            <DialogDescription>
              Built-in personas are read-only and cannot be edited.
            </DialogDescription>
          )}
        </DialogHeader>
        <form onSubmit={onSubmit} className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="persona-name">Name</Label>
            <Input
              id="persona-name"
              readOnly={readOnly}
              {...form.register('name')}
              placeholder="e.g., Risk Coach"
            />
            {form.formState.errors.name && (
              <p className="text-sm text-destructive">{form.formState.errors.name.message}</p>
            )}
          </div>
          <div className="space-y-2">
            <Label htmlFor="persona-description">Description</Label>
            <Input
              id="persona-description"
              readOnly={readOnly}
              {...form.register('description')}
              placeholder="Optional summary"
            />
            {form.formState.errors.description && (
              <p className="text-sm text-destructive">
                {form.formState.errors.description.message}
              </p>
            )}
          </div>
          <div className="space-y-2">
            <Label htmlFor="persona-system-prompt">System prompt</Label>
            <Textarea
              id="persona-system-prompt"
              readOnly={readOnly}
              rows={6}
              {...form.register('systemPrompt')}
              placeholder="Instructions that shape the advisor's voice"
            />
            {form.formState.errors.systemPrompt && (
              <p className="text-sm text-destructive">
                {form.formState.errors.systemPrompt.message}
              </p>
            )}
          </div>
          <div className="flex justify-end gap-2">
            <Button type="button" variant="outline" className="cursor-pointer" onClick={onClose}>
              {readOnly ? 'Close' : 'Cancel'}
            </Button>
            {!readOnly && (
              <Button type="submit" className="cursor-pointer" disabled={isPending}>
                {isPending ? 'Saving...' : 'Save'}
              </Button>
            )}
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}

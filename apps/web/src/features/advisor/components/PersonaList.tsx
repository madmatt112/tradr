// PersonaList — built-in + user persona management surface (REQ-7.7–7.10).
//
// Built-in personas (isBuiltin) render with a "Built-in" badge and NO
// edit/delete actions — they are immutable (server returns 403; we never even
// send the request). User-owned personas get edit + delete (with an inline
// confirm step) and participate in the exclusive set-default toggle (REQ-7.9):
// exactly one persona may be the default at a time.
//
// Create/edit interactions delegate to Task 38's PersonaEditDialog — this
// component never inlines a dialog of its own.

import { useState } from 'react';

import type { Persona } from '@tradr/shared/schemas/advisor';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';

import { usePersonas } from '../hooks/usePersonas';

import { PersonaEditDialog } from './PersonaEditDialog';

type DialogState =
  | { open: false }
  | { open: true; mode: 'create' }
  | { open: true; mode: 'edit'; persona: Persona };

export function PersonaList() {
  const { data, isLoading } = usePersonas.list();
  const setDefault = usePersonas.setDefault();
  const remove = usePersonas.delete();

  const [dialog, setDialog] = useState<DialogState>({ open: false });
  const [confirmingDeleteId, setConfirmingDeleteId] = useState<string | null>(null);

  const personas = data?.items ?? [];

  const onDelete = async (persona: Persona) => {
    await remove.mutateAsync(persona);
    setConfirmingDeleteId(null);
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-semibold">Personas</h2>
        <Button
          type="button"
          className="cursor-pointer"
          onClick={() => setDialog({ open: true, mode: 'create' })}
        >
          New persona
        </Button>
      </div>

      {isLoading ? (
        <p className="text-sm text-muted-foreground">Loading personas…</p>
      ) : personas.length === 0 ? (
        <p className="text-sm text-muted-foreground">No personas yet.</p>
      ) : (
        <ul className="space-y-3">
          {personas.map((persona) => (
            <li key={persona.id}>
              <Card data-testid={`persona-${persona.id}`}>
                <CardHeader>
                  <div className="flex items-center justify-between gap-2">
                    <CardTitle className="flex items-center gap-2">
                      {persona.name}
                      {persona.isBuiltin && <Badge variant="secondary">Built-in</Badge>}
                      {persona.isDefault && <Badge variant="outline">Default</Badge>}
                    </CardTitle>
                  </div>
                  {persona.description && <CardDescription>{persona.description}</CardDescription>}
                </CardHeader>
                <CardContent>
                  <div className="flex flex-wrap items-center gap-2">
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      className="cursor-pointer"
                      disabled={persona.isDefault || setDefault.isPending}
                      onClick={() => setDefault.mutate(persona.id)}
                    >
                      {persona.isDefault ? 'Default' : 'Set as default'}
                    </Button>

                    {!persona.isBuiltin && (
                      <>
                        <Button
                          type="button"
                          variant="outline"
                          size="sm"
                          className="cursor-pointer"
                          onClick={() => setDialog({ open: true, mode: 'edit', persona })}
                        >
                          Edit
                        </Button>

                        {confirmingDeleteId === persona.id ? (
                          <>
                            <Button
                              type="button"
                              variant="destructive"
                              size="sm"
                              className="cursor-pointer"
                              disabled={remove.isPending}
                              onClick={() => onDelete(persona)}
                            >
                              Confirm delete
                            </Button>
                            <Button
                              type="button"
                              variant="outline"
                              size="sm"
                              className="cursor-pointer"
                              onClick={() => setConfirmingDeleteId(null)}
                            >
                              Cancel
                            </Button>
                          </>
                        ) : (
                          <Button
                            type="button"
                            variant="outline"
                            size="sm"
                            className="cursor-pointer"
                            onClick={() => setConfirmingDeleteId(persona.id)}
                          >
                            Delete
                          </Button>
                        )}
                      </>
                    )}
                  </div>
                </CardContent>
              </Card>
            </li>
          ))}
        </ul>
      )}

      {dialog.open && (
        <PersonaEditDialog
          open
          mode={dialog.mode}
          persona={dialog.mode === 'edit' ? dialog.persona : undefined}
          onClose={() => setDialog({ open: false })}
        />
      )}
    </div>
  );
}

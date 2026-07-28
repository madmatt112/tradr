// usePersonas — TanStack Query hooks for the advisor persona CRUD surface
// (REQ-7.7 list, REQ-7.8 create/update, REQ-7.9 set-default, REQ-7.10 delete).
//
// Built-in personas (isBuiltin) are immutable client-side: the update and
// delete mutations refuse to issue a request for them rather than relying on
// the server's 403/409 guard alone. Consuming components (PersonaList Task 37,
// PersonaEditDialog Task 38) read these helpers via usePersonas.* aliases.

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import type { Persona, PersonaInput } from '@tradr/shared/schemas/advisor';

import { api } from '@/lib/api';

export const personaKeys = {
  list: () => ['advisor', 'personas'] as const,
};

export interface PersonaListResponse {
  items: Persona[];
}

/** Thrown when a mutation is asked to edit/delete a built-in persona. */
export class BuiltinPersonaError extends Error {
  constructor() {
    super('Built-in personas cannot be edited or deleted.');
    this.name = 'BuiltinPersonaError';
  }
}

/** REQ-7.7 — list built-in personas plus the user's own. */
export function useListPersonas() {
  return useQuery<PersonaListResponse>({
    queryKey: personaKeys.list(),
    queryFn: () => api.get<PersonaListResponse>('/advisor/personas'),
  });
}

/** REQ-7.8 — create a user-owned persona, then refresh the list. */
export function useCreatePersona() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: PersonaInput) => api.post<Persona>('/advisor/personas', input),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: personaKeys.list() });
    },
  });
}

/** REQ-7.8 — update a user-owned persona; refuses built-ins client-side. */
export function useUpdatePersona() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ persona, input }: { persona: Persona; input: Partial<PersonaInput> }) => {
      if (persona.isBuiltin) {
        return Promise.reject(new BuiltinPersonaError());
      }
      return api.patch<Persona>(`/advisor/personas/${persona.id}`, input);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: personaKeys.list() });
    },
  });
}

/** REQ-7.10 — delete a user-owned persona; refuses built-ins client-side. */
export function useDeletePersona() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (persona: Persona) => {
      if (persona.isBuiltin) {
        return Promise.reject(new BuiltinPersonaError());
      }
      return api.delete(`/advisor/personas/${persona.id}`);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: personaKeys.list() });
    },
  });
}

/** REQ-7.9 — set a persona (built-in or owned) as the user's default. */
export function useSetDefaultPersona() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.post(`/advisor/personas/${id}/default`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: personaKeys.list() });
    },
  });
}

/**
 * Aggregate accessor so PersonaList / PersonaEditDialog can consume
 * usePersonas.create, usePersonas.update, etc.
 */
export const usePersonas = {
  list: useListPersonas,
  create: useCreatePersona,
  update: useUpdatePersona,
  delete: useDeletePersona,
  setDefault: useSetDefaultPersona,
};

// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderHook, waitFor } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { Persona } from '@tradr/shared/schemas/advisor';

import { api } from '@/lib/api';

import {
  BuiltinPersonaError,
  personaKeys,
  useCreatePersona,
  useListPersonas,
  useUpdatePersona,
} from './usePersonas';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('@/lib/api', () => ({
  api: { get: vi.fn(), post: vi.fn(), patch: vi.fn(), delete: vi.fn() },
}));

const builtin: Persona = {
  id: 'builtin-coach',
  userId: null,
  name: 'Coach',
  description: null,
  systemPrompt: 'sp',
  isBuiltin: true,
  isDefault: false,
  createdAt: 't',
  updatedAt: 't',
};

function makeWrapper(qc: QueryClient) {
  return function Wrapper({ children }: { children: ReactNode }) {
    return createElement(QueryClientProvider, { client: qc }, children);
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('usePersonas', () => {
  it('lists personas from GET /advisor/personas', async () => {
    const response = { items: [builtin] };
    vi.mocked(api.get).mockResolvedValue(response);
    const qc = new QueryClient();

    const { result } = renderHook(() => useListPersonas(), { wrapper: makeWrapper(qc) });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(api.get).toHaveBeenCalledWith('/advisor/personas');
    expect(result.current.data).toEqual(response);
  });

  it('create POSTs the persona and invalidates the list', async () => {
    vi.mocked(api.post).mockResolvedValue({ ...builtin, id: 'new', isBuiltin: false });
    const qc = new QueryClient();
    const invalidate = vi.spyOn(qc, 'invalidateQueries');

    const { result } = renderHook(() => useCreatePersona(), { wrapper: makeWrapper(qc) });
    await result.current.mutateAsync({ name: 'Mine', systemPrompt: 'sp' });

    expect(api.post).toHaveBeenCalledWith('/advisor/personas', {
      name: 'Mine',
      systemPrompt: 'sp',
    });
    expect(invalidate).toHaveBeenCalledWith({ queryKey: personaKeys.list() });
  });

  it('update refuses built-in personas without calling the API', async () => {
    const qc = new QueryClient();

    const { result } = renderHook(() => useUpdatePersona(), { wrapper: makeWrapper(qc) });

    await expect(
      result.current.mutateAsync({ persona: builtin, input: { name: 'Hacked' } }),
    ).rejects.toBeInstanceOf(BuiltinPersonaError);
    expect(api.patch).not.toHaveBeenCalled();
  });
});

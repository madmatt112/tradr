// @vitest-environment jsdom
import userEvent from '@testing-library/user-event';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { Persona } from '@tradr/shared/schemas/advisor';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// usePersonas (Task 34) is mocked so we assert the create/update mutations are
// invoked with the right payloads without touching TanStack Query / the API.
const createMutate = vi.fn().mockResolvedValue(undefined);
const updateMutate = vi.fn().mockResolvedValue(undefined);

vi.mock('../../hooks/usePersonas', () => ({
  usePersonas: {
    create: () => ({ mutateAsync: createMutate, isPending: false }),
    update: () => ({ mutateAsync: updateMutate, isPending: false }),
  },
}));

import { PersonaEditDialog } from '../PersonaEditDialog';

let mounted: { container: HTMLElement; root: Root } | null = null;

function mount(ui: React.ReactElement): void {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  mounted = { container, root };
  act(() => {
    root.render(ui);
  });
}

afterEach(() => {
  if (mounted) {
    act(() => mounted!.root.unmount());
    mounted.container.remove();
    mounted = null;
  }
  createMutate.mockClear();
  updateMutate.mockClear();
});

// Radix Dialog renders into a portal under document.body — query globally.
function byId<T extends HTMLElement>(id: string): T | null {
  return document.getElementById(id) as T | null;
}
function saveButton(): HTMLButtonElement | undefined {
  return Array.from(document.querySelectorAll('button')).find(
    (b) => b.textContent?.trim() === 'Save',
  ) as HTMLButtonElement | undefined;
}
function buttonByText(text: string): HTMLButtonElement | undefined {
  return Array.from(document.querySelectorAll('button')).find(
    (b) => b.textContent?.trim() === text,
  ) as HTMLButtonElement | undefined;
}

const ownedPersona: Persona = {
  id: 'p-1',
  userId: 'u-1',
  name: 'Risk Coach',
  description: 'Keeps me honest',
  systemPrompt: 'Be a tough but fair risk coach.',
  isBuiltin: false,
  isDefault: false,
  createdAt: 't',
  updatedAt: 't',
};

const builtinPersona: Persona = {
  ...ownedPersona,
  id: 'builtin-1',
  userId: null,
  name: 'Default Coach',
  isBuiltin: true,
};

describe('PersonaEditDialog', () => {
  it('create mode shows an empty form + Save and submits via usePersonas.create', async () => {
    const user = userEvent.setup();
    mount(<PersonaEditDialog open mode="create" onClose={vi.fn()} />);

    const name = byId<HTMLInputElement>('persona-name')!;
    const prompt = byId<HTMLTextAreaElement>('persona-system-prompt')!;
    expect(name.value).toBe('');
    expect(prompt.value).toBe('');
    expect(saveButton()).toBeDefined();

    await act(async () => {
      await user.type(name, 'Scalper');
      await user.type(prompt, 'Trade fast.');
    });
    await act(async () => {
      saveButton()!.click();
    });

    expect(createMutate).toHaveBeenCalledTimes(1);
    expect(createMutate).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'Scalper', systemPrompt: 'Trade fast.' }),
    );
    expect(updateMutate).not.toHaveBeenCalled();
  });

  it('edit mode pre-fills fields, submits via update, and cancel calls onClose without mutating', async () => {
    const onClose = vi.fn();
    mount(<PersonaEditDialog open mode="edit" persona={ownedPersona} onClose={onClose} />);

    expect(byId<HTMLInputElement>('persona-name')!.value).toBe('Risk Coach');
    expect(byId<HTMLTextAreaElement>('persona-system-prompt')!.value).toBe(
      'Be a tough but fair risk coach.',
    );

    await act(async () => {
      saveButton()!.click();
    });
    expect(updateMutate).toHaveBeenCalledTimes(1);
    expect(updateMutate).toHaveBeenCalledWith({
      persona: ownedPersona,
      input: expect.objectContaining({ name: 'Risk Coach' }),
    });

    await act(async () => {
      buttonByText('Cancel')!.click();
    });
    expect(onClose).toHaveBeenCalled();
    expect(createMutate).not.toHaveBeenCalled();
  });

  it('edit mode for a built-in persona is read-only with no Save button', () => {
    mount(<PersonaEditDialog open mode="edit" persona={builtinPersona} onClose={vi.fn()} />);

    expect(byId<HTMLInputElement>('persona-name')!.readOnly).toBe(true);
    expect(byId<HTMLTextAreaElement>('persona-system-prompt')!.readOnly).toBe(true);
    expect(saveButton()).toBeUndefined();
    expect(updateMutate).not.toHaveBeenCalled();
  });
});

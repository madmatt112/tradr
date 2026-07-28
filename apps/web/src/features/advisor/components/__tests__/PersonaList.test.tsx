// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { Persona } from '@tradr/shared/schemas/advisor';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// usePersonas (Task 34) is mocked: the list feeds fixtures and the mutations
// let us assert delete / set-default are issued (and never for built-ins).
const listData = { items: [] as Persona[] };
const setDefaultMutate = vi.fn();
const deleteMutate = vi.fn().mockResolvedValue(undefined);

vi.mock('../../hooks/usePersonas', () => ({
  usePersonas: {
    list: () => ({ data: listData, isLoading: false }),
    setDefault: () => ({ mutate: setDefaultMutate, isPending: false }),
    delete: () => ({ mutateAsync: deleteMutate, isPending: false }),
  },
}));

// PersonaEditDialog (Task 38) is owned elsewhere — stub it so we can assert
// PersonaList opens it with the right mode/persona instead of inlining a dialog.
const dialogProps = vi.fn();
vi.mock('../PersonaEditDialog', () => ({
  PersonaEditDialog: (props: { mode: string; persona?: Persona }) => {
    dialogProps(props);
    return null;
  },
}));

import { PersonaList } from '../PersonaList';

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
  listData.items = [];
  setDefaultMutate.mockClear();
  deleteMutate.mockClear();
  dialogProps.mockClear();
});

function buttonsByText(text: string): HTMLButtonElement[] {
  return Array.from(document.querySelectorAll('button')).filter(
    (b) => b.textContent?.trim() === text,
  ) as HTMLButtonElement[];
}
function buttonByText(text: string): HTMLButtonElement | undefined {
  return buttonsByText(text)[0];
}

const builtin: Persona = {
  id: 'builtin-1',
  userId: null,
  name: 'Default Coach',
  description: 'Built-in advisor',
  systemPrompt: 'Be helpful.',
  isBuiltin: true,
  isDefault: true,
  createdAt: 't',
  updatedAt: 't',
};

const owned: Persona = {
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

describe('PersonaList', () => {
  it('renders built-in personas with a badge and no edit/delete actions', () => {
    listData.items = [builtin];
    mount(<PersonaList />);

    expect(document.body.textContent).toContain('Built-in');
    // Built-ins are read-only: no Edit / Delete buttons rendered for them.
    expect(buttonByText('Edit')).toBeUndefined();
    expect(buttonByText('Delete')).toBeUndefined();
  });

  it('create flow opens Task 38 dialog in create mode', () => {
    listData.items = [builtin];
    mount(<PersonaList />);

    act(() => {
      buttonByText('New persona')!.click();
    });

    expect(dialogProps).toHaveBeenLastCalledWith(
      expect.objectContaining({ open: true, mode: 'create', persona: undefined }),
    );
  });

  it('user personas support edit (opens dialog) and delete (confirm)', async () => {
    listData.items = [owned];
    mount(<PersonaList />);

    act(() => {
      buttonByText('Edit')!.click();
    });
    expect(dialogProps).toHaveBeenLastCalledWith(
      expect.objectContaining({ open: true, mode: 'edit', persona: owned }),
    );

    act(() => {
      buttonByText('Delete')!.click();
    });
    await act(async () => {
      buttonByText('Confirm delete')!.click();
    });
    expect(deleteMutate).toHaveBeenCalledWith(owned);
  });

  it('set-default toggle is exclusive — only the default is disabled, others issue setDefault', () => {
    listData.items = [
      { ...owned, isDefault: true },
      { ...owned, id: 'p-2', isDefault: false },
    ];
    mount(<PersonaList />);

    const defaultBtns = buttonsByText('Default');
    const setBtns = buttonsByText('Set as default');
    // Exactly one persona is the default (disabled), the other can be promoted.
    expect(defaultBtns).toHaveLength(1);
    expect(defaultBtns[0].disabled).toBe(true);
    expect(setBtns).toHaveLength(1);

    act(() => {
      setBtns[0].click();
    });
    expect(setDefaultMutate).toHaveBeenCalledWith('p-2');
    expect(setDefaultMutate).toHaveBeenCalledTimes(1);
  });
});

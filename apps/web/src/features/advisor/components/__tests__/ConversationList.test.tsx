// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { ConversationListItem } from '@tradr/shared/schemas/advisor';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// useConversations (Task 32) is mocked: the list query feeds fixtures and the
// delete/rename mutations let us assert the right requests are issued.
const listData = { items: [] as ConversationListItem[], nextCursor: null };
const deleteMutate = vi.fn().mockResolvedValue(undefined);
const renameMutate = vi.fn().mockResolvedValue(undefined);

vi.mock('../../hooks/useConversations', () => ({
  useConversations: () => ({ data: listData, isLoading: false }),
  useDeleteConversation: () => ({ mutateAsync: deleteMutate, isPending: false }),
  useRenameConversation: () => ({ mutateAsync: renameMutate, isPending: false }),
}));

import { ConversationList } from '../ConversationList';

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
  deleteMutate.mockClear();
  renameMutate.mockClear();
});

function byLabel(label: string): HTMLButtonElement | undefined {
  return Array.from(document.querySelectorAll('button')).find(
    (b) => b.getAttribute('aria-label') === label,
  ) as HTMLButtonElement | undefined;
}

const one: ConversationListItem = {
  id: '11111111-1111-1111-1111-111111111111',
  title: 'First chat',
  providerId: 'claude',
  model: 'claude-opus-4-7',
  updatedAt: new Date().toISOString(),
};
const two: ConversationListItem = {
  id: '22222222-2222-2222-2222-222222222222',
  title: 'Second chat',
  providerId: 'openai',
  model: 'gpt-4o',
  updatedAt: new Date().toISOString(),
};

describe('ConversationList', () => {
  it('renders conversations and highlights the active one via onSelect', () => {
    listData.items = [one, two];
    const onSelect = vi.fn();
    mount(<ConversationList activeId={two.id} onSelect={onSelect} />);

    expect(document.body.textContent).toContain('First chat');
    expect(document.body.textContent).toContain('Second chat');

    // The active row is marked; clicking another row calls onSelect with its id.
    const active = document.querySelector(`[data-testid="conversation-${two.id}"]`)!;
    expect(active.querySelector('[aria-current="true"]')).not.toBeNull();

    act(() => {
      (
        document.querySelector(`[data-testid="conversation-${one.id}"] button`) as HTMLButtonElement
      ).click();
    });
    expect(onSelect).toHaveBeenCalledWith(one.id);
  });

  it('delete requires confirmation — no auto-delete on first click', async () => {
    listData.items = [one];
    mount(<ConversationList activeId={null} onSelect={vi.fn()} />);

    act(() => {
      byLabel('Delete conversation')!.click();
    });
    // First click only reveals the confirm control; nothing deleted yet.
    expect(deleteMutate).not.toHaveBeenCalled();

    await act(async () => {
      byLabel('Confirm delete')!.click();
    });
    expect(deleteMutate).toHaveBeenCalledWith(one.id);
  });

  it('inline rename submits the trimmed title via the rename mutation', async () => {
    listData.items = [one];
    mount(<ConversationList activeId={null} onSelect={vi.fn()} />);

    act(() => {
      byLabel('Rename conversation')!.click();
    });

    const input = document.querySelector('input') as HTMLInputElement;
    const setValue = Object.getOwnPropertyDescriptor(
      window.HTMLInputElement.prototype,
      'value',
    )!.set!;
    act(() => {
      setValue.call(input, '  Renamed  ');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });

    await act(async () => {
      byLabel('Save title')!.click();
    });
    expect(renameMutate).toHaveBeenCalledWith({ id: one.id, title: 'Renamed' });
  });

  it('shows an empty state when there are no conversations', () => {
    listData.items = [];
    mount(<ConversationList activeId={null} onSelect={vi.fn()} />);

    expect(document.body.textContent).toContain('No conversations yet.');
  });
});

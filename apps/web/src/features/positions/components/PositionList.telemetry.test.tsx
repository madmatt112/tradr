// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// The single deliberate frontend product event (REQ-3.8, design Component 9).
const captureClientEvent = vi.fn();
vi.mock('@/lib/telemetry/posthog', () => ({
  captureClientEvent: (...args: unknown[]) => captureClientEvent(...args),
}));

// Mock the data hooks so the component renders without TanStack Query / the API.
// One account is enough for the enabled "New Position" button to render.
vi.mock('@/features/accounts/hooks/useAccounts', () => ({
  useAccounts: () => ({ data: [{ id: 'a1' }] }),
}));
vi.mock('../hooks/usePositions', () => ({
  usePositions: () => ({ data: [], isLoading: false }),
}));

// Stub the (controlled) dialog so we don't pull in useCreatePosition / Radix
// portals. It exposes a close affordance so we can drive the open→close→open cycle.
vi.mock('./CreatePositionDialog', () => ({
  CreatePositionDialog: ({
    open,
    onOpenChange,
  }: {
    open: boolean;
    onOpenChange: (open: boolean) => void;
  }) =>
    open ? (
      <button type="button" data-testid="close-dialog" onClick={() => onOpenChange(false)}>
        close
      </button>
    ) : null,
}));

import { PositionList } from './PositionList';

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

function newPositionButton(): HTMLButtonElement {
  const btn = Array.from(document.querySelectorAll('button')).find(
    (b) => b.textContent?.trim() === 'New Position',
  );
  if (!btn) throw new Error('New Position button not found');
  return btn as HTMLButtonElement;
}

function closeDialogButton(): HTMLButtonElement | null {
  return document.querySelector('[data-testid="close-dialog"]');
}

beforeEach(() => {
  captureClientEvent.mockClear();
});

afterEach(() => {
  if (mounted) {
    act(() => mounted!.root.unmount());
    mounted.container.remove();
    mounted = null;
  }
});

describe('PositionList — position_create_dialog_opened event', () => {
  it('does not fire on initial render while the dialog is closed', () => {
    mount(<PositionList />);
    expect(captureClientEvent).not.toHaveBeenCalled();
    expect(closeDialogButton()).toBeNull();
  });

  it('fires exactly once when the create-position dialog opens', () => {
    mount(<PositionList />);

    act(() => {
      newPositionButton().click();
    });

    expect(closeDialogButton()).not.toBeNull();
    expect(captureClientEvent).toHaveBeenCalledTimes(1);
    expect(captureClientEvent).toHaveBeenCalledWith('position_create_dialog_opened');
  });

  it('fires again on reopen (once per open) and not on close', () => {
    mount(<PositionList />);

    act(() => {
      newPositionButton().click();
    });
    expect(captureClientEvent).toHaveBeenCalledTimes(1);

    // Close — must NOT fire.
    act(() => {
      closeDialogButton()!.click();
    });
    expect(captureClientEvent).toHaveBeenCalledTimes(1);
    expect(closeDialogButton()).toBeNull();

    // Reopen — fires again.
    act(() => {
      newPositionButton().click();
    });
    expect(captureClientEvent).toHaveBeenCalledTimes(2);
  });
});

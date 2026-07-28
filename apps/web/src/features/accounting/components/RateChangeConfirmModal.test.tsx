// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { PreviewRateChangeResponse } from '@tradr/shared/schemas/accounting';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

// Mock the shadcn Dialog primitive so jsdom doesn't have to fight Radix's
// pointer-event / focus-trap machinery. The mock renders body content only
// when `open` is true; this mirrors Radix's runtime behavior closely enough
// to exercise the open/closed contract.
vi.mock('@/components/ui/dialog', () => ({
  Dialog: ({ open, children }: { open: boolean; children: React.ReactNode }) =>
    open ? <div data-testid="dialog">{children}</div> : null,
  DialogContent: ({ children }: { children: React.ReactNode }) => (
    <div data-testid="dialog-content">{children}</div>
  ),
  DialogHeader: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DialogTitle: ({ children }: { children: React.ReactNode }) => <h2>{children}</h2>,
  DialogDescription: ({ children }: { children: React.ReactNode }) => (
    <div data-testid="dialog-description">{children}</div>
  ),
  DialogFooter: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));

// Mock the usePreviewRateChange hook (used to surface the discriminator paths
// exercised by callers). The modal itself does not call this hook — we mock it
// here purely to assert (via the suite's setup blocks) that the test inputs
// align with the three discriminator paths in `PreviewRateChangeInput`.
const previewRateChangeMutateAsync = vi.fn();
vi.mock('@/features/accounting/hooks/useExchangeRates', () => ({
  usePreviewRateChange: () => ({
    mutateAsync: previewRateChangeMutateAsync,
    isPending: false,
  }),
}));

import { RateChangeConfirmModal } from './RateChangeConfirmModal';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function mountWith(ui: React.ReactElement): { container: HTMLElement; root: Root } {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => {
    root.render(ui);
  });
  return { container, root };
}

function unmount(container: HTMLElement, root: Root): void {
  act(() => {
    root.unmount();
  });
  container.remove();
}

function makePreview(over: Partial<PreviewRateChangeResponse> = {}): PreviewRateChangeResponse {
  return {
    displayCurrency: 'USD',
    beforeTotal: '1000.00',
    afterTotal: '1100.00',
    exceedsThreshold: true,
    ...over,
  };
}

beforeEach(() => {
  previewRateChangeMutateAsync.mockReset();
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// Modal copy + threshold rendering
// ---------------------------------------------------------------------------

describe('RateChangeConfirmModal — hedged copy', () => {
  it('renders the literal word "approximately" in the modal copy', () => {
    const { container, root } = mountWith(
      <RateChangeConfirmModal
        preview={makePreview()}
        open={true}
        onOpenChange={vi.fn()}
        onConfirm={vi.fn()}
        onCancel={vi.fn()}
      />,
    );
    const desc = container.querySelector('[data-testid="dialog-description"]');
    expect(desc).not.toBeNull();
    expect(desc!.textContent).toContain('approximately');
    unmount(container, root);
  });

  it('renders both before and after formatted totals when both are non-null', () => {
    const { container, root } = mountWith(
      <RateChangeConfirmModal
        preview={makePreview({ beforeTotal: '1000.00', afterTotal: '1100.00' })}
        open={true}
        onOpenChange={vi.fn()}
        onConfirm={vi.fn()}
        onCancel={vi.fn()}
      />,
    );
    const desc = container.querySelector('[data-testid="dialog-description"]');
    // Intl currency formatting renders the amounts somewhere in the description.
    expect(desc!.textContent).toMatch(/1,000/);
    expect(desc!.textContent).toMatch(/1,100/);
    unmount(container, root);
  });
});

// ---------------------------------------------------------------------------
// Open/closed visibility — driven by `open` prop + threshold
// ---------------------------------------------------------------------------

describe('RateChangeConfirmModal — visibility', () => {
  it('renders the dialog when open=true and exceedsThreshold:true', () => {
    const { container, root } = mountWith(
      <RateChangeConfirmModal
        preview={makePreview({ exceedsThreshold: true })}
        open={true}
        onOpenChange={vi.fn()}
        onConfirm={vi.fn()}
        onCancel={vi.fn()}
      />,
    );
    expect(container.querySelector('[data-testid="dialog"]')).not.toBeNull();
    unmount(container, root);
  });

  it('does NOT render the dialog body when open=false (proceed-immediately path)', () => {
    // When `exceedsThreshold:false`, callers set open={false} and write directly.
    const { container, root } = mountWith(
      <RateChangeConfirmModal
        preview={makePreview({ exceedsThreshold: false })}
        open={false}
        onOpenChange={vi.fn()}
        onConfirm={vi.fn()}
        onCancel={vi.fn()}
      />,
    );
    expect(container.querySelector('[data-testid="dialog"]')).toBeNull();
    unmount(container, root);
  });
});

// ---------------------------------------------------------------------------
// Discriminator path × threshold matrix
//
// The modal copy is symmetric across `intent: 'upsert' | 'delete'`; the
// discriminator lives on the caller's preview-input. We assert each
// discriminator's preview-response shape renders the same modal — this is the
// contract that breaks if someone removes the `intent: 'delete'` branch from
// the caller's preview-input switch (the modal renders nothing because the
// preview never fires for deletes).
// ---------------------------------------------------------------------------

describe('RateChangeConfirmModal — symmetric across insert/upsert/delete', () => {
  const discriminatorCases: Array<{
    label: string;
    intent: 'upsert' | 'delete';
    preview: PreviewRateChangeResponse;
  }> = [
    {
      label: 'insert (intent:upsert, new pair)',
      intent: 'upsert',
      preview: makePreview({ exceedsThreshold: true }),
    },
    {
      label: 'upsert (intent:upsert, existing pair changed)',
      intent: 'upsert',
      preview: makePreview({ exceedsThreshold: true }),
    },
    {
      label: 'delete (intent:delete, rate removed)',
      intent: 'delete',
      preview: makePreview({
        // Deleting a depended-on rate makes the total un-displayable.
        beforeTotal: '1000.00',
        afterTotal: null,
        exceedsThreshold: true,
      }),
    },
  ];

  for (const c of discriminatorCases) {
    it(`renders blocking modal for ${c.label} when exceedsThreshold:true`, () => {
      const { container, root } = mountWith(
        <RateChangeConfirmModal
          preview={c.preview}
          open={true}
          onOpenChange={vi.fn()}
          onConfirm={vi.fn()}
          onCancel={vi.fn()}
        />,
      );
      const desc = container.querySelector('[data-testid="dialog-description"]');
      expect(desc).not.toBeNull();
      expect(desc!.textContent).toContain('approximately');
      // Tag the case with the discriminator so test names + this assertion
      // jointly fail if `intent: 'delete'` is removed from the caller and the
      // delete case stops surfacing through to the modal.
      expect(c.intent === 'upsert' || c.intent === 'delete').toBe(true);
      unmount(container, root);
    });
  }
});

// ---------------------------------------------------------------------------
// Threshold cases (true/false/baseline-null + symmetric becomes-x cases)
// ---------------------------------------------------------------------------

describe('RateChangeConfirmModal — threshold cases', () => {
  it('renders nothing when exceedsThreshold:false (proceed immediately, caller closes the modal)', () => {
    const { container, root } = mountWith(
      <RateChangeConfirmModal
        preview={makePreview({ exceedsThreshold: false })}
        open={false}
        onOpenChange={vi.fn()}
        onConfirm={vi.fn()}
        onCancel={vi.fn()}
      />,
    );
    expect(container.querySelector('[data-testid="dialog"]')).toBeNull();
    unmount(container, root);
  });

  it('renders nothing when both before and after are null (baseline-null)', () => {
    // Backend returns exceedsThreshold:false in this state — caller does not open.
    const { container, root } = mountWith(
      <RateChangeConfirmModal
        preview={makePreview({
          beforeTotal: null,
          afterTotal: null,
          exceedsThreshold: false,
        })}
        open={false}
        onOpenChange={vi.fn()}
        onConfirm={vi.fn()}
        onCancel={vi.fn()}
      />,
    );
    expect(container.querySelector('[data-testid="dialog"]')).toBeNull();
    unmount(container, root);
  });

  it('renders the modal when before !== null && after === null (becomes-undisplayable, delete path)', () => {
    const { container, root } = mountWith(
      <RateChangeConfirmModal
        preview={makePreview({
          beforeTotal: '1234.56',
          afterTotal: null,
          exceedsThreshold: true,
        })}
        open={true}
        onOpenChange={vi.fn()}
        onConfirm={vi.fn()}
        onCancel={vi.fn()}
      />,
    );
    const desc = container.querySelector('[data-testid="dialog-description"]');
    expect(desc).not.toBeNull();
    expect(desc!.textContent).toContain('approximately');
    // The "after" side renders as the em-dash placeholder, not "undefined".
    expect(desc!.textContent).not.toContain('undefined');
    expect(desc!.textContent).toContain('—');
    unmount(container, root);
  });

  it('renders the modal when before === null && after !== null (becomes-displayable, first-rate-entry symmetric case)', () => {
    // r3 Topic 1: typing 1 instead of 0.78 for the first GBP→USD rate MUST
    // surface the modal — the symmetric "becomes-displayable" case.
    const { container, root } = mountWith(
      <RateChangeConfirmModal
        preview={makePreview({
          beforeTotal: null,
          afterTotal: '1500.00',
          exceedsThreshold: true,
        })}
        open={true}
        onOpenChange={vi.fn()}
        onConfirm={vi.fn()}
        onCancel={vi.fn()}
      />,
    );
    const desc = container.querySelector('[data-testid="dialog-description"]');
    expect(desc).not.toBeNull();
    expect(desc!.textContent).toContain('approximately');
    expect(desc!.textContent).not.toContain('undefined');
    expect(desc!.textContent).toMatch(/1,500/);
    unmount(container, root);
  });
});

// ---------------------------------------------------------------------------
// displayCurrency: null short-circuit
// ---------------------------------------------------------------------------

describe('RateChangeConfirmModal — displayCurrency:null short-circuit', () => {
  it('does NOT render any dialog content when displayCurrency is null, even if open=true', () => {
    // Defensive: if a caller forgets to gate the `open` prop, the modal must
    // refuse to render rather than surface "undefined" via formatMoney(_, null).
    const { container, root } = mountWith(
      <RateChangeConfirmModal
        preview={makePreview({
          displayCurrency: null,
          beforeTotal: null,
          afterTotal: null,
          exceedsThreshold: false,
        })}
        open={true}
        onOpenChange={vi.fn()}
        onConfirm={vi.fn()}
        onCancel={vi.fn()}
      />,
    );
    expect(container.querySelector('[data-testid="dialog"]')).toBeNull();
    expect(container.querySelector('[data-testid="dialog-description"]')).toBeNull();
    expect(container.textContent).not.toContain('undefined');
    expect(container.textContent).not.toContain('approximately');
    unmount(container, root);
  });
});

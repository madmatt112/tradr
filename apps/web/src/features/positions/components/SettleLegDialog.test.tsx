// @vitest-environment jsdom
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { SettlementContext } from '@tradr/shared';

import { makePosition } from '@/features/positions/__fixtures__/position-fixtures';

import { useSettleLeg, useSettlementContext } from '../hooks/useOptionLifecycle';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/**
 * Contract block — one row per success criterion this file covers.
 *
 * | Criterion | Pre-condition | Call (seam) | Observable result | Source of expected value |
 * |---|---|---|---|---|
 * | No default outcome, submit disabled | context with `suggestedOutcome: null` | render(SettleLegDialog) | no outcome button carries `aria-pressed="true"`; the Settle button is disabled | requirements.md AC 2.2; tasks.md task 24 Prompt "with suggestedOutcome null no outcome is selected and submit is disabled (AC 2.2)" |
 * | States the OCC auto-exercise rule | any context | render(SettleLegDialog) | dialog text names OCC, 17:30 and $0.01 | requirements.md AC 2.2 "stating that OCC auto-exercises anything in the money by $0.01 at its 17:30 ET cut-off" |
 * | Suggested outcome pre-selects but never auto-posts | context with `suggestedOutcome: 'assigned'` | render, then click "Settle" | Assigned carries `aria-pressed="true"` and mutateAsync is NOT called before the click; mutateAsync IS called once after it | requirements.md AC 2.3 "the dialog MAY pre-select ... and the user SHALL still confirm"; tasks.md task 24 Prompt "nothing posts until confirm (AC 2.3)" |
 * | Offered outcomes match the leg's side | context `legalOutcomes: ['worthless','assigned']` vs `['worthless','exercised']` | render(SettleLegDialog) | the short-leg context offers Worthless/Assigned and hides Exercised; the long-leg context offers Worthless/Exercised and hides Assigned | requirements.md AC 2.1 "a short leg accepts worthless or assigned; a long leg accepts worthless or exercised"; tasks.md task 24 Prompt "a short leg offers worthless and assigned, a long leg worthless and exercised (AC 2.1)" |
 * | Worthless sends no date or quantity | outcome "Worthless" clicked | click "Settle" | useSettleLeg's mutateAsync payload has no `settledAt` or `quantity` key | tasks.md task 24 Prompt "worthless sends no date or quantity" |
 * | A partial quantity and a fee are sent | outcome "Assigned" clicked, quantity typed "3", fee typed "1.25" | click "Settle" | mutateAsync is called with `{ outcome: 'assigned', quantity: '3', fees: '1.25' }` | requirements.md AC 2.5 "quantity ... MAY be fewer"; AC 2.6 "an optional fee"; tasks.md task 24 Prompt "a partial quantity and a fee are sent (AC 2.5, 2.6)" |
 * | Row-order choice only with 2+ held rows | context `heldRows` length 2 vs length 1 | render(SettleLegDialog) | `stock-row-order` test id present for 2 held rows, absent for 1 | requirements.md AC 3.5 "IF several open long rows qualify THEN the dialog SHALL let the user choose"; tasks.md task 24 Prompt "two held rows show the order choice and one does not (AC 3.5)" |
 */

vi.mock('../hooks/useOptionLifecycle', () => ({
  useSettlementContext: vi.fn(),
  useSettleLeg: vi.fn(() => ({ mutateAsync: vi.fn(), isPending: false })),
}));

import { SettleLegDialog } from './SettleLegDialog';

function makeContext(overrides: Partial<SettlementContext> = {}): SettlementContext {
  return {
    legalOutcomes: ['worthless', 'assigned'],
    expiryInstant: '2026-06-19T20:00:00.000Z',
    premium: 2.5,
    heldRows: [],
    suggestedOutcome: null,
    ...overrides,
  };
}

const LEG = makePosition({
  id: 'leg-1',
  symbol: 'AAPL260619P150',
  assetType: 'option',
  side: 'short',
  status: 'open',
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

function renderDialog(context: SettlementContext, onOpenChange = vi.fn()) {
  vi.mocked(useSettlementContext).mockReturnValue({
    data: context,
    isLoading: false,
  } as unknown as ReturnType<typeof useSettlementContext>);
  return render(<SettleLegDialog position={LEG} open onOpenChange={onOpenChange} />);
}

describe('SettleLegDialog — no default outcome (AC 2.2)', () => {
  it('selects nothing and disables Settle when suggestedOutcome is null', () => {
    renderDialog(makeContext({ suggestedOutcome: null }));

    for (const name of ['Worthless', 'Assigned']) {
      expect(screen.getByRole('button', { name }).getAttribute('aria-pressed')).not.toBe('true');
    }
    expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Settle' }).disabled).toBe(true);
  });
});

describe('SettleLegDialog — OCC disclosure (AC 2.2)', () => {
  it('states the OCC auto-exercise rule', () => {
    renderDialog(makeContext());

    const text = screen.getByRole('dialog').textContent ?? '';
    expect(text).toMatch(/OCC/);
    expect(text).toMatch(/17:30/);
    expect(text).toMatch(/0\.01/);
  });
});

describe('SettleLegDialog — suggested outcome still needs confirmation (AC 2.3)', () => {
  it('pre-selects the suggestion but posts only once the user clicks Settle', async () => {
    const mutateAsync = vi.fn().mockResolvedValue({
      settlementId: 's1',
      legId: 'leg-1',
      outcome: 'assigned',
      premium: 2.5,
      quantity: 1,
      settledAt: '2026-06-19T20:00:00.000Z',
      openedPositionIds: [],
      exitedPositionIds: [],
    });
    vi.mocked(useSettleLeg).mockReturnValue({
      mutateAsync,
      isPending: false,
    } as unknown as ReturnType<typeof useSettleLeg>);

    renderDialog(makeContext({ suggestedOutcome: 'assigned' }));

    expect(screen.getByRole('button', { name: 'Assigned' }).getAttribute('aria-pressed')).toBe(
      'true',
    );
    expect(mutateAsync).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: 'Settle' }));

    await waitFor(() => expect(mutateAsync).toHaveBeenCalledTimes(1));
    expect(mutateAsync.mock.calls[0][0]).toMatchObject({ outcome: 'assigned' });
  });
});

describe('SettleLegDialog — offered outcomes match the leg side (AC 2.1)', () => {
  it('offers Worthless and Assigned for a short leg, hiding Exercised', () => {
    renderDialog(makeContext({ legalOutcomes: ['worthless', 'assigned'] }));

    expect(screen.getByRole('button', { name: 'Worthless' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Assigned' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Exercised' })).toBeNull();
  });

  it('offers Worthless and Exercised for a long leg, hiding Assigned', () => {
    renderDialog(makeContext({ legalOutcomes: ['worthless', 'exercised'] }));

    expect(screen.getByRole('button', { name: 'Worthless' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Exercised' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Assigned' })).toBeNull();
  });
});

describe('SettleLegDialog — worthless omits date and quantity (AC 2.5)', () => {
  it('sends no settledAt or quantity when the outcome is worthless', async () => {
    const mutateAsync = vi.fn().mockResolvedValue({
      settlementId: 's1',
      legId: 'leg-1',
      outcome: 'worthless',
      premium: 2.5,
      quantity: 1,
      settledAt: '2026-06-19T20:00:00.000Z',
      openedPositionIds: [],
      exitedPositionIds: [],
    });
    vi.mocked(useSettleLeg).mockReturnValue({
      mutateAsync,
      isPending: false,
    } as unknown as ReturnType<typeof useSettleLeg>);

    renderDialog(makeContext());

    fireEvent.click(screen.getByRole('button', { name: 'Worthless' }));
    fireEvent.click(screen.getByRole('button', { name: 'Settle' }));

    await waitFor(() => expect(mutateAsync).toHaveBeenCalledTimes(1));
    const payload = mutateAsync.mock.calls[0][0];
    expect(payload).not.toHaveProperty('settledAt');
    expect(payload).not.toHaveProperty('quantity');
  });
});

describe('SettleLegDialog — partial quantity and fee (AC 2.5, 2.6)', () => {
  it('sends a typed quantity and fee alongside the outcome', async () => {
    const mutateAsync = vi.fn().mockResolvedValue({
      settlementId: 's1',
      legId: 'leg-1',
      outcome: 'assigned',
      premium: 2.5,
      quantity: 3,
      settledAt: '2026-06-19T20:00:00.000Z',
      openedPositionIds: [],
      exitedPositionIds: [],
    });
    vi.mocked(useSettleLeg).mockReturnValue({
      mutateAsync,
      isPending: false,
    } as unknown as ReturnType<typeof useSettleLeg>);

    renderDialog(makeContext());

    fireEvent.click(screen.getByRole('button', { name: 'Assigned' }));
    fireEvent.change(screen.getByLabelText('Quantity'), { target: { value: '3' } });
    fireEvent.change(screen.getByLabelText('Fee'), { target: { value: '1.25' } });
    fireEvent.click(screen.getByRole('button', { name: 'Settle' }));

    await waitFor(() => expect(mutateAsync).toHaveBeenCalledTimes(1));
    expect(mutateAsync.mock.calls[0][0]).toMatchObject({
      outcome: 'assigned',
      quantity: '3',
      fees: '1.25',
    });
  });
});

describe('SettleLegDialog — stock row order (AC 3.5)', () => {
  it('shows the order choice with two held rows and hides it with one', () => {
    renderDialog(
      makeContext({
        heldRows: [
          {
            positionId: 'row-1',
            symbol: 'AAPL',
            openUnits: 100,
            openedAt: '2026-01-01T00:00:00.000Z',
          },
          {
            positionId: 'row-2',
            symbol: 'AAPL',
            openUnits: 50,
            openedAt: '2026-02-01T00:00:00.000Z',
          },
        ],
      }),
    );
    expect(screen.getByTestId('stock-row-order')).toBeTruthy();
    cleanup();

    renderDialog(
      makeContext({
        heldRows: [
          {
            positionId: 'row-1',
            symbol: 'AAPL',
            openUnits: 100,
            openedAt: '2026-01-01T00:00:00.000Z',
          },
        ],
      }),
    );
    expect(screen.queryByTestId('stock-row-order')).toBeNull();
  });
});

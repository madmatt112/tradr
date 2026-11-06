// @vitest-environment jsdom
//
// RollLegDialog (design C10 Web "RollLegDialog.tsx ... the chain option
// renders only when the key status is configured" [that clause governs
// EntryGreeksDialog — see EntryGreeksDialog.test.tsx]; Requirement 5 Rolls;
// tasks.md task 27): rolls an open leg into a new contract through
// `OptionContractFields`, with quantity defaulted to the leg's open units,
// close/open prices, both fees and a required date.
//
// Contract block — one row per success criterion this file covers (task 27).
//
// | Criterion | Pre-condition | Call (seam) | Observable result | Source of expected value |
// |---|---|---|---|---|
// | A roll submits the new symbol, quantity (defaulted to open units), prices, fees and date (AC 5.1) | leg `openUnits: 5`; new contract NVDA/2026-03-21/call/120 typed, close/open price and fee typed, date typed, quantity left at its default | render(RollLegDialog), click "Roll" | `useRollLeg`'s `mutateAsync` is called once with `{ newSymbol: 'NVDA260321C120', quantity: '5', closePrice: '1.00', openPrice: '2.50', closeFees: '0.65', openFees: '0.65', rolledAt: <ISO of the typed date> }` | requirements.md AC 5.1 "a quantity up to its open units, close and open prices, fees and a date"; packages/shared/src/options.test.ts:896-901 ("NVDA/120 → 'NVDA260321C120'", probed against the installed encoder) fixes the expected symbol; packages/shared/src/schemas/option-lifecycle.ts:34-60 `RollLegInputSchema` fixes the payload's field names |
// | A 403 TIER_LIMIT_POSITIONS shows inline and the dialog stays open (AC 5.5) | `mutateAsync` rejects with `{ status: 403, error: { code: 'TIER_LIMIT_POSITIONS', message: 'server text is not branched on' } }` | render(RollLegDialog), fill the required fields, click "Roll" | a `roll-tier-refusal` test id appears, carrying `data-error-code="TIER_LIMIT_POSITIONS"`; `onOpenChange` is never called with `false` | requirements.md AC 5.5 "The L1 and L2 tier checks SHALL apply to a roll, refused before any write"; tasks.md task 27 Restrictions "show a tier refusal inline as `CreatePositionDialog.tsx` does (AC 5.5)"; apps/web/src/features/positions/components/CreatePositionDialog.tsx:281-291 and apps/web/src/features/accounts/components/AccountDialog.tsx:251 fix the `<feature>-tier-refusal` test-id convention this dialog is told to follow |

import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { makePosition } from '@/features/positions/__fixtures__/position-fixtures';

import { useRollLeg } from '../hooks/useOptionLifecycle';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('../hooks/useOptionLifecycle', () => ({
  useRollLeg: vi.fn(() => ({ mutateAsync: vi.fn(), isPending: false })),
}));

import { RollLegDialog } from './RollLegDialog';

const LEG = makePosition({
  id: 'leg-1',
  symbol: 'AAPL260619P150',
  assetType: 'option',
  side: 'short',
  status: 'open',
  openUnits: 5,
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

function fillNewContract() {
  fireEvent.change(screen.getByLabelText('Underlying'), { target: { value: 'NVDA' } });
  fireEvent.change(screen.getByLabelText('Expiry'), { target: { value: '2026-03-21' } });
  fireEvent.change(screen.getByLabelText('Strike'), { target: { value: '120' } });
  // Type defaults to "call" (OptionContractFields' own default), matching
  // the NVDA/120 call fixture probed in options.test.ts — no tab click needed.
}

function fillRollTerms() {
  fireEvent.change(screen.getByLabelText('Close price'), { target: { value: '1.00' } });
  fireEvent.change(screen.getByLabelText('Open price'), { target: { value: '2.50' } });
  fireEvent.change(screen.getByLabelText('Close fee'), { target: { value: '0.65' } });
  fireEvent.change(screen.getByLabelText('Open fee'), { target: { value: '0.65' } });
  fireEvent.change(screen.getByLabelText('Date'), { target: { value: '2026-02-01T10:00' } });
}

describe('RollLegDialog — submits the new contract, quantity, prices, fees and date (AC 5.1)', () => {
  it('defaults quantity to open units and sends the full payload', async () => {
    const mutateAsync = vi.fn().mockResolvedValue({
      rollId: 'roll-1',
      chainId: 'chain-1',
      fromPositionId: 'leg-1',
      toPositionId: 'leg-2',
      newSymbol: 'NVDA260321C120',
    });
    vi.mocked(useRollLeg).mockReturnValue({
      mutateAsync,
      isPending: false,
    } as unknown as ReturnType<typeof useRollLeg>);

    render(<RollLegDialog position={LEG} open onOpenChange={vi.fn()} />);

    expect((screen.getByLabelText('Quantity') as HTMLInputElement).value).toBe('5');

    fillNewContract();
    fillRollTerms();
    fireEvent.click(screen.getByRole('button', { name: 'Roll' }));

    await waitFor(() => expect(mutateAsync).toHaveBeenCalledTimes(1));
    expect(mutateAsync.mock.calls[0][0]).toMatchObject({
      newSymbol: 'NVDA260321C120',
      quantity: '5',
      closePrice: '1.00',
      openPrice: '2.50',
      closeFees: '0.65',
      openFees: '0.65',
      rolledAt: new Date('2026-02-01T10:00').toISOString(),
    });
  });
});

describe('RollLegDialog — tier refusal (AC 5.5)', () => {
  it('shows the 403 TIER_LIMIT_POSITIONS refusal inline and keeps the dialog open', async () => {
    const mutateAsync = vi.fn().mockRejectedValue({
      status: 403,
      error: { code: 'TIER_LIMIT_POSITIONS', message: 'server text is not branched on' },
    });
    vi.mocked(useRollLeg).mockReturnValue({
      mutateAsync,
      isPending: false,
    } as unknown as ReturnType<typeof useRollLeg>);
    const onOpenChange = vi.fn();

    render(<RollLegDialog position={LEG} open onOpenChange={onOpenChange} />);

    fillNewContract();
    fillRollTerms();
    fireEvent.click(screen.getByRole('button', { name: 'Roll' }));

    const banner = await screen.findByTestId('roll-tier-refusal');
    expect(banner.getAttribute('data-error-code')).toBe('TIER_LIMIT_POSITIONS');
    expect(onOpenChange).not.toHaveBeenCalledWith(false);
  });
});

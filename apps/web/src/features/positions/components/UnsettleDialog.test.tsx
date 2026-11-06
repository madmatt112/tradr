// @vitest-environment jsdom
//
// UnsettleDialog (design C10 Web "UnsettleDialog.tsx: warns about tags,
// screenshots and lots when the record opened a row"; Requirement 4
// Unsettle): confirms undoing a settlement and always posts to the
// settlement's leg — never the viewed position's own id — so the same
// dialog works whether it is opened from the leg's page or from a stock
// row's page (task 26 Prompt "It posts with the settlement's
// legPositionId").
//
// Contract block — one row per success criterion this file covers (task 26).
//
// | Criterion | Pre-condition | Call (seam) | Observable result | Source of expected value |
// |---|---|---|---|---|
// | An assigned record with an opened row shows the warning (AC 4.3) | settlement `outcome: 'assigned'`, `role: 'stock_opened'` (only a `stock_opened` row is ever deleted — design C5 step 6) | render(UnsettleDialog) | dialog text mentions tags, screenshots and lots | requirements.md AC 4.3 "The dialog SHALL warn that its tags, screenshots and lots go with it"; tasks.md task 26 Success |
// | A worthless record does not show the warning | settlement `outcome: 'worthless'`, `role: 'leg'` | render(UnsettleDialog) | dialog text has no mention of tags, screenshots or lots | tasks.md task 26 Success "a worthless record does not" |
// | Confirming posts to the leg's route from a stock row's page | settlement viewed with `role: 'stock_opened'` and `legPositionId: LEG_ID` distinct from the viewed stock row | render(UnsettleDialog), click "Unsettle" | `useUnsettleLeg` is called with `LEG_ID`, and its `mutateAsync` is called with `{ settlementId }` | tasks.md task 26 Prompt "It posts with the settlement's legPositionId"; task 26 Success "confirming posts to the leg's route from a stock row's page" |
// | A refusal shows its reason and the dialog stays open (AC 4.7) | `mutateAsync` rejects with `{ error: { message: 'A fill was recorded after the settlement' } }` | render(UnsettleDialog), click "Unsettle" | the refusal text renders in the dialog; `onOpenChange` is never called | requirements.md AC 4.7 "refused with the reason"; tasks.md task 26 Restrictions "show its refusal reason as sent (AC 4.7)" |
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { PositionSettlementDetail } from '@tradr/shared';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('../hooks/useOptionLifecycle', () => ({
  useUnsettleLeg: vi.fn(() => ({
    mutateAsync: vi.fn().mockResolvedValue(undefined),
    isPending: false,
  })),
}));

import { useUnsettleLeg } from '../hooks/useOptionLifecycle';

import { UnsettleDialog } from './UnsettleDialog';

function makeSettlement(
  overrides: Partial<PositionSettlementDetail> = {},
): PositionSettlementDetail {
  return {
    settlementId: 'settlement-1',
    outcome: 'assigned',
    premium: 120,
    quantity: 1,
    settledAt: '2026-03-01T00:00:00.000Z',
    createdAt: '2026-03-01T00:00:00.000Z',
    role: 'leg',
    legPositionId: 'leg-1',
    stockPositionIds: ['stock-1'],
    ...overrides,
  };
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('UnsettleDialog — opened-row warning (AC 4.3)', () => {
  it('warns about tags, screenshots and lots for an assigned record that opened a row', () => {
    render(
      <UnsettleDialog
        settlement={makeSettlement({ outcome: 'assigned', role: 'stock_opened' })}
        open
        onOpenChange={vi.fn()}
      />,
    );

    const text = screen.getByRole('dialog').textContent ?? '';
    expect(text).toMatch(/tags/i);
    expect(text).toMatch(/screenshots/i);
    expect(text).toMatch(/lots/i);
  });

  it('shows no warning for a worthless record', () => {
    render(
      <UnsettleDialog
        settlement={makeSettlement({ outcome: 'worthless', role: 'leg', stockPositionIds: [] })}
        open
        onOpenChange={vi.fn()}
      />,
    );

    const text = screen.getByRole('dialog').textContent ?? '';
    expect(text).not.toMatch(/tags/i);
    expect(text).not.toMatch(/screenshots/i);
    expect(text).not.toMatch(/lots/i);
  });
});

describe('UnsettleDialog — posts to the leg, not the viewed row', () => {
  it("confirming posts to the leg's route from a stock row's page", async () => {
    const LEG_ID = 'leg-00000000-9999';
    const mutateAsync = vi.fn().mockResolvedValue(undefined);
    vi.mocked(useUnsettleLeg).mockReturnValue({
      mutateAsync,
      isPending: false,
    } as unknown as ReturnType<typeof useUnsettleLeg>);

    render(
      <UnsettleDialog
        settlement={makeSettlement({
          role: 'stock_opened',
          legPositionId: LEG_ID,
          settlementId: 'settlement-42',
        })}
        open
        onOpenChange={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Unsettle' }));

    await waitFor(() => expect(mutateAsync).toHaveBeenCalledTimes(1));
    expect(useUnsettleLeg).toHaveBeenCalledWith(LEG_ID);
    expect(mutateAsync).toHaveBeenCalledWith({ settlementId: 'settlement-42' });
  });
});

describe('UnsettleDialog — server refusal (AC 4.7)', () => {
  it('shows the refusal reason and keeps the dialog open', async () => {
    const onOpenChange = vi.fn();
    const mutateAsync = vi
      .fn()
      .mockRejectedValue({ error: { message: 'A fill was recorded after the settlement' } });
    vi.mocked(useUnsettleLeg).mockReturnValue({
      mutateAsync,
      isPending: false,
    } as unknown as ReturnType<typeof useUnsettleLeg>);

    render(<UnsettleDialog settlement={makeSettlement()} open onOpenChange={onOpenChange} />);

    fireEvent.click(screen.getByRole('button', { name: 'Unsettle' }));

    await waitFor(() =>
      expect(screen.getByText(/A fill was recorded after the settlement/)).toBeTruthy(),
    );
    expect(onOpenChange).not.toHaveBeenCalled();
  });
});

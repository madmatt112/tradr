// @vitest-environment jsdom
//
// EntryGreeksDialog (design C10 Web "RollLegDialog.tsx, EntryGreeksDialog.tsx:
// the chain option renders only when the key status is configured";
// Requirement 6 Greeks at entry; tasks.md task 27): captures the Greeks a
// trade was entered with, either typed Black-Scholes inputs or, with a
// configured market-data key, the chain's own Greeks for the contract.
//
// Contract block — one row per success criterion this file covers (task 27).
//
// | Criterion | Pre-condition | Call (seam) | Observable result | Source of expected value |
// |---|---|---|---|---|
// | A Black-Scholes capture submits its inputs (AC 6.1) | key absent; Volatility/Spot/Rate typed, Dividend yield left blank | render(EntryGreeksDialog), click "Capture" | `useCaptureEntryGreeks`'s `mutateAsync` is called once with `{ source: 'black_scholes', volatility: 0.25, spot: 150, rate: 0.05 }` and no `dividendYield` key | requirements.md AC 6.1 "the user supplies volatility, spot, rate and optional dividend yield"; packages/shared/src/schemas/option-lifecycle.ts:67-75 `CaptureEntryGreeksBlackScholesSchema` fixes the field names and that they are numbers, and that `dividendYield` is optional |
// | A server 400 shows its reason (AC 6.4) | `mutateAsync` rejects with `{ status: 400, error: { code: 'VALIDATION_ERROR', message: 'Time to expiry must be positive' } }` | render(EntryGreeksDialog), fill the Black-Scholes inputs, click "Capture" | the dialog's text includes "Time to expiry must be positive"; `onOpenChange` is never called with `false` | requirements.md AC 6.4 "IF the inputs are invalid or the time is not positive THEN the capture SHALL be a 400 with no write" |
// | With no key the chain option is absent (AC 6.2a) | `useMarketDataKey` returns `{ configured: false }` | render(EntryGreeksDialog) | no `tab` named "Chain" is in the document | requirements.md AC 6.2 "without a key the option SHALL be absent" |
// | With a key, selecting Chain submits source chain (AC 6.2b) | `useMarketDataKey` returns `{ configured: true, keyHintTail: '...1234', verified: true }` | render(EntryGreeksDialog), click the "Chain" tab, click "Capture" | `mutateAsync` is called once with exactly `{ source: 'chain' }` | requirements.md AC 6.2 "they MAY capture the chain's Greeks for that contract instead, stored with source chain"; packages/shared/src/schemas/option-lifecycle.ts:77-81 `CaptureEntryGreeksChainSchema` fixes the exact (strict, no further input) shape |

import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { MarketDataKeyStatus } from '@/features/advisor/hooks/useMarketDataKey';
import { useMarketDataKey } from '@/features/advisor/hooks/useMarketDataKey';
import { makePosition } from '@/features/positions/__fixtures__/position-fixtures';

import { useCaptureEntryGreeks } from '../hooks/useOptionLifecycle';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('../hooks/useOptionLifecycle', () => ({
  useCaptureEntryGreeks: vi.fn(() => ({ mutateAsync: vi.fn(), isPending: false })),
}));

vi.mock('@/features/advisor/hooks/useMarketDataKey', () => ({
  useMarketDataKey: vi.fn(),
}));

import { EntryGreeksDialog } from './EntryGreeksDialog';

const LEG = makePosition({
  id: 'leg-1',
  symbol: 'AAPL260619P150',
  assetType: 'option',
  side: 'short',
  status: 'open',
});

function mockKeyStatus(status: MarketDataKeyStatus) {
  vi.mocked(useMarketDataKey).mockReturnValue({
    data: status,
    isLoading: false,
  } as unknown as ReturnType<typeof useMarketDataKey>);
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

function fillBlackScholesInputs() {
  fireEvent.change(screen.getByLabelText('Volatility'), { target: { value: '0.25' } });
  fireEvent.change(screen.getByLabelText('Spot'), { target: { value: '150' } });
  fireEvent.change(screen.getByLabelText('Rate'), { target: { value: '0.05' } });
}

describe('EntryGreeksDialog — Black-Scholes capture (AC 6.1)', () => {
  it('submits volatility, spot and rate, with no dividendYield key when left blank', async () => {
    mockKeyStatus({ configured: false });
    const mutateAsync = vi.fn().mockResolvedValue({
      delta: 0.5,
      gamma: 0.1,
      thetaPerDay: -0.02,
      vegaPerPct: 0.1,
      rhoPerPct: null,
      source: 'black_scholes',
      volatility: 0.25,
      spot: 150,
      rate: 0.05,
      dividendYield: null,
      capturedAt: '2026-02-01T10:00:00.000Z',
    });
    vi.mocked(useCaptureEntryGreeks).mockReturnValue({
      mutateAsync,
      isPending: false,
    } as unknown as ReturnType<typeof useCaptureEntryGreeks>);

    render(<EntryGreeksDialog position={LEG} open onOpenChange={vi.fn()} />);

    fillBlackScholesInputs();
    fireEvent.click(screen.getByRole('button', { name: 'Capture' }));

    await waitFor(() => expect(mutateAsync).toHaveBeenCalledTimes(1));
    const payload = mutateAsync.mock.calls[0][0];
    expect(payload).toMatchObject({ source: 'black_scholes', volatility: 0.25, spot: 150, rate: 0.05 });
    expect(payload).not.toHaveProperty('dividendYield');
  });
});

describe('EntryGreeksDialog — server 400 shows its reason (AC 6.4)', () => {
  it('renders the server message and keeps the dialog open', async () => {
    mockKeyStatus({ configured: false });
    const mutateAsync = vi.fn().mockRejectedValue({
      status: 400,
      error: { code: 'VALIDATION_ERROR', message: 'Time to expiry must be positive' },
    });
    vi.mocked(useCaptureEntryGreeks).mockReturnValue({
      mutateAsync,
      isPending: false,
    } as unknown as ReturnType<typeof useCaptureEntryGreeks>);
    const onOpenChange = vi.fn();

    render(<EntryGreeksDialog position={LEG} open onOpenChange={onOpenChange} />);

    fillBlackScholesInputs();
    fireEvent.click(screen.getByRole('button', { name: 'Capture' }));

    await screen.findByText(/Time to expiry must be positive/);
    expect(onOpenChange).not.toHaveBeenCalledWith(false);
  });
});

describe('EntryGreeksDialog — chain option gated on the key status (AC 6.2)', () => {
  it('has no Chain option when the key is absent', () => {
    mockKeyStatus({ configured: false });

    render(<EntryGreeksDialog position={LEG} open onOpenChange={vi.fn()} />);

    expect(screen.queryByRole('tab', { name: 'Chain' })).toBeNull();
  });

  it('submits source chain, with no other fields, once a key is configured', async () => {
    mockKeyStatus({ configured: true, keyHintTail: '...1234', verified: true });
    const mutateAsync = vi.fn().mockResolvedValue({
      delta: 0.5,
      gamma: 0.1,
      thetaPerDay: -0.02,
      vegaPerPct: 0.1,
      rhoPerPct: 0.01,
      source: 'chain',
      volatility: null,
      spot: null,
      rate: null,
      dividendYield: null,
      capturedAt: '2026-02-01T10:00:00.000Z',
    });
    vi.mocked(useCaptureEntryGreeks).mockReturnValue({
      mutateAsync,
      isPending: false,
    } as unknown as ReturnType<typeof useCaptureEntryGreeks>);

    render(<EntryGreeksDialog position={LEG} open onOpenChange={vi.fn()} />);

    fireEvent.click(screen.getByRole('tab', { name: 'Chain' }));
    fireEvent.click(screen.getByRole('button', { name: 'Capture' }));

    await waitFor(() => expect(mutateAsync).toHaveBeenCalledTimes(1));
    expect(mutateAsync.mock.calls[0][0]).toEqual({ source: 'chain' });
  });
});

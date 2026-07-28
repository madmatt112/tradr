// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { DashboardTotalResponse } from '@/features/accounting/hooks/useDashboardTotal';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

let mockDashboardData: DashboardTotalResponse | undefined;

vi.mock('@/features/accounting/hooks/useDashboardTotal', () => ({
  useDashboardTotalQuery: () => ({
    data: mockDashboardData,
    isLoading: false,
    error: null,
  }),
}));

import { useMissingRatePrompt, type MissingRatePromptResult } from './useMissingRatePrompt';

// ---------------------------------------------------------------------------
// Helpers — mount a component that captures the hook output (no
// @testing-library/react dependency available in this monorepo).
// ---------------------------------------------------------------------------

function captureHook(): MissingRatePromptResult {
  let captured: MissingRatePromptResult | null = null;
  function Probe() {
    captured = useMissingRatePrompt();
    return null;
  }
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root: Root = createRoot(container);
  act(() => {
    root.render(<Probe />);
  });
  act(() => {
    root.unmount();
  });
  container.remove();
  if (captured === null) throw new Error('hook did not run');
  return captured;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

beforeEach(() => {
  mockDashboardData = undefined;
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('useMissingRatePrompt — no prompt path', () => {
  it('returns shouldPrompt:false when total is non-null and missingPairs is empty', () => {
    mockDashboardData = {
      displayCurrency: 'USD',
      total: '1234.56',
      missingPairs: [],
    };
    const r = captureHook();
    expect(r.shouldPrompt).toBe(false);
    expect(r.missingPair).toBeNull();
    expect(r.deeplinkTo).toBeNull();
    expect(r.missingPairs).toEqual([]);
  });

  it('returns shouldPrompt:false when missingPairs is undefined (legacy response shape)', () => {
    mockDashboardData = {
      displayCurrency: 'USD',
      total: '1234.56',
    };
    const r = captureHook();
    expect(r.shouldPrompt).toBe(false);
    expect(r.deeplinkTo).toBeNull();
  });

  it('returns shouldPrompt:false when the query has not resolved (data is undefined)', () => {
    mockDashboardData = undefined;
    const r = captureHook();
    expect(r.shouldPrompt).toBe(false);
    expect(r.missingPair).toBeNull();
    expect(r.deeplinkTo).toBeNull();
  });
});

describe('useMissingRatePrompt — one missing pair', () => {
  it('returns shouldPrompt:true and a deeplink targeting the single missing pair', () => {
    mockDashboardData = {
      displayCurrency: 'USD',
      total: null,
      missingPairs: [{ baseCurrency: 'USD', quoteCurrency: 'GBP' }],
    };
    const r = captureHook();
    expect(r.shouldPrompt).toBe(true);
    expect(r.missingPair).toEqual({ baseCurrency: 'USD', quoteCurrency: 'GBP' });
    expect(r.deeplinkTo).toBe('/settings/profile?base=USD&quote=GBP');
  });
});

describe('useMissingRatePrompt — multiple missing pairs', () => {
  it('targets index 0 even when the input order is non-sorted (consumer trusts backend ordering)', () => {
    // The input is intentionally NOT in alphabetical order. The hook is the
    // consumer side of the contract: Task 11's computeDashboardTotal sorts
    // `missingPairs` by (base ASC, quote ASC) at the source. The hook's
    // deeplink MUST target missingPairs[0] verbatim — if a refactor changes
    // the hook to "find the smallest pair" it would silently mask backend
    // ordering regressions. This test pins the consumer behavior.
    mockDashboardData = {
      displayCurrency: 'USD',
      total: null,
      missingPairs: [
        { baseCurrency: 'JPY', quoteCurrency: 'USD' },
        { baseCurrency: 'EUR', quoteCurrency: 'USD' },
        { baseCurrency: 'AUD', quoteCurrency: 'GBP' },
      ],
    };
    const r = captureHook();
    expect(r.shouldPrompt).toBe(true);
    // Deeplink targets index 0 — the FIRST element of the array, not the
    // alphabetically smallest. (Backend ordering is tested separately.)
    expect(r.missingPair).toEqual({ baseCurrency: 'JPY', quoteCurrency: 'USD' });
    expect(r.deeplinkTo).toBe('/settings/profile?base=JPY&quote=USD');
    expect(r.missingPairs).toHaveLength(3);
  });

  it('exposes all missing pairs via the missingPairs array so the tooltip can enumerate them', () => {
    mockDashboardData = {
      displayCurrency: 'USD',
      total: null,
      missingPairs: [
        { baseCurrency: 'EUR', quoteCurrency: 'USD' },
        { baseCurrency: 'GBP', quoteCurrency: 'USD' },
      ],
    };
    const r = captureHook();
    expect(r.missingPairs).toEqual([
      { baseCurrency: 'EUR', quoteCurrency: 'USD' },
      { baseCurrency: 'GBP', quoteCurrency: 'USD' },
    ]);
  });
});

describe('useMissingRatePrompt — deeplink shape', () => {
  it('produces the exact `/settings/profile?base=X&quote=Y` shape for the first missing pair', () => {
    mockDashboardData = {
      displayCurrency: 'USD',
      total: null,
      missingPairs: [{ baseCurrency: 'USD', quoteCurrency: 'GBP' }],
    };
    const r = captureHook();
    expect(r.deeplinkTo).toBe('/settings/profile?base=USD&quote=GBP');
    // Pin the contract shape — removing `base=`, `quote=`, or the
    // `/settings/profile` prefix breaks the deeplink that the Profile tab's FX
    // form reads to prefill `(base, quote)`.
    expect(r.deeplinkTo).toMatch(/^\/settings\/profile\?base=[A-Z]{3}&quote=[A-Z]{3}$/);
  });
});

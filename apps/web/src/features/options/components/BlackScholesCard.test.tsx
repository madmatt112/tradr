// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { BlackScholesCard } from './BlackScholesCard';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// ---------------------------------------------------------------------------
// Test 1 — Comfortable density renders the T-vs-date helper
// ---------------------------------------------------------------------------

describe('BlackScholesCard', () => {
  afterEach(() => {
    cleanup();
  });

  it('comfortable density renders T-vs-date helper with local-date text', () => {
    render(<BlackScholesCard density="comfortable" />);
    expect(document.body.textContent).toContain('(your local date)');
  });

  // -------------------------------------------------------------------------
  // Test 2 — Compact density hides the helper
  // -------------------------------------------------------------------------

  it('compact density does not render T-vs-date helper', () => {
    render(<BlackScholesCard density="compact" />);
    expect(document.body.textContent).not.toContain('(your local date)');
  });

  // -------------------------------------------------------------------------
  // Test 3 — hideDateHelper override
  // -------------------------------------------------------------------------

  it('hideDateHelper={true} overrides comfortable density', () => {
    render(<BlackScholesCard density="comfortable" hideDateHelper={true} />);
    expect(document.body.textContent).not.toContain('(your local date)');
  });

  // -------------------------------------------------------------------------
  // Test 4 — Defaults applied on mount (scoped fake timers per v1-14)
  // -------------------------------------------------------------------------

  describe('default-T derivation', () => {
    beforeEach(() => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-06-15T12:00:00Z'));
      // RTL's asyncWrapper hangs under vi fake timers without a `jest` global.
      (globalThis as { jest?: unknown }).jest = {
        advanceTimersByTime: (ms: number) => vi.advanceTimersByTime(ms),
      };
    });

    afterEach(() => {
      vi.useRealTimers();
      delete (globalThis as { jest?: unknown }).jest;
    });

    it('applies default sigma, r, q, type, and T derived from today + 30d', () => {
      render(<BlackScholesCard />);

      const sigmaInput = screen.getByLabelText(/Volatility/i) as HTMLInputElement;
      const rInput = screen.getByLabelText(/Risk-free rate/i) as HTMLInputElement;
      const qInput = screen.getByLabelText(/Dividend yield/i) as HTMLInputElement;
      const tInput = screen.getByLabelText(/Time to expiry/i) as HTMLInputElement;

      expect(sigmaInput.value).toBe('0.3');
      expect(rInput.value).toBe('0.044');
      expect(qInput.value).toBe('0');

      const callTab = screen.getByRole('tab', { name: 'Call' });
      expect(callTab.getAttribute('data-state')).toBe('active');

      // T = 30 / 365 ≈ 0.0821917808...
      const expectedT = 30 / 365;
      expect(Number(tInput.value)).toBeCloseTo(expectedT, 10);
    });
  });

  // -------------------------------------------------------------------------
  // Test 5 — initialInputs seeds state once (rerender does not re-seed)
  // -------------------------------------------------------------------------

  it('initialInputs seeds state once; rerender with different initialInputs does not overwrite', () => {
    const { rerender } = render(<BlackScholesCard initialInputs={{ S: 100 }} />);
    const sFirst = screen.getByLabelText(/Spot price/i) as HTMLInputElement;
    expect(sFirst.value).toBe('100');

    rerender(<BlackScholesCard initialInputs={{ S: 200 }} />);
    const sAfter = screen.getByLabelText(/Spot price/i) as HTMLInputElement;
    expect(sAfter.value).toBe('100');
  });

  // -------------------------------------------------------------------------
  // Test 6 — onCompute fires with the expected output shape
  // -------------------------------------------------------------------------

  it('onCompute fires after valid input with a full BlackScholesOutput object', async () => {
    const onCompute = vi.fn();
    const user = userEvent.setup();
    render(<BlackScholesCard onCompute={onCompute} />);

    const S = screen.getByLabelText(/Spot price/i) as HTMLInputElement;
    const K = screen.getByLabelText(/Strike price/i) as HTMLInputElement;
    const T = screen.getByLabelText(/Time to expiry/i) as HTMLInputElement;
    const sigma = screen.getByLabelText(/Volatility/i) as HTMLInputElement;
    const r = screen.getByLabelText(/Risk-free rate/i) as HTMLInputElement;

    await user.clear(T);
    await user.clear(sigma);
    await user.clear(r);

    await user.type(S, '100');
    await user.type(K, '100');
    await user.type(T, '0.5');
    await user.type(sigma, '0.30');
    await user.type(r, '0.04');
    // type='call' is the default — no need to click

    // Flush React effects.
    await act(async () => {
      await Promise.resolve();
    });

    await waitFor(() => expect(onCompute).toHaveBeenCalled());

    const last = onCompute.mock.calls[onCompute.mock.calls.length - 1][0];
    expect(last).toEqual(
      expect.objectContaining({
        price: expect.any(String),
        delta: expect.any(String),
        gamma: expect.any(String),
        thetaPerDay: expect.any(String),
        vegaPerPct: expect.any(String),
        rhoPerPct: expect.any(String),
      }),
    );
  });

  // -------------------------------------------------------------------------
  // Test 7 — No field-level 'Required' error on fresh mount for S/K
  // -------------------------------------------------------------------------

  it('does not render Required errors on fresh mount for empty S/K', () => {
    render(<BlackScholesCard />);
    // S and K start empty but dirtyFields.S/K are false → no 'Required' visible.
    expect(document.body.textContent).not.toContain('Required');
  });

  // -------------------------------------------------------------------------
  // Test 8 — dirtyFields.S → typing then erasing surfaces 'Required'
  // -------------------------------------------------------------------------

  it('dirtyFields.S becomes true after user types; subsequent invalid value surfaces an inline error', async () => {
    const user = userEvent.setup();
    render(<BlackScholesCard />);
    const S = screen.getByLabelText(/Spot price/i) as HTMLInputElement;
    const K = screen.getByLabelText(/Strike price/i) as HTMLInputElement;

    // (a) Fresh — no inline error near S even though it is empty (dirtyFields.S=false).
    expect(document.body.textContent).not.toContain('Required');

    // Fill K so the adapter clears its 'Required' gate and runs the wire schema;
    // otherwise any K=empty error short-circuits before S bound-checks fire.
    await user.type(K, '100');

    // (b) Type '100' → dirtyFields.S=true; value is valid so still no error.
    await user.type(S, '100');

    // (c) Backspace and type a negative value — wire schema rejects S <= 0
    // (BlackScholesInputSchema: S.positive()). Per design.md §Component 10 case 8,
    // a subsequent invalid value '-5' should surface the wire-schema error.
    // Using backspaces (vs user.clear) keeps the intermediate state non-empty so
    // RHF does not reset dirtyFields.S when the value matches the '' default.
    await user.type(S, '{Backspace}{Backspace}{Backspace}-5');

    await waitFor(() => {
      const text = document.body.textContent ?? '';
      expect(text).toContain('Number must be greater than 0');
    });
  });
});

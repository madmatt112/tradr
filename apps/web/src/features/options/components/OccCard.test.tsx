// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// v3-8 ESM-safe mock: passthrough everything from @tradr/shared, but wrap
// `encodeOccSymbol` and `parseOccSymbol` as `vi.fn(actual.*)` so call-count
// assertions and per-call overrides (`mockReturnValueOnce`) work against the
// named imports inside `OccCard.tsx`. The real implementations still run on
// every invocation (the wrappers default to calling the originals) — this is
// the only ESM-safe way to spy on named-import call sites, since `vi.spyOn`
// against the module namespace does not intercept them.
vi.mock('@tradr/shared', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@tradr/shared')>();
  return {
    ...actual,
    encodeOccSymbol: vi.fn(actual.encodeOccSymbol),
    parseOccSymbol: vi.fn(actual.parseOccSymbol),
  };
});

import { encodeOccSymbol, parseOccSymbol } from '@tradr/shared';

import { OccCard } from './OccCard';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Advance fake timers by `ms` AND flush React's act queue so any state updates
 * scheduled by debounce setTimeouts are applied to the DOM before assertions.
 */
function advanceAndFlush(ms: number): void {
  act(() => {
    vi.advanceTimersByTime(ms);
  });
}

// ---------------------------------------------------------------------------
// Shared per-test setup (v3-8 boilerplate)
// ---------------------------------------------------------------------------

describe('OccCard', () => {
  let user: ReturnType<typeof userEvent.setup>;
  let clipboardWriteText: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.useFakeTimers();
    // RTL's asyncWrapper hangs on its internal setTimeout(0) under vi fake timers
    // because it gates `jest.advanceTimersByTime(0)` on `typeof jest !== 'undefined'`.
    // Stub a minimal `jest` global that proxies to vi so RTL flushes its timer.
    (globalThis as { jest?: unknown }).jest = {
      advanceTimersByTime: (ms: number) => vi.advanceTimersByTime(ms),
    };
    user = userEvent.setup({ advanceTimers: (ms: number) => vi.advanceTimersByTime(ms) });

    // Reset call history on the named-import wrappers each test.
    vi.mocked(parseOccSymbol).mockClear();
    vi.mocked(encodeOccSymbol).mockClear();

    // jsdom does not implement navigator.clipboard by default — install a stub.
    clipboardWriteText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText: clipboardWriteText },
    });
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
    delete (globalThis as { jest?: unknown }).jest;
  });

  // -------------------------------------------------------------------------
  // Test 1 — Decode mode parses and renders after 300ms debounce (3-step)
  // -------------------------------------------------------------------------

  it('decode mode parses and renders after 300ms debounce', async () => {
    render(<OccCard />);

    const input = screen.getByLabelText('OCC symbol') as HTMLInputElement;
    await user.type(input, 'AAPL  250620C00150000');

    // (a) 299ms after the last keystroke — parser not yet called.
    vi.mocked(parseOccSymbol).mockClear();
    advanceAndFlush(299);
    expect(parseOccSymbol).not.toHaveBeenCalled();

    // (b) +1ms (300ms total) — parser called exactly once.
    advanceAndFlush(1);
    expect(parseOccSymbol).toHaveBeenCalledTimes(1);

    // (c) decoded fields render.
    expect(document.body.textContent).toContain('AAPL');
    expect(document.body.textContent).toContain('2025-06-20');
    expect(document.body.textContent).toContain('call');
    expect(document.body.textContent).toContain('150.000');
  });

  // -------------------------------------------------------------------------
  // Test 2 — Decode mode shows inline error after debounce on invalid input
  // -------------------------------------------------------------------------

  it('decode mode shows inline error after debounce on invalid input', async () => {
    render(<OccCard />);

    const input = screen.getByLabelText('OCC symbol') as HTMLInputElement;
    await user.type(input, 'foo');
    advanceAndFlush(300);

    // The OCC_NO_FORM_MATCH message from the pure parser.
    expect(document.body.textContent).toContain('could not canonicalise to OCC-21');
  });

  // -------------------------------------------------------------------------
  // Test 3 — Encode mode produces 21-char canonical symbol immediately
  // -------------------------------------------------------------------------

  it('encode mode produces 21-char canonical symbol on valid inputs (no debounce)', async () => {
    render(<OccCard />);

    // Toggle to Encode mode — no debounce.
    await user.click(screen.getByRole('tab', { name: 'Encode' }));

    const underlying = screen.getByLabelText('Underlying') as HTMLInputElement;
    const expiration = screen.getByLabelText('Expiration') as HTMLInputElement;
    const strike = screen.getByLabelText('Strike') as HTMLInputElement;

    await user.type(underlying, 'AAPL');
    // userEvent.type on type="date" inputs is finicky in jsdom — set via
    // an explicit change event so React picks up the new value.
    act(() => {
      const setter = Object.getOwnPropertyDescriptor(
        window.HTMLInputElement.prototype,
        'value',
      )?.set;
      setter?.call(expiration, '2025-06-20');
      expiration.dispatchEvent(new Event('input', { bubbles: true }));
    });

    await user.type(strike, '150');

    // No timer advance — Encode is live on every render.
    expect(document.body.textContent).toContain('AAPL  250620C00150000');
  });

  // -------------------------------------------------------------------------
  // Test 4a — Copy button copies canonical 21-char form (success path)
  // -------------------------------------------------------------------------

  it('copy button copies canonical 21-char form (success path)', async () => {
    render(<OccCard />);

    const input = screen.getByLabelText('OCC symbol') as HTMLInputElement;
    // Use a non-canonical form so we can prove canonical was preferred.
    await user.type(input, 'AAPL250620C150');
    advanceAndFlush(300);

    // Sanity: result rendered (so the Copy button exists).
    expect(document.body.textContent).toContain('AAPL');

    const copyBtn = screen.getByRole('button', { name: /copy/i });
    await user.click(copyBtn);

    expect(clipboardWriteText).toHaveBeenCalledTimes(1);
    expect(clipboardWriteText).toHaveBeenCalledWith('AAPL  250620C00150000');
  });

  // -------------------------------------------------------------------------
  // Test 4b — Copy button fallback path (v3-8 ESM-safe mock)
  // -------------------------------------------------------------------------

  it('copy button falls back to raw input .trim().toUpperCase() when re-encode fails', async () => {
    render(<OccCard />);

    const input = screen.getByLabelText('OCC symbol') as HTMLInputElement;
    // Non-canonical, lower-case, with surrounding whitespace — verifies
    // `.trim().toUpperCase()` is applied for the fallback.
    await user.type(input, '  aapl250620c150  ');

    // Force the next encodeOccSymbol call to fail. The next call happens during
    // the post-debounce render of the Decode result row (which precomputes the
    // Copy button's `text` prop via `canonicalFromParsed`). With the failure,
    // `canonicalFromParsed` MUST fall back to `raw.trim().toUpperCase()` (v1-11).
    vi.mocked(encodeOccSymbol).mockReturnValueOnce({
      ok: false,
      error: { code: 'OCC_BAD_UNDERLYING', message: 'forced failure' },
    });
    advanceAndFlush(300);

    const copyBtn = screen.getByRole('button', { name: /copy/i });
    await user.click(copyBtn);

    expect(clipboardWriteText).toHaveBeenCalledTimes(1);
    expect(clipboardWriteText).toHaveBeenCalledWith('AAPL250620C150');
  });

  // -------------------------------------------------------------------------
  // Test 5 — Mode toggle resets ALL FOUR Encode-mode inputs
  // -------------------------------------------------------------------------

  it('mode toggle resets all four Encode-mode inputs', async () => {
    render(<OccCard />);

    // Decode → parse a value.
    const decodeInput = screen.getByLabelText('OCC symbol') as HTMLInputElement;
    await user.type(decodeInput, 'AAPL  250620C00150000');
    advanceAndFlush(300);
    expect(document.body.textContent).toContain('2025-06-20');

    // Toggle to Encode.
    await user.click(screen.getByRole('tab', { name: 'Encode' }));

    // Assert all four Encode-mode inputs are empty/default.
    const underlying = screen.getByLabelText('Underlying') as HTMLInputElement;
    const expiration = screen.getByLabelText('Expiration') as HTMLInputElement;
    const strike = screen.getByLabelText('Strike') as HTMLInputElement;
    expect(underlying.value).toBe('');
    expect(expiration.value).toBe('');
    expect(strike.value).toBe('');

    // Type tab defaults to 'call' (data-state="active" on the Call trigger).
    const callTab = screen.getByRole('tab', { name: 'Call' });
    expect(callTab.getAttribute('data-state')).toBe('active');
  });

  // -------------------------------------------------------------------------
  // Test 6 — Rapid-keystroke debounce reset (v3-8 typing sequence pinned)
  // -------------------------------------------------------------------------

  it('rapid keystrokes reset the debounce (300ms after the LAST keystroke)', async () => {
    render(<OccCard />);

    const input = screen.getByLabelText('OCC symbol') as HTMLInputElement;
    vi.mocked(parseOccSymbol).mockClear();

    // t=0: type 'AAPL  '
    await user.type(input, 'AAPL  ');
    // advance to t=100
    advanceAndFlush(100);
    // t=100: type '250620'
    await user.type(input, '250620');
    // advance to t=200
    advanceAndFlush(100);
    // t=200: type 'C0015'
    await user.type(input, 'C0015');
    // advance to t=400
    advanceAndFlush(200);
    // t=400: type '0000'
    await user.type(input, '0000');

    // Advance to t=699 (299ms after the last keystroke) — parser NOT called.
    vi.mocked(parseOccSymbol).mockClear();
    advanceAndFlush(299);
    expect(parseOccSymbol).not.toHaveBeenCalled();

    // Advance +1ms to t=700 — parser called exactly once with FINAL string.
    advanceAndFlush(1);
    expect(parseOccSymbol).toHaveBeenCalledTimes(1);
    expect(parseOccSymbol).toHaveBeenCalledWith('AAPL  250620C00150000');

    // And the four decoded fields render.
    expect(document.body.textContent).toContain('AAPL');
    expect(document.body.textContent).toContain('2025-06-20');
    expect(document.body.textContent).toContain('call');
    expect(document.body.textContent).toContain('150.000');
  });
});

// @vitest-environment jsdom
import { cleanup, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import { Numeric } from './Numeric';

afterEach(() => {
  cleanup();
});

/** The reserved leading-slot class — must be byte-identical across every state. */
const SLOT_CLASS = 'inline-block min-w-[1.25ch] text-right';

describe('Numeric — four states', () => {
  it('absent (value=null) renders the em-dash, muted, reserved slot, no glyph', () => {
    render(<Numeric value={null} kind="money" currency="USD" />);
    const el = screen.getByTestId('numeric');
    expect(el.getAttribute('data-state')).toBe('absent');
    expect(el.textContent).toContain('—');
    expect(el.className).toContain('text-muted-foreground');
    // No lucide glyph in the absent state.
    expect(el.querySelector('svg')).toBeNull();
  });

  it('flat (value=0) renders the literal 0.00, text-flat, no marker — never the em-dash', () => {
    render(<Numeric value={0} kind="money" currency="USD" />);
    const el = screen.getByTestId('numeric');
    expect(el.getAttribute('data-state')).toBe('flat');
    expect(el.textContent).not.toContain('—');
    expect(el.textContent).toContain('0.00');
    expect(el.className).toContain('text-flat');
    // No marker glyph — flat is a bare 0.00 (regression guard for the sign-only fix).
    expect(within(el).getByTestId('numeric-slot').querySelector('svg')).toBeNull();
  });

  it('value gain renders the leading + sign and text-gain, no arrow glyph', () => {
    render(<Numeric value={125.5} kind="money" currency="USD" />);
    const el = screen.getByTestId('numeric');
    expect(el.getAttribute('data-state')).toBe('gain');
    expect(el.className).toContain('text-gain');
    const slot = within(el).getByTestId('numeric-slot');
    expect(slot.textContent).toContain('+');
    // No arrow icon — sign is the only non-color channel (regression guard).
    expect(el.querySelector('svg')).toBeNull();
  });

  it('value loss renders the leading − sign and text-loss, no arrow glyph', () => {
    render(<Numeric value={-25} kind="money" currency="USD" />);
    const el = screen.getByTestId('numeric');
    expect(el.getAttribute('data-state')).toBe('loss');
    expect(el.className).toContain('text-loss');
    const slot = within(el).getByTestId('numeric-slot');
    expect(slot.textContent).toContain('−'); // U+2212
    // No arrow icon — sign is the only non-color channel (regression guard).
    expect(el.querySelector('svg')).toBeNull();
  });

  it('loading renders the cell-shaped Skeleton variant with the reserved slot', () => {
    render(<Numeric value={null} state="loading" />);
    const el = screen.getByTestId('numeric');
    expect(el.getAttribute('data-state')).toBe('loading');
    expect(screen.getByTestId('numeric-skeleton')).not.toBeNull();
    expect(screen.getByTestId('numeric-slot')).not.toBeNull();
  });
});

describe('Numeric — reserved-slot invariant (R4.2)', () => {
  // jsdom has no layout engine, so we assert the slot CLASS/STRUCTURE is present
  // and identical across all four states (the EquityCurveChart.test.tsx class
  // assertion precedent), not a measured pixel width.
  const cases: Array<[string, React.ReactElement]> = [
    ['absent', <Numeric value={null} kind="money" currency="USD" />],
    ['flat', <Numeric value={0} kind="money" currency="USD" />],
    ['value', <Numeric value={42} kind="money" currency="USD" />],
    ['loading', <Numeric value={null} state="loading" />],
  ];

  it.each(cases)('the %s state carries the identical fixed-width slot class', (_name, element) => {
    render(element);
    const slot = screen.getByTestId('numeric-slot');
    expect(slot.className).toContain(SLOT_CLASS);
    cleanup();
  });
});

describe('Numeric — non-color channel per direction (the colorblind gate)', () => {
  it('gain → + sign; loss → − sign (distinct per direction, no arrow glyph)', () => {
    const { rerender } = render(<Numeric value={10} kind="signed" />);
    let el = screen.getByTestId('numeric');
    expect(screen.getByTestId('numeric-slot').textContent).toContain('+');
    expect(el.querySelector('svg')).toBeNull();

    rerender(<Numeric value={-10} kind="signed" />);
    el = screen.getByTestId('numeric');
    expect(screen.getByTestId('numeric-slot').textContent).toContain('−');
    expect(el.querySelector('svg')).toBeNull();
  });

  it('no decorative glyph renders in any value/flat/absent state (sign is the only channel)', () => {
    for (const value of [5, -5, 0, null]) {
      render(<Numeric value={value} kind="signed" />);
      expect(screen.getByTestId('numeric').querySelector('svg')).toBeNull();
      cleanup();
    }
  });
});

describe('Numeric — precision per kind', () => {
  it('money → 2 decimals', () => {
    render(<Numeric value={5} kind="money" currency="USD" />);
    expect(screen.getByTestId('numeric').textContent).toContain('5.00');
  });

  it('percent → 1 decimal with a % suffix', () => {
    render(<Numeric value={42} kind="percent" />);
    expect(screen.getByTestId('numeric').textContent).toContain('42.0%');
  });

  it('integer → 0 decimals', () => {
    render(<Numeric value={1234} kind="integer" direction="none" />);
    const text = screen.getByTestId('numeric').textContent ?? '';
    expect(text).not.toContain('.');
    expect(text).toContain('1,234');
  });

  it('precision override wins over the per-kind default', () => {
    render(<Numeric value={3} kind="decimal" precision={4} direction="none" />);
    expect(screen.getByTestId('numeric').textContent).toContain('3.0000');
  });
});

describe('Numeric — money sign-lift via formatToParts', () => {
  it('lifts the minus sign into the slot, leaving {symbol+digits} in the body', () => {
    render(<Numeric value={-320.5} kind="money" currency="USD" />);
    const el = screen.getByTestId('numeric');
    const slot = within(el).getByTestId('numeric-slot');
    // Sign is in the slot, not the body.
    expect(slot.textContent).toContain('−');
    // The currency symbol + digits live in the body; the body has no minus sign.
    expect(el.textContent).toContain('$320.50');
    // No leading "-$" in the body — the sign was lifted out.
    expect(el.textContent).not.toContain('-$');
  });

  it('emits no trailing currency-code suffix (suffix-less convention)', () => {
    render(<Numeric value={1234.5} kind="money" currency="USD" />);
    expect(screen.getByTestId('numeric').textContent).not.toContain('USD');
  });
});

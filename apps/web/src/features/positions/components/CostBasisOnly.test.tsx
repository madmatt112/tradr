// @vitest-environment jsdom
//
// CostBasisOnly (design C9, D13; Req 4.7): the reason a row has no market
// value. The `tooltip` variant (widget) puts the reason on a focusable span
// readable on hover/focus; the `inline` variant (drawer, detail page) shows
// the reason as plain visible text.
import { cleanup, render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

// Mock the shadcn Tooltip primitives exactly as
// CrossCurrencyTotal.test.tsx:38-48 does, so jsdom isn't fighting Radix
// portals and the tooltip content is always in the DOM to assert on.
vi.mock('@/components/ui/tooltip', () => ({
  Tooltip: ({ children }: { children: ReactNode }) => <div data-testid="tooltip">{children}</div>,
  TooltipTrigger: ({ children }: { children: ReactNode }) => (
    <div data-testid="tooltip-trigger">{children}</div>
  ),
  TooltipContent: ({ children }: { children: ReactNode }) => (
    <div data-testid="tooltip-content">{children}</div>
  ),
}));

import { CostBasisOnly } from './CostBasisOnly';

const REASON = 'Delayed quotes cover stocks, not option contracts.';

/**
 * Contract block — one row per success criterion this file covers.
 *
 * | Criterion | Pre-condition | Call (seam) | Observable result | Source of expected value |
 * |---|---|---|---|---|
 * | Tooltip variant: focusable span carries the visible label and an sr-only copy of the reason; the tooltip content holds the reason (Req 4.7) | none | render(&lt;CostBasisOnly reason={REASON} variant="tooltip" /&gt;) | a `span[tabindex="0"]` whose textContent includes both "Cost basis only" and REASON exists; the mocked tooltip-content's textContent is exactly REASON | design.md C9 "tooltip" bullet; requirements.md AC 4.7 |
 * | Inline variant: the label and the reason render as separate, visible text (Req 4.7) | none | render(&lt;CostBasisOnly reason={REASON} variant="inline" /&gt;) | screen.getByText('Cost basis only') and screen.getByText(REASON) both resolve | design.md C9 "inline" bullet; requirements.md AC 4.7 |
 */

afterEach(() => {
  cleanup();
});

describe('CostBasisOnly — tooltip variant (Req 4.7)', () => {
  it('puts the visible label and an sr-only reason on a focusable span, and the reason in the tooltip content', () => {
    const { container } = render(<CostBasisOnly reason={REASON} variant="tooltip" />);

    const focusableSpan = container.querySelector('span[tabindex="0"]');
    expect(focusableSpan).not.toBeNull();
    expect(focusableSpan!.textContent).toContain('Cost basis only');
    expect(focusableSpan!.textContent).toContain(REASON);

    const tooltipContent = screen.getByTestId('tooltip-content');
    expect(tooltipContent.textContent).toBe(REASON);
  });
});

describe('CostBasisOnly — inline variant (Req 4.7)', () => {
  it('renders the label and the reason as visible text', () => {
    render(<CostBasisOnly reason={REASON} variant="inline" />);

    expect(screen.getByText('Cost basis only')).toBeTruthy();
    expect(screen.getByText(REASON)).toBeTruthy();
  });
});

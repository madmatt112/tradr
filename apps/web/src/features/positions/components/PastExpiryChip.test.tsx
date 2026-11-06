// @vitest-environment jsdom
//
// PastExpiryChip (design C10, Req 1.5/1.3): a reusable mark for a leg past
// its expiry instant with no settlement recorded. A bare chip marks one leg;
// a `count` renders the group-row form that also states how many legs are
// flagged.
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import { PastExpiryChip } from './PastExpiryChip';

/**
 * Contract block — one row per success criterion this file covers.
 *
 * | Criterion | Pre-condition | Call (seam) | Observable result | Source of expected value |
 * |---|---|---|---|---|
 * | A flagged leg carries a past-expiry mark (Req 1.5) | none | render(&lt;PastExpiryChip /&gt;) | "Past expiry" text is present | requirements.md AC 1.5; design.md C10 "PastExpiryChip.tsx" |
 * | A group row shows its flagged-leg count (Req 1.3) | none | render(&lt;PastExpiryChip count={3} /&gt;) | "Past expiry (3)" text is present | requirements.md AC 1.3; design.md C10 "Group rows show pastExpiryLegCount" |
 */

afterEach(() => {
  cleanup();
});

describe('PastExpiryChip', () => {
  it('shows the past-expiry text with no count, for a single flagged leg', () => {
    render(<PastExpiryChip />);

    expect(screen.getByText('Past expiry')).toBeTruthy();
  });

  it('shows the flagged-leg count, for a group row', () => {
    render(<PastExpiryChip count={3} />);

    expect(screen.getByText('Past expiry (3)')).toBeTruthy();
  });
});

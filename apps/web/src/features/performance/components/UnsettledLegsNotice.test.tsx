// @vitest-environment jsdom
//
// UnsettledLegsNotice (design C10, Req 1.5): the performance page's
// flagged-leg count, shown beside DataQualityBanner, absent at zero (the
// response key itself is absent — `packages/shared/src/schemas/performance.ts:225-240`).
import { cleanup, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

// `Link` is stubbed to a plain anchor so the notice mounts without a router
// context, matching the sibling `CompliancePanel.test.tsx` convention in
// this same directory.
vi.mock('@tanstack/react-router', () => ({
  Link: ({ to, children, ...rest }: { to: string; children: React.ReactNode }) => (
    <a href={to} {...rest}>
      {children}
    </a>
  ),
}));

import { UnsettledLegsNotice } from './UnsettledLegsNotice';

/**
 * Contract block — one row per success criterion this file covers.
 *
 * | Criterion | Pre-condition | Call (seam) | Observable result | Source of expected value |
 * |---|---|---|---|---|
 * | Performance page shows the flagged-leg count (Req 1.5) | `pastExpiryUnsettledLegs` is 2 | render(&lt;UnsettledLegsNotice pastExpiryUnsettledLegs={2} /&gt;) | the notice renders the count and a link to the positions list | requirements.md AC 1.5; design.md C10 "UnsettledLegsNotice.tsx renders beside DataQualityBanner"; task 28 Prompt Success "a count of 2 renders the notice with the number and the link" |
 * | Count is absent at zero — the key itself is absent (Req 1.5) | `pastExpiryUnsettledLegs` is undefined | render(&lt;UnsettledLegsNotice /&gt;) | nothing renders | requirements.md AC 1.5 "absent at zero"; packages/shared/src/schemas/performance.ts:225-240 (`.optional()`); task 28 Prompt Success "with the key absent nothing renders" |
 */

afterEach(() => {
  cleanup();
});

describe('UnsettledLegsNotice', () => {
  it('shows the flagged-leg count with a link to the positions list', () => {
    render(<UnsettledLegsNotice pastExpiryUnsettledLegs={2} />);

    const notice = screen.getByTestId('unsettled-legs-notice');
    expect(notice.textContent).toContain('2');

    const link = within(notice).getByRole('link');
    expect(link.getAttribute('href')).toBe('/positions');
  });

  it('renders nothing when the key is absent', () => {
    render(<UnsettledLegsNotice />);

    expect(screen.queryByTestId('unsettled-legs-notice')).toBeNull();
  });
});

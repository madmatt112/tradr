// @vitest-environment jsdom
//
// QuoteStaleness (design C9, D14; Req 8.1): the one-line staleness
// statement every surface shows beside a displayed price. Renders nothing
// when there is no price to be stale, otherwise states the ~15-minute
// provider delay and the local time of the oldest price shown.
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import { QuoteStaleness } from './QuoteStaleness';

const OLDEST_FETCHED_AT = '2026-11-19T20:15:00.000Z';

// Same formatting call design.md C9 pins for the component itself, so the
// expected value here traces to the design's literal computation, not a
// value this test invents independently.
const EXPECTED_LOCAL_TIME = new Date(OLDEST_FETCHED_AT).toLocaleTimeString(undefined, {
  hour: 'numeric',
  minute: '2-digit',
});

/**
 * Contract block — one row per success criterion this file covers.
 *
 * | Criterion | Pre-condition | Call (seam) | Observable result | Source of expected value |
 * |---|---|---|---|---|
 * | Renders nothing when there is no oldest price (Req 8.1) | none | render(&lt;QuoteStaleness oldestFetchedAt={null} /&gt;) | container.textContent is '' | design.md C9 "renders nothing when the value is null" |
 * | Renders the D14 sentence with the local hour/minute and a trailing full stop (Req 8.1) | none | render(&lt;QuoteStaleness oldestFetchedAt={OLDEST_FETCHED_AT} /&gt;) | screen.getByText of the exact pinned sentence resolves | design.md D14; design.md C9 "Otherwise it renders..." |
 */

afterEach(() => {
  cleanup();
});

describe('QuoteStaleness — no price (Req 8.1)', () => {
  it('renders nothing when oldestFetchedAt is null', () => {
    const { container } = render(<QuoteStaleness oldestFetchedAt={null} />);

    expect(container.textContent).toBe('');
  });
});

describe('QuoteStaleness — staleness sentence (Req 8.1, design D14)', () => {
  it('states the ~15-minute delay and the local time of the oldest price, ending in a full stop', () => {
    render(<QuoteStaleness oldestFetchedAt={OLDEST_FETCHED_AT} />);

    const expectedSentence = `Prices are delayed about 15 minutes; oldest as of ${EXPECTED_LOCAL_TIME}.`;
    expect(screen.getByText(expectedSentence)).toBeTruthy();
  });
});

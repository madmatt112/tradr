// @vitest-environment jsdom
// IssueList — distinguishing blocking from non-blocking located errors
// (design C12: `nonBlocking` on LocatedError; AC 10.3).
//
// | Criterion (AC)                                                         | Pre-condition                                              | Test (seam)                 | Observable result                                                                      | Expected-value source |
// | --------------------------------------------------------------------- | ------------------------------------------------------------- | ------------------------------- | ------------------------------------------------------------------------------------------ | ---------------------- |
// | 10.3 — a non-blocking error shows outside the blocking card, and the blocking count excludes it | one blocking error, one `nonBlocking: true` error | render(IssueList, { errors }) | "Blocking errors (1)" (not 2); the non-blocking error's message is outside the blocking card | task 21 Success "a non-blocking error shows outside the blocking card and the blocking count excludes it"; requirements.md AC 10.3 "other rows SHALL still import" |
// | 10.3 — a blocking error still shows in the blocking card                | same mixed errors as above                                     | render(IssueList, { errors }) | the blocking error's message is inside the blocking card                                   | task 21 Success "a blocking error still shows in the blocking card" |
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import type { LocatedError } from '@tradr/shared';

import { IssueList } from './IssueList';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

afterEach(() => {
  cleanup();
});

const BLOCKING_ERROR: LocatedError = {
  rowNumber: 2,
  code: 'MAPPING_INVALID',
  message: 'Column "Price" could not be parsed as a number.',
};

const NON_BLOCKING_ERROR: LocatedError = {
  rowNumber: 7,
  code: 'LIFECYCLE_EVENT_TARGET_NOT_FOUND',
  message: 'No open leg was found to settle this event against.',
  nonBlocking: true,
};

describe('IssueList — blocking vs non-blocking located errors', () => {
  it('titles only the blocking error as blocking, excluding the non-blocking one from the count, and shows the non-blocking one outside that card (AC 10.3)', () => {
    render(<IssueList errors={[BLOCKING_ERROR, NON_BLOCKING_ERROR]} warnings={[]} />);

    expect(screen.getByText('Blocking errors (1)')).not.toBeNull();

    const blockingCard = screen.getByTestId('blocking-errors');
    expect(blockingCard.textContent).not.toContain(NON_BLOCKING_ERROR.message);

    expect(screen.getByText(NON_BLOCKING_ERROR.message)).not.toBeNull();
    const nonBlockingMessageEl = screen.getByText(NON_BLOCKING_ERROR.message);
    expect(blockingCard.contains(nonBlockingMessageEl)).toBe(false);
  });

  it('still shows the blocking error inside the blocking card (AC 10.3)', () => {
    render(<IssueList errors={[BLOCKING_ERROR, NON_BLOCKING_ERROR]} warnings={[]} />);

    const blockingCard = screen.getByTestId('blocking-errors');
    expect(blockingCard.textContent).toContain(BLOCKING_ERROR.message);
  });
});

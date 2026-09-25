// @vitest-environment jsdom
import { render, screen, cleanup } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import { docsUrl } from '@/lib/docs';

import { RetentionSummary } from './RetentionSummary';

afterEach(cleanup);

describe('RetentionSummary', () => {
  it('shows the survival and money lines', () => {
    render(<RetentionSummary creditBalance="0" />);

    // Survival lines (extracts of the docs page).
    expect(screen.getByText(/Stripe keeps its customer and invoice records/)).toBeTruthy();
    expect(screen.getByText(/One tombstone row stays/)).toBeTruthy();
    expect(screen.getByText(/Backups keep a copy/)).toBeTruthy();

    // Money lines.
    expect(screen.getByText(/Deletion is not refunded/)).toBeTruthy();
  });

  it('renders the passed credit balance in the money line', () => {
    render(<RetentionSummary creditBalance="2500000" />);

    const credits = screen.getByTestId('retention-credits');
    expect(credits.textContent).toContain('2,500,000');
    expect(credits.textContent).toContain('not refunded');
  });

  it('states credits are not refunded even before the balance loads', () => {
    render(<RetentionSummary creditBalance={undefined} />);

    const credits = screen.getByTestId('retention-credits');
    expect(credits.textContent).toContain('Unused wallet credits are deleted');
  });

  it('links to the account-deletion docs page', () => {
    render(<RetentionSummary creditBalance="0" />);

    const link = screen.getByRole('link', {
      name: 'What deletion removes and what it keeps',
    });
    expect(link.getAttribute('href')).toBe(docsUrl('accountDeletion'));
    expect(link.getAttribute('href')).toBe('https://docs.tradr.cloud/user-guide/account-deletion/');
  });
});

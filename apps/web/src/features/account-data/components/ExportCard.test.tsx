// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';
import { afterEach, describe, expect, it } from 'vitest';

import { ExportCard, exportFilename } from './ExportCard';

function Wrapper({ children }: { children: ReactNode }) {
  const qc = new QueryClient({ defaultOptions: { mutations: { retry: false } } });
  return createElement(QueryClientProvider, { client: qc }, children);
}

afterEach(cleanup);

describe('exportFilename', () => {
  // The header carries the same name but is not CORS-exposed, so the name is
  // computed client-side — and it must be the UTC calendar date, not the local
  // one, or two users the same instant apart get different names. These two
  // instants straddle midnight UTC, so the assertion holds in any test-runner
  // timezone: a local-date computation would fail one of them.
  it('uses the UTC date just after midnight UTC, not the (earlier) local date', () => {
    expect(exportFilename(new Date('2026-03-16T00:30:00.000Z'))).toBe(
      'tradr-export-2026-03-16.zip',
    );
  });

  it('uses the UTC date just before midnight UTC, not the (later) local date', () => {
    expect(exportFilename(new Date('2026-03-15T23:30:00.000Z'))).toBe(
      'tradr-export-2026-03-15.zip',
    );
  });
});

describe('ExportCard', () => {
  it('renders one export button that carries cursor-pointer', () => {
    render(createElement(ExportCard), { wrapper: Wrapper });
    const button = screen.getByRole('button', { name: 'Export data' });
    expect(button.className).toContain('cursor-pointer');
  });
});

// @vitest-environment jsdom
// CSV import — the Flex fetch button on the import page (design Component 11;
// Req 2.1, 2.3, 2.5, 2.7, 2.11, 3.1, 4.2, 6.1, 7.2). `useCsvPreview` and
// `useIbkrConnections` run for REAL here (they are the module under test,
// alongside the new `FlexFetchButton`); only their own collaborators — the
// `@/lib/api` client and the global `fetch` the upload arm calls directly —
// are stubbed, plus the hooks/components this task does not touch
// (useAccounts, useTierState, useCsvCommit, CoachMark, the Select primitive,
// the router Link).
//
// | AC            | Pre-condition                                                              | Test (seam: render(ImportPage))                              | Observable result                                                                 | Expected-value source |
// | -------------- | --------------------------------------------------------------------------- | -------------------------------------------------------------- | ------------------------------------------------------------------------------------ | ---------------------- |
// | 2.1, 7.2       | chosen account has a connection with a last-fetch record                    | render                                                          | a "Fetch my Flex report" button renders, and the record's dates render with it       | requirements.md 2.1, 7.2; design.md C11 |
// | 2.3            | a connection exists; the button is pressed                                  | click "Fetch my Flex report"                                   | `api.post` is called with only `{ accountId }`; the preview renders; step 3 (mapper) stays absent | requirements.md 2.3; design.md C11 |
// | 7.2            | a fetch settles                                                             | click the button, wait                                         | the connections query re-fetches and the last-fetch line shows the new record        | requirements.md 7.2; design.md C11 ("onSettled... invalidates") |
// | 2.5 (flex)     | a flex-origin preview comes back CSV_IMPORT_SUPERSEDED                      | click "Re-preview"                                              | a second flex fetch runs; the upload path is never called                            | requirements.md 2.5; design.md C11 |
// | 2.5 (flips back) | a flex fetch, then an upload preview, both from the same page              | upload + "Preview import", then "Re-preview" on CSV_IMPORT_SUPERSEDED | the upload path re-runs, not the flex endpoint — origin flipped back to upload  | requirements.md 2.5; design.md C11 ("runPreview sets the origin back to upload") |
// | 2.7            | the fetch rejects with IBKR_FLEX_NO_TRADES                                  | click the button, wait                                         | the neutral "No trades in this report" card shows; the destructive "Preview failed" card does not | requirements.md 2.7; design.md C11 |
// | 4.2            | the fetch rejects with any other code                                       | click the button, wait                                         | the existing "Preview failed" card shows the server's message                        | requirements.md 4.2; ImportPage.tsx existing failure card |
// | 2.11           | a fetched preview with `committable: false`, and one with `committable: true` | render after each fetch                                        | the false one shows the two-ways-out note; the true one does not                     | requirements.md 2.11; design.md C11 (exact note text) |
//
// Req 6.1 (no button/control/hint with no connection, no chosen account, or a
// loading connections query) is RED-IMPOSSIBLE here: with no FlexFetchButton
// built yet, "nothing related renders" already holds trivially for any state,
// so a test asserting absence cannot fail at base. See the report for the
// implementer-brief note.
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { CsvPreviewResponse } from '@tradr/shared';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const { accountsData, tierData, commitState, apiGet, apiPost } = vi.hoisted(() => ({
  accountsData: { current: [] as unknown[] },
  tierData: { current: undefined as unknown },
  commitState: {
    current: { mutate: vi.fn(), isPending: false, data: undefined, error: null } as {
      mutate: (body: unknown) => void;
      isPending: boolean;
      data: unknown;
      error: unknown;
    },
  },
  apiGet: vi.fn(),
  apiPost: vi.fn(),
}));

vi.mock('@/features/accounts/hooks/useAccounts', () => ({
  useAccounts: () => ({ data: accountsData.current, isLoading: false, isError: false }),
}));

vi.mock('@/features/billing/useTierState', () => ({
  useTierState: () => ({ data: tierData.current }),
}));

vi.mock('../hooks/useCsvCommit', () => ({
  useCsvCommit: () => commitState.current,
}));

// The real `useIbkrConnections` and `useCsvPreview` run on top of this — only
// the HTTP layer underneath them is stubbed.
vi.mock('@/lib/api', () => ({
  api: { get: apiGet, post: apiPost, put: vi.fn(), patch: vi.fn(), delete: vi.fn() },
  resolveApiUrl: (path: string) => path,
  announceSessionExpired: vi.fn(),
  isLoggingOut: false,
  setIsLoggingOut: vi.fn(),
}));

vi.mock('@/components/ui/select', () => ({
  Select: ({
    value,
    onValueChange,
    children,
  }: {
    value?: string;
    onValueChange: (v: string) => void;
    children: React.ReactNode;
  }) => (
    <select value={value ?? ''} onChange={(e) => onValueChange(e.currentTarget.value)}>
      {children}
    </select>
  ),
  SelectTrigger: () => null,
  SelectValue: () => null,
  SelectContent: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  SelectItem: ({
    value,
    children,
    disabled,
  }: {
    value: string;
    children: React.ReactNode;
    disabled?: boolean;
  }) => (
    <option value={value} disabled={disabled}>
      {children}
    </option>
  ),
}));

vi.mock('@tanstack/react-router', () => ({
  Link: ({ to, children }: { to: string; children: React.ReactNode }) => (
    <a href={to}>{children}</a>
  ),
}));

vi.mock('@/features/onboarding/components/CoachMark', () => ({
  CoachMark: () => null,
}));

import { ImportPage } from './ImportPage';

const ACCOUNT_A = '11111111-1111-4111-a111-111111111111';

const CONNECTION_A = {
  accountId: ACCOUNT_A,
  tokenHintTail: '4242',
  lastFetchedAt: null as string | null,
  lastPeriodStart: null as string | null,
  lastPeriodEnd: null as string | null,
};

function previewFixture(overrides: Partial<CsvPreviewResponse> = {}): CsvPreviewResponse {
  return {
    token: '33333333-3333-4333-a333-333333333333',
    summary: { rowsParsed: 3, rowsValid: 3, rowsWithErrors: 0, positions: 1, fills: 3 },
    positions: [],
    errors: [],
    warnings: [],
    timezone: 'UTC',
    committable: true,
    requiresDuplicateAffirmation: false,
    groupProposals: [],
    events: [],
    ...overrides,
  } as CsvPreviewResponse;
}

function flexError(code: string, message: string, status: number) {
  return { status, error: { code, message } };
}

const fetchMock = vi.fn();

function renderImportPage() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <ImportPage />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  accountsData.current = [{ id: ACCOUNT_A, name: 'Main', currency: 'USD', isDefault: true }];
  tierData.current = undefined;
  commitState.current = { mutate: vi.fn(), isPending: false, data: undefined, error: null };
  apiGet.mockReset();
  apiPost.mockReset();
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

// ---------------------------------------------------------------------------
// Req 2.1, 7.2 — shown with a connection; shows the last-fetch record
// ---------------------------------------------------------------------------

describe('ImportPage — Flex fetch button visibility (Req 2.1, 7.2)', () => {
  it('shows "Fetch my Flex report" beside the upload, with the last-fetch record, when the chosen account has a connection', async () => {
    apiGet.mockResolvedValue([
      {
        ...CONNECTION_A,
        lastFetchedAt: '2026-10-15T12:00:00.000Z',
        lastPeriodStart: '2026-10-01',
        lastPeriodEnd: '2026-10-14',
      },
    ]);

    renderImportPage();

    expect(await screen.findByRole('button', { name: 'Fetch my Flex report' })).toBeTruthy();
    expect(screen.getByText('CSV file')).toBeTruthy();
    expect(screen.getByText(/2026-10-01/)).toBeTruthy();
    expect(screen.getByText(/2026-10-14/)).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
// Req 2.3 — pressing it posts only the accountId; preview renders, mapper hidden
// ---------------------------------------------------------------------------

describe('ImportPage — pressing the Flex fetch button (Req 2.3)', () => {
  it('posts only the accountId, renders the preview, and keeps the column-mapping step hidden', async () => {
    apiGet.mockResolvedValue([CONNECTION_A]);
    apiPost.mockResolvedValueOnce(previewFixture());

    renderImportPage();
    const button = await screen.findByRole('button', { name: 'Fetch my Flex report' });
    fireEvent.click(button);

    await waitFor(() =>
      expect(apiPost).toHaveBeenCalledWith('/csv-import/flex-fetch', { accountId: ACCOUNT_A }),
    );
    expect(apiPost).toHaveBeenCalledTimes(1);

    await screen.findByText('Rows parsed');
    expect(screen.queryByText('3. Map columns')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Req 7.2 — a settled fetch invalidates the connections query
// ---------------------------------------------------------------------------

describe('ImportPage — last-fetch line updates after a settled fetch (Req 7.2)', () => {
  it('invalidates the connections query on settle, so the last-fetch line updates', async () => {
    apiGet
      .mockResolvedValueOnce([CONNECTION_A])
      .mockResolvedValueOnce([
        {
          ...CONNECTION_A,
          lastFetchedAt: '2026-11-07T00:00:00.000Z',
          lastPeriodStart: '2026-10-01',
          lastPeriodEnd: '2026-10-31',
        },
      ]);
    apiPost.mockResolvedValueOnce(previewFixture());

    renderImportPage();
    const button = await screen.findByRole('button', { name: 'Fetch my Flex report' });
    expect(screen.queryByText(/2026-10-01/)).toBeNull();

    fireEvent.click(button);

    await waitFor(() => expect(apiGet).toHaveBeenCalledTimes(2));
    await screen.findByText(/2026-10-01/);
  });
});

// ---------------------------------------------------------------------------
// Req 2.5 — Re-preview routes by origin
// ---------------------------------------------------------------------------

describe('ImportPage — Re-preview after CSV_IMPORT_SUPERSEDED routes by origin (Req 2.5)', () => {
  it('re-runs the fetch for a flex-origin preview, never the upload path', async () => {
    apiGet.mockResolvedValue([CONNECTION_A]);
    apiPost.mockResolvedValue(previewFixture());
    commitState.current.error = {
      status: 409,
      error: { code: 'CSV_IMPORT_SUPERSEDED', message: 'superseded' },
    };

    renderImportPage();
    const fetchButton = await screen.findByRole('button', { name: 'Fetch my Flex report' });
    fireEvent.click(fetchButton);
    await waitFor(() => expect(apiPost).toHaveBeenCalledTimes(1));

    const rePreviewButton = await screen.findByRole('button', { name: 'Re-preview' });
    fireEvent.click(rePreviewButton);

    await waitFor(() => expect(apiPost).toHaveBeenCalledTimes(2));
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('flips the origin back to upload once runPreview runs, so a later Re-preview re-runs the upload, not the flex endpoint', async () => {
    apiGet.mockResolvedValue([CONNECTION_A]);
    apiPost.mockResolvedValueOnce(previewFixture());
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify(previewFixture()), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );
    commitState.current.error = {
      status: 409,
      error: { code: 'CSV_IMPORT_SUPERSEDED', message: 'superseded' },
    };

    renderImportPage();

    // First, fetch via the flex connection — this sets the origin to 'flex'.
    const fetchButton = await screen.findByRole('button', { name: 'Fetch my Flex report' });
    fireEvent.click(fetchButton);
    await waitFor(() => expect(apiPost).toHaveBeenCalledTimes(1));

    // Then run an upload preview — design C11 says this sets the origin back
    // to 'upload'.
    const fileInput = document.getElementById('import-file') as HTMLInputElement;
    const file = new File(
      [
        'Symbol,AssetClass,Buy/Sell,Quantity,TradePrice,DateTime,IBCommission,Multiplier,Notes/Codes\n',
      ],
      'trades.csv',
      { type: 'text/csv' },
    );
    fireEvent.change(fileInput, { target: { files: [file] } });

    await screen.findByText('3. Map columns');
    const presetSelect = Array.from(document.querySelectorAll('select')).find((s) =>
      Array.from(s.options).some((o) => o.value === 'interactive-brokers'),
    ) as HTMLSelectElement;
    fireEvent.change(presetSelect, { target: { value: 'interactive-brokers' } });

    const previewButton = await screen.findByRole('button', { name: 'Preview import' });
    fireEvent.click(previewButton);
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));

    // Re-preview now must follow the upload origin, not fall back to flex.
    const rePreviewButton = await screen.findByRole('button', { name: 'Re-preview' });
    fireEvent.click(rePreviewButton);

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    expect(apiPost).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// Req 2.7 — IBKR_FLEX_NO_TRADES renders the neutral card
// ---------------------------------------------------------------------------

describe('ImportPage — IBKR_FLEX_NO_TRADES (Req 2.7)', () => {
  it('renders the neutral "No trades in this report" card, not the destructive failure card', async () => {
    apiGet.mockResolvedValue([CONNECTION_A]);
    apiPost.mockRejectedValueOnce(
      flexError('IBKR_FLEX_NO_TRADES', 'This Flex report has no trades.', 422),
    );

    renderImportPage();
    const button = await screen.findByRole('button', { name: 'Fetch my Flex report' });
    fireEvent.click(button);

    await screen.findByText('No trades in this report');
    expect(screen.queryByText('Preview failed')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Req 4.2 — any other failure uses the existing failure card
// ---------------------------------------------------------------------------

describe('ImportPage — other fetch failures (Req 4.2)', () => {
  it('renders the existing failure card with the server message', async () => {
    apiGet.mockResolvedValue([CONNECTION_A]);
    apiPost.mockRejectedValueOnce(
      flexError('IBKR_FLEX_UNAVAILABLE', 'IBKR is unavailable. Try again shortly.', 503),
    );

    renderImportPage();
    const button = await screen.findByRole('button', { name: 'Fetch my Flex report' });
    fireEvent.click(button);

    await screen.findByText('Preview failed');
    expect(screen.getByText('IBKR is unavailable. Try again shortly.')).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
// Req 2.11 — not-committable note, named both ways out
// ---------------------------------------------------------------------------

describe('ImportPage — not-committable fetched preview (Req 2.11)', () => {
  it('names both ways out when not committable, and shows no such note when committable', async () => {
    apiGet.mockResolvedValue([CONNECTION_A]);
    apiPost.mockResolvedValueOnce(previewFixture({ committable: false }));

    const { unmount } = renderImportPage();
    const button = await screen.findByRole('button', { name: 'Fetch my Flex report' });
    fireEvent.click(button);

    await screen.findByText(
      /change the Flex query and fetch again, or export from IBKR and upload it/i,
    );
    unmount();
    cleanup();

    apiPost.mockResolvedValueOnce(previewFixture({ committable: true }));
    renderImportPage();
    const button2 = await screen.findByRole('button', { name: 'Fetch my Flex report' });
    fireEvent.click(button2);

    await screen.findByText('Rows parsed');
    expect(
      screen.queryByText(
        /change the Flex query and fetch again, or export from IBKR and upload it/i,
      ),
    ).toBeNull();
  });
});

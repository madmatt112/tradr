// @vitest-environment jsdom
//
// Red-first (task 5): neither `IbkrConnectionCard` nor
// `@/features/ibkr/hooks/useIbkrConnections` exists yet. This file fixes the
// contract the implementer builds to.
//
// `IbkrConnectionCard({ accountId: string; accountName: string })` — one
// instance per Tradr account (design C10), reading the real
// `useIbkrConnections`/`useSaveIbkrConnection`/`useDeleteIbkrConnection` hooks,
// which call `api.get/put/delete` on `/ibkr/connections[/:accountId]` (design
// C2, C9). Only `@/lib/api` is mocked — the hook module itself is exercised —
// mirroring apps/web/src/features/advisor/components/__tests__/MarketDataKeyCard.test.tsx.
// The card renders a `data-testid="ibkr-connection-card"` root, a masked
// `••••••••<tokenHintTail>` line, the raw (unformatted) last-fetch fields or
// "No fetch yet", a `Token` and a `Query ID` input, and Save/Replace + Remove
// controls mirroring MarketDataKeyCard's Save/Replace + Remove-then-confirm.
//
// | Criterion                                                      | Pre-condition                                            | Call (seam)                         | Observable result                                              | Source |
// |-----------------------------------------------------------------|-----------------------------------------------------------|---------------------------------------|------------------------------------------------------------------|--------|
// | Req 7.2 — shows the last-fetch record when one exists           | GET /ibkr/connections returns a row with lastFetchedAt set | render(IbkrConnectionCard)          | masked tail + raw lastFetchedAt/period text shown                | requirements.md Req 7 AC 2 |
// | Req 7.2 — shows "no record" when none exists                    | GET returns a row with lastFetchedAt null                 | render(IbkrConnectionCard)          | masked tail shown, "No fetch yet" shown, no fetch/period text    | requirements.md Req 7 AC 2 |
// | Req 1.10 / Security NFR — password inputs                       | GET returns no row for this account                       | render(IbkrConnectionCard)          | Token and Query ID inputs both have type="password"              | task 5 _Prompt Success; design C10 |
// | Req 1.10 — clears plaintext as soon as a save resolves          | user fills both fields, PUT resolves                       | fireEvent.click('Save connection')  | both input values reset to ''                                    | requirements.md Req 1 AC 10; MarketDataKeyCard.tsx:78-80 |
// | Req 1.10 — clears plaintext as soon as a save rejects           | user fills both fields, PUT rejects                         | fireEvent.click('Save connection')  | both input values reset to ''                                    | task 5 _Prompt Success ("resolves or rejects") |
// | Task 5 Success — Remove asks to confirm, then deletes            | a connection exists for this account                        | click 'Remove connection' then 'Confirm remove' | DELETE fires only after confirm; card reverts to unconnected | task 5 _Prompt Success |

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { IbkrConnectionStatus } from '@tradr/shared';

import { api } from '@/lib/api';

import { IbkrConnectionCard } from './IbkrConnectionCard';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('@/lib/api', () => ({
  api: { get: vi.fn(), put: vi.fn(), delete: vi.fn() },
}));

const toast = vi.hoisted(() => ({ success: vi.fn(), warning: vi.fn(), error: vi.fn() }));
vi.mock('sonner', () => ({ toast }));

const ACCOUNT_ID = '11111111-1111-1111-1111-111111111111';

function renderCard() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const wrapper = ({ children }: { children: ReactNode }) =>
    createElement(QueryClientProvider, { client: qc }, children);
  return render(<IbkrConnectionCard accountId={ACCOUNT_ID} accountName="Main" />, { wrapper });
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('IbkrConnectionCard', () => {
  it('shows the masked tail and the last-fetch record when one exists (Req 7.2)', async () => {
    const row: IbkrConnectionStatus = {
      accountId: ACCOUNT_ID,
      tokenHintTail: 'wxyz',
      lastFetchedAt: '2026-10-05T00:00:00.000Z',
      lastPeriodStart: '2026-09-01',
      lastPeriodEnd: '2026-09-30',
    };
    vi.mocked(api.get).mockResolvedValue([row]);

    renderCard();

    const card = await screen.findByTestId('ibkr-connection-card');
    expect(within(card).getByText(/••••••••wxyz/)).toBeTruthy();
    expect(within(card).getByText(/2026-10-05/)).toBeTruthy();
    expect(within(card).getByText(/2026-09-01/)).toBeTruthy();
    expect(within(card).getByText(/2026-09-30/)).toBeTruthy();
  });

  it('shows the masked tail with no record when nothing has been fetched yet (Req 7.2)', async () => {
    const row: IbkrConnectionStatus = {
      accountId: ACCOUNT_ID,
      tokenHintTail: 'wxyz',
      lastFetchedAt: null,
      lastPeriodStart: null,
      lastPeriodEnd: null,
    };
    vi.mocked(api.get).mockResolvedValue([row]);

    renderCard();

    const card = await screen.findByTestId('ibkr-connection-card');
    expect(within(card).getByText(/••••••••wxyz/)).toBeTruthy();
    expect(within(card).getByText(/No fetch yet/)).toBeTruthy();
  });

  it('renders the Token and Query ID inputs as type="password"', async () => {
    vi.mocked(api.get).mockResolvedValue([]);

    renderCard();

    await screen.findByTestId('ibkr-connection-card');
    expect(screen.getByLabelText('Token')).toHaveProperty('type', 'password');
    expect(screen.getByLabelText('Query ID')).toHaveProperty('type', 'password');
  });

  it('clears both fields as soon as a save resolves (Req 1.10)', async () => {
    vi.mocked(api.get).mockResolvedValue([]);
    vi.mocked(api.put).mockResolvedValue({
      accountId: ACCOUNT_ID,
      tokenHintTail: 'abcd',
      lastFetchedAt: null,
      lastPeriodStart: null,
      lastPeriodEnd: null,
    });

    renderCard();
    await screen.findByTestId('ibkr-connection-card');

    fireEvent.input(screen.getByLabelText('Token'), {
      target: { value: 'ibkr-secret-token-12345' },
    });
    fireEvent.input(screen.getByLabelText('Query ID'), { target: { value: '98765' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save connection' }));

    await waitFor(() =>
      expect(api.put).toHaveBeenCalledWith(`/ibkr/connections/${ACCOUNT_ID}`, {
        token: 'ibkr-secret-token-12345',
        queryId: '98765',
      }),
    );
    await waitFor(() => {
      expect(screen.getByLabelText('Token')).toHaveProperty('value', '');
      expect(screen.getByLabelText('Query ID')).toHaveProperty('value', '');
    });
  });

  it('clears both fields as soon as a save rejects (Req 1.10)', async () => {
    vi.mocked(api.get).mockResolvedValue([]);
    vi.mocked(api.put).mockRejectedValue({ status: 400, error: { code: 'VALIDATION_ERROR' } });

    renderCard();
    await screen.findByTestId('ibkr-connection-card');

    fireEvent.input(screen.getByLabelText('Token'), {
      target: { value: 'ibkr-secret-token-67890' },
    });
    fireEvent.input(screen.getByLabelText('Query ID'), { target: { value: '13579' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save connection' }));

    await waitFor(() => expect(api.put).toHaveBeenCalledTimes(1));
    await waitFor(() => {
      expect(screen.getByLabelText('Token')).toHaveProperty('value', '');
      expect(screen.getByLabelText('Query ID')).toHaveProperty('value', '');
    });
  });

  it('Remove connection asks to confirm, then deletes (task 5 Success)', async () => {
    let connections: IbkrConnectionStatus[] = [
      {
        accountId: ACCOUNT_ID,
        tokenHintTail: 'wxyz',
        lastFetchedAt: null,
        lastPeriodStart: null,
        lastPeriodEnd: null,
      },
    ];
    vi.mocked(api.get).mockImplementation(() => Promise.resolve(connections));
    vi.mocked(api.delete).mockImplementation(() => {
      connections = [];
      return Promise.resolve(undefined);
    });

    renderCard();
    await screen.findByTestId('ibkr-connection-card');

    fireEvent.click(await screen.findByRole('button', { name: 'Remove connection' }));

    expect(screen.getByRole('button', { name: 'Confirm remove' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeTruthy();
    expect(api.delete).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: 'Confirm remove' }));

    await waitFor(() => expect(api.delete).toHaveBeenCalledWith(`/ibkr/connections/${ACCOUNT_ID}`));
    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Save connection' })).toBeTruthy();
    });
  });
});

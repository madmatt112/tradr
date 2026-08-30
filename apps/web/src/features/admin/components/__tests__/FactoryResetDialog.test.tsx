// @vitest-environment jsdom
// FactoryResetDialog — the confirmation in front of the admin surface's one
// destructive action.
//
// The dialog is a usability layer over a guard that lives on the server, so
// these tests are about what it SHOWS and what it REFUSES TO ARM, not about
// whether it can be bypassed — bypassing it is covered by the API suite, which
// asserts the service rejects a mismatched confirmEmail on its own.
//
// Covers: the counts that make a wrong-row click noticeable; the settings switch
// defaulting to OFF and saying what each position means; the typed-email gate on
// the destructive button (including the case-insensitive match the server also
// applies); both fields resetting when the dialog is re-opened on another user;
// and the button staying disabled while the counts are unknown.
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createElement, type ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { api } from '@/lib/api';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('@/lib/api', () => ({
  api: { get: vi.fn(), post: vi.fn() },
}));

const toast = vi.hoisted(() => ({ error: vi.fn(), success: vi.fn() }));
vi.mock('sonner', () => ({ toast }));

import { FactoryResetDialog } from '../FactoryResetDialog';

const USER = {
  id: '11111111-1111-1111-1111-111111111111',
  email: 'target@x.com',
  isAdmin: false,
  emailVerified: true,
  createdAt: '2026-01-01T00:00:00.000Z',
  lastActiveAt: null,
};

const PREVIEW = {
  userId: USER.id,
  email: USER.email,
  tradingData: {
    accounts: 3,
    positions: 47,
    fills: 112,
    ledgerEntries: 89,
    expenses: 0,
    brokerages: 1,
    csvImportStaging: 0,
  },
  settings: {
    providerKeys: 2,
    externalApiKeys: 0,
    advisorPersonas: 1,
    advisorConversations: 5,
    dashboardLayouts: 1,
  },
};

function mockPreview(response: unknown = PREVIEW) {
  vi.mocked(api.get).mockImplementation((url: string) => {
    if (url.endsWith('/reset-preview')) return Promise.resolve(response as never);
    return Promise.reject(new Error(`unexpected GET ${url}`));
  });
}

function renderDialog(user: typeof USER | null = USER, onClose = vi.fn()) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const wrapper = ({ children }: { children: ReactNode }) =>
    createElement(QueryClientProvider, { client: qc }, children);
  const utils = render(<FactoryResetDialog user={user} onClose={onClose} />, { wrapper });
  return { ...utils, onClose, qc };
}

const resetButton = () =>
  screen.getByRole('button', { name: /reset this account/i }) as HTMLButtonElement;
const settingsSwitch = () => screen.getByRole('switch', { name: /remove user settings/i });
const confirmInput = () => screen.getByLabelText(/type .* to confirm/i);

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('FactoryResetDialog — what it shows', () => {
  // THE COUNTS ARE THE WARNING. They are the only thing in the dialog that can
  // tell an operator they are about to reset the wrong account, and the last
  // moment such a check is possible.
  it('lists what will be deleted, with counts, omitting the empty tables', async () => {
    mockPreview();
    renderDialog();

    const counts = await screen.findByTestId('reset-trading-counts');
    expect(counts.textContent).toContain('3 accounts');
    expect(counts.textContent).toContain('47 positions');
    expect(counts.textContent).toContain('112 fills');
    expect(counts.textContent).toContain('89 ledger entries');
    expect(counts.textContent).toContain('1 custom brokerage');
    // Zero-count tables are left out rather than shown as "0 expenses" — the
    // list is meant to be read, not audited.
    expect(counts.textContent).not.toContain('expense');
  });

  // Said whether or not settings are included: the two things an operator is
  // most likely to fear this touches are the two it never touches.
  it('states that billing and login are never affected', async () => {
    mockPreview();
    renderDialog();

    await screen.findByTestId('reset-trading-counts');
    expect(
      screen.getByText(/billing, subscription and wallet credit are never affected/i),
    ).toBeTruthy();
    expect(screen.getByText(/onboarding walkthrough is reset either way/i)).toBeTruthy();
  });
});

describe('FactoryResetDialog — the settings switch', () => {
  it('defaults to off and says what keeping settings means', async () => {
    mockPreview();
    renderDialog();

    await screen.findByTestId('reset-trading-counts');
    expect(settingsSwitch().getAttribute('aria-checked')).toBe('false');
    expect(screen.getByTestId('reset-settings-counts').textContent).toMatch(
      /keeps their api keys/i,
    );
  });

  it('names the settings it would delete once switched on', async () => {
    mockPreview();
    renderDialog();
    await screen.findByTestId('reset-trading-counts');

    await userEvent.click(settingsSwitch());

    const settings = screen.getByTestId('reset-settings-counts');
    expect(settings.textContent).toContain('2 AI provider keys');
    expect(settings.textContent).toContain('1 advisor persona');
    expect(settings.textContent).toContain('5 advisor conversations');
  });
});

describe('FactoryResetDialog — the confirmation gate', () => {
  it('keeps the destructive button disabled until the email is typed exactly', async () => {
    mockPreview();
    renderDialog();
    await screen.findByTestId('reset-trading-counts');

    expect(resetButton().disabled).toBe(true);

    await userEvent.type(confirmInput(), 'target@x.co');
    expect(resetButton().disabled).toBe(true);

    await userEvent.type(confirmInput(), 'm');
    expect(resetButton().disabled).toBe(false);
  });

  // The server compares case-insensitively; an operator reading the address off
  // the row above should not be defeated by a capital letter.
  it('accepts the address in any case', async () => {
    mockPreview();
    renderDialog();
    await screen.findByTestId('reset-trading-counts');

    await userEvent.type(confirmInput(), 'TARGET@X.COM');
    expect(resetButton().disabled).toBe(false);
  });

  // A reset fired while the counts are unknown is one the operator was never
  // shown the size of.
  it('stays disabled when the preview could not be read, even with the email typed', async () => {
    vi.mocked(api.get).mockRejectedValue(new Error('boom'));
    renderDialog();

    await screen.findByText(/could not read what this would delete/i);
    await userEvent.type(confirmInput(), USER.email);
    expect(resetButton().disabled).toBe(true);
  });

  it('posts the confirmation and the flag, then closes', async () => {
    mockPreview();
    vi.mocked(api.post).mockResolvedValue({
      userId: USER.id,
      email: USER.email,
      removeSettings: true,
      deleted: { accounts: 3, positions: 47 },
    } as never);
    const { onClose } = renderDialog();
    await screen.findByTestId('reset-trading-counts');

    await userEvent.click(settingsSwitch());
    await userEvent.type(confirmInput(), USER.email);
    await userEvent.click(resetButton());

    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(api.post).toHaveBeenCalledWith(`/admin/users/${USER.id}/reset`, {
      confirmEmail: USER.email,
      removeSettings: true,
    });
    expect(toast.success).toHaveBeenCalledWith(expect.stringContaining('50 rows deleted'));
  });

  it('reports a failure as having deleted nothing, and stays open', async () => {
    mockPreview();
    vi.mocked(api.post).mockRejectedValue(new Error('boom'));
    const { onClose } = renderDialog();
    await screen.findByTestId('reset-trading-counts');

    await userEvent.type(confirmInput(), USER.email);
    await userEvent.click(resetButton());

    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith(expect.stringContaining('Nothing was deleted')),
    );
    expect(onClose).not.toHaveBeenCalled();
  });
});

describe('FactoryResetDialog — reopening', () => {
  // A typed address carried across a close would mean the confirm button was
  // already armed the next time it opened — on a different row.
  it('clears the typed email and the switch when opened on another user', async () => {
    mockPreview();
    const { rerender, qc } = renderDialog();
    await screen.findByTestId('reset-trading-counts');

    await userEvent.click(settingsSwitch());
    await userEvent.type(confirmInput(), USER.email);
    expect(resetButton().disabled).toBe(false);

    const other = { ...USER, id: '22222222-2222-2222-2222-222222222222', email: 'other@x.com' };
    vi.mocked(api.get).mockResolvedValue({ ...PREVIEW, userId: other.id, email: other.email });
    const wrapper = ({ children }: { children: ReactNode }) =>
      createElement(QueryClientProvider, { client: qc }, children);
    rerender(
      createElement(wrapper, {
        children: <FactoryResetDialog user={other} onClose={vi.fn()} />,
      }),
    );

    await waitFor(() => expect(resetButton().disabled).toBe(true));
    expect(settingsSwitch().getAttribute('aria-checked')).toBe('false');
  });
});

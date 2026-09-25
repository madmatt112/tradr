// @vitest-environment jsdom
// AdminDeleteUserDialog — the confirmation in front of the admin Delete action.
//
// The dialog is a usability layer over a guard that lives on the server, so
// these tests are about what it ARMS and what it keeps open, not whether it can
// be bypassed — bypassing it is covered by the API suite, which asserts the
// service rejects a mismatched confirmEmail on its own.
//
// Covers: the typed-email gate on the destructive button (including the
// case-insensitive match the server also applies); the target's unused credit
// balance surfaced through the shared RetentionSummary; a successful delete
// posting the confirmation and closing; and 502 STRIPE_CANCEL_FAILED keeping the
// dialog open with its own message, with the confirm button left as the retry.
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

import { AdminDeleteUserDialog } from '../AdminDeleteUserDialog';

const USER = {
  id: '11111111-1111-1111-1111-111111111111',
  email: 'target@x.com',
  isAdmin: false,
  emailVerified: true,
  createdAt: '2026-01-01T00:00:00.000Z',
  lastActiveAt: null,
};

// AdminUserDetail: the delete dialog reads walletBalance off it for the summary.
const DETAIL = {
  ...USER,
  positionCount: 3,
  advisorTurns: 0,
  usage: { inputTokens: '0', outputTokens: '0', billedCredits: '0' },
  walletBalance: '2500000',
};

function mockDetail(response: unknown = DETAIL) {
  vi.mocked(api.get).mockImplementation((url: string) => {
    if (url === `/admin/users/${USER.id}`) return Promise.resolve(response as never);
    return Promise.reject(new Error(`unexpected GET ${url}`));
  });
}

function renderDialog(user: typeof USER | null = USER, onClose = vi.fn()) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const wrapper = ({ children }: { children: ReactNode }) =>
    createElement(QueryClientProvider, { client: qc }, children);
  const utils = render(<AdminDeleteUserDialog user={user} onClose={onClose} />, { wrapper });
  return { ...utils, onClose, qc };
}

const deleteButton = () =>
  screen.getByRole('button', { name: /delete this account/i }) as HTMLButtonElement;
const confirmInput = () => screen.getByLabelText(/type .* to confirm/i);

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('AdminDeleteUserDialog — the confirmation gate', () => {
  it('keeps the destructive button disabled until the email is typed, matched case-insensitively', async () => {
    mockDetail();
    renderDialog();

    expect(deleteButton().disabled).toBe(true);
    expect(deleteButton().getAttribute('data-variant')).toBe('destructive');

    await userEvent.type(confirmInput(), 'target@x.co');
    expect(deleteButton().disabled).toBe(true);

    // Completes the address in the wrong case — the server compares
    // case-insensitively, so this arms the button.
    await userEvent.type(confirmInput(), 'M');
    expect(deleteButton().disabled).toBe(false);
  });

  it('shows the target unused credit balance from useAdminUser', async () => {
    mockDetail();
    renderDialog();

    await waitFor(() =>
      expect(screen.getByTestId('retention-credits').textContent).toContain('2,500,000'),
    );
  });

  it('posts the confirmation and closes on success', async () => {
    mockDetail();
    vi.mocked(api.post).mockResolvedValue({
      userId: USER.id,
      outcome: 'deleted',
      purgeOutcome: 'complete',
    } as never);
    const { onClose } = renderDialog();

    await userEvent.type(confirmInput(), USER.email);
    await userEvent.click(deleteButton());

    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(api.post).toHaveBeenCalledWith(`/admin/users/${USER.id}/delete`, {
      confirmEmail: USER.email,
    });
  });

  it('a 502 STRIPE_CANCEL_FAILED keeps the dialog open with its message; confirm is the retry', async () => {
    mockDetail();
    vi.mocked(api.post).mockRejectedValue({ error: { code: 'STRIPE_CANCEL_FAILED' }, status: 502 });
    const { onClose } = renderDialog();

    await userEvent.type(confirmInput(), USER.email);
    await userEvent.click(deleteButton());

    const err = await screen.findByTestId('admin-delete-error');
    expect(err.textContent).toMatch(/could not be cancelled/i);
    // Nothing deleted, dialog still open, and the still-armed confirm is the retry.
    expect(onClose).not.toHaveBeenCalled();
    expect(deleteButton().disabled).toBe(false);
  });
});

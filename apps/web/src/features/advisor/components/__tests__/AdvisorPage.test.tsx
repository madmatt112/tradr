// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, fireEvent, waitFor, cleanup, act } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { TierState } from '@tradr/shared';
import type { Persona } from '@tradr/shared/schemas/advisor';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// ---- Mocks ----------------------------------------------------------------

// Navigation is owned by the page; we assert nothing about routing here beyond
// that it does not throw, so a no-op navigate suffices.
const navigateMock = vi.fn();
vi.mock('@tanstack/react-router', () => ({
  useNavigate: () => navigateMock,
  // The context strip's settings link renders inside the page now.
  Link: ({ children, ...rest }: { children?: React.ReactNode }) => <a {...rest}>{children}</a>,
}));

// Conversation list query — drives empty-state vs. populated.
let conversationsValue: { data: { items: unknown[] } | undefined; refetch: () => Promise<unknown> };
vi.mock('../../hooks/useConversations', () => ({
  useConversations: () => conversationsValue,
  // The Transcript (rendered on the $id route) reads useConversation; the cases
  // here exercise the new/empty panes, so a stub is enough.
  useConversation: () => ({ data: undefined }),
  useDeleteConversation: () => ({ mutateAsync: vi.fn(), isPending: false }),
  useRenameConversation: () => ({ mutateAsync: vi.fn(), isPending: false }),
}));

// Provider keys — drives the no-key banner vs. enabled composer.
let providerKeysValue: { data: { items: unknown[] } | undefined };
vi.mock('../../hooks/useProviderKeys', () => ({
  useProviderKeys: () => providerKeysValue,
}));

// Billing config — drives platform-enablement (the no-BYOK platform entry path)
// and the allowance-model mark / purchasable flag (plan-tiers Task 16). The page
// also imports billingKeys for its tier-invalidation seam.
let billingConfigValue: {
  data:
    | { enabled: boolean; models: unknown[]; subscription?: { purchasable: boolean } }
    | undefined;
};
vi.mock('../../../billing/useWalletBalance', () => ({
  useBillingConfig: () => billingConfigValue,
  billingKeys: {
    balance: () => ['billing', 'balance'] as const,
    config: () => ['billing', 'config'] as const,
    history: () => ['billing', 'history'] as const,
    tier: () => ['billing', 'tier'] as const,
  },
}));

// Tier state — drives the REQ-8.9b allowance preselect and the composer hints.
// tier-usage helpers stay REAL (pure functions over this data).
let tierStateValue: { data: TierState | undefined };
vi.mock('../../../billing/useTierState', () => ({
  useTierState: () => tierStateValue,
}));

const personasValue = {
  data: {
    items: [
      {
        id: 'default-trading-advisor',
        userId: null,
        name: 'Trading Advisor',
        description: null,
        systemPrompt: 'You are a trading advisor.',
        isBuiltin: true,
        isDefault: false,
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
      } satisfies Persona,
    ],
  },
};
vi.mock('../../hooks/usePersonas', () => ({
  useListPersonas: () => personasValue,
}));

// Stream mutation — capture submissions so we can assert the clientMessageId
// passed on submit and on retry.
const mutateAsyncMock = vi.fn<(input: { clientMessageId: string }) => Promise<unknown>>();
let streamValue: { mutateAsync: typeof mutateAsyncMock; isPending: boolean; error: unknown };
vi.mock('../../hooks/useAdvisorStream', () => ({
  useAdvisorStream: () => streamValue,
}));

import { AdvisorPage } from '../../pages/AdvisorPage';

// ---- Helpers --------------------------------------------------------------

function renderPage(props: Parameters<typeof AdvisorPage>[0]) {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const view = render(
    <QueryClientProvider client={qc}>
      <AdvisorPage {...props} />
    </QueryClientProvider>,
  );
  return { view, qc };
}

// Tier-state builder (plan-tiers): gating on, Free tier at the REQ-5.1 caps.
function makeTierState(usage: { allowanceUsed?: number } = {}): TierState {
  return {
    gatingEnabled: true,
    exempt: false,
    tier: 'free',
    purchasable: true,
    subscription: null,
    limits: {
      free: {
        accounts: 2,
        positions: 500,
        lookbackMonths: 6,
        platformTurns: 25,
        images: 20,
        csvImports: 10,
      },
      pro: {
        accounts: null,
        positions: null,
        lookbackMonths: null,
        platformTurns: 200,
        images: 500,
        csvImports: null,
      },
    },
    usage: {
      accounts: { used: 1, writableAccountId: null },
      positions: { used: 0 },
      platformTurns: { allowanceUsed: usage.allowanceUsed ?? 0 },
      images: { used: 0 },
      csvImports: { used: 0 },
    },
  };
}

// The no-BYOK platform setup shared by the preselect cases: platform billing on,
// the allowance model marked SECOND in rate-table order (so preselection — not
// first-in-list — is what the assertions prove).
function setupNoByokPlatform(): void {
  providerKeysValue = { data: { items: [] } };
  billingConfigValue = {
    data: {
      enabled: true,
      models: [
        { providerId: 'claude', model: 'claude-opus' },
        { providerId: 'claude', model: 'claude-haiku', allowance: true },
      ],
      subscription: { purchasable: true },
    },
  };
}

beforeEach(() => {
  navigateMock.mockReset();
  mutateAsyncMock.mockReset();
  mutateAsyncMock.mockResolvedValue(undefined);
  conversationsValue = {
    data: { items: [] },
    refetch: vi.fn().mockResolvedValue({ data: { items: [] } }),
  };
  providerKeysValue = { data: { items: [{ id: 'k1' }] } };
  // Default: platform billing disabled — exercises pure BYOK behavior.
  billingConfigValue = { data: { enabled: false, models: [] } };
  // Default: tier query in flight (no data) — the self-host/loading posture.
  tierStateValue = { data: undefined };
  streamValue = { mutateAsync: mutateAsyncMock, isPending: false, error: undefined };
});

afterEach(() => {
  cleanup();
});

// ---- Tests ----------------------------------------------------------------

describe('AdvisorPage', () => {
  it('case 1: renders the empty-state message when there are no conversations and a key exists', () => {
    renderPage({ conversationId: null });
    expect(screen.getByText('Start a conversation with the Tradr Advisor.')).toBeTruthy();
    // Composer is present and enabled (a key is configured).
    expect(screen.getByTestId('composer')).toBeTruthy();
  });

  it('case 2: renders the no-key banner instead of the empty-state when no provider key is configured', () => {
    providerKeysValue = { data: { items: [] } };
    renderPage({ conversationId: null });
    expect(screen.getByTestId('no-key-banner')).toBeTruthy();
    expect(
      screen.getByText('Add a provider API key in Settings → Advisor to start chatting.'),
    ).toBeTruthy();
    // Composer is suppressed in the no-key case.
    expect(screen.queryByTestId('composer')).toBeNull();
  });

  it('case 3: submitting in the composer forwards a clientMessageId and a non-undefined personaId to the stream', async () => {
    renderPage({ conversationId: null, isNew: true });
    fireEvent.change(screen.getByLabelText('Message'), { target: { value: 'hello advisor' } });
    fireEvent.click(screen.getByLabelText('Send message'));

    await waitFor(() => expect(mutateAsyncMock).toHaveBeenCalledTimes(1));
    const submitted = mutateAsyncMock.mock.calls[0][0] as {
      clientMessageId: string;
      personaId?: string;
      text: string;
    };
    expect(submitted.text).toBe('hello advisor');
    expect(submitted.clientMessageId).toMatch(/[0-9a-f-]{36}/i);
    // Carry-over from Task 42 review: the page always supplies a default persona.
    expect(submitted.personaId).toBe('default-trading-advisor');
  });

  it('case 4: clicking the in-transcript retry re-submits with the SAME clientMessageId', async () => {
    // Render on an existing conversation so the Transcript (which hosts the retry
    // control) is mounted and the page retains the submission for retry.
    renderPage({ conversationId: 'conv-1' });

    // First submission — the page records its clientMessageId for retry.
    fireEvent.change(screen.getByLabelText('Message'), { target: { value: 'retry me' } });
    fireEvent.click(screen.getByLabelText('Send message'));
    await waitFor(() => expect(mutateAsyncMock).toHaveBeenCalledTimes(1));
    const firstId = (mutateAsyncMock.mock.calls[0][0] as { clientMessageId: string })
      .clientMessageId;

    // Simulate a stream error so the Transcript renders its retry control.
    const { useStreamStore } = await import('../../stores/stream.store');
    act(() => useStreamStore.getState().setError('conv-1', 'STREAM_TIMEOUT'));

    const retryButton = await screen.findByRole('button', { name: 'Retry' });
    fireEvent.click(retryButton);
    await waitFor(() => expect(mutateAsyncMock).toHaveBeenCalledTimes(2));
    const retryId = (mutateAsyncMock.mock.calls[1][0] as { clientMessageId: string })
      .clientMessageId;
    expect(retryId).toBe(firstId);

    useStreamStore.getState().reset('conv-1');
  });

  it('case 5: a BYOK send carries NO providerOverride (BYOK behavior unchanged)', async () => {
    // hasProviderKey is true (default) — even with platform billing enabled, the
    // BYOK path takes precedence and sends no override.
    billingConfigValue = {
      data: { enabled: true, models: [{ providerId: 'claude', model: 'claude-x' }] },
    };
    renderPage({ conversationId: null, isNew: true });
    // No picker is forced for a BYOK user.
    expect(screen.queryByTestId('platform-model-picker')).toBeNull();

    fireEvent.change(screen.getByLabelText('Message'), { target: { value: 'hi' } });
    fireEvent.click(screen.getByLabelText('Send message'));

    await waitFor(() => expect(mutateAsyncMock).toHaveBeenCalledTimes(1));
    const submitted = mutateAsyncMock.mock.calls[0][0] as { providerOverride?: unknown };
    expect(submitted.providerOverride).toBeUndefined();
  });

  it('case 6: a no-BYOK platform new conversation sends providerOverride after a model is picked', async () => {
    providerKeysValue = { data: { items: [] } };
    billingConfigValue = {
      data: {
        enabled: true,
        models: [
          { providerId: 'claude', model: 'claude-sonnet' },
          { providerId: 'openai', model: 'gpt-x' },
        ],
      },
    };
    renderPage({ conversationId: null, isNew: true });

    // The composer is ungated (no "configure a key" banner) and the picker shows.
    expect(screen.queryByTestId('no-key-banner')).toBeNull();
    const picker = screen.getByTestId('platform-model-picker');
    expect(picker).toBeTruthy();

    // Send is blocked until a model is picked.
    expect((screen.getByLabelText('Send message') as HTMLButtonElement).disabled).toBe(true);

    // Pick a provider — the picker auto-selects that provider's first priced
    // model, so the selection becomes a valid { providerId, model } pair.
    fireEvent.change(screen.getByLabelText('Provider'), { target: { value: 'claude' } });

    fireEvent.change(screen.getByLabelText('Message'), { target: { value: 'platform hello' } });
    fireEvent.click(screen.getByLabelText('Send message'));

    await waitFor(() => expect(mutateAsyncMock).toHaveBeenCalledTimes(1));
    const submitted = mutateAsyncMock.mock.calls[0][0] as {
      providerOverride?: { providerId: string; model: string };
    };
    expect(submitted.providerOverride).toEqual({ providerId: 'claude', model: 'claude-sonnet' });
  });

  it('case 7: preselects the allowance model for a no-BYOK user with headroom (REQ-8.9b)', async () => {
    setupNoByokPlatform();
    tierStateValue = { data: makeTierState({ allowanceUsed: 0 }) };
    renderPage({ conversationId: null, isNew: true });

    // No picker interaction: the allowance model is preselected, so the first
    // send goes through immediately, carrying the allowance model — NOT the
    // rate-table-first (most expensive) model.
    fireEvent.change(screen.getByLabelText('Message'), { target: { value: 'first turn' } });
    fireEvent.click(screen.getByLabelText('Send message'));
    await waitFor(() => expect(mutateAsyncMock).toHaveBeenCalledTimes(1));
    const submitted = mutateAsyncMock.mock.calls[0][0] as {
      providerOverride?: { providerId: string; model: string };
    };
    expect(submitted.providerOverride).toEqual(
      expect.objectContaining({ providerId: 'claude', model: 'claude-haiku' }),
    );
  });

  it('case 8: the picker stays empty (send blocked) while the tier query is in flight', () => {
    setupNoByokPlatform();
    tierStateValue = { data: undefined }; // in flight — empty-until-loaded
    renderPage({ conversationId: null, isNew: true });

    fireEvent.change(screen.getByLabelText('Message'), { target: { value: 'hi' } });
    expect((screen.getByLabelText('Send message') as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByLabelText('Provider') as HTMLSelectElement).value).toBe('');
  });

  it('case 9: no preselect without allowance headroom (exhausted)', () => {
    setupNoByokPlatform();
    tierStateValue = { data: makeTierState({ allowanceUsed: 25 }) }; // cap 25 — no headroom
    renderPage({ conversationId: null, isNew: true });

    fireEvent.change(screen.getByLabelText('Message'), { target: { value: 'hi' } });
    // Today's behavior stands: the user must pick a model first.
    expect((screen.getByLabelText('Send message') as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByLabelText('Provider') as HTMLSelectElement).value).toBe('');
  });

  it('case 10: invalidates billingKeys.tier() exactly once after a committed turn (the ONE seam)', async () => {
    const { qc } = renderPage({ conversationId: 'conv-1' });
    const spy = vi.spyOn(qc, 'invalidateQueries');

    fireEvent.change(screen.getByLabelText('Message'), { target: { value: 'committed turn' } });
    fireEvent.click(screen.getByLabelText('Send message'));
    await waitFor(() => expect(mutateAsyncMock).toHaveBeenCalledTimes(1));

    await waitFor(() => {
      const tierInvalidations = spy.mock.calls.filter(
        ([arg]) =>
          JSON.stringify((arg as { queryKey?: unknown })?.queryKey) ===
          JSON.stringify(['billing', 'tier']),
      );
      // Exactly one — the AdvisorPage stream-lifecycle seam; no second copy in
      // the Composer or useAdvisorStream.
      expect(tierInvalidations.length).toBe(1);
    });
  });

  it('case 11: invalidates billingKeys.tier() on a 402-family refusal too', async () => {
    mutateAsyncMock.mockRejectedValueOnce(
      Object.assign(new Error('refused'), { code: 'ALLOWANCE_EXHAUSTED' }),
    );
    const { qc } = renderPage({ conversationId: 'conv-1' });
    const spy = vi.spyOn(qc, 'invalidateQueries');

    fireEvent.change(screen.getByLabelText('Message'), { target: { value: 'refused turn' } });
    fireEvent.click(screen.getByLabelText('Send message'));
    await waitFor(() => expect(mutateAsyncMock).toHaveBeenCalledTimes(1));

    await waitFor(() => {
      const tierInvalidations = spy.mock.calls.filter(
        ([arg]) =>
          JSON.stringify((arg as { queryKey?: unknown })?.queryKey) ===
          JSON.stringify(['billing', 'tier']),
      );
      expect(tierInvalidations.length).toBe(1);
    });
  });
});

// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createElement, type ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { api } from '@/lib/api';

import { ProviderKeyCard } from '../ProviderKeyCard';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('@/lib/api', () => ({
  api: { get: vi.fn(), put: vi.fn(), patch: vi.fn(), delete: vi.fn() },
}));

// Radix Select needs pointer-capture + scrollIntoView, which jsdom lacks.
window.HTMLElement.prototype.hasPointerCapture = vi.fn();
window.HTMLElement.prototype.releasePointerCapture = vi.fn();
window.HTMLElement.prototype.scrollIntoView = vi.fn();

const toast = vi.hoisted(() => ({ success: vi.fn(), warning: vi.fn(), error: vi.fn() }));
vi.mock('sonner', () => ({ toast }));

const MODELS = {
  items: [
    {
      id: 'claude-3-5-sonnet',
      displayName: 'Claude 3.5 Sonnet',
      contextWindow: 200000,
      vision: true,
      providerId: 'claude',
    },
    {
      id: 'claude-opus-4-8',
      displayName: 'Claude Opus 4.8',
      contextWindow: 200000,
      vision: true,
      providerId: 'claude',
    },
  ],
};

const CONFIGURED_ITEM = {
  id: '22222222-2222-2222-2222-222222222222',
  providerId: 'claude',
  defaultModel: 'claude-3-5-sonnet',
  keyHintTail: 'wxyz',
  lastUsedAt: null,
};

function renderCard() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const wrapper = ({ children }: { children: ReactNode }) =>
    createElement(QueryClientProvider, { client: qc }, children);
  return render(<ProviderKeyCard providerId="claude" />, { wrapper });
}

beforeEach(() => {
  vi.mocked(api.get).mockResolvedValue(MODELS);
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('ProviderKeyCard', () => {
  it('shows the unconfigured CTA when no key is configured', async () => {
    vi.mocked(api.get).mockImplementation((path: string) =>
      Promise.resolve(path === '/advisor/provider-keys' ? { items: [] } : MODELS),
    );

    renderCard();

    expect(await screen.findByText(/Not configured/)).toBeTruthy();
    expect(screen.getByText(/Add a Claude API key to start chatting/)).toBeTruthy();
  });

  it('renders the configured state with the keyHintTail', async () => {
    vi.mocked(api.get).mockImplementation((path: string) =>
      Promise.resolve(path === '/advisor/provider-keys' ? { items: [CONFIGURED_ITEM] } : MODELS),
    );

    renderCard();

    expect(await screen.findByText(/Configured/)).toBeTruthy();
    expect(screen.getByText(/••••••••wxyz/)).toBeTruthy();
  });

  it('saves a first-time key without a model selection (server picks the default)', async () => {
    // First save: no configured key, so /advisor/models is empty — the save
    // must go through with just the key and omit defaultModel from the body.
    vi.mocked(api.get).mockImplementation((path: string) =>
      Promise.resolve(path === '/advisor/provider-keys' ? { items: [] } : { items: [] }),
    );
    vi.mocked(api.put).mockResolvedValue({
      ...CONFIGURED_ITEM,
      defaultModel: 'claude-opus-4-8',
      verified: true,
    });

    renderCard();

    await screen.findByText(/Not configured/);
    fireEvent.input(screen.getByLabelText('API key'), {
      target: { value: 'sk-ant-first-key-123' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Save key' }));

    await waitFor(() => expect(toast.success).toHaveBeenCalledWith('Key verified'));
    expect(api.put).toHaveBeenCalledWith('/advisor/provider-keys/claude', {
      apiKey: 'sk-ant-first-key-123',
      defaultModel: undefined,
    });
  });

  it('shows the verified toast and state on a successful save', async () => {
    vi.mocked(api.get).mockImplementation((path: string) =>
      Promise.resolve(path === '/advisor/provider-keys' ? { items: [CONFIGURED_ITEM] } : MODELS),
    );
    vi.mocked(api.put).mockResolvedValue({ ...CONFIGURED_ITEM, verified: true });

    renderCard();

    // Wait for the list query to resolve so the saved default model is synced.
    await screen.findByText(/Configured/);
    fireEvent.input(screen.getByLabelText('API key'), {
      target: { value: 'sk-secret-plaintext-123' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Save key' }));

    await waitFor(() => expect(toast.success).toHaveBeenCalledWith('Key verified'));
    expect(screen.getByText('Key verified')).toBeTruthy();
  });

  it('shows "API key rejected" when the save returns PROVIDER_KEY_INVALID', async () => {
    vi.mocked(api.get).mockImplementation((path: string) =>
      Promise.resolve(path === '/advisor/provider-keys' ? { items: [CONFIGURED_ITEM] } : MODELS),
    );
    vi.mocked(api.put).mockRejectedValue({ status: 400, error: { code: 'PROVIDER_KEY_INVALID' } });

    renderCard();

    await screen.findByText(/Configured/);
    fireEvent.input(screen.getByLabelText('API key'), {
      target: { value: 'sk-bad-key-plaintext' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Save key' }));

    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith(expect.stringContaining('API key rejected')),
    );
  });

  it('changes the default model via PATCH without requiring the key', async () => {
    vi.mocked(api.get).mockImplementation((path: string) =>
      Promise.resolve(path === '/advisor/provider-keys' ? { items: [CONFIGURED_ITEM] } : MODELS),
    );
    vi.mocked(api.patch).mockResolvedValue({ ...CONFIGURED_ITEM, defaultModel: 'claude-opus-4-8' });

    renderCard();

    await screen.findByText(/Configured/);
    // Open the (Radix) select and pick the other model. pointerEventsCheck is
    // off because jsdom computes no layout for Radix's pointer-events styles.
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    await user.click(screen.getByLabelText('Default model'));
    await user.click(await screen.findByRole('option', { name: 'Claude Opus 4.8' }));

    await waitFor(() =>
      expect(api.patch).toHaveBeenCalledWith('/advisor/provider-keys/claude', {
        defaultModel: 'claude-opus-4-8',
      }),
    );
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith('Default model updated'));
    expect(api.put).not.toHaveBeenCalled();
  });

  it('reverts to unconfigured after delete + confirm', async () => {
    let keysResponse: { items: (typeof CONFIGURED_ITEM)[] } = { items: [CONFIGURED_ITEM] };
    vi.mocked(api.get).mockImplementation((path: string) =>
      Promise.resolve(path === '/advisor/provider-keys' ? keysResponse : MODELS),
    );
    vi.mocked(api.delete).mockImplementation(() => {
      keysResponse = { items: [] };
      return Promise.resolve(undefined);
    });

    renderCard();

    fireEvent.click(await screen.findByRole('button', { name: 'Remove key' }));
    fireEvent.click(screen.getByRole('button', { name: 'Confirm remove' }));

    expect(await screen.findByText(/Not configured/)).toBeTruthy();
    expect(api.delete).toHaveBeenCalledWith('/advisor/provider-keys/claude');
  });
});

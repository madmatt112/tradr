// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { api } from '@/lib/api';

import { MarketDataKeyCard } from '../MarketDataKeyCard';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('@/lib/api', () => ({
  api: { get: vi.fn(), put: vi.fn(), delete: vi.fn() },
}));

const toast = vi.hoisted(() => ({ success: vi.fn(), warning: vi.fn(), error: vi.fn() }));
vi.mock('sonner', () => ({ toast }));

function renderCard() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const wrapper = ({ children }: { children: ReactNode }) =>
    createElement(QueryClientProvider, { client: qc }, children);
  return render(<MarketDataKeyCard />, { wrapper });
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('MarketDataKeyCard', () => {
  it('shows the unconfigured CTA when no key is configured', async () => {
    vi.mocked(api.get).mockResolvedValue({ configured: false });

    renderCard();

    expect(await screen.findByText(/Not configured/)).toBeTruthy();
    expect(
      await screen.findByText(/Add an Unusual Whales API key to enable market-data tools/),
    ).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Save key' })).toBeTruthy();
  });

  it('renders the masked configured state with the keyHintTail and verified status', async () => {
    vi.mocked(api.get).mockResolvedValue({
      configured: true,
      keyHintTail: 'wxyz',
      verified: true,
    });

    renderCard();

    expect(await screen.findByText(/Configured/)).toBeTruthy();
    expect(screen.getByText(/••••••••wxyz/)).toBeTruthy();
    expect(screen.getByText('Key verified')).toBeTruthy();
    // Configured keys offer a Replace key action, never plaintext.
    expect(screen.getByRole('button', { name: 'Replace key' })).toBeTruthy();
    expect(screen.queryByText('wxyzwxyz')).toBeNull();
  });

  it('shows the unverified status when the stored key is unverified', async () => {
    vi.mocked(api.get).mockResolvedValue({
      configured: true,
      keyHintTail: 'wxyz',
      verified: false,
    });

    renderCard();

    expect(await screen.findByText(/could not be verified/)).toBeTruthy();
  });

  it('shows the verified toast and state on a successful save', async () => {
    vi.mocked(api.get).mockResolvedValue({ configured: false });
    vi.mocked(api.put).mockResolvedValue({ configured: true, keyHintTail: 'last', verified: true });

    renderCard();

    await screen.findByText(/Not configured/);
    fireEvent.input(screen.getByLabelText('API key'), {
      target: { value: 'uw-secret-plaintext-123' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Save key' }));

    await waitFor(() => expect(toast.success).toHaveBeenCalledWith('Key verified'));
    expect(api.put).toHaveBeenCalledWith('/advisor/market-data-key', {
      apiKey: 'uw-secret-plaintext-123',
    });
    expect(screen.getByText('Key verified')).toBeTruthy();
  });

  it('shows the unverified toast when a save returns verified:false', async () => {
    vi.mocked(api.get).mockResolvedValue({ configured: false });
    vi.mocked(api.put).mockResolvedValue({
      configured: true,
      keyHintTail: 'last',
      verified: false,
    });

    renderCard();

    await screen.findByText(/Not configured/);
    fireEvent.input(screen.getByLabelText('API key'), { target: { value: 'uw-maybe-key-123' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save key' }));

    await waitFor(() =>
      expect(toast.warning).toHaveBeenCalledWith(expect.stringContaining('could not be verified')),
    );
  });

  it('shows "API key rejected" when the save returns MARKET_DATA_KEY_INVALID', async () => {
    vi.mocked(api.get).mockResolvedValue({ configured: false });
    vi.mocked(api.put).mockRejectedValue({
      status: 400,
      error: { code: 'MARKET_DATA_KEY_INVALID' },
    });

    renderCard();

    await screen.findByText(/Not configured/);
    fireEvent.input(screen.getByLabelText('API key'), { target: { value: 'uw-bad-key-123' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save key' }));

    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith(expect.stringContaining('API key rejected')),
    );
  });

  it('reverts to unconfigured after delete + confirm', async () => {
    let statusResponse: unknown = { configured: true, keyHintTail: 'wxyz', verified: true };
    vi.mocked(api.get).mockImplementation(() => Promise.resolve(statusResponse));
    vi.mocked(api.delete).mockImplementation(() => {
      statusResponse = { configured: false };
      return Promise.resolve(undefined);
    });

    renderCard();

    fireEvent.click(await screen.findByRole('button', { name: 'Remove key' }));
    fireEvent.click(screen.getByRole('button', { name: 'Confirm remove' }));

    expect(await screen.findByText(/Not configured/)).toBeTruthy();
    expect(api.delete).toHaveBeenCalledWith('/advisor/market-data-key');
  });

  it('keeps all action buttons clickable (cursor-pointer)', async () => {
    vi.mocked(api.get).mockResolvedValue({ configured: true, keyHintTail: 'wxyz', verified: true });

    renderCard();

    const save = await screen.findByRole('button', { name: 'Replace key' });
    const remove = screen.getByRole('button', { name: 'Remove key' });
    expect(save.className).toContain('cursor-pointer');
    expect(remove.className).toContain('cursor-pointer');
  });
});

// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { api } from '@/lib/api';

import { TradeDataConsentToggle } from '../TradeDataConsentToggle';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('@/lib/api', () => ({
  api: { get: vi.fn(), put: vi.fn() },
}));

const toast = vi.hoisted(() => ({ success: vi.fn(), warning: vi.fn(), error: vi.fn() }));
vi.mock('sonner', () => ({ toast }));

function renderToggle() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const wrapper = ({ children }: { children: ReactNode }) =>
    createElement(QueryClientProvider, { client: qc }, children);
  return render(<TradeDataConsentToggle />, { wrapper });
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('TradeDataConsentToggle', () => {
  it('renders off by default and turns consent on optimistically', async () => {
    // Stateful mock: GET reflects whatever PUT last persisted, mirroring the API.
    let stored = false;
    vi.mocked(api.get).mockImplementation(async () => ({ consent: stored }));
    vi.mocked(api.put).mockImplementation(async (_path, body) => {
      stored = (body as { consent: boolean }).consent;
      return { consent: stored };
    });

    renderToggle();

    const toggle = await screen.findByRole('switch', { name: 'Trade-data access' });
    await waitFor(() => expect(toggle.getAttribute('aria-checked')).toBe('false'));

    fireEvent.click(toggle);

    // Optimistic: flips immediately, then stays on after the PUT + refetch settle.
    await waitFor(() => expect(toggle.getAttribute('aria-checked')).toBe('true'));
    expect(api.put).toHaveBeenCalledWith('/advisor/trade-data-consent', { consent: true });
  });

  it('turns consent off when it was on', async () => {
    let stored = true;
    vi.mocked(api.get).mockImplementation(async () => ({ consent: stored }));
    vi.mocked(api.put).mockImplementation(async (_path, body) => {
      stored = (body as { consent: boolean }).consent;
      return { consent: stored };
    });

    renderToggle();

    const toggle = await screen.findByRole('switch', { name: 'Trade-data access' });
    await waitFor(() => expect(toggle.getAttribute('aria-checked')).toBe('true'));

    fireEvent.click(toggle);

    await waitFor(() => expect(toggle.getAttribute('aria-checked')).toBe('false'));
    expect(api.put).toHaveBeenCalledWith('/advisor/trade-data-consent', { consent: false });
  });

  it('rolls back to the previous value when the mutation fails', async () => {
    vi.mocked(api.get).mockResolvedValue({ consent: false });
    vi.mocked(api.put).mockRejectedValue(new Error('boom'));

    renderToggle();

    const toggle = await screen.findByRole('switch', { name: 'Trade-data access' });
    await waitFor(() => expect(toggle.getAttribute('aria-checked')).toBe('false'));

    fireEvent.click(toggle);

    // Optimistically flips on, then rolls back to off after the error.
    await waitFor(() => expect(toggle.getAttribute('aria-checked')).toBe('false'));
    expect(toast.error).toHaveBeenCalled();
  });

  it('expands the disclosure, including the delete-conversation caveat', async () => {
    vi.mocked(api.get).mockResolvedValue({ consent: false });

    renderToggle();

    const trigger = await screen.findByText('What this means');
    fireEvent.click(trigger);

    expect(
      await screen.findByText(/to fully remove trade data, delete the conversation/),
    ).toBeTruthy();
    // Does not lean on "read-only" as a safety claim.
    expect(screen.getByText(/not made safe by the data being read-only/)).toBeTruthy();
  });

  it('shows the reliability/cost disclosure', async () => {
    vi.mocked(api.get).mockResolvedValue({ consent: false });

    renderToggle();

    expect(await screen.findByTestId('reliability-note')).toBeTruthy();
    expect(screen.getByText(/discards that turn .* still costs\s+provider tokens/i)).toBeTruthy();
    expect(screen.getByText(/temporarily rate-limited/)).toBeTruthy();
  });
});

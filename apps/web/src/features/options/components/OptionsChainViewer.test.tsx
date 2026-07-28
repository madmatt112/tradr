// @vitest-environment jsdom
// OptionsChainViewer + OptionsPage tests (Task 35; design §Component 12,
// REQ-12.1/12.2/12.3/12.6). Covers the viewer's UW states AND the REQ-12.6
// regression: the options route resolves and renders all three cards (the
// Black-Scholes and OCC cards are unbroken alongside the additive viewer), and
// the page layout (heading + chain card) is intact.
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  RouterProvider,
} from '@tanstack/react-router';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// Stub TanStack Router's <Link> so the no-key CTA renders without a router.
vi.mock('@tanstack/react-router', async () => {
  const actual =
    await vi.importActual<typeof import('@tanstack/react-router')>('@tanstack/react-router');
  return {
    ...actual,
    Link: ({ to, children }: { to: string; children: React.ReactNode }) => (
      <a href={to}>{children}</a>
    ),
  };
});

// Mock the chain hook so each test scripts a UW state without network.
const useOptionsChainMock = vi.fn();
vi.mock('../hooks/useOptionsChain', () => ({
  useOptionsChain: (...a: unknown[]) => useOptionsChainMock(...a),
}));

import { OptionsChainViewer } from './OptionsChainViewer';
import { OptionsPage } from './OptionsPage';

function renderWithClient(ui: React.ReactNode) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={qc}>{ui}</QueryClientProvider>);
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('OptionsChainViewer', () => {
  it('renders the symbol input and no result before a symbol is entered', () => {
    useOptionsChainMock.mockReturnValue({ isLoading: false, isError: false, data: undefined });
    renderWithClient(<OptionsChainViewer />);
    expect(screen.getByLabelText('Symbol')).toBeTruthy();
    expect(screen.queryByText('Loading chain…')).toBeNull();
  });

  it('shows the no-key empty-state CTA to Settings (REQ-12.2)', async () => {
    useOptionsChainMock.mockReturnValue({
      isLoading: false,
      isError: false,
      data: { configured: false },
    });
    renderWithClient(<OptionsChainViewer />);
    await userEvent.type(screen.getByLabelText('Symbol'), 'AAPL');
    await waitFor(() => {
      expect(screen.getByText(/Connect an Unusual Whales key/i)).toBeTruthy();
    });
    const cta = screen.getByRole('link', { name: /Go to Settings/i });
    expect(cta.getAttribute('href')).toBe('/settings/advisor');
  });

  it('renders a contract table on success', async () => {
    useOptionsChainMock.mockReturnValue({
      isLoading: false,
      isError: false,
      data: {
        configured: true,
        chain: {
          symbol: 'AAPL',
          count: 1,
          contracts: [
            { option_type: 'call', strike: 150, expiry: '2025-06-20', bid: 3.1, ask: 3.3 },
          ],
        },
      },
    });
    renderWithClient(<OptionsChainViewer />);
    await userEvent.type(screen.getByLabelText('Symbol'), 'AAPL');
    await waitFor(() => {
      expect(screen.getByText('150')).toBeTruthy();
    });
    expect(screen.getByText('2025-06-20')).toBeTruthy();
  });

  it.each([
    ['MARKET_DATA_RATE_LIMITED', /Rate limited/i],
    ['SYMBOL_NOT_FOUND', /No options chain found/i],
    ['MARKET_DATA_KEY_INVALID', /key was rejected/i],
    ['MARKET_DATA_UNAVAILABLE', /temporarily unavailable/i],
  ])('renders the %s UW failure state (REQ-12.3)', async (code, matcher) => {
    useOptionsChainMock.mockReturnValue({
      isLoading: false,
      isError: true,
      error: { error: { code } },
      data: undefined,
    });
    renderWithClient(<OptionsChainViewer />);
    await userEvent.type(screen.getByLabelText('Symbol'), 'AAPL');
    await waitFor(() => {
      expect(screen.getByText(matcher)).toBeTruthy();
    });
  });

  it('renders the loading state', async () => {
    useOptionsChainMock.mockReturnValue({ isLoading: true, isError: false, data: undefined });
    renderWithClient(<OptionsChainViewer />);
    await userEvent.type(screen.getByLabelText('Symbol'), 'AAPL');
    await waitFor(() => {
      expect(screen.getByText('Loading chain…')).toBeTruthy();
    });
  });
});

// --- REQ-6.5/6.6 onSelectContract selection prop ----------------------------
// A mixed chain: one row WITH a non-empty option_symbol (selectable) and one
// WITHOUT (not selectable). Proves the "Use" button renders only for the former
// and calls onSelectContract(row); and that the prop-less mount is unchanged.
describe('OptionsChainViewer onSelectContract (REQ-6.5/6.6)', () => {
  const mixedChain = {
    isLoading: false,
    isError: false,
    data: {
      configured: true,
      chain: {
        symbol: 'AAPL',
        count: 2,
        contracts: [
          {
            option_symbol: 'AAPL250620C00150000',
            option_type: 'call',
            strike: 150,
            expiry: '2025-06-20',
            last_price: 3.2,
          },
          { option_type: 'put', strike: 140, expiry: '2025-06-20' },
        ],
      },
    },
  };

  it('renders "Use" only for rows with a non-empty option_symbol and calls onSelectContract(row)', async () => {
    useOptionsChainMock.mockReturnValue(mixedChain);
    const onSelectContract = vi.fn();
    renderWithClient(<OptionsChainViewer onSelectContract={onSelectContract} />);
    await userEvent.type(screen.getByLabelText('Symbol'), 'AAPL');
    await waitFor(() => {
      expect(screen.getByText('150')).toBeTruthy();
    });

    // Exactly one "Use" button — the row lacking option_symbol renders none.
    const useButtons = screen.getAllByRole('button', { name: 'Use' });
    expect(useButtons).toHaveLength(1);
    expect(useButtons[0].className).toContain('cursor-pointer');

    await userEvent.click(useButtons[0]);
    expect(onSelectContract).toHaveBeenCalledTimes(1);
    expect(onSelectContract).toHaveBeenCalledWith(mixedChain.data.chain.contracts[0]);
  });

  it('renders no "Use" button when onSelectContract is omitted (display-only, REQ-6.6)', async () => {
    useOptionsChainMock.mockReturnValue(mixedChain);
    renderWithClient(<OptionsChainViewer />);
    await userEvent.type(screen.getByLabelText('Symbol'), 'AAPL');
    await waitFor(() => {
      expect(screen.getByText('150')).toBeTruthy();
    });
    expect(screen.queryByRole('button', { name: 'Use' })).toBeNull();
  });
});

// --- REQ-12.6 route/layout regression --------------------------------------
// Re-host the real /options route under a fresh root and assert it resolves and
// renders all three cards with the heading intact (additive viewer does not
// break the page layout or the Black-Scholes / OCC cards).

describe('OptionsPage route (REQ-12.6 regression)', () => {
  it('route resolves and renders all three cards with the layout intact', async () => {
    useOptionsChainMock.mockReturnValue({ isLoading: false, isError: false, data: undefined });

    const rootRoute = createRootRoute();
    /* eslint-disable @typescript-eslint/no-explicit-any */
    const optionsRoute = createRoute({
      getParentRoute: () => rootRoute as any,
      path: '/options',
      component: OptionsPage,
    });
    const routeTree = rootRoute.addChildren([optionsRoute]);
    const router = createRouter({
      routeTree: routeTree as any,
      history: createMemoryHistory({ initialEntries: ['/options'] }),
    });
    /* eslint-enable @typescript-eslint/no-explicit-any */

    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={qc}>
        {/* eslint-disable-next-line @typescript-eslint/no-explicit-any */}
        <RouterProvider router={router as any} />
      </QueryClientProvider>,
    );

    await waitFor(() => {
      expect(router.state.location.pathname).toBe('/options');
    });
    // Heading + all three card titles present (layout unbroken).
    expect(screen.getByText('Options Tools')).toBeTruthy();
    expect(screen.getByText('Black-Scholes Pricer')).toBeTruthy();
    expect(screen.getByText('OCC Symbol Decoder / Encoder')).toBeTruthy();
    expect(screen.getByText('Options Chain')).toBeTruthy();
  });
});

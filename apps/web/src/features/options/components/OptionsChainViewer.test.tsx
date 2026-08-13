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
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
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
        expiration: '2025-06-20',
        expirations: ['2025-06-20', '2025-09-19'],
        chain: {
          symbol: 'AAPL',
          count: 1,
          contracts: [
            {
              option_type: 'call',
              strike: 150,
              expiry: '2025-06-20',
              bid: 3.1,
              ask: 3.3,
              premium: 3.2,
            },
          ],
        },
      },
    });
    renderWithClient(<OptionsChainViewer />);
    await userEvent.type(screen.getByLabelText('Symbol'), 'AAPL');
    await waitFor(() => {
      expect(screen.getByText('150.00')).toBeTruthy();
    });
    // The expiry lives in the picker now, not repeated down every row — it is
    // constant for a chain, so a column of it was pure noise.
    const table = screen.getByRole('table');
    expect(within(table).queryByText('2025-06-20')).toBeNull();
    expect((screen.getByLabelText('Expiration') as HTMLSelectElement).value).toBe('2025-06-20');
    // The premium column is what the calculator hand-off uses.
    expect(within(table).getByText('3.20')).toBeTruthy();
  });

  it('offers every expiry in a picker and refetches on change (REQ-12.4)', async () => {
    useOptionsChainMock.mockReturnValue({
      isLoading: false,
      isError: false,
      data: {
        configured: true,
        expiration: '2025-06-20',
        expirations: ['2025-06-20', '2025-09-19'],
        chain: { symbol: 'AAPL', count: 1, contracts: [{ strike: 150, premium: 3.2 }] },
      },
    });
    renderWithClient(<OptionsChainViewer />);
    await userEvent.type(screen.getByLabelText('Symbol'), 'AAPL');

    const picker = await screen.findByLabelText('Expiration');
    expect((picker as HTMLSelectElement).value).toBe('2025-06-20');

    await userEvent.selectOptions(picker, '2025-09-19');
    await waitFor(() => {
      // The hook is re-invoked with the chosen expiry, which is what scopes the
      // upstream fetch to one ladder instead of the whole chain.
      expect(useOptionsChainMock).toHaveBeenCalledWith('AAPL', '2025-09-19');
    });
  });

  // The defect this replaced: a flat 400-row list of both sides, ordered from
  // the lowest strike, so the view opened on deep-ITM calls and worthless puts
  // and at-the-money was far below the fold.
  it('opens centred on at-the-money and hides the far strikes', async () => {
    const contracts = [];
    for (let strike = 700; strike <= 850; strike += 1) {
      contracts.push({ option_type: 'call', strike, option_symbol: `SPY${strike}C`, premium: 1 });
      contracts.push({ option_type: 'put', strike, option_symbol: `SPY${strike}P`, premium: 1 });
    }
    useOptionsChainMock.mockReturnValue({
      isLoading: false,
      isError: false,
      data: {
        configured: true,
        expiration: '2030-06-21',
        expirations: ['2030-06-21'],
        underlying: { price: 772.5, market_time: 'regular' },
        chain: { symbol: 'SPY', count: contracts.length, contracts },
      },
    });
    renderWithClient(<OptionsChainViewer />);
    await userEvent.type(screen.getByLabelText('Symbol'), 'SPY');

    const table = await screen.findByRole('table');
    // 10 strikes either side of ATM, one row per strike — not 302 rows.
    const rows = within(table).getAllByRole('row').slice(1);
    expect(rows).toHaveLength(21);
    expect(within(table).getByText('772.00')).toBeTruthy();
    // Far strikes are out of the window entirely.
    expect(within(table).queryByText('700.00')).toBeNull();
    expect(screen.getByRole('button', { name: /Show more strikes/ })).toBeTruthy();
  });

  it('marks the at-the-money row and shades in-the-money rows', async () => {
    useOptionsChainMock.mockReturnValue({
      isLoading: false,
      isError: false,
      data: {
        configured: true,
        expiration: '2030-06-21',
        expirations: ['2030-06-21'],
        underlying: { price: 772.5, market_time: 'regular' },
        chain: {
          symbol: 'SPY',
          count: 3,
          contracts: [
            { option_type: 'call', strike: 770, option_symbol: 'SPY770C' },
            { option_type: 'call', strike: 775, option_symbol: 'SPY775C' },
          ],
        },
      },
    });
    renderWithClient(<OptionsChainViewer />);
    await userEvent.type(screen.getByLabelText('Symbol'), 'SPY');

    const table = await screen.findByRole('table');
    const rows = within(table).getAllByRole('row').slice(1);
    // 770 is below spot → ITM call, and nearest spot → ATM.
    expect(rows[0].getAttribute('data-itm')).toBe('true');
    expect(rows[0].getAttribute('data-atm')).toBe('true');
    // 775 is above spot → OTM.
    expect(rows[1].getAttribute('data-itm')).toBeNull();
  });

  it('opens on puts for a short and lets the toggle switch sides', async () => {
    useOptionsChainMock.mockReturnValue({
      isLoading: false,
      isError: false,
      data: {
        configured: true,
        expiration: '2030-06-21',
        expirations: ['2030-06-21'],
        underlying: { price: 100, market_time: 'regular' },
        chain: {
          symbol: 'SPY',
          count: 2,
          contracts: [
            { option_type: 'call', strike: 100, option_symbol: 'C', premium: 1.5 },
            { option_type: 'put', strike: 100, option_symbol: 'P', premium: 2.5 },
          ],
        },
      },
    });
    renderWithClient(<OptionsChainViewer direction="short" />);
    await userEvent.type(screen.getByLabelText('Symbol'), 'SPY');

    const table = await screen.findByRole('table');
    expect(within(table).getByText('2.50')).toBeTruthy();
    expect(within(table).queryByText('1.50')).toBeNull();

    await userEvent.click(screen.getByRole('button', { name: 'Calls' }));
    await waitFor(() => {
      expect(within(screen.getByRole('table')).getByText('1.50')).toBeTruthy();
    });
  });

  it('surfaces the underlying price and flags a non-regular session', async () => {
    useOptionsChainMock.mockReturnValue({
      isLoading: false,
      isError: false,
      data: {
        configured: true,
        expiration: '2030-06-21',
        expirations: ['2030-06-21'],
        underlying: { price: 772.5, market_time: 'postmarket' },
        chain: {
          symbol: 'SPY',
          count: 1,
          contracts: [{ option_type: 'call', strike: 770, option_symbol: 'C' }],
        },
      },
    });
    renderWithClient(<OptionsChainViewer />);
    await userEvent.type(screen.getByLabelText('Symbol'), 'SPY');

    const banner = await screen.findByText(/772\.5/);
    expect(banner).toBeTruthy();
    // A postmarket print is not a live quote — say so rather than imply it is.
    expect(screen.getByText(/Postmarket/)).toBeTruthy();
  });

  it('renders the whole side unwindowed when no spot price came back', async () => {
    const contracts = [];
    for (let strike = 100; strike <= 140; strike += 1) {
      contracts.push({ option_type: 'call', strike, option_symbol: `C${strike}` });
    }
    useOptionsChainMock.mockReturnValue({
      isLoading: false,
      isError: false,
      data: {
        configured: true,
        expiration: '2030-06-21',
        expirations: ['2030-06-21'],
        chain: { symbol: 'SPY', count: contracts.length, contracts },
      },
    });
    renderWithClient(<OptionsChainViewer />);
    await userEvent.type(screen.getByLabelText('Symbol'), 'SPY');

    const table = await screen.findByRole('table');
    expect(within(table).getAllByRole('row').slice(1)).toHaveLength(41);
    expect(screen.queryByRole('button', { name: /Show more strikes/ })).toBeNull();
  });

  it('hides the picker when the API sends no expiry list', async () => {
    useOptionsChainMock.mockReturnValue({
      isLoading: false,
      isError: false,
      data: {
        configured: true,
        chain: { symbol: 'AAPL', count: 1, contracts: [{ option_type: 'call', strike: 150 }] },
      },
    });
    renderWithClient(<OptionsChainViewer />);
    await userEvent.type(screen.getByLabelText('Symbol'), 'AAPL');
    await waitFor(() => {
      expect(screen.getByText('150.00')).toBeTruthy();
    });
    expect(screen.queryByLabelText('Expiration')).toBeNull();
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
      expiration: '2025-06-20',
      expirations: ['2025-06-20'],
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
            premium: 3.2,
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
      expect(screen.getByText('150.00')).toBeTruthy();
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
      expect(screen.getByText('150.00')).toBeTruthy();
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

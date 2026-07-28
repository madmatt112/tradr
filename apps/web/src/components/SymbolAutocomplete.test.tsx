// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, fireEvent, waitFor, cleanup, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { api } from '@/lib/api';

import type { SymbolAutocompleteProps } from './SymbolAutocomplete';
import { SymbolAutocomplete } from './SymbolAutocomplete';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// Mock the API client — the hook is driven entirely through api.get.
// vi.mock is hoisted above the imports, so `api.get` above is the mock.
vi.mock('@/lib/api', () => ({ api: { get: vi.fn() } }));

const AAPL = { ticker: 'AAPL', name: 'Apple Inc.', exchange: 'NASDAQ' };
const AAL = { ticker: 'AAL', name: 'American Airlines Group Inc.', exchange: 'NASDAQ' };

function renderAC(props: Partial<SymbolAutocompleteProps> = {}) {
  const onChange = props.onChange ?? vi.fn();
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
  const utils = render(
    <QueryClientProvider client={qc}>
      <SymbolAutocomplete value="" onChange={onChange} placeholder="Symbol" {...props} />
    </QueryClientProvider>,
  );
  const input = screen.getByPlaceholderText('Symbol') as HTMLInputElement;
  return { ...utils, onChange, input };
}

function type(input: HTMLInputElement, text: string) {
  fireEvent.focus(input);
  fireEvent.change(input, { target: { value: text } });
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

beforeEach(() => {
  vi.mocked(api.get).mockReset();
});

describe('SymbolAutocomplete', () => {
  it('empty field fires no request and shows no suggestions or error', () => {
    renderAC();
    expect(api.get).not.toHaveBeenCalled();
    expect(screen.queryByRole('listbox')).toBeNull();
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.queryByText('Searching…')).toBeNull();
  });

  it('shows a loading state while the search is in flight', async () => {
    // Never-resolving promise keeps the query pending.
    vi.mocked(api.get).mockReturnValue(new Promise(() => {}));
    const { input } = renderAC();
    type(input, 'aa');
    await waitFor(() => expect(screen.getByText('Searching…')).toBeTruthy());
    // The uppercased, debounced query drove the request.
    expect(api.get).toHaveBeenCalledWith(expect.stringContaining('q=AA'));
  });

  it('shows a distinct empty state when there are no matches', async () => {
    vi.mocked(api.get).mockResolvedValue({ results: [] });
    const { input } = renderAC();
    type(input, 'zzz');
    await waitFor(() => expect(screen.getByText('No matches')).toBeTruthy());
    expect(screen.queryByRole('option')).toBeNull();
  });

  it('renders results and selection fires onChange with the uppercased ticker', async () => {
    vi.mocked(api.get).mockResolvedValue({ results: [AAPL, AAL] });
    const { input, onChange } = renderAC();
    type(input, 'aa');
    const list = await screen.findByRole('listbox');
    expect(within(list).getByText('AAPL')).toBeTruthy();
    // Select via mousedown (keeps input focus; the selection handler is onMouseDown).
    fireEvent.mouseDown(within(list).getByText('AAPL').closest('[role="option"]')!);
    expect(onChange).toHaveBeenCalledWith('AAPL');
  });

  it('degrades to a plain text input on a search-endpoint error', async () => {
    vi.mocked(api.get).mockRejectedValue(new Error('boom'));
    const { input, onChange } = renderAC();
    type(input, 'msft');
    // Distinct error state (no dropdown).
    await waitFor(() => expect(screen.getByRole('alert')).toBeTruthy());
    expect(screen.queryByRole('listbox')).toBeNull();
    // Input is still usable: typing works and Enter commits the uppercased ticker.
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onChange).toHaveBeenCalledWith('MSFT');
  });

  it('keyboard nav moves aria-activedescendant and Enter selects the highlighted ticker', async () => {
    vi.mocked(api.get).mockResolvedValue({ results: [AAPL, AAL] });
    const { input, onChange } = renderAC();
    type(input, 'aa');
    await screen.findByRole('listbox');

    fireEvent.keyDown(input, { key: 'ArrowDown' });
    await waitFor(() => expect(input.getAttribute('aria-activedescendant')).toMatch(/-option-0$/));

    fireEvent.keyDown(input, { key: 'ArrowDown' });
    await waitFor(() => expect(input.getAttribute('aria-activedescendant')).toMatch(/-option-1$/));

    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onChange).toHaveBeenCalledWith('AAL');
  });

  it('Escape dismisses the open dropdown', async () => {
    vi.mocked(api.get).mockResolvedValue({ results: [AAPL, AAL] });
    const { input } = renderAC();
    type(input, 'aa');
    await screen.findByRole('listbox');
    fireEvent.keyDown(input, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('listbox')).toBeNull());
  });
});

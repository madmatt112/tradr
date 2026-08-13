// useOptionsChain — TanStack Query hook for the options-chain viewer
// (design §Component 12; REQ-12.2/12.3/12.4). Wraps GET /api/advisor/options-chain.
//
// The query is disabled until a symbol is supplied so typing does not fire a
// request per keystroke (the viewer debounces the symbol). The response is
// either the no-key empty state (`{ configured: false }`) or the parsed chain
// (`{ configured: true, chain }`). UW failures surface as the thrown API error
// envelope (`{ error: { code } }`) carrying the REQ-6.5 reason code so the
// viewer can render the right UI state.

import { useQuery } from '@tanstack/react-query';

import { api } from '@/lib/api';

/** One projected contract row (compact projection; fields optional). */
export interface OptionContract {
  option_symbol?: string;
  option_type?: string;
  strike?: number;
  expiry?: string;
  last_price?: number;
  bid?: number;
  ask?: number;
  /**
   * The premium to use as an entry price: the last traded price when the
   * contract has traded, otherwise the NBBO midpoint. Absent when the contract
   * has neither, in which case the calculator asks for it manually.
   */
  premium?: number;
  volume?: number;
  open_interest?: number;
  implied_volatility?: number;
  delta?: number;
  gamma?: number;
  theta?: number;
  vega?: number;
}

export interface OptionChain {
  symbol: string;
  expiration?: string;
  count: number;
  contracts: OptionContract[];
}

/**
 * The underlying's last trade, used to anchor the ladder on at-the-money.
 * Absent when the quote could not be fetched — the chain still renders.
 */
export interface Underlying {
  price?: number;
  /** Session the trade came from; anything but `regular` is not a live quote. */
  market_time?: string;
  tape_time?: string;
}

/** GET response — empty state (no key) or the parsed chain. */
export type OptionsChainResponse =
  | { configured: false }
  | {
      configured: true;
      /** The expiry this chain is for — the requested one, or the nearest. */
      expiration: string;
      /** Every tradeable expiry, soonest first, for the picker. */
      expirations: string[];
      underlying?: Underlying;
      chain: OptionChain;
    };

export const optionsChainKeys = {
  chain: (symbol: string, expiration?: string) =>
    ['options', 'chain', symbol, expiration ?? null] as const,
};

/**
 * Fetch the options chain for `symbol` (optionally one `expiration`). The query
 * is enabled only when a non-empty symbol is supplied (REQ-12.3 — no request on
 * an empty input). Retries are disabled so UW failure states render immediately
 * rather than after backoff.
 */
export function useOptionsChain(symbol: string, expiration?: string) {
  const trimmed = symbol.trim();
  return useQuery<OptionsChainResponse>({
    queryKey: optionsChainKeys.chain(trimmed, expiration),
    queryFn: () => {
      const params = new URLSearchParams({ symbol: trimmed });
      if (expiration) params.set('expiration', expiration);
      return api.get<OptionsChainResponse>(`/advisor/options-chain?${params.toString()}`);
    },
    enabled: trimmed.length > 0,
    retry: false,
  });
}

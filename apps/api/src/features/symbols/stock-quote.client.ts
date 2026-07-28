// Delayed spot-quote provider client (design v4 — stock-quote.client, REQ-4).
//
// The single outbound choke point for delayed last-price lookups: fetch one
// symbol's ~15-min-delayed price from the platform-global provider (API
// Ninjas /v1/stockprice), cache per-symbol with a short TTL + per-symbol
// single-flight, and project to the shared quote schema. Mirrors the
// changelog stack: the `ReleasesCache` TTL/single-flight/stale-on-error
// structure (adapted to a per-symbol keyed cache), the `github-releases`
// injected-`fetchImpl` seam + AbortController timeout, and the
// `initChangelogCache` NODE_ENV==='test' fence so CI never makes a live call.
//
// Key discipline: the provider base URL and key are read from `config` ONLY
// (bare `process.env` is ESLint-banned here); the key is NEVER logged and
// NEVER returned to the client; the base URL is not user-influenced (no SSRF).

import type { StockQuote } from '@tradr/shared';

import { config } from '@/lib/config';
import { AppError, NotFoundError } from '@/lib/errors';
import { logger } from '@/lib/logger';

/** The data subset the client returns — the handler adds the `configured:true` discriminant. */
export type StockQuoteData = Omit<StockQuote, 'configured'>;

/** Per-symbol cache TTL (design-pinned): repeated pulls within the window hit the cache. */
export const STOCK_QUOTE_TTL_MS = 60_000;

/** Per-request upstream timeout (changelog/UW precedent). */
const REQUEST_TIMEOUT_MS = 10_000;

// --- Provider fetch + error mapping ------------------------------------

export interface FetchStockQuoteDeps {
  /** Test seam (github-releases precedent): defaults to global `fetch`. */
  fetchImpl?: typeof fetch;
}

/**
 * Fetch and project one symbol's delayed last price. The four
 * caller-distinguishable outcomes (REQ-4.3):
 *
 *   - 200 with a finite `price`        → the projected quote
 *   - 200 with no/empty `price`, or 404 → NotFoundError (unknown symbol, 404)
 *   - 429 / timeout / network / 5xx    → 503 QUOTE_PROVIDER_UNAVAILABLE
 *   - 401 / 403 (key rejected)         → 502 QUOTE_PROVIDER_MISCONFIGURED (logged)
 *
 * API Ninjas supplies no day-change field, so `change` is always `null` and
 * `delayed` is always `true`. The key/URL come from `config`; the key is
 * never logged and never surfaced in an error.
 */
export async function fetchStockQuote(
  symbol: string,
  deps: FetchStockQuoteDeps = {},
): Promise<StockQuoteData> {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const baseUrl = config.STOCK_QUOTE_BASE_URL.replace(/\/$/, '');
  // The symbol reaches only the query string (encoded); the host comes
  // exclusively from server config (no SSRF, no user-influenced URL).
  const url = `${baseUrl}/v1/stockprice?ticker=${encodeURIComponent(symbol)}`;

  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(new Error('request timeout')),
    REQUEST_TIMEOUT_MS,
  );

  let res: Response;
  try {
    res = await fetchImpl(url, {
      method: 'GET',
      // API Ninjas auth header. Never logged, never returned.
      headers: { 'X-Api-Key': config.STOCK_QUOTE_API_KEY ?? '' },
      signal: controller.signal,
    });
  } catch {
    // Timeout / abort / network failure. The caught error is intentionally
    // NOT surfaced (no upstream/network detail, no key leak).
    throw unavailable();
  } finally {
    clearTimeout(timer);
  }

  // Key set but rejected ⇒ misconfigured. Log at `error` (status only — never
  // the key or an upstream body).
  if (res.status === 401 || res.status === 403) {
    logger.error('stock quote provider rejected credentials', { status: res.status });
    throw new AppError(502, 'QUOTE_PROVIDER_MISCONFIGURED', 'Quote provider is misconfigured.');
  }

  // Unknown ticker.
  if (res.status === 404) {
    throw new NotFoundError('symbol', symbol);
  }

  // Rate-limited (429), upstream error (5xx), or any other non-2xx ⇒
  // temporarily unavailable.
  if (!res.ok) {
    throw unavailable();
  }

  let json: unknown;
  try {
    json = await res.json();
  } catch {
    throw unavailable();
  }

  const price = (json as { price?: unknown } | null)?.price;
  // 200 with no/empty price ⇒ unknown symbol (API Ninjas returns `{}` for
  // unrecognized tickers). Same outcome as a 404.
  if (typeof price !== 'number' || !Number.isFinite(price)) {
    throw new NotFoundError('symbol', symbol);
  }

  return { symbol, lastPrice: String(price), change: null, delayed: true };
}

function unavailable(): AppError {
  return new AppError(
    503,
    'QUOTE_PROVIDER_UNAVAILABLE',
    'Quote provider is temporarily unavailable.',
  );
}

// --- Per-symbol TTL + single-flight + stale-on-error cache -------------

interface QuoteEntry {
  snapshot: StockQuoteData;
  fetchedAt: number;
}

/**
 * A per-symbol adaptation of `ReleasesCache`: a `Map<symbol, entry>` with a
 * short TTL, per-symbol single-flight, and stale-on-error. Injectable loader
 * so tests drive it without a live provider call.
 */
export class StockQuoteCache {
  private entries = new Map<string, QuoteEntry>();
  private inFlight = new Map<string, Promise<StockQuoteData>>();

  constructor(
    private readonly loader: (symbol: string) => Promise<StockQuoteData>,
    // Injectable ONLY for unit tests — prod uses the module constant.
    private readonly ttlMs: number = STOCK_QUOTE_TTL_MS,
  ) {}

  async get(symbol: string): Promise<StockQuoteData> {
    const now = Date.now();
    const entry = this.entries.get(symbol);

    // (1) Fresh hit — no provider call.
    if (entry && now - entry.fetchedAt < this.ttlMs) {
      return entry.snapshot;
    }

    // (2) A fetch for this symbol is already in flight — coalesce onto it
    //     (single-flight); the burst counts as ONE provider call.
    const existing = this.inFlight.get(symbol);
    if (existing) return existing;

    // (3) Start the fetch. `inFlight` is set synchronously before any await,
    //     so two concurrent get()s can never both start one.
    const promise = this.runFetch(symbol, entry);
    this.inFlight.set(symbol, promise);
    try {
      return await promise;
    } finally {
      this.inFlight.delete(symbol);
    }
  }

  private async runFetch(
    symbol: string,
    lastGood: QuoteEntry | undefined,
  ): Promise<StockQuoteData> {
    try {
      const snapshot = await this.loader(symbol);
      this.entries.set(symbol, { snapshot, fetchedAt: Date.now() });
      return snapshot;
    } catch (err) {
      // Stale-on-error: serve the last good snapshot if we have one, else
      // surface the mapped provider error.
      if (lastGood) return lastGood.snapshot;
      throw err;
    }
  }
}

// --- Module singleton + bootstrap/test seam ---------------------------

let cache: StockQuoteCache | null = null;

/** Real loader: the live provider fetch. Fenced off from NODE_ENV=test below. */
function loadQuote(symbol: string): Promise<StockQuoteData> {
  return fetchStockQuote(symbol);
}

/**
 * Bootstrap init + unit-test reset seam (mirrors `initChangelogCache`).
 *
 * - With a `loader`: (re)constructs the singleton around it — works in every
 *   environment; this IS the test seam.
 * - No-arg: constructs the singleton around the live provider loader; a NO-OP
 *   under `config.NODE_ENV === 'test'` so bootstrap-under-test never arms a
 *   live provider call, and a guarded no-op once initialized.
 */
export function initStockQuoteCache(loader?: (symbol: string) => Promise<StockQuoteData>): void {
  if (loader) {
    cache = new StockQuoteCache(loader);
    return;
  }
  if (config.NODE_ENV === 'test') return;
  if (cache) return;
  cache = new StockQuoteCache(loadQuote);
}

function ensureCache(): StockQuoteCache {
  if (!cache) {
    if (config.NODE_ENV === 'test') {
      throw new Error(
        'Stock quote cache not initialized under NODE_ENV=test — ' +
          'call initStockQuoteCache(testLoader) before exercising quote routes.',
      );
    }
    logger.warn('stock quote cache not initialized at bootstrap — constructing lazily');
    cache = new StockQuoteCache(loadQuote);
  }
  return cache;
}

/**
 * Fetch a symbol's delayed last price through the per-symbol cache. Returns
 * the data subset (`configured:true` is added by the handler). Maps every
 * provider failure to a coded `AppError`/`NotFoundError` — never an unhandled
 * 500 (REQ-4.3).
 */
export async function getStockQuote(symbol: string): Promise<StockQuoteData> {
  return ensureCache().get(symbol);
}

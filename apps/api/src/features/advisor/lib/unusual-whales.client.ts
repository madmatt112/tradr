// Unusual Whales client (design §Component 5, REQ-6.4–6.7, REQ-3.10, REQ-7.5).
//
// A thin `fetch` wrapper (NO SDK). It is the single outbound choke point for
// market-data: it owns (a) a per-turn TTL cache (cache hits do NOT meter), and
// (b) a per-user execution meter (60 calls / 60 s / user → PLATFORM_RATE_LIMITED).
//
// Each method: bearer auth, a per-request AbortSignal with a 10 s timeout
// COMBINED with the per-tool signal handed in by the dispatcher (so a 15 s
// tool-timeout abort cancels the in-flight socket — closes the v2 leak),
// Zod-parsed responses, and the REQ-6.5 status→reason mapping. Methods THROW a
// typed `MarketDataError` (mapped reason code + optional Retry-After) or a
// `PlatformRateLimitedError` (meter trip); the market-data tool handler (task 13)
// catches these and maps them to a `tool_result` ToolResult.
//
// Secret hygiene (REQ-6.6): the plaintext key lives only as a closed-over local;
// it is never logged, persisted, or streamed. Nothing in this module logs the
// Authorization header, the key, or response bodies.
//
// Endpoint paths are pinned against the live UW docs (api.unusualwhales.com/docs,
// PublicApi.TickerController): info / flow-alerts / expiry-breakdown /
// option-contracts.

import { z } from 'zod';

import { config } from '@/lib/config';

import { TOOL_RESULT_CODES, type ToolResultCode } from '../tools/error-codes';

/** Per-request upstream timeout (REQ-6.4, design §Component 5). */
const REQUEST_TIMEOUT_MS = 10_000;

/** Per-turn cache TTL (REQ-6.7). */
const CACHE_TTL_MS = 60_000;

/** Per-user meter window + limit (REQ-3.10). */
const METER_WINDOW_MS = 60_000;
const METER_MAX = 60;

/**
 * A mapped Unusual Whales failure (REQ-6.5). Carries a `tool_result`-bucket
 * reason code and, for a 429, the upstream `Retry-After` (seconds) when present.
 * The provider's raw message is NEVER surfaced (REQ-6.8 / Security) — only the
 * generic message below.
 */
export class MarketDataError extends Error {
  readonly code: ToolResultCode;
  readonly retryAfter?: number;

  constructor(code: ToolResultCode, message: string, retryAfter?: number) {
    super(message);
    this.name = 'MarketDataError';
    this.code = code;
    if (retryAfter !== undefined) this.retryAfter = retryAfter;
  }
}

/**
 * The per-user platform execution meter tripped (REQ-3.10). Distinct from an
 * upstream UW 429 (`MARKET_DATA_RATE_LIMITED`) — this is OUR cap, mapped to
 * `PLATFORM_RATE_LIMITED` by the handler.
 */
export class PlatformRateLimitedError extends Error {
  readonly code: ToolResultCode = TOOL_RESULT_CODES.PLATFORM_RATE_LIMITED;

  constructor(message = 'Platform tool-execution rate limit reached.') {
    super(message);
    this.name = 'PlatformRateLimitedError';
  }
}

// --- TTL cache (REQ-6.7) ----------------------------------------------------

interface CacheEntry {
  value: unknown;
  expiresAt: number;
}

/**
 * Per-turn, process-local TTL cache keyed by `(method, normalizedArgs)`
 * (REQ-6.7). Created once per turn by the loop and shared across the iterations'
 * clients. A hit skips both the outbound fetch AND the meter (design §Component 5).
 */
export class MarketDataCache {
  private readonly store = new Map<string, CacheEntry>();

  constructor(private readonly ttlMs: number = CACHE_TTL_MS) {}

  get(key: string): { hit: true; value: unknown } | { hit: false } {
    const entry = this.store.get(key);
    if (entry && entry.expiresAt > Date.now()) {
      return { hit: true, value: entry.value };
    }
    if (entry) this.store.delete(key);
    return { hit: false };
  }

  set(key: string, value: unknown): void {
    this.store.set(key, { value, expiresAt: Date.now() + this.ttlMs });
  }
}

// --- Per-user meter (REQ-3.10) ---------------------------------------------

interface MeterEntry {
  count: number;
  resetAt: number;
}

/**
 * Per-user fixed-window execution meter (REQ-3.10), mirroring the
 * `createRateLimiter` store pattern (rate-limit.middleware.ts). 60 calls / 60 s
 * per user; `charge` throws `PlatformRateLimitedError` once tripped. The client
 * charges ONLY on a cache miss (cache hits do not meter — design §Component 5).
 * Shared across a user's clients (constructed once per turn by the loop).
 */
export class MarketDataMeter {
  private readonly store = new Map<string, MeterEntry>();

  constructor(
    private readonly max: number = METER_MAX,
    private readonly windowMs: number = METER_WINDOW_MS,
  ) {}

  charge(userId: string): void {
    const now = Date.now();
    const entry = this.store.get(userId);
    if (entry && entry.resetAt > now) {
      if (entry.count >= this.max) {
        throw new PlatformRateLimitedError();
      }
      entry.count += 1;
    } else {
      this.store.set(userId, { count: 1, resetAt: now + this.windowMs });
    }
  }
}

// --- Response schemas (Zod-parsed — REQ-6.4) --------------------------------
//
// UW wraps ticker payloads in a `{ data: ... }` envelope. The shapes are kept
// permissive (passthrough) because the market-data tool (task 13) owns the
// compact projection; the client only guarantees the envelope is well-formed
// and non-empty (empty → SYMBOL_NOT_FOUND, REQ-6.5).

const stockInfoSchema = z.object({ data: z.record(z.unknown()) });
const flowAlertsSchema = z.object({ data: z.array(z.record(z.unknown())) });
const expiryBreakdownSchema = z.object({ data: z.array(z.record(z.unknown())) });
const optionContractsSchema = z.object({ data: z.array(z.record(z.unknown())) });

// --- Client -----------------------------------------------------------------

export interface UnusualWhalesClientDeps {
  /** Decrypted plaintext key (REQ-6.6 — held only for the call's lifetime). */
  apiKey: string;
  /** Owner of the per-user meter bucket (REQ-3.10). */
  userId: string;
  /** Per-turn TTL cache (REQ-6.7) — shared across iterations. */
  cache: MarketDataCache;
  /** Per-user meter (REQ-3.10) — shared across iterations. */
  meter: MarketDataMeter;
  /** Test seam (i): defaults to global `fetch`. */
  fetchImpl?: typeof fetch;
  /** Test/E2E seam (ii): defaults to `config.UNUSUAL_WHALES_BASE_URL`. */
  baseUrl?: string;
}

export interface UnusualWhalesClient {
  getStockQuote(symbol: string, signal?: AbortSignal): Promise<unknown>;
  getOptionsFlow(symbol: string, limit?: number, signal?: AbortSignal): Promise<unknown>;
  /** The ticker's expiries (cheap — no contract rows). */
  getExpiryBreakdown(symbol: string, signal?: AbortSignal): Promise<unknown>;
  /** One expiry's contracts, with NBBO + greeks. */
  getOptionContracts(symbol: string, expiry: string, signal?: AbortSignal): Promise<unknown>;
}

/** Stable cache/normalized-args key for `(method, args)` (REQ-6.7). */
function cacheKey(method: string, args: Record<string, unknown>): string {
  // Deterministic key insertion order keeps the key stable for equal args.
  const normalized = Object.keys(args)
    .sort()
    .reduce<Record<string, unknown>>((acc, k) => {
      if (args[k] !== undefined) acc[k] = args[k];
      return acc;
    }, {});
  return `${method}:${JSON.stringify(normalized)}`;
}

/**
 * Combine the per-tool signal (handed in by the handler) with a fresh 10 s
 * request-timeout signal so the in-flight fetch aborts on EITHER (REQ-6.4). The
 * returned `cleanup` clears the timer and detaches the listener so a fast
 * response does not leak a pending timer.
 */
function combinedRequestSignal(toolSignal?: AbortSignal): {
  signal: AbortSignal;
  cleanup: () => void;
  didTimeout: () => boolean;
} {
  const controller = new AbortController();
  let timedOut = false;

  const onTimeout = (): void => {
    timedOut = true;
    controller.abort(new Error('request timeout'));
  };
  const timer = setTimeout(onTimeout, REQUEST_TIMEOUT_MS);

  const onToolAbort = (): void => controller.abort(toolSignal?.reason);

  if (toolSignal) {
    if (toolSignal.aborted) {
      controller.abort(toolSignal.reason);
    } else {
      toolSignal.addEventListener('abort', onToolAbort, { once: true });
    }
  }

  return {
    signal: controller.signal,
    didTimeout: () => timedOut,
    cleanup: () => {
      clearTimeout(timer);
      toolSignal?.removeEventListener('abort', onToolAbort);
    },
  };
}

/** Map an upstream HTTP status to its REQ-6.5 reason code. */
function statusToError(status: number, retryAfterHeader: string | null): MarketDataError {
  if (status === 401 || status === 403) {
    return new MarketDataError(
      TOOL_RESULT_CODES.MARKET_DATA_KEY_INVALID,
      'The Unusual Whales API key was rejected.',
    );
  }
  if (status === 429) {
    const parsed = retryAfterHeader ? Number(retryAfterHeader) : NaN;
    const retryAfter = Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined;
    return new MarketDataError(
      TOOL_RESULT_CODES.MARKET_DATA_RATE_LIMITED,
      'Unusual Whales rate limit reached.',
      retryAfter,
    );
  }
  if (status === 404) {
    return new MarketDataError(TOOL_RESULT_CODES.SYMBOL_NOT_FOUND, 'Symbol not found.');
  }
  // 5xx (and any other non-2xx) → transient/unavailable.
  return new MarketDataError(
    TOOL_RESULT_CODES.MARKET_DATA_UNAVAILABLE,
    'Unusual Whales is temporarily unavailable.',
  );
}

/**
 * Construct a per-call UW client bound to one user's key, meter, and cache
 * (design §Component 5). Built per iteration by the loop from the current
 * iteration's key ciphertext (REQ-1.7 rotation); the plaintext `apiKey` lives
 * only inside this closure.
 */
export function createUnusualWhalesClient(deps: UnusualWhalesClientDeps): UnusualWhalesClient {
  const { apiKey, userId, cache, meter } = deps;
  const fetchImpl = deps.fetchImpl ?? fetch;
  const baseUrl = (deps.baseUrl ?? config.UNUSUAL_WHALES_BASE_URL).replace(/\/$/, '');

  async function request(
    method: string,
    path: string,
    query: Record<string, string | number | undefined>,
    schema: z.ZodType,
    emptyCheck: (parsed: { data: unknown }) => boolean,
    toolSignal?: AbortSignal,
  ): Promise<unknown> {
    // Stable args for the cache key + meter decision (REQ-6.7).
    const args: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(query)) {
      if (v !== undefined) args[k] = v;
    }
    const key = cacheKey(method, { path, ...args });

    // Cache hit — return WITHOUT charging the meter (design §Component 5).
    const cached = cache.get(key);
    if (cached.hit) return cached.value;

    // Cache miss — charge the per-user meter (may throw PlatformRateLimitedError).
    meter.charge(userId);

    const url = new URL(`${baseUrl}${path}`);
    for (const [k, v] of Object.entries(query)) {
      if (v !== undefined) url.searchParams.set(k, String(v));
    }

    const { signal, cleanup, didTimeout } = combinedRequestSignal(toolSignal);

    let res: Response;
    try {
      res = await fetchImpl(url.toString(), {
        method: 'GET',
        headers: {
          authorization: `Bearer ${apiKey}`,
          accept: 'application/json',
        },
        signal,
      });
    } catch {
      // Timeout or network failure → MARKET_DATA_UNAVAILABLE (REQ-6.5). A
      // per-tool-signal abort surfaces the same way; the loop already knows it
      // aborted, and the in-flight socket is cancelled either way. The caught
      // error is intentionally NOT surfaced (no provider/network detail leak).
      throw new MarketDataError(
        TOOL_RESULT_CODES.MARKET_DATA_UNAVAILABLE,
        didTimeout() ? 'Unusual Whales request timed out.' : 'Could not reach Unusual Whales.',
      );
    } finally {
      cleanup();
    }

    if (!res.ok) {
      throw statusToError(res.status, res.headers.get('retry-after'));
    }

    let json: unknown;
    try {
      json = await res.json();
    } catch {
      throw new MarketDataError(
        TOOL_RESULT_CODES.MARKET_DATA_UNAVAILABLE,
        'Unusual Whales returned an unreadable response.',
      );
    }

    const result = schema.safeParse(json);
    if (!result.success) {
      throw new MarketDataError(
        TOOL_RESULT_CODES.MARKET_DATA_UNAVAILABLE,
        'Unusual Whales returned an unexpected response.',
      );
    }

    // 200 with an empty payload → SYMBOL_NOT_FOUND (REQ-6.5).
    if (emptyCheck(result.data as { data: unknown })) {
      throw new MarketDataError(TOOL_RESULT_CODES.SYMBOL_NOT_FOUND, 'Symbol not found.');
    }

    cache.set(key, result.data);
    return result.data;
  }

  return {
    // Pinned: GET /api/stock/{ticker}/info (PublicApi.TickerController.info).
    getStockQuote(symbol, signal) {
      return request(
        'getStockQuote',
        `/api/stock/${encodeURIComponent(symbol)}/info`,
        {},
        stockInfoSchema,
        (p) => !p.data || Object.keys(p.data as Record<string, unknown>).length === 0,
        signal,
      );
    },

    // Pinned: GET /api/stock/{ticker}/flow-alerts (PublicApi.TickerController.flow_alerts).
    getOptionsFlow(symbol, limit, signal) {
      return request(
        'getOptionsFlow',
        `/api/stock/${encodeURIComponent(symbol)}/flow-alerts`,
        { limit },
        flowAlertsSchema,
        (p) => !Array.isArray(p.data) || (p.data as unknown[]).length === 0,
        signal,
      );
    },

    // Pinned: GET /api/stock/{ticker}/expiry-breakdown.
    //
    // The cheap expiry index (~2.5 KB): one row per expiry with its contract
    // count. Used to resolve "nearest expiry" and to populate the viewer's
    // expiry picker without pulling any contract rows.
    getExpiryBreakdown(symbol, signal) {
      return request(
        'getExpiryBreakdown',
        `/api/stock/${encodeURIComponent(symbol)}/expiry-breakdown`,
        {},
        expiryBreakdownSchema,
        (p) => !Array.isArray(p.data) || (p.data as unknown[]).length === 0,
        signal,
      );
    },

    // Pinned: GET /api/stock/{ticker}/option-contracts.
    //
    // NOT `option-chains`. That endpoint's `date` parameter is the MARKET day
    // ("symbols present at the given day"), not the expiry — passing a future
    // expiry to it returns an empty envelope, which the empty-check then
    // reports as SYMBOL_NOT_FOUND. `option-contracts` takes a real `expiry`
    // filter, and its rows carry `last_price` and NBBO, which the chain rows
    // do not. One expiry is ~200 KB against ~4.7 MB for a whole greeks chain.
    //
    // `limit` is the endpoint's documented maximum (500). Rows carry
    // `option_symbol` but no strike/type/expiry fields — the projection decodes
    // those from the symbol.
    getOptionContracts(symbol, expiry, signal) {
      return request(
        'getOptionContracts',
        `/api/stock/${encodeURIComponent(symbol)}/option-contracts`,
        { expiry, limit: 500 },
        optionContractsSchema,
        (p) => !Array.isArray(p.data) || (p.data as unknown[]).length === 0,
        signal,
      );
    },
  };
}

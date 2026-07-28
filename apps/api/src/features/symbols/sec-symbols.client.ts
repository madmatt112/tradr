// SEC source client (design v4 — sec-symbols.client, REQ-2.1/2.2/2.5).
//
// The single outbound choke point for symbol population: fetch the SEC
// exchange-annotated ticker file and project it into upsertable `SymbolRow`s.
// The parse/filter/dedup step is a PURE function (`parseSecTickers`) so it is
// unit-testable with no network; `fetchSecSymbols` is the thin IO wrapper.

import { config } from '@/lib/config';
import { logger } from '@/lib/logger';

import type { SymbolRow } from './symbols.types';

/** Exchanges we keep, compared case-insensitively (the file uses mixed case, e.g. `Nasdaq`). */
const KEPT_EXCHANGES = new Set<'NYSE' | 'NASDAQ'>(['NYSE', 'NASDAQ']);

/**
 * The SEC columnar file shape: `{ fields: ["cik","name","ticker","exchange"],
 * data: [[…], …] }`. Typed loosely — we read every column BY its `fields`
 * index, never by a positional assumption.
 */
interface SecTickersFile {
  fields?: unknown;
  data?: unknown;
}

/**
 * Parse + filter + dedup the SEC columnar file into upsertable rows. PURE (no
 * network) so it is unit-tested against a fixture.
 *
 * - Maps each column by its index in `fields` (NOT positional — the order is
 *   read from the file).
 * - Keeps rows whose `exchange`, normalized via `String(x).trim().toUpperCase()`,
 *   is NYSE or NASDAQ; drops null/blank/other (OTC, CBOE, …).
 * - Uppercases the ticker.
 * - Dedups last-wins into a `Map<ticker, SymbolRow>` — MANDATORY (REQ-2.5): a
 *   batched `onConflictDoUpdate` raises SQLSTATE 21000 if a ticker appears
 *   twice in one INSERT.
 */
export function parseSecTickers(json: unknown): SymbolRow[] {
  const file = (json ?? {}) as SecTickersFile;
  const fields = Array.isArray(file.fields) ? file.fields.map((f) => String(f)) : [];
  const rows = Array.isArray(file.data) ? (file.data as unknown[][]) : [];

  const cikIdx = fields.indexOf('cik');
  const nameIdx = fields.indexOf('name');
  const tickerIdx = fields.indexOf('ticker');
  const exchangeIdx = fields.indexOf('exchange');

  const byTicker = new Map<string, SymbolRow>();

  for (const row of rows) {
    if (!Array.isArray(row)) continue;

    const exchange = String(row[exchangeIdx]).trim().toUpperCase();
    if (exchange !== 'NYSE' && exchange !== 'NASDAQ') continue;
    // `exchange` is now narrowed to 'NYSE' | 'NASDAQ'.
    if (!KEPT_EXCHANGES.has(exchange)) continue;

    const ticker = String(row[tickerIdx]).trim().toUpperCase();
    const cikValue = row[cikIdx];
    const cik = typeof cikValue === 'number' ? cikValue : null;

    // Last-wins: a later duplicate ticker overwrites the earlier row.
    byTicker.set(ticker, { ticker, name: String(row[nameIdx]), exchange, cik });
  }

  return [...byTicker.values()];
}

/**
 * Fetch the SEC ticker file and project it. Reads ONLY `config` (never bare
 * `process.env`): the URL seam (`SEC_TICKERS_URL`) and the compliant contact
 * `User-Agent` (`SEC_USER_AGENT`) — SEC 403s a non-compliant agent (REQ-2.2).
 * Throws on a failed fetch; the caller (`syncSymbolsIfStale`) maps that to a
 * `SyncOutcome` error.
 */
export async function fetchSecSymbols(): Promise<SymbolRow[]> {
  const res = await fetch(config.SEC_TICKERS_URL, {
    method: 'GET',
    headers: { 'User-Agent': config.SEC_USER_AGENT },
  });

  if (!res.ok) {
    logger.error('SEC ticker fetch failed', { status: res.status });
    throw new Error(`SEC ticker fetch failed with status ${res.status}`);
  }

  const json: unknown = await res.json();
  return parseSecTickers(json);
}

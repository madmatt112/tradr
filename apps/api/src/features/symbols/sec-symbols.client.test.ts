// Unit tests for the PURE SEC parser (design v4, REQ-2.1/2.2/2.5). NO network:
// `parseSecTickers` is exercised against a hand-built columnar fixture, and
// `fetchSecSymbols` against a stubbed global fetch.

import { afterEach, describe, expect, it, vi } from 'vitest';

import { config } from '@/lib/config';

import { fetchSecSymbols, parseSecTickers } from './sec-symbols.client';

// A deliberately NON-canonical `fields` order (the real SEC file is
// ["cik","name","ticker","exchange"]). Reading by index proves the parser maps
// by `fields`, not by a positional assumption — a positional read of this
// fixture would map every column wrong and drop everything.
const FIELDS = ['exchange', 'ticker', 'name', 'cik'];

// Rows follow FIELDS: [exchange, ticker, name, cik].
const DATA: unknown[][] = [
  ['Nasdaq', 'aapl', 'Apple Inc', 320193], // mixed-case NASDAQ → keep
  ['NYSE', 'brk-b', 'Berkshire Hathaway B', 1067983], // hyphen ticker → keep
  ['nyse', 'ge', 'General Electric', null], // lowercase NYSE + null cik → keep
  ['OTC', 'otcm', 'OTC Markets', 1591588], // other exchange → drop
  ['', 'blnk', 'Blank Exchange', 999], // blank exchange → drop
  ['NASDAQ', 'aapl', 'Apple Inc UPDATED', 320193], // duplicate AAPL → last wins
];

function fixture() {
  return { fields: FIELDS, data: DATA };
}

describe('parseSecTickers', () => {
  it('retains NYSE/NASDAQ case-insensitively and drops other/blank exchanges', () => {
    const tickers = parseSecTickers(fixture()).map((r) => r.ticker);
    // Kept: AAPL (Nasdaq), BRK-B (NYSE), GE (nyse). Dropped: OTCM, BLNK.
    expect(tickers).toContain('AAPL');
    expect(tickers).toContain('BRK-B');
    expect(tickers).toContain('GE');
    expect(tickers).not.toContain('OTCM');
    expect(tickers).not.toContain('BLNK');
  });

  it('uppercases tickers (incl. hyphenated)', () => {
    const rows = parseSecTickers(fixture());
    expect(rows.find((r) => r.ticker === 'BRK-B')).toBeDefined();
    // No lowercase source ticker survives.
    expect(rows.every((r) => r.ticker === r.ticker.toUpperCase())).toBe(true);
  });

  it('maps columns by `fields` index, not positionally', () => {
    const aapl = parseSecTickers(fixture()).find((r) => r.ticker === 'AAPL');
    // If read positionally (cik,name,ticker,exchange), these would all be wrong.
    expect(aapl).toMatchObject({ ticker: 'AAPL', exchange: 'NASDAQ', cik: 320193 });
    const ge = parseSecTickers(fixture()).find((r) => r.ticker === 'GE');
    expect(ge).toMatchObject({ ticker: 'GE', exchange: 'NYSE', cik: null });
  });

  it('canonicalizes the kept exchange to NYSE/NASDAQ', () => {
    const rows = parseSecTickers(fixture());
    expect(rows.every((r) => r.exchange === 'NYSE' || r.exchange === 'NASDAQ')).toBe(true);
  });

  it('dedups last-wins to exactly one row per uppercased ticker (REQ-2.5)', () => {
    const rows = parseSecTickers(fixture());
    const aapls = rows.filter((r) => r.ticker === 'AAPL');
    expect(aapls).toHaveLength(1);
    // Last duplicate wins.
    expect(aapls[0].name).toBe('Apple Inc UPDATED');
    // Three surviving tickers total (AAPL, BRK-B, GE) — no duplicates.
    expect(rows).toHaveLength(3);
    expect(new Set(rows.map((r) => r.ticker)).size).toBe(rows.length);
  });

  it('tolerates a malformed/empty file shape', () => {
    expect(parseSecTickers({})).toEqual([]);
    expect(parseSecTickers(null)).toEqual([]);
    expect(parseSecTickers({ fields: FIELDS, data: 'nope' })).toEqual([]);
  });
});

describe('fetchSecSymbols request headers (REQ-2.2)', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('sends the configured contact User-Agent', async () => {
    const fetchMock = vi.fn(async () =>
      Response.json({ fields: ['cik', 'name', 'ticker', 'exchange'], data: [] }),
    );
    vi.stubGlobal('fetch', fetchMock);

    await fetchSecSymbols();

    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect((init.headers as Record<string, string>)['User-Agent']).toBe(config.SEC_USER_AGENT);
  });

  // The bug this guards: SEC serves a 403 to any User-Agent referencing
  // github.com (verified against the live host). `fetchSecSymbols` then threw,
  // the sync recorded `last_error`, and `symbols` stayed empty — so symbol
  // search returned 200 with no results indefinitely, with nothing in the API
  // response to indicate a failure.
  it('defaults to a contact SEC accepts — never a github.com URL', () => {
    expect(config.SEC_USER_AGENT).not.toMatch(/github\.com/i);
    // A bare name with no contact at all is also rejected.
    expect(config.SEC_USER_AGENT).toMatch(/https?:\/\/|@/);
  });
});

/**
 * Local Unusual Whales (UW) stub server for the e2e suite.
 *
 * The advisor UW client (apps/api/.../unusual-whales.client.ts) is the single
 * outbound choke point for UW calls. In e2e we must NOT hit the live UW host
 * (non-deterministic, requires a real key). Instead the API-under-test is
 * booted with `UNUSUAL_WHALES_BASE_URL` pointed at THIS server, which serves
 * deterministic responses for the three pinned ticker endpoints:
 *
 *   GET /api/stock/{ticker}/info             → stockInfoSchema  `{ data: {...} }`
 *   GET /api/stock/{ticker}/flow-alerts      → flowAlertsSchema `{ data: [...] }`
 *   GET /api/stock/{ticker}/expiry-breakdown → expiryBreakdownSchema `{ data: [...] }`
 *   GET /api/stock/{ticker}/option-contracts → optionContractsSchema `{ data: [...] }`
 *
 * A ticker of `UNKNOWN` yields an empty envelope so e2e can exercise the
 * SYMBOL_NOT_FOUND path; any other ticker yields a non-empty deterministic
 * payload.
 *
 * Used two ways:
 *   1. As a Playwright `webServer` entry — run directly (`tsx uw-stub-server.ts`),
 *      reads `UW_STUB_PORT` from the env and listens.
 *   2. Programmatically — import { startUwStubServer } for ad-hoc control.
 */
import { createServer, type Server } from 'node:http';

// This file runs as a standalone CLI (via tsx / Playwright webServer) outside
// the apps/api boot path, so it reads its port from the env directly. The
// project-wide `process.env` ban does not apply here (same carve-out as
// playwright.config.ts) — there is no `@/lib/config` module in scope.
/* eslint-disable no-restricted-syntax */
const DEFAULT_PORT = 4599;

function deterministicResponse(pathname: string): { status: number; body: unknown } | null {
  // /api/stock/{ticker}/{resource}
  const match =
    /^\/api\/stock\/([^/]+)\/(info|stock-state|flow-alerts|expiry-breakdown|option-contracts)$/.exec(
      pathname,
    );
  if (!match) return null;

  const ticker = decodeURIComponent(match[1]).toUpperCase();
  const resource = match[2];

  // Deterministic SYMBOL_NOT_FOUND path: empty envelope.
  const empty = ticker === 'UNKNOWN';

  if (resource === 'info') {
    return {
      status: 200,
      body: empty
        ? { data: {} }
        : {
            data: {
              ticker,
              company_name: `${ticker} Test Corp`,
              last: '187.32',
              market_cap: '2950000000000',
              sector: 'Technology',
            },
          },
    };
  }

  // stock-state — the last-trade endpoint the quote tool and the chain's ATM
  // anchor both read.
  //
  // Spot is deliberately 192.50, between this stub's 190 and 200 strikes: 175
  // and 190 are then ITM calls, 200 is OTM, and 190 is unambiguously the ATM
  // row. A spot unrelated to the strikes would still render, but would anchor
  // the ladder somewhere meaningless and make the ITM shading untestable.
  if (resource === 'stock-state') {
    return {
      status: 200,
      body: empty
        ? { data: {} }
        : {
            data: {
              close: '192.50',
              open: '191.80',
              high: '193.10',
              low: '191.42',
              prev_close: '191.95',
              volume: 6675723,
              market_time: 'regular',
              tape_time: '2030-06-20T18:00:00Z',
            },
          },
    };
  }

  if (resource === 'flow-alerts') {
    return {
      status: 200,
      body: empty
        ? { data: [] }
        : {
            data: [
              {
                ticker,
                type: 'call',
                strike: '190',
                expiry: '2026-06-19',
                premium: '125000',
                volume: 420,
                open_interest: 1200,
              },
            ],
          },
    };
  }

  // expiry-breakdown — the cheap expiry index the viewer resolves "nearest"
  // from and populates its picker with. Dates are far enough out that they stay
  // tradeable (the API drops expiries already past).
  if (resource === 'expiry-breakdown') {
    return {
      status: 200,
      body: empty
        ? { data: [] }
        : {
            data: [
              { expires: '2030-06-21', open_interest: 1200, volume: 420, chains: 2 },
              { expires: '2030-07-19', open_interest: 900, volume: 310, chains: 2 },
            ],
          },
    };
  }

  // option-contracts — THREE deterministic contracts on the nearest expiry,
  // one per premium-resolution branch:
  //   - Row A carries a `last_price` so the calculator's option hand-off
  //     (symbol-search-quotes Task 14) can assert entry = the traded premium.
  //   - Row B has NO `last_price` but a two-sided quote, exercising the
  //     NBBO-mid fallback: its premium resolves to (4.10 + 4.30) / 2 = 4.20.
  //   - Row C has neither, so no premium resolves and the hand-off falls
  //     through to "enter the premium manually". Before the mid fallback that
  //     was Row B's job; a quoted contract now always yields a premium, so the
  //     manual path needs a contract that is genuinely unpriced.
  //
  // Rows are spelled the way the live endpoint spells them: NO strike / type /
  // expiry fields (the projection decodes those from the OCC symbol) and prices
  // as decimal STRINGS. The previous fixture invented post-projection field
  // names, so it agreed with the client instead of testing it — which is how a
  // response shape the provider never sends stayed green all the way to prod.
  return {
    status: 200,
    body: empty
      ? { data: [] }
      : {
          data: [
            {
              option_symbol: `${ticker}300621C00200000`,
              last_price: '5.25',
              nbbo_bid: '5.10',
              nbbo_ask: '5.30',
              volume: 150,
              open_interest: 400,
            },
            {
              option_symbol: `${ticker}300621C00190000`,
              nbbo_bid: '4.10',
              nbbo_ask: '4.30',
              volume: 320,
              open_interest: 980,
            },
            // Unpriced: no trade, no quote. Strike 175 shares no substring with
            // any other rendered value, so a row filter resolves it uniquely.
            {
              option_symbol: `${ticker}300621C00175000`,
              volume: 0,
              open_interest: 44,
            },
          ],
        },
  };
}

export interface UwStubHandle {
  server: Server;
  port: number;
  url: string;
  close: () => Promise<void>;
}

export function startUwStubServer(port = DEFAULT_PORT): Promise<UwStubHandle> {
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');

    // Health probe used by Playwright `webServer.url` readiness check.
    if (url.pathname === '/__health') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ status: 'ok' }));
      return;
    }

    const result = deterministicResponse(url.pathname);
    if (!result) {
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'not_found', path: url.pathname }));
      return;
    }

    res.writeHead(result.status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(result.body));
  });

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, () => {
      resolve({
        server,
        port,
        url: `http://localhost:${port}`,
        close: () =>
          new Promise<void>((res, rej) => server.close((err) => (err ? rej(err) : res()))),
      });
    });
  });
}

// CLI entrypoint: Playwright `webServer` spawns this file via tsx.
const isMain = import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  const port = Number(process.env.UW_STUB_PORT ?? DEFAULT_PORT);
  startUwStubServer(port)
    .then((handle) => {
      console.log(`[uw-stub] listening on ${handle.url}`);
    })
    .catch((err) => {
      console.error('[uw-stub] failed to start', err);
      process.exit(1);
    });
}
/* eslint-enable no-restricted-syntax */

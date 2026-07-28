/**
 * Local Unusual Whales (UW) stub server for the e2e suite.
 *
 * The advisor UW client (apps/api/.../unusual-whales.client.ts) is the single
 * outbound choke point for UW calls. In e2e we must NOT hit the live UW host
 * (non-deterministic, requires a real key). Instead the API-under-test is
 * booted with `UNUSUAL_WHALES_BASE_URL` pointed at THIS server, which serves
 * deterministic responses for the three pinned ticker endpoints:
 *
 *   GET /api/stock/{ticker}/info          → stockInfoSchema  `{ data: {...} }`
 *   GET /api/stock/{ticker}/flow-alerts   → flowAlertsSchema `{ data: [...] }`
 *   GET /api/stock/{ticker}/option-chains → optionChainsSchema `{ data: [...] }`
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
  const match = /^\/api\/stock\/([^/]+)\/(info|flow-alerts|option-chains)$/.exec(pathname);
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

  // option-chains — TWO deterministic call contracts:
  //   - Row A carries a `last_price` (the premium) so the calculator's option
  //     hand-off (symbol-search-quotes Task 14) can assert entry = premium.
  //   - Row B has NO `last_price` (existing fixture, kept byte-identical) so the
  //     hand-off's "no last trade ⇒ entry blank + manual note" case is covered,
  //     and the advisor-tools spec's `strike 190 / expiry 2026-06-19` assertions
  //     still resolve uniquely (Row A uses a distinct strike/expiry that share no
  //     substring with either).
  return {
    status: 200,
    body: empty
      ? { data: [] }
      : {
          data: [
            {
              ticker,
              option_symbol: `${ticker}260717C00200000`,
              strike: '200',
              expiry: '2026-07-17',
              option_type: 'call',
              last_price: 5.25,
              bid: '5.10',
              ask: '5.30',
              volume: 150,
              open_interest: 400,
            },
            {
              ticker,
              option_symbol: `${ticker}260619C00190000`,
              strike: '190',
              expiry: '2026-06-19',
              option_type: 'call',
              bid: '4.10',
              ask: '4.25',
              volume: 320,
              open_interest: 980,
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

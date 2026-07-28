/**
 * Local delayed-quote provider stub for the e2e suite (symbol-search-quotes,
 * Task 14).
 *
 * The quote client (apps/api/.../stock-quote.client.ts) is the single outbound
 * choke point for delayed last-price lookups. In e2e we must NOT hit the live
 * API Ninjas host (needs a real key, non-deterministic). The API-under-test is
 * booted with `STOCK_QUOTE_BASE_URL` pointed at THIS server (the config seam
 * from Task 2), so the provider call is deterministic. The base URL is set
 * unconditionally; the capability is armed only when `STOCK_QUOTE_API_KEY` is
 * also exported (then `isStockQuoteConfigured()` is true and the pull-quote
 * button appears). When the key is unset the quote handler short-circuits to
 * `{ configured: false }` and never reaches this server.
 *
 *   GET  /v1/stockprice?ticker=X → API-Ninjas-shaped `{ ticker, price }`
 *   GET  /__health               → Playwright webServer readiness probe
 *
 * `price` is a fixed per-ticker value so the calculator entry / disclaimer /
 * sizing assertions are deterministic. An `X-Api-Key` header is required (the
 * client always sends it) — a missing key yields 401, exercising the client's
 * misconfigured mapping if ever hit.
 *
 * Used two ways (uw-stub-server / github-stub-server idiom):
 *   1. As a Playwright `webServer` entry — run directly (`tsx
 *      stock-quote-stub-server.ts`), reads `QUOTE_STUB_PORT` from the env.
 *   2. Programmatically — import { startStockQuoteStubServer } for ad-hoc control.
 */
import { createServer, type Server } from 'node:http';

// Standalone CLI (via tsx / Playwright webServer) outside the apps/api boot
// path — reads its port from the env directly (same carve-out as the other
// stub servers / playwright.config.ts).
/* eslint-disable no-restricted-syntax */
const DEFAULT_PORT = 4603;

// Deterministic delayed prices. AAPL is the ticker the stock-path spec pulls;
// any other known ticker gets a fixed value so a stray lookup is still stable.
const PRICES: Record<string, number> = {
  AAPL: 187.32,
  MSFT: 421.5,
  NVDA: 132.4,
};

function priceFor(ticker: string): number {
  return PRICES[ticker] ?? 100;
}

export interface StockQuoteStubHandle {
  server: Server;
  port: number;
  url: string;
  close: () => Promise<void>;
}

export function startStockQuoteStubServer(port = DEFAULT_PORT): Promise<StockQuoteStubHandle> {
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');

    // Health probe used by Playwright `webServer.url` readiness check.
    if (url.pathname === '/__health') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ status: 'ok' }));
      return;
    }

    if (url.pathname === '/v1/stockprice' && req.method === 'GET') {
      // The client always sends the key; reject a missing one (maps to the
      // client's 401 → QUOTE_PROVIDER_MISCONFIGURED branch).
      if (!req.headers['x-api-key']) {
        res.writeHead(401, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'missing api key' }));
        return;
      }
      const ticker = (url.searchParams.get('ticker') ?? '').toUpperCase();
      if (!ticker) {
        // API Ninjas returns `{}` for an unrecognized ticker — the client maps
        // an empty/no-price 200 to NOT_FOUND.
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({}));
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ticker, price: priceFor(ticker) }));
      return;
    }

    res.writeHead(404, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'not_found', path: url.pathname }));
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
  const port = Number(process.env.QUOTE_STUB_PORT ?? DEFAULT_PORT);
  startStockQuoteStubServer(port)
    .then((handle) => {
      console.log(`[quote-stub] listening on ${handle.url}`);
    })
    .catch((err) => {
      console.error('[quote-stub] failed to start', err);
      process.exit(1);
    });
}
/* eslint-enable no-restricted-syntax */

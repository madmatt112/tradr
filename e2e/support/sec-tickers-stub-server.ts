/**
 * Local SEC company-tickers stub for the e2e suite (symbol-search-quotes,
 * Task 14).
 *
 * The symbol-population SEC client (apps/api/.../sec-symbols.client.ts) is the
 * single outbound choke point for the exchange-annotated ticker file. In e2e we
 * must NEVER hit the live `https://www.sec.gov/...` host: it is
 * non-deterministic, rate-limited, and 403s a non-compliant User-Agent (the
 * exact REQ-2.2/REQ-2.4(c) hazard). The e2e API boots `NODE_ENV=development`, so
 * Task 9's bootstrap `void syncSymbolsIfStale()` is NOT a test no-op — it fires
 * on every boot. Pointing `SEC_TICKERS_URL` at THIS server (the config seam from
 * Task 2, set UNCONDITIONALLY in playwright.config.ts's apiEnv) redirects that
 * fetch to a deterministic local fixture so no e2e boot ever touches live SEC.
 *
 *   GET  <any path>            → the columnar `{ fields, data }` fixture
 *   GET  /__health             → Playwright webServer readiness probe
 *   POST /__mode {"mode":...}  → failure toggle ("ok" | "fail")
 *
 * In `fail` mode the ticker route returns 403 — reproducing the SEC non-compliant
 * -agent rejection — so the graceful-absence scenario can drive an admin refresh
 * against a down source and prove the sync fails softly (no crash, /search still
 * serves; REQ-2.3). Boot mode is always `ok` so bootstrap population succeeds and
 * the autocomplete has rows.
 *
 * Fixture shape mirrors the live SEC file: a columnar `{ fields, data }` object.
 * `fields` order is deliberately NOT the storage order — the client maps every
 * column by its `fields` index (never positionally). Rows include mixed-case
 * exchanges (`Nasdaq`/`NYSE`), a hyphen ticker (`BRK-B`), and OTC/blank rows the
 * client's case-insensitive NYSE/NASDAQ filter must drop.
 *
 * Used two ways (uw-stub-server / github-stub-server idiom):
 *   1. As a Playwright `webServer` entry — run directly (`tsx
 *      sec-tickers-stub-server.ts`), reads `SEC_STUB_PORT` from the env.
 *   2. Programmatically — import { startSecTickersStubServer } for ad-hoc control.
 */
import { createServer, type Server } from 'node:http';

// This file runs as a standalone CLI (via tsx / Playwright webServer) outside
// the apps/api boot path, so it reads its port from the env directly. The
// project-wide `process.env` ban does not apply here (same carve-out as
// uw-stub-server.ts / github-stub-server.ts / playwright.config.ts).
/* eslint-disable no-restricted-syntax */
const DEFAULT_PORT = 4602;

type StubMode = 'ok' | 'fail';

// Columnar SEC file. `fields` order (name, cik, exchange, ticker) is scrambled
// on purpose so the client's fields-index mapping is exercised, not a positional
// assumption. Kept rows: NYSE/NASDAQ (case-insensitive). Dropped rows: OTC, blank.
const FIXTURE = {
  fields: ['name', 'cik', 'exchange', 'ticker'],
  data: [
    ['Apple Inc.', 320193, 'Nasdaq', 'AAPL'],
    ['Microsoft Corporation', 789019, 'Nasdaq', 'MSFT'],
    ['NVIDIA Corporation', 1045810, 'Nasdaq', 'NVDA'],
    ['American Airlines Group Inc.', 6201, 'Nasdaq', 'AAL'],
    ['Alcoa Corporation', 1675149, 'NYSE', 'AA'],
    ['Berkshire Hathaway Inc. Class B', 1067983, 'NYSE', 'BRK-B'],
    // Dropped by the NYSE/NASDAQ filter — proves the filter is load-bearing.
    ['OTC Example Corp', 111111, 'OTC', 'OTCX'],
    ['Blank Exchange Corp', 222222, '', 'BLNK'],
  ],
};

function readBody(req: import('node:http').IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (chunk: Buffer) => {
      data += chunk.toString('utf8');
    });
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

export interface SecTickersStubHandle {
  server: Server;
  port: number;
  url: string;
  close: () => Promise<void>;
}

export function startSecTickersStubServer(port = DEFAULT_PORT): Promise<SecTickersStubHandle> {
  // Mutable failure toggle — e2e flips it via POST /__mode to prove the
  // graceful-absence path (SEC 403 ⇒ soft sync failure, no crash).
  let mode: StubMode = 'ok';

  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');

    // Health probe used by Playwright `webServer.url` readiness check.
    if (url.pathname === '/__health') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ status: 'ok', mode }));
      return;
    }

    if (url.pathname === '/__mode' && req.method === 'POST') {
      void readBody(req)
        .then((raw) => {
          let next: unknown;
          try {
            next = (JSON.parse(raw) as { mode?: unknown }).mode;
          } catch {
            next = undefined;
          }
          if (next !== 'ok' && next !== 'fail') {
            res.writeHead(400, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ error: 'mode must be "ok" or "fail"' }));
            return;
          }
          mode = next;
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ mode }));
        })
        .catch(() => {
          res.writeHead(500, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: 'body read failed' }));
        });
      return;
    }

    if (req.method === 'GET') {
      // Reproduce the live SEC 403-on-non-compliant-agent rejection when armed
      // to fail (REQ-2.2) so the graceful-absence path can be driven.
      if (mode === 'fail') {
        res.writeHead(403, { 'content-type': 'text/plain' });
        res.end('Forbidden');
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(FIXTURE));
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
  const port = Number(process.env.SEC_STUB_PORT ?? DEFAULT_PORT);
  startSecTickersStubServer(port)
    .then((handle) => {
      console.log(`[sec-stub] listening on ${handle.url}`);
    })
    .catch((err) => {
      console.error('[sec-stub] failed to start', err);
      process.exit(1);
    });
}
/* eslint-enable no-restricted-syntax */

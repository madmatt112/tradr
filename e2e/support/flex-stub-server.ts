/**
 * Local IBKR Flex Web Service stub for the e2e suite (ibkr-flex-import, Task 14).
 *
 * `fetchFlexReport` (apps/api/.../flex.client.ts) is the single outbound
 * choke point for the SendRequest + GetStatement two-step. In e2e we must
 * NEVER hit the live `ndcdyn.interactivebrokers.com` host — there is no live
 * token, and the wire is non-deterministic. `IBKR_FLEX_BASE_URL` is set
 * UNCONDITIONALLY to this server in playwright.config.ts's apiEnv, so no boot
 * or fetch ever reaches IBKR.
 *
 * Serves the checked wire (.spec-workflow/specs/ibkr-flex-import/wire-check.md
 * W1, W2):
 *
 *   GET /AccountManagement/FlexWebService/SendRequest?t=&q=&v=3
 *     → a `FlexStatementResponse` envelope. A request whose token is
 *       `BAD_TOKEN` answers Fail/1012 ("Token has expired", W3) regardless of
 *       the query id — the token-rejected path. Every other token answers
 *       Success, echoing the query id back as the reference code (this stub
 *       owns both ends, so there is no need for a second opaque identifier).
 *   GET /AccountManagement/FlexWebService/GetStatement?t=&q=&v=3
 *     → the report body registered for that reference code (immediately —
 *       this stub never answers "in progress"; the poll-until-ready path is
 *       covered by flex.client.test.ts). An unregistered id answers Fail with
 *       an error code the design maps to `other` (unavailable), so a typo
 *       never hangs a test waiting for a poll that will not arrive.
 *   GET  /__health → Playwright webServer readiness probe.
 *
 * Each report body carries the fixed `ClientAccountID` column `proveSingleAccount`
 * (flex-report.ts) requires, with every row holding the same value — the
 * "second connection/second account" and "repeat fetch/partial overlap"
 * scenarios are picked by query id, below.
 *
 * Used two ways (uw-stub-server / stock-quote-stub-server idiom):
 *   1. As a Playwright `webServer` entry — run directly (`tsx
 *      flex-stub-server.ts`), reads `FLEX_STUB_PORT` from the env.
 *   2. Programmatically — import { startFlexStubServer } for ad-hoc control.
 */
import { createServer, type Server } from 'node:http';

// Standalone CLI (via tsx / Playwright webServer) outside the apps/api boot
// path — reads its port from the env directly (same carve-out as the other
// stub servers / playwright.config.ts).
/* eslint-disable no-restricted-syntax */
const DEFAULT_PORT = 4606;

/** A token that always draws the token-rejected envelope (1012), any query id. */
export const BAD_TOKEN = 'e2e-flex-bad-token-9999999';
/** Any other token is accepted — the stub does not otherwise check it. */
export const GOOD_TOKEN = 'e2e-flex-good-token-1111111';

export const QID_HAPPY = 'qid-happy-a1';
export const QID_SECOND = 'qid-second-b1';
export const QID_REPEAT = 'qid-repeat-c1';
export const QID_PARTIAL_1 = 'qid-partial-1-d1';
export const QID_PARTIAL_2 = 'qid-partial-2-d1';

/**
 * One Flex Trades row, in the shape the `interactive-brokers` preset maps
 * (ibkr.service.ts `buildFlexPreviewRequest`), plus the `ClientAccountID`
 * column the flex-only account-proof reads. Mirrors
 * e2e/tests/fixtures/csv-import/ibkr-execution.csv's row shape exactly, with
 * `ClientAccountID` appended as a 16th column.
 */
function flexRow(
  clientAccountId: string,
  symbol: string,
  action: 'BUY' | 'SELL',
  quantity: number,
  price: string,
  fee: string,
  dateTime: string,
): string {
  const indicator = action === 'BUY' ? 'O' : 'C';
  return [
    symbol,
    '',
    '',
    '',
    '',
    '',
    '1',
    'STK',
    action,
    indicator,
    String(quantity),
    price,
    fee,
    `"${dateTime}"`,
    '',
    clientAccountId,
  ].join(',');
}

const FLEX_HEADER =
  'Symbol,Description,UnderlyingSymbol,Strike,Expiry,Put/Call,Multiplier,AssetClass,Buy/Sell,Open/CloseIndicator,Quantity,TradePrice,IBCommission,DateTime,Notes/Codes,ClientAccountID';

function flexReport(rows: string[]): string {
  return [FLEX_HEADER, ...rows].join('\n') + '\n';
}

// Happy path (Req 9.1 "a fetch previews and commits"): one closed AAPL round
// trip, same prices as ibkr-execution.csv → $158.00 net.
const REPORT_HAPPY = flexReport([
  flexRow('U1000001', 'AAPL', 'BUY', 100, '121.50', '-1.00', '2026-01-05;09:30:00'),
  flexRow('U1000001', 'AAPL', 'SELL', -100, '123.10', '-1.00', '2026-01-05;15:55:00'),
]);

// Second connection / second account: a different symbol, different account,
// same shape as the tradezella scenario's numbers → $498.00 net.
const REPORT_SECOND = flexReport([
  flexRow('U1000002', 'MSFT', 'BUY', 50, '400.00', '-1.00', '2026-02-10;09:30:00'),
  flexRow('U1000002', 'MSFT', 'SELL', -50, '410.00', '-1.00', '2026-02-10;15:30:00'),
]);

// Repeat fetch of one period: fetched and committed once, then fetched again
// unchanged → 100% overlap trips the duplicate gate.
const REPORT_REPEAT = flexReport([
  flexRow('U1000003', 'AAPL', 'BUY', 100, '121.50', '-1.00', '2026-03-01;09:30:00'),
  flexRow('U1000003', 'AAPL', 'SELL', -100, '123.10', '-1.00', '2026-03-01;15:55:00'),
]);

// Partial overlap pair: PARTIAL_1 is the baseline fetch; PARTIAL_2 repeats its
// first row exactly and adds two unrelated MSFT fills — 1 of 3 incoming fills
// match (33%), below the 90% block ratio but still > 0, so the flex-only
// `gateAnyOverlap` still gates it (csv-import.service.ts `scanDuplicates`).
const REPORT_PARTIAL_1 = flexReport([
  flexRow('U1000004', 'AAPL', 'BUY', 100, '121.50', '-1.00', '2026-04-01;09:30:00'),
  flexRow('U1000004', 'AAPL', 'SELL', -100, '123.10', '-1.00', '2026-04-01;15:55:00'),
]);
const REPORT_PARTIAL_2 = flexReport([
  flexRow('U1000004', 'AAPL', 'BUY', 100, '121.50', '-1.00', '2026-04-01;09:30:00'),
  flexRow('U1000004', 'MSFT', 'BUY', 50, '400.00', '-1.00', '2026-04-02;09:30:00'),
  flexRow('U1000004', 'MSFT', 'SELL', -50, '410.00', '-1.00', '2026-04-02;15:30:00'),
]);

const REPORTS: Record<string, string> = {
  [QID_HAPPY]: REPORT_HAPPY,
  [QID_SECOND]: REPORT_SECOND,
  [QID_REPEAT]: REPORT_REPEAT,
  [QID_PARTIAL_1]: REPORT_PARTIAL_1,
  [QID_PARTIAL_2]: REPORT_PARTIAL_2,
};

function envelope(opts: { referenceCode?: string; errorCode?: number }): string {
  const parts = ['<FlexStatementResponse timestamp="now">'];
  parts.push(`<Status>${opts.referenceCode ? 'Success' : 'Fail'}</Status>`);
  if (opts.referenceCode) parts.push(`<ReferenceCode>${opts.referenceCode}</ReferenceCode>`);
  if (opts.errorCode !== undefined) parts.push(`<ErrorCode>${opts.errorCode}</ErrorCode>`);
  parts.push('</FlexStatementResponse>');
  return parts.join('');
}

export interface FlexStubHandle {
  server: Server;
  port: number;
  url: string;
  close: () => Promise<void>;
}

export function startFlexStubServer(port = DEFAULT_PORT): Promise<FlexStubHandle> {
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');

    // Health probe used by Playwright `webServer.url` readiness check.
    if (url.pathname === '/__health') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ status: 'ok' }));
      return;
    }

    if (url.pathname === '/AccountManagement/FlexWebService/SendRequest' && req.method === 'GET') {
      const token = url.searchParams.get('t') ?? '';
      const queryId = url.searchParams.get('q') ?? '';
      if (token === BAD_TOKEN) {
        // 1012 "Token has expired" — one of W3's token-error codes, maps to
        // the client's token-rejected path (Req 4.1 "a bad token shows its
        // message naming Settings").
        res.writeHead(200, { 'content-type': 'text/xml' });
        res.end(envelope({ errorCode: 1012 }));
        return;
      }
      // Echo the query id back as the reference code: this stub answers both
      // SendRequest and GetStatement, so there is no need for a second
      // opaque identifier — GetStatement's `q` looks the report up the same way.
      res.writeHead(200, { 'content-type': 'text/xml' });
      res.end(envelope({ referenceCode: queryId }));
      return;
    }

    if (url.pathname === '/AccountManagement/FlexWebService/GetStatement' && req.method === 'GET') {
      const referenceCode = url.searchParams.get('q') ?? '';
      const report = REPORTS[referenceCode];
      if (report === undefined) {
        // Unregistered id: answer an envelope error that maps to `other`
        // (unavailable) rather than `in-progress`, so a typo never hangs a
        // test waiting on a poll that will not arrive.
        res.writeHead(200, { 'content-type': 'text/xml' });
        res.end(envelope({ errorCode: 9999 }));
        return;
      }
      res.writeHead(200, { 'content-type': 'text/csv' });
      res.end(report);
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
  const port = Number(process.env.FLEX_STUB_PORT ?? DEFAULT_PORT);
  startFlexStubServer(port)
    .then((handle) => {
      console.log(`[flex-stub] listening on ${handle.url}`);
    })
    .catch((err) => {
      console.error('[flex-stub] failed to start', err);
      process.exit(1);
    });
}
/* eslint-enable no-restricted-syntax */

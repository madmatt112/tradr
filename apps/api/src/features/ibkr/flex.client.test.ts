// Unit tests for the Flex client (design C4, Req 2.2/2.6/4.1/4.3/5.2/6.3,
// NFR Performance/Security/Reliability). `fetchFlexReport` is exercised only
// through its injected `fetchImpl`/`sleep`/`now`/`budgetMs` seam — no real
// network call, no real polling delay.
//
// Contract block (one row per success criterion):
//
// T1  polls through a report
//     Pre: SendRequest answers an envelope with a referenceCode; the first
//          GetStatement poll answers an in-progress envelope; the second
//          answers the report bytes.
//     Call: fetchFlexReport({ token, queryId }, { fetchImpl, sleep, now })
//     Result: resolves to the report's own bytes; 3 fetchImpl calls.
//     Source: design C4 post-conditions + TD2 poll rule (task text).
//
// T2  budget ends while polling / at most six calls (folded, same scenario)
//     Pre: SendRequest succeeds; every GetStatement answers in-progress.
//     Call: fetchFlexReport(..., { fetchImpl, sleep, now }) with a
//           controlled virtual clock and the default budget.
//     Result: rejects IBKR_FLEX_NOT_READY/503; exactly 6 fetchImpl calls.
//     Source: design C4 ("at most six calls"); Error Handling row 3.
//
// T3  abort during a stalled body read ends the call
//     Pre: SendRequest's own response body stalls after one chunk.
//     Call: fetchFlexReport(..., { fetchImpl, budgetMs: 30 }), real timers.
//     Result: settles (does not hang) and rejects IBKR_FLEX_UNAVAILABLE/503.
//     Source: design C4 Probe ("abort ... rejects a pending body read");
//              Error Handling row 5 ("unreadable body").
//
// T4  an envelope naming another host draws no request to it
//     Pre: SendRequest's envelope carries a referenceCode plus a <Url> tag
//          pointing at an attacker host.
//     Call: fetchFlexReport(..., { fetchImpl, sleep, now })
//     Result: the GetStatement call targets config's own host/path only;
//              no call ever names the attacker host.
//     Source: design C4 ("Any URL in a response body is ignored"); Req 6.3.
//
// T5  an http non-local base sends nothing, gives the unavailable code
//     Pre: config.IBKR_FLEX_BASE_URL is `http://example.com`.
//     Call: fetchFlexReport({ token, queryId }, { fetchImpl })
//     Result: fetchImpl never called; rejects IBKR_FLEX_UNAVAILABLE/503.
//     Source: design C4 ("must be https:, or have host localhost or
//              127.0.0.1 ... throws the unavailable code and sends
//              nothing").
//
// T6  an https base and a http://localhost base both send
//     Pre: config.IBKR_FLEX_BASE_URL is, in turn, an https host and
//          `http://localhost:4610`.
//     Call: fetchFlexReport(..., { fetchImpl, sleep, now }) full happy path.
//     Result: fetchImpl is called (the fetch is not refused).
//     Source: design C4, same sentence as T5.
//
// T7  an over-cap body gives 413 PAYLOAD_TOO_LARGE
//     Pre: config.CSV_IMPORT_MAX_FILE_BYTES is lowered; SendRequest answers
//          a body bigger than the cap.
//     Call: fetchFlexReport({ token, queryId }, { fetchImpl })
//     Result: rejects with statusCode 413, code PAYLOAD_TOO_LARGE — the
//              same shape `readBodyCapped` throws, unchanged.
//     Source: csv-import.upload.ts:35-77 `readBodyCapped`; Req 2.6.
//
// T8  a failed SendRequest makes one call only
//     Pre: SendRequest answers a token-rejected error envelope.
//     Call: fetchFlexReport({ token, queryId }, { fetchImpl, sleep, now })
//     Result: rejects IBKR_FLEX_TOKEN_REJECTED/400; exactly 1 fetchImpl call.
//     Source: design C4 ("A failed SendRequest is terminal"); Reliability NFR.
//
// T9  every code in Error Handling rows 1-5 and 7 is asserted with its status
//     Pre/Call: one case per row trigger (it.each table below).
//     Result: the stated code and HTTP status.
//     Source: design.md "Error Handling" table, rows 1-5 and 7; flex-wire.ts
//              error-kind sets; wire-check.md W3 (code 1025 falls to "other").
//
// T10 the caught error object and the IBKR error text appear in no
//     thrown message
//     Pre: a transport failure with a sentinel message, and an envelope
//          whose (unparsed) ErrorMessage text carries a sentinel string.
//     Call: fetchFlexReport({ token, queryId }, { fetchImpl, sleep, now })
//     Result: the rejected error's message contains neither sentinel.
//     Source: Req 4.3, 5.2; design C4 ("the caught object is never
//              surfaced").
//
// T11 each request sends the User-Agent design C4 gives
//     Pre: a full SendRequest + GetStatement happy path.
//     Call: fetchFlexReport(..., { fetchImpl, sleep, now })
//     Result: both fetchImpl calls carry `User-Agent: tradr-flex-import`.
//     Source: design C4 ("It sets a User-Agent of tradr-flex-import").
//
// T12 a token holding reserved characters is percent-encoded in the URL
//     Pre: a token containing `+ / & = space ? #`.
//     Call: fetchFlexReport({ token, queryId }, { fetchImpl, sleep, now })
//     Result: both request URLs carry `t=<encodeURIComponent(token)>`.
//     Source: design C4 ("passed through encodeURIComponent").

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { FLEX_GET_PATH, FLEX_SEND_PATH } from './flex-wire';
import { fetchFlexReport } from './flex.client';

const mockConfig = vi.hoisted(() => ({
  IBKR_FLEX_BASE_URL: 'https://ndcdyn.interactivebrokers.com',
  CSV_IMPORT_MAX_FILE_BYTES: 10_485_760,
}));
vi.mock('@/lib/config', () => ({ config: mockConfig }));

const ENCODER = new TextEncoder();

function bytesOf(text: string): Uint8Array {
  return ENCODER.encode(text);
}

function streamOf(bytes: Uint8Array): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    },
  });
}

/** Enqueues one chunk, then never closes — until `signal` aborts the read. */
function stalledStreamAfterOneChunk(signal: AbortSignal | undefined): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      controller.enqueue(bytesOf('partial-headers-only'));
      signal?.addEventListener('abort', () => {
        controller.error(new Error('stalled body aborted'));
      });
    },
  });
}

function httpResponse(init: { status: number; ok?: boolean; bytes?: Uint8Array }): Response {
  return {
    ok: init.ok ?? (init.status >= 200 && init.status < 300),
    status: init.status,
    body: streamOf(init.bytes ?? bytesOf('')),
  } as unknown as Response;
}

function envelopeResponse(opts: {
  referenceCode?: string;
  errorCode?: number;
  extra?: string;
}): Response {
  const parts = ['<FlexStatementResponse timestamp="now">'];
  parts.push(`<Status>${opts.referenceCode ? 'Success' : 'Fail'}</Status>`);
  if (opts.referenceCode) parts.push(`<ReferenceCode>${opts.referenceCode}</ReferenceCode>`);
  if (opts.errorCode !== undefined) parts.push(`<ErrorCode>${opts.errorCode}</ErrorCode>`);
  if (opts.extra) parts.push(opts.extra);
  parts.push('</FlexStatementResponse>');
  return httpResponse({ status: 200, bytes: bytesOf(parts.join('')) });
}

function reportResponse(content: string): Response {
  return httpResponse({ status: 200, bytes: bytesOf(content) });
}

function xmlReportResponse(): Response {
  return httpResponse({
    status: 200,
    bytes: bytesOf('<FlexQueryResponse><FlexStatements/></FlexQueryResponse>'),
  });
}

/** Sleep/now that never advances the budget clock — happy-path tests run instantly. */
function instantClock() {
  return { sleep: vi.fn(async () => {}), now: () => 0 };
}

function fetchImplOf(...responses: Response[]): ReturnType<typeof vi.fn> {
  const mock = vi.fn();
  for (const res of responses) mock.mockResolvedValueOnce(res);
  return mock;
}

const CREDS = { token: 'test-token', queryId: 'q-1' };

beforeEach(() => {
  mockConfig.IBKR_FLEX_BASE_URL = 'https://ndcdyn.interactivebrokers.com';
  mockConfig.CSV_IMPORT_MAX_FILE_BYTES = 10_485_760;
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('fetchFlexReport — polling to a report (T1)', () => {
  it('polls through an in-progress GetStatement to the report bytes', async () => {
    const report = 'ClientAccountID,Symbol\nU1234567,AAPL\n';
    const fetchImpl = fetchImplOf(
      envelopeResponse({ referenceCode: 'REF-1' }),
      envelopeResponse({ errorCode: 1001 }), // in-progress
      reportResponse(report),
    ) as unknown as typeof fetch;

    const result = await fetchFlexReport(CREDS, {
      fetchImpl,
      ...instantClock(),
    });

    expect(new TextDecoder().decode(result)).toBe(report);
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });
});

describe('fetchFlexReport — budget exhaustion while polling (T2, folds S9)', () => {
  it('stops after at most six calls and rejects IBKR_FLEX_NOT_READY/503', async () => {
    let clock = 0;
    const sleep = vi.fn(async (ms: number) => {
      clock += ms;
    });
    const now = () => clock;

    // The first call (SendRequest) succeeds; every GetStatement poll after
    // it answers in-progress forever, so only the budget ends the loop.
    const fetchImpl = vi.fn(async () => {
      if (fetchImpl.mock.calls.length === 1) return envelopeResponse({ referenceCode: 'REF-1' });
      return envelopeResponse({ errorCode: 1001 });
    });

    await expect(
      fetchFlexReport(CREDS, { fetchImpl: fetchImpl as unknown as typeof fetch, sleep, now }),
    ).rejects.toMatchObject({ statusCode: 503, code: 'IBKR_FLEX_NOT_READY' });

    expect(fetchImpl).toHaveBeenCalledTimes(6);
  });
});

describe('fetchFlexReport — stalled body read is bounded by the budget (T3)', () => {
  it('ends the call instead of hanging, with IBKR_FLEX_UNAVAILABLE/503', async () => {
    const fetchImpl = vi.fn(
      async (_url: string, opts?: { signal?: AbortSignal }) =>
        ({
          ok: true,
          status: 200,
          body: stalledStreamAfterOneChunk(opts?.signal),
        }) as unknown as Response,
    ) as unknown as typeof fetch;

    await expect(fetchFlexReport(CREDS, { fetchImpl, budgetMs: 30 })).rejects.toMatchObject({
      statusCode: 503,
      code: 'IBKR_FLEX_UNAVAILABLE',
    });
  }, 2000);
});

describe('fetchFlexReport — ignores a hostile URL in the envelope body (T4)', () => {
  it('sends GetStatement only to the configured host and path', async () => {
    const report = 'ClientAccountID,Symbol\nU1234567,AAPL\n';
    const fetchImpl = fetchImplOf(
      envelopeResponse({
        referenceCode: 'REF-1',
        extra: '<Url>http://evil.example.com/malicious</Url>',
      }),
      reportResponse(report),
    ) as unknown as typeof fetch;

    await fetchFlexReport(CREDS, { fetchImpl, ...instantClock() });

    expect(fetchImpl).toHaveBeenCalledTimes(2);
    const mock = fetchImpl as unknown as ReturnType<typeof vi.fn>;
    for (const call of mock.mock.calls) {
      expect(String(call[0])).not.toContain('evil.example.com');
    }
    expect(String(mock.mock.calls[1][0])).toContain(
      `${mockConfig.IBKR_FLEX_BASE_URL}${FLEX_GET_PATH}`,
    );
  });
});

describe('fetchFlexReport — base URL scheme/host gate (T5, T6)', () => {
  it('an http non-local base sends nothing and gives IBKR_FLEX_UNAVAILABLE/503', async () => {
    mockConfig.IBKR_FLEX_BASE_URL = 'http://example.com';
    const fetchImpl = vi.fn(async () => {
      throw new Error('must not be called');
    }) as unknown as typeof fetch;

    await expect(fetchFlexReport(CREDS, { fetchImpl })).rejects.toMatchObject({
      statusCode: 503,
      code: 'IBKR_FLEX_UNAVAILABLE',
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it.each([
    ['https host', 'https://ndcdyn.interactivebrokers.com'],
    ['http://localhost', 'http://localhost:4610'],
  ])('an %s base sends the request', async (_label, base) => {
    mockConfig.IBKR_FLEX_BASE_URL = base;
    const report = 'ClientAccountID,Symbol\nU1234567,AAPL\n';
    const fetchImpl = fetchImplOf(
      envelopeResponse({ referenceCode: 'REF-1' }),
      reportResponse(report),
    ) as unknown as typeof fetch;

    await fetchFlexReport(CREDS, { fetchImpl, ...instantClock() });

    expect(fetchImpl).toHaveBeenCalled();
  });
});

describe('fetchFlexReport — over-cap body (T7, Req 2.6)', () => {
  it('gives 413 PAYLOAD_TOO_LARGE, unchanged from readBodyCapped', async () => {
    mockConfig.CSV_IMPORT_MAX_FILE_BYTES = 10;
    const fetchImpl = fetchImplOf(
      httpResponse({ status: 200, bytes: bytesOf('x'.repeat(11)) }),
    ) as unknown as typeof fetch;

    await expect(fetchFlexReport(CREDS, { fetchImpl })).rejects.toMatchObject({
      statusCode: 413,
      code: 'PAYLOAD_TOO_LARGE',
    });
  });
});

describe('fetchFlexReport — a failed SendRequest is terminal (T8)', () => {
  it('rejects IBKR_FLEX_TOKEN_REJECTED/400 with exactly one fetchImpl call', async () => {
    const fetchImpl = fetchImplOf(
      envelopeResponse({ errorCode: 1011 }), // token kind
    ) as unknown as typeof fetch;

    await expect(fetchFlexReport(CREDS, { fetchImpl, ...instantClock() })).rejects.toMatchObject({
      statusCode: 400,
      code: 'IBKR_FLEX_TOKEN_REJECTED',
    });

    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});

describe('fetchFlexReport — Error Handling rows 1-5 and 7 (T9, S11)', () => {
  it.each([
    ['query rejected', [envelopeResponse({ errorCode: 1010 })], 'IBKR_FLEX_QUERY_REJECTED', 400, 1],
    ['rate kind', [envelopeResponse({ errorCode: 1018 })], 'IBKR_FLEX_RATE_LIMITED', 429, 1],
    ['raw HTTP 429', [httpResponse({ status: 429 })], 'IBKR_FLEX_RATE_LIMITED', 429, 1],
    [
      'in-progress on SendRequest',
      [envelopeResponse({ errorCode: 1001 })],
      'IBKR_FLEX_NOT_READY',
      503,
      1,
    ],
    [
      'other kind (1025, wire-check W3)',
      [envelopeResponse({ errorCode: 1025 })],
      'IBKR_FLEX_UNAVAILABLE',
      503,
      1,
    ],
    ['non-2xx', [httpResponse({ status: 500 })], 'IBKR_FLEX_UNAVAILABLE', 503, 1],
    [
      'xml-report',
      [envelopeResponse({ referenceCode: 'REF-1' }), xmlReportResponse()],
      'IBKR_FLEX_FORMAT_UNSUPPORTED',
      422,
      2,
    ],
  ] as const)('%s → %s / %d', async (_label, responses, code, status, calls) => {
    const fetchImpl = fetchImplOf(...responses) as unknown as typeof fetch;

    await expect(fetchFlexReport(CREDS, { fetchImpl, ...instantClock() })).rejects.toMatchObject({
      statusCode: status,
      code,
    });

    expect(fetchImpl).toHaveBeenCalledTimes(calls);
  });

  it('transport failure → IBKR_FLEX_UNAVAILABLE/503', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error('network down');
    }) as unknown as typeof fetch;

    await expect(fetchFlexReport(CREDS, { fetchImpl, ...instantClock() })).rejects.toMatchObject({
      statusCode: 503,
      code: 'IBKR_FLEX_UNAVAILABLE',
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});

describe('fetchFlexReport — never surfaces the caught error or IBKR text (T10, Req 4.3/5.2)', () => {
  it('a transport error message never reaches the thrown message', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error('SENTINEL_TRANSPORT_DETAIL_9f3a');
    }) as unknown as typeof fetch;

    const err = await fetchFlexReport(CREDS, { fetchImpl, ...instantClock() }).catch(
      (e: unknown) => e,
    );

    expect((err as Error).message).not.toContain('SENTINEL_TRANSPORT_DETAIL_9f3a');
  });

  it("IBKR's envelope error text never reaches the thrown message", async () => {
    const fetchImpl = fetchImplOf(
      envelopeResponse({
        errorCode: 1010,
        extra: '<ErrorMessage>SENTINEL_IBKR_TEXT_7c1b</ErrorMessage>',
      }),
    ) as unknown as typeof fetch;

    const err = await fetchFlexReport(CREDS, { fetchImpl, ...instantClock() }).catch(
      (e: unknown) => e,
    );

    expect((err as Error).message).not.toContain('SENTINEL_IBKR_TEXT_7c1b');
  });
});

describe('fetchFlexReport — User-Agent (T11)', () => {
  it('sends tradr-flex-import on every request', async () => {
    const report = 'ClientAccountID,Symbol\nU1234567,AAPL\n';
    const fetchImpl = fetchImplOf(
      envelopeResponse({ referenceCode: 'REF-1' }),
      reportResponse(report),
    ) as unknown as ReturnType<typeof vi.fn>;

    await fetchFlexReport(CREDS, {
      fetchImpl: fetchImpl as unknown as typeof fetch,
      ...instantClock(),
    });

    expect(fetchImpl).toHaveBeenCalledTimes(2);
    for (const call of fetchImpl.mock.calls) {
      expect(call[1]).toMatchObject({
        headers: expect.objectContaining({ 'User-Agent': 'tradr-flex-import' }),
      });
    }
  });
});

describe('fetchFlexReport — token percent-encoding (T12)', () => {
  it('percent-encodes a token with reserved characters on every request', async () => {
    const token = 'ab+c/d&e=f g?h#i';
    const report = 'ClientAccountID,Symbol\nU1234567,AAPL\n';
    const fetchImpl = fetchImplOf(
      envelopeResponse({ referenceCode: 'REF-1' }),
      reportResponse(report),
    ) as unknown as ReturnType<typeof vi.fn>;

    await fetchFlexReport(
      { token, queryId: CREDS.queryId },
      { fetchImpl: fetchImpl as unknown as typeof fetch, ...instantClock() },
    );

    expect(fetchImpl).toHaveBeenCalledTimes(2);
    const encoded = encodeURIComponent(token);
    for (const call of fetchImpl.mock.calls) {
      expect(String(call[0])).toContain(`t=${encoded}`);
    }
    expect(String(fetchImpl.mock.calls[0][0])).toContain(FLEX_SEND_PATH);
  });
});

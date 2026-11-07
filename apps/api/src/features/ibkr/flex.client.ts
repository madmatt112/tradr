// IBKR Flex Web Service client (design C4): the outbound SendRequest +
// GetStatement two-step with polling, inside one budget. All wire knowledge
// (paths, envelope parsing, error-code classification) lives in flex-wire.ts;
// this file only sequences the calls and maps outcomes to Tradr's own codes.

import { readBodyCapped } from '@/features/csv-import/csv-import.upload';
import { config } from '@/lib/config';
import { AppError } from '@/lib/errors';

import {
  FLEX_API_VERSION,
  FLEX_GET_PATH,
  FLEX_SEND_PATH,
  classifyFlexBody,
  flexErrorKind,
} from './flex-wire';
import type { FlexBody } from './flex-wire';

const FLEX_BUDGET_MS = 40_000;
const FLEX_FIRST_POLL_MS = 2_000;
const FLEX_POLL_MS = 8_000;
const FLEX_MAX_CALLS = 6;
const USER_AGENT = 'tradr-flex-import';

export interface FetchFlexDeps {
  /** Test seam (stock-quote.client precedent): defaults to global `fetch`. */
  fetchImpl?: typeof fetch;
  /** Test seam: defaults to a real delay. */
  sleep?: (ms: number) => Promise<void>;
  /** Test seam: defaults to `Date.now`. */
  now?: () => number;
  /** Test seam: defaults to `FLEX_BUDGET_MS`. */
  budgetMs?: number;
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function unavailable(): AppError {
  return new AppError(503, 'IBKR_FLEX_UNAVAILABLE', 'IBKR is unavailable; try again later.');
}

function notReady(): AppError {
  return new AppError(503, 'IBKR_FLEX_NOT_READY', 'The report is not ready; try again shortly.');
}

function rateLimited(): AppError {
  return new AppError(
    429,
    'IBKR_FLEX_RATE_LIMITED',
    'IBKR is limiting requests; wait a minute and try again.',
  );
}

function tokenRejected(): AppError {
  return new AppError(
    400,
    'IBKR_FLEX_TOKEN_REJECTED',
    'IBKR rejected this token; replace it in Settings.',
  );
}

function queryRejected(): AppError {
  return new AppError(
    400,
    'IBKR_FLEX_QUERY_REJECTED',
    'IBKR rejected this query id; check it in Settings.',
  );
}

function formatUnsupported(): AppError {
  return new AppError(
    422,
    'IBKR_FLEX_FORMAT_UNSUPPORTED',
    "Set this Flex query's format to CSV and fetch again.",
  );
}

/** Maps a failed envelope's error code to its coded `AppError` (design Error Handling rows 1, 2, 3, 4, 5, 7). */
function classifyEnvelopeError(errorCode: number | undefined): AppError {
  if (errorCode === undefined) return unavailable();
  switch (flexErrorKind(errorCode)) {
    case 'token':
      return tokenRejected();
    case 'query':
      return queryRejected();
    case 'rate':
      return rateLimited();
    case 'in-progress':
      return notReady();
    case 'other':
    default:
      return unavailable();
  }
}

/** `https:`, or `http:` with host `localhost` or `127.0.0.1` (design Security NFR, D12). */
function isAllowedBase(baseUrl: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(baseUrl);
  } catch {
    return false;
  }
  if (parsed.protocol === 'https:') return true;
  return (
    parsed.protocol === 'http:' &&
    (parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1')
  );
}

function buildUrl(baseUrl: string, path: string, token: string, qValue: string): string {
  return `${baseUrl}${path}?t=${encodeURIComponent(token)}&q=${encodeURIComponent(qValue)}&v=${FLEX_API_VERSION}`;
}

/**
 * Fetch one response and return its (capped) bytes. Every outcome besides a
 * successful 2xx body read is replaced by a coded `AppError` — the caught
 * object, the response body and the URL are never surfaced. `readBodyCapped`'s
 * own `AppError` (413 PAYLOAD_TOO_LARGE) passes through unchanged.
 */
async function requestBytes(
  fetchImpl: typeof fetch,
  url: string,
  signal: AbortSignal,
): Promise<Uint8Array> {
  let res: Response;
  try {
    res = await fetchImpl(url, { signal, headers: { 'User-Agent': USER_AGENT } });
  } catch {
    throw unavailable();
  }

  if (res.status === 429) throw rateLimited();
  if (!res.ok) throw unavailable();

  try {
    return await readBodyCapped(res.body);
  } catch (err) {
    if (err instanceof AppError) throw err;
    throw unavailable();
  }
}

function referenceCodeOf(body: FlexBody): string {
  if (body.kind !== 'envelope') throw unavailable();
  if (body.referenceCode) return body.referenceCode;
  throw classifyEnvelopeError(body.errorCode);
}

/**
 * The outbound two-step (SendRequest, then polling GetStatement) inside one
 * budget (design C4). Resolves to the report's own bytes.
 */
export async function fetchFlexReport(
  credentials: { token: string; queryId: string },
  deps: FetchFlexDeps = {},
): Promise<Uint8Array> {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const sleep = deps.sleep ?? defaultSleep;
  const now = deps.now ?? Date.now;
  const budgetMs = deps.budgetMs ?? FLEX_BUDGET_MS;

  const baseUrl = config.IBKR_FLEX_BASE_URL.replace(/\/+$/, '');
  if (!isAllowedBase(baseUrl)) throw unavailable();

  const controller = new AbortController();
  const deadline = setTimeout(() => controller.abort(new Error('flex budget exceeded')), budgetMs);

  try {
    const started = now();

    const sendUrl = buildUrl(baseUrl, FLEX_SEND_PATH, credentials.token, credentials.queryId);
    const sendBytes = await requestBytes(fetchImpl, sendUrl, controller.signal);
    const referenceCode = referenceCodeOf(classifyFlexBody(sendBytes));

    let callCount = 1;
    let delay = FLEX_FIRST_POLL_MS;

    for (;;) {
      if (callCount >= FLEX_MAX_CALLS || now() - started + delay > budgetMs) {
        throw notReady();
      }
      await sleep(delay);
      delay = FLEX_POLL_MS;

      const getUrl = buildUrl(baseUrl, FLEX_GET_PATH, credentials.token, referenceCode);
      const bytes = await requestBytes(fetchImpl, getUrl, controller.signal);
      callCount += 1;

      const body = classifyFlexBody(bytes);
      if (body.kind === 'report') return bytes;
      if (body.kind === 'xml-report') throw formatUnsupported();

      if (body.errorCode !== undefined && flexErrorKind(body.errorCode) === 'in-progress') {
        continue;
      }
      throw classifyEnvelopeError(body.errorCode);
    }
  } finally {
    clearTimeout(deadline);
  }
}

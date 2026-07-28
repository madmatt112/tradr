// HTTP handlers for the symbols feature (design v4 §symbols.handler, REQ-3/4/9).
//
// Thin handlers: validate inputs IN-HANDLER via `schema.safeParse` (throwing
// `ValidationError` on failure — the options-chain.handler idiom, NOT
// `zValidator`), delegate to the service / provider client, and shape the
// response. The global `onError` (errorHandler) renders every thrown AppError
// subclass to its coded HTTP status, so handlers throw rather than build
// envelopes inline.

import type { Context } from 'hono';
import type { ZodError } from 'zod';

import { QuoteSymbolParamSchema, SymbolQuerySchema } from '@tradr/shared';

import { db } from '@/db';
import { isStockQuoteConfigured } from '@/lib/config';
import { ValidationError } from '@/lib/errors';

import { getStockQuote } from './stock-quote.client';
import { searchSymbols, syncSymbolsIfStale } from './symbols.service';

type AuthEnv = { Variables: { userId: string; isAdmin: boolean } };

/** Project a Zod failure into a `ValidationError` (options-chain.handler idiom). */
function toValidationError(error: ZodError): ValidationError {
  const details: Record<string, string> = {};
  for (const issue of error.issues) {
    details[issue.path.join('.') || '_root'] = issue.message;
  }
  return new ValidationError('Validation failed', details);
}

/**
 * GET /search?q=<prefix> — ranked ticker-prefix autocomplete (REQ-3.2/3.5/3.6).
 *
 * Validates `q` against the shared sanitizer (`[A-Z.-]{0,16}`, uppercased,
 * trimmed). A normalized-empty `q` short-circuits to `{ results: [] }` @200
 * BEFORE the service is called, so the query layer never builds `LIKE '%'`
 * (REQ-3.2). Read-only / side-effect-free (CSRF-safe GET); NEVER calls the
 * quote provider (REQ-3.6).
 */
export async function searchSymbolsHandler(c: Context<AuthEnv>) {
  const parsed = SymbolQuerySchema.safeParse({ q: c.req.query('q') });
  if (!parsed.success) throw toValidationError(parsed.error);
  const { q } = parsed.data;

  if (q.trim() === '') return c.json({ results: [] });

  const results = await searchSymbols(db, q);
  return c.json({ results });
}

/**
 * GET /:symbol/quote — delayed spot last-price for a symbol (REQ-4.2/4.6).
 *
 * Defense-in-depth (REQ-4.2): with no provider key configured, returns
 * `{ configured: false }` @200 WITHOUT touching the provider (short-circuits
 * before `getStockQuote`). Otherwise returns `{ configured: true, ...quote }`.
 * Provider failures propagate as coded `AppError`s (404 / 503 / 502) — never a
 * generic 500. Independent of the `symbols` table (REQ-4.6).
 */
export async function getQuoteHandler(c: Context<AuthEnv>) {
  const parsed = QuoteSymbolParamSchema.safeParse({ symbol: c.req.param('symbol') });
  if (!parsed.success) throw toValidationError(parsed.error);
  const { symbol } = parsed.data;

  if (!isStockQuoteConfigured()) return c.json({ configured: false });

  const quote = await getStockQuote(symbol);
  return c.json({ configured: true, ...quote });
}

/**
 * GET /quote-config — whether the delayed-quote provider is configured
 * (REQ-9.5). Lets the frontend gate the pull-last-price affordance without
 * probing the quote endpoint. Gates solely on the presence of the provider key.
 */
export function quoteConfigHandler(c: Context<AuthEnv>) {
  return c.json({ stockQuoteConfigured: isStockQuoteConfigured() });
}

/**
 * POST /refresh — admin manual symbols reference-data refresh (REQ-2.4(d)).
 * Runs the guarded, multi-container-safe population with `force: true` and
 * returns the `SyncOutcome` verbatim as the JSON body (a no-op returning
 * `skipped-test-env` under `NODE_ENV=test`).
 */
export async function refreshSymbolsHandler(c: Context<AuthEnv>) {
  const outcome = await syncSymbolsIfStale({ force: true });
  return c.json(outcome);
}

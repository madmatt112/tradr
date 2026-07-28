import { cors } from 'hono/cors';
import { createMiddleware } from 'hono/factory';

import { getCorsAllowedOrigins, isSplitOriginConfigured } from '@/lib/config';

// Credentialed CORS for split-origin operation (REQ-5.1/5.3). The origin
// function echoes the request origin ONLY on an exact allow-list match, else
// returns null so hono/cors omits Access-Control-Allow-Origin entirely — the
// spec forbids `*` for credentialed requests, so we never reflect blindly. The
// allow-list is read live (via getCorsAllowedOrigins) so config is the single
// source of truth.
const corsHandler = cors({
  origin: (origin) => (getCorsAllowedOrigins().includes(origin) ? origin : null),
  credentials: true,
});

/**
 * Global CORS, gated on the single split-origin predicate (REQ-6.4 — the SAME
 * predicate gates the anti-CSRF middleware, inseparably). When split-origin is
 * unconfigured this is a pure pass-through: no CORS headers at all (not even
 * Access-Control-Allow-Credentials / Vary), so same-origin behavior is
 * byte-for-byte today's (REQ-6.3). When configured, hono/cors handles the
 * allow-list echo, credentials, and the OPTIONS preflight, covering every route
 * — including the image-proxy GET (Task 9).
 */
export const corsMiddleware = createMiddleware(async (c, next) => {
  if (!isSplitOriginConfigured()) {
    return next();
  }
  return corsHandler(c, next);
});

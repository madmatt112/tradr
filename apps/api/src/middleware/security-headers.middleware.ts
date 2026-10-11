import { secureHeaders } from 'hono/secure-headers';

import { config } from '@/lib/config';

/**
 * Security headers on every API response (design C9, REQ-5). Mounted globally in
 * app.ts beside CORS/CSRF so no route is missed (REQ-5.1), and because hono sets
 * these after `next()` they land on a 200, a 404, a thrown AppError and the CSRF
 * 403 alike (REQ-5.2).
 *
 * Three options override the hono 4.12.8 defaults; the rest of the pinned set
 * comes from those defaults (`X-Content-Type-Options: nosniff`,
 * `Referrer-Policy: no-referrer`):
 *  - `strictTransportSecurity` — the default sends HSTS always; we send it ONLY
 *    when the operator turns it on, and never otherwise (REQ-5.3, D8).
 *  - `crossOriginResourcePolicy: 'same-site'` — the default `same-origin` would
 *    block the split-origin advisor image proxy and the SSE stream; `same-site`
 *    still loads them while staying cross-origin-restrictive (REQ-5.4, D8).
 *  - `xFrameOptions: 'DENY'` — the default is `SAMEORIGIN`; the app is never
 *    framed, so refuse framing outright.
 *
 * `hstsEnabled` defaults to the parsed config value and is a parameter only so a
 * test can drive both states without mutating global config.
 */
export function securityHeadersMiddleware(hstsEnabled: boolean = config.HSTS_ENABLED) {
  return secureHeaders({
    strictTransportSecurity: hstsEnabled ? 'max-age=31536000; includeSubDomains' : false,
    crossOriginResourcePolicy: 'same-site',
    xFrameOptions: 'DENY',
  });
}

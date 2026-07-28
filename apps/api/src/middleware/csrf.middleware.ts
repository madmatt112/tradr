import { createMiddleware } from 'hono/factory';

import { getCorsAllowedOrigins, isSplitOriginConfigured } from '@/lib/config';
import { AppError } from '@/lib/errors';

// Methods that never mutate state — left completely untouched (REQ-6.1).
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

// Paths exempt from the Origin/Referer check. ONLY the Stripe webhook: it is
// the sole mutating route authenticated by a signature rather than the session
// cookie, and it is called server-to-server by Stripe with no Origin header, so
// deny-by-default would otherwise (correctly, for a cookie route) reject it.
const EXEMPT_PATHS = ['/api/billing/webhook'];

/** Origin (scheme://host[:port]) of a URL string, or null when unparseable. */
function originOf(url: string | undefined): string | null {
  if (!url) return null;
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
}

function isExempt(path: string): boolean {
  return EXEMPT_PATHS.some((p) => path === p);
}

/**
 * Anti-CSRF for split-origin operation (REQ-6). SameSite=None cookies (Task 14)
 * let the browser attach the session cookie to cross-site requests, so a
 * compensating origin check is mandatory. On non-safe methods this requires an
 * EXACT allow-list match on the request Origin (falling back to the Referer's
 * origin only when Origin is entirely absent) and DENIES BY DEFAULT on an
 * absent or literal-`null` Origin (REQ-6.5) with 403 CSRF_FORBIDDEN.
 *
 * Gated on the SAME isSplitOriginConfigured() predicate as CORS (REQ-6.4) — the
 * two are inseparable. Off ⇒ pure pass-through, no enforcement, so same-origin
 * Lax flow is unchanged (REQ-6.3). Safe methods (GET/HEAD/OPTIONS) are untouched.
 */
export const csrfMiddleware = createMiddleware(async (c, next) => {
  if (!isSplitOriginConfigured()) {
    return next();
  }
  if (SAFE_METHODS.has(c.req.method)) {
    return next();
  }
  if (isExempt(c.req.path)) {
    return next();
  }

  const originHeader = c.req.header('Origin');

  // Resolve the request origin. A literal `null` Origin (opaque origin) is an
  // explicit deny signal and never falls back to Referer. Only a wholly absent
  // Origin falls back to the Referer's origin.
  let requestOrigin: string | null;
  if (originHeader === undefined) {
    requestOrigin = originOf(c.req.header('Referer'));
  } else if (originHeader === 'null') {
    requestOrigin = null;
  } else {
    requestOrigin = originHeader;
  }

  if (requestOrigin !== null && getCorsAllowedOrigins().includes(requestOrigin)) {
    return next();
  }

  throw new AppError(403, 'CSRF_FORBIDDEN', 'Cross-origin request forbidden');
});

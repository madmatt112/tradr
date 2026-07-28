import { config, isSplitOriginConfigured } from './config';

// Centralized cookie policy for the two production cookie surfaces — the
// `session` cookie (auth.route.ts) and the `tradr_theme` cookie
// (dashboard.route.ts). Both flip to `SameSite=None; Secure` under split-origin
// operation so credentialed cross-origin requests carry them (REQ-5.2/5.4).
//
// TLS invariant (REQ-5.5): `Secure` is forced true whenever split-origin is
// configured, and `SameSite=None` is NEVER emitted without `Secure`. The
// predicate is gated on a non-empty CORS allow-list (isSplitOriginConfigured),
// so the split-origin branch never fires in dev/test/self-host — where behavior
// stays byte-identical to today's `SameSite=Lax` (REQ-1.2).

type SessionCookieOptions = {
  httpOnly: true;
  sameSite: 'Lax' | 'None';
  path: string;
  maxAge: number;
  secure: boolean;
};

/**
 * Cookie options for the HttpOnly `session` cookie. Split-origin ⇒
 * `SameSite=None; Secure` (HttpOnly retained); otherwise `SameSite=Lax` with
 * `secure` following NODE_ENV, exactly as today (REQ-5.2).
 */
export function sessionCookieOptions(): SessionCookieOptions {
  if (isSplitOriginConfigured()) {
    return { httpOnly: true, sameSite: 'None', path: '/', maxAge: 86400, secure: true };
  }
  return {
    httpOnly: true,
    sameSite: 'Lax',
    path: '/',
    maxAge: 86400,
    secure: config.NODE_ENV === 'production',
  };
}

/**
 * Attribute string (everything after `name=value; `) for the JS-readable
 * `tradr_theme` cookie — no HttpOnly, matching today's stance. Split-origin ⇒
 * `SameSite=None; Secure`; otherwise `SameSite=Lax` with `Secure` only in
 * production, byte-identical to today (REQ-5.4/1.2).
 */
export function themeCookieAttributes(): string {
  if (isSplitOriginConfigured()) {
    return 'Path=/; SameSite=None; Max-Age=31536000; Secure';
  }
  const base = 'Path=/; SameSite=Lax; Max-Age=31536000';
  return config.NODE_ENV === 'production' ? `${base}; Secure` : base;
}

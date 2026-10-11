// Content-Security-Policy artefact (security-hardening, design C10).
//
// One build-time policy template, shared by every serving path: the Vite
// preview server (csp-plugin.mjs), the self-host nginx entrypoint (C11) and
// the hosted Pages writer (C12). Zero runtime dependencies on purpose.
//
//   inlineScriptHashes(html) -> ["'sha256-…'"] for every <script> without src
//   cspTemplate(hashes)      -> the policy with the hash filled, origins as
//                               __API_ORIGIN__ / __POSTHOG_ORIGINS__ placeholders
//   renderCsp(template, …)   -> the placeholders filled in, no stray "__"
//   posthogOrigins(host)     -> the PostHog connect/img origins for a host
//   STATIC_SECURITY_HEADERS  -> the four header name/value pairs served alongside
import { createHash } from 'node:crypto';

// Exact template string (design C10). `HASHES` is filled by cspTemplate; the two
// `__…__` tokens are filled by renderCsp (or the shell/Pages writers downstream).
const TEMPLATE =
  "default-src 'self'; " +
  "script-src 'self' HASHES __POSTHOG_ORIGINS__; " +
  "style-src 'self' 'unsafe-inline'; " +
  "img-src 'self' data: blob: __API_ORIGIN__ __POSTHOG_ORIGINS__; " +
  "connect-src 'self' __API_ORIGIN__ __POSTHOG_ORIGINS__; " +
  "font-src 'self'; " +
  "manifest-src 'self'; " +
  "worker-src 'self'; " +
  "frame-ancestors 'none'; " +
  "object-src 'none'; " +
  "base-uri 'self'; " +
  "form-action 'self'";

// The four static headers served beside the CSP on every SPA path (design C10).
export const STATIC_SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), payment=(), usb=()',
};

// PostHog region endpoints, mirroring posthog-js 1.387.0 `region`/`endpointFor`
// (node_modules/posthog-js/dist/module.js): the apiHost default and
// https://app.posthog.com resolve to US; the us/eu patterns give their asset
// pairs; any other host keeps its own origin.
const POSTHOG_US = ['https://us.i.posthog.com', 'https://us-assets.i.posthog.com'];
const POSTHOG_EU = ['https://eu.i.posthog.com', 'https://eu-assets.i.posthog.com'];
const POSTHOG_US_RE = /https:\/\/(app|us|us-assets)(\.i)?\.posthog\.com/i;
const POSTHOG_EU_RE = /https:\/\/(eu|eu-assets)(\.i)?\.posthog\.com/i;

/**
 * SHA-256/base64 CSP hash-sources for every inline <script> that has no `src`.
 * A changed boot script changes the hash with no hand edit (Req 6.6).
 * @param {string} html
 * @returns {string[]}
 */
export function inlineScriptHashes(html) {
  const hashes = [];
  for (const match of html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)) {
    const [, attrs, body] = match;
    if (/\bsrc\s*=/i.test(attrs)) continue;
    const digest = createHash('sha256').update(body, 'utf8').digest('base64');
    hashes.push(`'sha256-${digest}'`);
  }
  return hashes;
}

/**
 * The policy template with the inline-script hashes filled into script-src.
 * @param {string[]} hashes
 * @returns {string}
 */
export function cspTemplate(hashes) {
  return TEMPLATE.replace('HASHES', hashes.join(' '));
}

/**
 * Fill __API_ORIGIN__ and __POSTHOG_ORIGINS__, collapse the whitespace the empty
 * cases leave behind, and leave no "__" placeholder (Req 6.4).
 * @param {string} template
 * @param {{ apiOrigin?: string, posthogOrigins?: string[] }} origins
 * @returns {string}
 */
export function renderCsp(template, { apiOrigin = '', posthogOrigins = [] } = {}) {
  return template
    .replaceAll('__API_ORIGIN__', apiOrigin)
    .replaceAll('__POSTHOG_ORIGINS__', posthogOrigins.join(' '))
    .replace(/ {2,}/g, ' ')
    .replace(/ +;/g, ';')
    .trim();
}

/**
 * The PostHog connect/img origins for a configured apiHost (design C10).
 * @param {string} [host]
 * @returns {string[]}
 */
export function posthogOrigins(host) {
  if (!host) return POSTHOG_US;
  if (POSTHOG_US_RE.test(host)) return POSTHOG_US;
  if (POSTHOG_EU_RE.test(host)) return POSTHOG_EU;
  return [new URL(host).origin];
}

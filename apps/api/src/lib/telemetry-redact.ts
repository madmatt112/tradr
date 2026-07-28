/**
 * Shared telemetry redaction primitive (design §Component 2, REQ-8.1/8.2/8.5).
 *
 * A pure, dependency-free value scrubber applied at the PostHog capture boundary
 * (`posthog.ts`) so a secret/PII/email/filename value cannot ride an event
 * property to the vendor. It is imported BY the capture boundary, so it MUST NOT
 * import `logger.ts` or `config.ts` (that would create an import cycle). Keep
 * this module free of any app imports.
 *
 * Exports:
 *   - scrubString(s)    — mask vendor-secret / email / upload-filename shapes in a string
 *   - scrubDeep(value)  — recurse objects/arrays: key denylist + scrubString on strings
 */

const REDACTED = '[redacted]';

/**
 * Value patterns masked inside any string (REQ-8.5 residual-channel coverage).
 *
 * Prefixes are pinned to the real installed SDK conventions:
 *   - OpenAI / Anthropic API keys use a HYPHEN: `sk-`, `sk-ant-`, `sk-proj-`
 *   - Stripe keys use an UNDERSCORE: `sk_`, `rk_`, `whsec_`
 *   - PostHog keys: `phc_`, `phx_`
 * The hyphen-vs-underscore distinction is load-bearing.
 *
 * There is deliberately NO bare "long-hex >=32" rule: it would mask legitimate
 * 64-hex SHA-256 fingerprints (e.g. the key-rotation diagnostics `encryption.ts`
 * emits) and adds little over the prefix patterns.
 *
 * The email pattern is ANCHORED on purpose (email-shaped local part, a
 * TLD-ish `\.[A-Za-z]{2,}` boundary, no `/`) so it matches `john@example.com`
 * but NOT pnpm scoped packages (`@hono/node-server/...`) or store-path version
 * tokens (`postgres@3.4.4/...`) in a stack trace — keeping `error.middleware`
 * `stack` frames (`file.js:line:col`) intact. Likewise the filename
 * rule keys on image/doc extensions, which never appear in stack frames (those
 * end `.js:line:col`), so it adds no stack false-positives.
 */
const VALUE_PATTERNS: RegExp[] = [
  // OpenAI / Anthropic API keys (hyphen form: sk-, sk-ant-, sk-proj-)
  /\bsk-[A-Za-z0-9_-]+/g,
  // Stripe keys (underscore form: sk_, rk_, whsec_)
  /\b(?:sk|rk|whsec)_[A-Za-z0-9_]+/g,
  // PostHog keys (phc_, phx_)
  /\b(?:phc|phx)_[A-Za-z0-9_]+/g,
  // Authorization bearer tokens
  /Bearer\s+\S+/g,
  // JSON Web Tokens
  /eyJ[\w-]+\.[\w-]+\.[\w-]+/g,
  // Anchored email address (see note above)
  /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g,
  // Uploaded image / document filenames
  /[\w-]+\.(?:png|jpe?g|webp|gif|pdf|csv|xlsx?)/g,
];

/**
 * Keys whose values are always masked, regardless of value shape, at every
 * depth. Matched case-insensitively against the lowercased key name.
 */
const DENY_KEYS: ReadonlySet<string> = new Set([
  'password',
  'token',
  'apikey',
  'api_key',
  'secret',
  'authorization',
  'cookie',
  'sessiontoken',
  'session',
  'encryptionkey',
  'refreshtoken',
  'accesstoken',
  'clientsecret',
  'email',
]);

/** Mask every secret / email / filename substring in a string value. */
export function scrubString(s: string): string {
  let out = s;
  for (const pattern of VALUE_PATTERNS) {
    out = out.replace(pattern, REDACTED);
  }
  return out;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object') return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/**
 * Recurse into plain objects and arrays. A denylisted key (case-insensitive)
 * masks its value; every string value is passed through `scrubString`; every
 * non-string, non-traversable value (number/boolean/null/undefined/Date/etc.)
 * is left untouched via the `typeof` / plain-object guards, so it never throws.
 */
export function scrubDeep(value: unknown): unknown {
  if (typeof value === 'string') return scrubString(value);
  if (Array.isArray(value)) return value.map((item) => scrubDeep(item));
  if (isPlainObject(value)) {
    const out: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(value)) {
      out[key] = DENY_KEYS.has(key.toLowerCase()) ? REDACTED : scrubDeep(val);
    }
    return out;
  }
  return value;
}

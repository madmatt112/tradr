import { z } from 'zod';

import type { ProviderId } from '@tradr/shared';

import { logger } from './logger';

export const envSchema = z.object({
  DATABASE_URL: z.string(),
  SESSION_SECRET: z.string().min(32),
  PORT: z.coerce.number().default(3100),
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  // Deployed-version string surfaced by GET /api/health (e.g. "v0.2.0-f51f9f5").
  // Baked into the api image at build time (docker build-arg → ENV) by the
  // staging deploy and release workflows — not an operator knob. Absent in dev.
  APP_VERSION: z.string().optional(),
  DB_POOL_SIZE: z.coerce.number().default(10),
  TRUSTED_PROXIES: z.string().optional(),
  WEEK_START_DAY: z
    .string()
    .regex(/^[01]$/)
    .default('0')
    .transform((v) => Number(v) as 0 | 1),
  SKIP_POST_MIGRATIONS: z
    .enum(['true', 'false'])
    .default('false')
    .transform((v) => v === 'true'),
  ENCRYPTION_KEY: z.string().regex(/^[0-9a-fA-F]{64}$/),
  ENCRYPTION_KEY_PREVIOUS: z
    .string()
    .regex(/^[0-9a-fA-F]{64}$/)
    .optional(),
  ENCRYPTION_KEY_FINGERPRINT: z
    .string()
    .regex(/^[0-9a-f]{64}$/)
    .optional(),
  ADVISOR_STREAM_TIMEOUT_MS: z.coerce.number().int().positive().default(120_000),
  ADVISOR_MAX_IMAGES_PER_MESSAGE: z.coerce.number().int().positive().default(4),
  ADVISOR_BUILTIN_PERSONA_PROMPT_DEFAULT_TRADING_ADVISOR: z.string().optional(),
  ADVISOR_BUILTIN_PERSONA_PROMPT_RISK_COACH: z.string().optional(),
  ADVISOR_BUILTIN_PERSONA_PROMPT_CHART_REVIEWER: z.string().optional(),
  // Unusual Whales base URL (REQ-6.4 E2E seam, task 8). Optional — defaults to
  // the real host, so this introduces NO new required env var. An out-of-process
  // E2E (task 37) sets it to a local stub. The client reads `config.UNUSUAL_WHALES_BASE_URL`
  // (NOT process.env): bare process.env is ESLint-banned in apps/api and the
  // non-strict envSchema parse would otherwise silently strip an unknown key.
  UNUSUAL_WHALES_BASE_URL: z.string().url().default('https://api.unusualwhales.com'),
  // OpenAI-compatible base URLs for the Gemini / OpenRouter adapters (v6).
  // Optional with production defaults — no new required env vars. E2E points
  // them at local stubs, mirroring UNUSUAL_WHALES_BASE_URL. (Claude and OpenAI
  // need no config entry: their SDKs read ANTHROPIC_BASE_URL / OPENAI_BASE_URL
  // from the env themselves.)
  GEMINI_BASE_URL: z
    .string()
    .url()
    .default('https://generativelanguage.googleapis.com/v1beta/openai/'),
  OPENROUTER_BASE_URL: z.string().url().default('https://openrouter.ai/api/v1'),
  // CSV import (api container). All optional with defaults — the feature works
  // out of the box. Operator constraints (hand-synced across containers):
  //   - MAX_UPLOAD_SIZE ≥ CSV_IMPORT_MAX_FILE_BYTES (nginx, web container)
  //   - CSV_IMPORT_CLAIM_TIMEOUT_SECONDS ≥ 2 × CSV_IMPORT_NGINX_PROXY_TIMEOUT
  //     (the nginx timeout lives in the web container — not auto-coupled)
  CSV_IMPORT_MAX_FILE_BYTES: z.coerce.number().int().positive().default(10_485_760),
  CSV_IMPORT_MAX_REQUEST_BYTES: z.coerce.number().int().positive().default(65_536),
  CSV_IMPORT_MAX_ROWS: z.coerce.number().int().positive().default(10_000),
  CSV_IMPORT_STAGING_TTL_MINUTES: z.coerce.number().int().positive().default(30),
  CSV_IMPORT_MAX_STAGED_BYTES: z.coerce.number().int().positive().default(25_165_824),
  CSV_IMPORT_CLAIM_TIMEOUT_SECONDS: z.coerce.number().int().positive().default(600),
  // Wallet billing (api container). ALL optional — the feature is absent, not
  // broken, when unconfigured (REQ-10.1/10.2). Stripe and platform keys are read
  // via the helpers below; never via bare process.env (ESLint-banned here).
  // Stripe — both SECRET + WEBHOOK_SECRET required for the purchase+webhook path
  // (isStripeConfigured). PUBLISHABLE_KEY is unused by the redirect flow client-side
  // (reserved).
  STRIPE_SECRET_KEY: z.string().optional(),
  STRIPE_WEBHOOK_SECRET: z.string().optional(),
  STRIPE_PUBLISHABLE_KEY: z.string().optional(),
  // Pro subscription Price id — the Price the subscription checkout sells RIGHT
  // NOW (D14, REQ-2.2). Plain optional string ('' reads falsy through the
  // isProSubscriptionConfigured predicate — the STRIPE_SECRET_KEY precedent).
  // Changing the price you sell = point this var at a new Price id and
  // restart — a config change, never a deploy; see .env.example for setup.
  STRIPE_PRO_PRICE_ID: z.string().optional(),
  // Platform LLM keys (per provider). Absent ⇒ advisor stays BYOK-only (REQ-10.3).
  ANTHROPIC_API_KEY: z.string().optional(),
  OPENAI_API_KEY: z.string().optional(),
  // Tunables.
  // Minimum available credits required to pass the pre-stream gate (REQ-6.3).
  MIN_RESERVATION_CREDITS: z.coerce.number().int().positive().default(1),
  // Reservation hold TTL for crash-recovery of a stranded hold. MUST be strictly
  // greater than the per-turn wall-clock budget (WALL_CLOCK_MS = 480_000ms in
  // advisor/streaming.ts) so a still-running turn never has its hold reclaimed.
  RESERVATION_TTL_MS: z.coerce.number().int().positive().default(600_000),
  // Pricing markup applied over raw provider cost, as a decimal string
  // (e.g. '1.2' = 20% markup). Parsed by pricing.ts.
  PRICING_MARKUP: z.string().default('1.2'),
  // Feature gating (admin-platform). Default OFF — self-hosters unrestricted (REQ-5.1).
  // SKIP_POST_MIGRATIONS idiom (above) — NOT z.coerce.boolean(), which coerces 'false' to true.
  FEATURE_GATING: z
    .enum(['true', 'false'])
    .default('false')
    .transform((v) => v === 'true'),
  // The PRO platform-turn allowance (plan-tiers REQ-5.3 — its ONE meaning):
  // committed platform-key advisor turns per UTC calendar month for Pro users
  // when gating is ON. The default 200 equals the previous flat cap, so existing
  // deployments keep their configured intent (numeric continuity). Parse is
  // deliberately unchanged. Server config, never client input.
  FEATURE_GATING_ADVISOR_TURNS_PER_MONTH: z.coerce.number().int().positive().default(200),
  // First-admin bootstrap (REQ-8.4) — promotes this email to admin at startup IF no admin exists.
  // Empty-string-tolerant and transform-BEFORE-validate (deliberately NOT RegisterSchema's
  // `.email().trim().toLowerCase()` order, where .email() validates the raw value and .trim()
  // is dead code — harmless on a 400-able request path, boot-fatal in envSchema.parse):
  //  - '' → undefined (a set-but-empty env var, e.g. a blank .env line, means "unset" — never a crash)
  //  - ' John@Example.com ' → 'john@example.com' (registration stores lowercase —
  //    packages/shared/src/schemas/auth.ts — so the lookup must compare lowercase)
  SEED_ADMIN_EMAIL: z.preprocess(
    (v) => (v === '' ? undefined : v),
    z.string().trim().toLowerCase().email().optional(),
  ),
  // Changelog (REQ-3). Both optional with defaults — zero new required config.
  // GitHub repo as an owner/repo slug, NEVER a URL. The negative lookahead
  // rejects whole-segment '.'/'..' while dots inside repo names stay legal
  // ('repo.name'); the alphabets reject %, ?, #, @, whitespace, and extra '/'.
  // Empty string ⇒ default (the SEED_ADMIN_EMAIL preprocess idiom above) — a
  // blank .env line means "unset", never a boot crash. Format-invalid values
  // fail envSchema.parse (boot-fail, REQ-3.3).
  CHANGELOG_GITHUB_REPO: z.preprocess(
    (v) => (v === '' ? undefined : v),
    z
      .string()
      .regex(/^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?\/(?!\.\.?$)[A-Za-z0-9._-]+$/)
      .default('madmatt112/tradr'),
  ),
  // GitHub API base URL (REQ-3.6 test/E2E seam). The UNUSUAL_WHALES_BASE_URL
  // idiom above PLUS empty-tolerance (the UW var lacks it and survives only by
  // being env_file-only). Leave unset in production.
  CHANGELOG_GITHUB_BASE_URL: z.preprocess(
    (v) => (v === '' ? undefined : v),
    z.string().url().default('https://api.github.com'),
  ),
  // Observability telemetry (REQ-1.2/1.3). ALL optional — each surface is absent,
  // not broken, when unconfigured (REQ-10.2). Gated via the predicates below;
  // read through `config`, never bare process.env (ESLint-banned here).
  // PostHog backend Node SDK (`phc_…` project key). Plain optional string — a
  // blank .env line / compose `${POSTHOG_API_KEY:-}` yields '', accepted and read
  // falsy by the `!!` predicate (the STRIPE_SECRET_KEY:60 precedent).
  POSTHOG_API_KEY: z.string().optional(),
  // PostHog ingestion host. Carries a `.url()` validator, so it CANNOT be a bare
  // optional string: compose injects a bare `${POSTHOG_HOST:-}` ⇒ '', which
  // `.url()` rejects, crash-looping envSchema.parse (:119). The empty-tolerant
  // preprocess ('' → undefined) + `.default(…)` (the CHANGELOG_GITHUB_BASE_URL
  // idiom above) makes config.POSTHOG_HOST ALWAYS a valid URL.
  POSTHOG_HOST: z.preprocess(
    (v) => (v === '' ? undefined : v),
    z.string().url().default('https://us.i.posthog.com'),
  ),
  // ─── Hosted platform (REQ-12.1) ───────────────────────────────────────────
  // ALL optional — every capability is a no-op when unconfigured (REQ-1 self-host
  // parity). With none of these set the system behaves EXACTLY as today: advisor
  // images inline base64-in-JSONB, the process-local rate limiter, same-origin
  // SameSite=Lax cookies, migrations over DATABASE_URL, prepared statements on.
  // Secrets (OBJECT_STORAGE_*_KEY, REDIS_URL) are server-side env only — NEVER
  // emitted to the frontend window.__TRADR_CONFIG__ seam. Read via `config` / the
  // isXConfigured predicates below, never bare process.env (ESLint-banned here).
  //
  // Centralized rate-limit store (REQ-7). Empty-tolerant (POSTHOG_HOST idiom): a
  // blank .env line / compose ${REDIS_URL:-} yields '' → undefined → the limiter
  // stays process-local (isRedisConfigured false).
  REDIS_URL: z.preprocess((v) => (v === '' ? undefined : v), z.string().url().optional()),
  // Non-pooled migration/CLI connection (REQ-9.1). Plain URL (DATABASE_URL is also
  // unvalidated), empty-tolerant. Unset ⇒ migrations run over DATABASE_URL as today.
  DIRECT_DATABASE_URL: z.preprocess((v) => (v === '' ? undefined : v), z.string().optional()),
  // App-pool prepared-statement mode (REQ-9.2). SKIP_POST_MIGRATIONS enum idiom (NOT
  // z.coerce.boolean, which maps 'false' → true). Default 'false' ⇒ prepared
  // statements ON exactly as today; 'true' ⇒ prepare:false for a transaction pooler.
  DB_TRANSACTION_POOLER: z
    .enum(['true', 'false'])
    .default('false')
    .transform((v) => v === 'true'),
  // Object storage for advisor images (REQ-2). isObjectStorageConfigured needs
  // endpoint + bucket + access key + secret; unset/partial ⇒ inline base64 as today.
  // ENDPOINT carries a .url() so it needs the empty-tolerant preprocess (POSTHOG_HOST
  // idiom); the rest are plain optional strings ('' reads falsy via the predicate —
  // the STRIPE_SECRET_KEY precedent).
  OBJECT_STORAGE_ENDPOINT: z.preprocess(
    (v) => (v === '' ? undefined : v),
    z.string().url().optional(),
  ),
  OBJECT_STORAGE_BUCKET: z.string().optional(),
  OBJECT_STORAGE_REGION: z.string().optional(),
  OBJECT_STORAGE_ACCESS_KEY_ID: z.string().optional(),
  OBJECT_STORAGE_SECRET_ACCESS_KEY: z.string().optional(),
  // MinIO/path-style addressing. enum-transform idiom; default 'true'. Read only
  // when object storage is configured — no self-host parity impact when unset.
  OBJECT_STORAGE_FORCE_PATH_STYLE: z
    .enum(['true', 'false'])
    .default('true')
    .transform((v) => v === 'true'),
  // Split-origin CORS allow-list (REQ-5), comma-separated origins. isSplitOriginConfigured
  // is true only for a non-empty parsed list (getCorsAllowedOrigins). '' / unset ⇒ no
  // CORS, same-origin only, SameSite=Lax cookies — exactly as today.
  CORS_ALLOWED_ORIGINS: z.string().optional(),
  // Operator-tunable per-image byte cap override (REQ-4.6). Unset ⇒ the shared-schema
  // MAX_IMAGE_BYTES_DEFAULT. coerce-number optional (no default here). NOTE: kept
  // env_file-only in docker-compose (NOT a bare ${VAR:-}), because '' coerces to 0
  // and fails .positive() — which would boot-crash an unconfigured self-host (REQ-1).
  ADVISOR_IMAGE_MAX_BYTES: z.coerce.number().int().positive().optional(),
  // Stream-route bodyLimit floor (REQ-4, SF-3). Default DERIVED in a later task;
  // declared optional here. Same coerce-number env_file-only caveat as above.
  ADVISOR_MAX_REQUEST_BYTES: z.coerce.number().int().positive().optional(),
  // ─── Transactional email (REQ-7, D2) ─────────────────────────────────────
  // ALL seven optional and ''-tolerant — a compose bare `${VAR:-}` injection
  // must NEVER crash an unconfigured instance (REQ-7.6). Configuredness is
  // all-or-nothing over the trio {SMTP_HOST, EMAIL_FROM, WEB_BASE_URL} via
  // isEmailConfigured() below; a PARTIAL config fails loud at boot in
  // assertEmailConfigCoherence naming the vars — never a silent
  // configured-but-unsendable state.
  //
  // SMTP server hostname — presence anchor of the trio (empty-tolerant
  // preprocess, the POSTHOG_HOST idiom minus the default).
  SMTP_HOST: z.preprocess((v) => (v === '' ? undefined : v), z.string().optional()),
  // SMTP port. The preprocess makes even a bare ${VAR:-} safe ('' → default),
  // belt-and-braces beyond the compose file's value-default rule.
  SMTP_PORT: z.preprocess(
    (v) => (v === '' ? undefined : v),
    z.coerce.number().int().min(1).max(65535).default(587),
  ),
  // TLS mode, mapped by the mailer to nodemailer: implicit → secure:true;
  // starttls → secure:false + requireTLS; none → secure:false + ignoreTLS
  // (Mailpit/local relays). Same empty-tolerant preprocess as SMTP_PORT.
  SMTP_TLS_MODE: z.preprocess(
    (v) => (v === '' ? undefined : v),
    z.enum(['implicit', 'starttls', 'none']).default('starttls'),
  ),
  // SMTP credentials — an optional PAIR for auth-optional local relays. Plain
  // optional strings ('' reads falsy — the STRIPE_SECRET_KEY precedent);
  // both-or-neither is enforced by assertEmailConfigCoherence.
  SMTP_USER: z.string().optional(),
  SMTP_PASS: z.string().optional(),
  // From address (bare address). Transform-before-validate (the
  // SEED_ADMIN_EMAIL lesson above) but deliberately WITHOUT .toLowerCase():
  // this is a SENDING identity, not a lookup key — RFC 5321 local parts are
  // case-significant and silently mutating operator config with no lookup to
  // justify it would be wrong.
  EMAIL_FROM: z.preprocess((v) => (v === '' ? undefined : v), z.string().trim().email().optional()),
  // Optional From display name. The no-CR/LF regex is a cheap header-hygiene
  // backstop; the mailer additionally builds the From header with nodemailer's
  // escape-safe address-object form { name, address }, never a formatted string.
  EMAIL_FROM_NAME: z.preprocess(
    (v) => (v === '' ? undefined : v),
    z
      .string()
      .regex(/^[^\r\n]+$/)
      .optional(),
  ),
  // Public web origin emailed links land on — the SOLE emailed-link base (D3),
  // never request headers. Origin-only: an absolute http(s) URL whose path is
  // '/' (or empty) with no query/fragment; the trailing slash is stripped so
  // config.WEB_BASE_URL is always a bare origin. Under split-origin this is
  // the WEB origin (where the reset/verify pages live), never the API origin.
  WEB_BASE_URL: z.preprocess(
    (v) => (v === '' ? undefined : v),
    z
      .string()
      .url()
      .refine(
        (v) => {
          // Zod v3 still runs refinements when .url() has already failed (dirty
          // status), so the constructor must not throw on a non-URL.
          let url: URL;
          try {
            url = new URL(v);
          } catch {
            return false;
          }
          return (
            (url.protocol === 'http:' || url.protocol === 'https:') &&
            (url.pathname === '/' || url.pathname === '') &&
            url.search === '' &&
            url.hash === '' &&
            !v.endsWith('?') &&
            !v.endsWith('#')
          );
        },
        {
          message: 'WEB_BASE_URL must be an origin-only http(s) URL (no path, query, or fragment)',
        },
      )
      .transform((v) => v.replace(/\/$/, ''))
      .optional(),
  ),
  // ─── Symbol search + delayed quotes (REQ-9) ──────────────────────────────
  // Optional platform-global delayed-quote provider — absent ⇒ the last-price
  // capability is OFF for everyone (isStockQuoteConfigured false), degrading
  // gracefully with no error. Read via `config` / the predicate below, never
  // bare process.env (ESLint-banned here). Plain optional string ('' reads
  // falsy via the `!!` predicate — the STRIPE_SECRET_KEY precedent).
  STOCK_QUOTE_API_KEY: z.string().optional(),
  // Quote-provider base URL (API Ninjas). Carries a `.url()` validator, so it
  // needs the empty-tolerant preprocess ('' → undefined) + `.default(…)` (the
  // CHANGELOG_GITHUB_BASE_URL / POSTHOG_HOST idiom): a bare compose
  // `${STOCK_QUOTE_BASE_URL:-}` yields '' which `.url()` would reject. Not
  // user-influenced (no SSRF). Leave unset in production; an out-of-process E2E
  // points it at a local stub.
  STOCK_QUOTE_BASE_URL: z.preprocess(
    (v) => (v === '' ? undefined : v),
    z.string().url().default('https://api.api-ninjas.com'),
  ),
  // SEC source: compliant contact User-Agent (safe NON-personal default — no
  // hard-coded personal contact in source, REQ-9.4) + test/E2E URL seam. Both
  // empty-tolerant (the CHANGELOG_GITHUB_BASE_URL idiom); SEC_USER_AGENT has no
  // `.url()` so it drops the validator but keeps the '' → default preprocess.
  SEC_USER_AGENT: z.preprocess(
    (v) => (v === '' ? undefined : v),
    z.string().default('tradr (+https://github.com/madmatt112/tradr)'),
  ),
  SEC_TICKERS_URL: z.preprocess(
    (v) => (v === '' ? undefined : v),
    z.string().url().default('https://www.sec.gov/files/company_tickers_exchange.json'),
  ),
});

export const config = envSchema.parse(process.env);
export type Config = z.infer<typeof envSchema>;

/**
 * Fail-loud coherence gate for the transactional-email config (D2, REQ-7.6).
 * Throws — naming the offending vars — when (a) any presence-signal var
 * (SMTP_HOST, EMAIL_FROM, WEB_BASE_URL, SMTP_USER, SMTP_PASS, EMAIL_FROM_NAME)
 * is set while the required trio {SMTP_HOST, EMAIL_FROM, WEB_BASE_URL} is
 * incomplete, or (b) exactly one of SMTP_USER/SMTP_PASS is set. SMTP_PORT and
 * SMTP_TLS_MODE are NOT presence signals — the production compose gives them
 * value defaults on every instance, so their presence carries no operator
 * intent. Rationale: a typo'd config that silently degrades to "email absent"
 * is an operator trap; partial config is a boot error, not email-off.
 */
export function assertEmailConfigCoherence(cfg: Config): void {
  const trio = ['SMTP_HOST', 'EMAIL_FROM', 'WEB_BASE_URL'] as const;
  const presenceSignals = [...trio, 'SMTP_USER', 'SMTP_PASS', 'EMAIL_FROM_NAME'] as const;
  const set = presenceSignals.filter((key) => !!cfg[key]);
  const missing = trio.filter((key) => !cfg[key]);
  if (set.length > 0 && missing.length > 0) {
    throw new Error(
      `Partial email config: ${set.join(', ')} set, but required email var(s) missing: ` +
        `${missing.join(', ')}. Set all of SMTP_HOST, EMAIL_FROM, WEB_BASE_URL to enable ` +
        'email, or unset every email var to disable it.',
    );
  }
  if (!!cfg.SMTP_USER !== !!cfg.SMTP_PASS) {
    const [present, absent] = cfg.SMTP_USER
      ? (['SMTP_USER', 'SMTP_PASS'] as const)
      : (['SMTP_PASS', 'SMTP_USER'] as const);
    throw new Error(
      `Incoherent email config: ${present} is set without ${absent} — SMTP credentials ` +
        'are an optional pair; set both or neither.',
    );
  }
}

// Invoked at module scope immediately after envSchema.parse (D2): a partial
// email config crashes boot — api and CLI alike — naming the vars, instead of
// silently degrading to email-off (REQ-7.6).
assertEmailConfigCoherence(config);

/** True when Stripe is fully configured for the purchase + webhook path (REQ-10.1). */
export function isStripeConfigured(): boolean {
  return !!config.STRIPE_SECRET_KEY && !!config.STRIPE_WEBHOOK_SECRET;
}

/** True when the Pro subscription is purchasable — Stripe fully configured AND the Pro Price id set (D14, REQ-2.7). */
export function isProSubscriptionConfigured(): boolean {
  return isStripeConfigured() && !!config.STRIPE_PRO_PRICE_ID;
}

/** True when the PostHog backend surface is configured (REQ-1.2). Gates solely on the key. */
export function isPostHogConfigured(): boolean {
  return !!config.POSTHOG_API_KEY;
}

/** True when the platform delayed-quote provider is configured (REQ-9.3). Gates solely on the key. */
export function isStockQuoteConfigured(): boolean {
  return !!config.STOCK_QUOTE_API_KEY;
}

/** True when admin-platform feature gating is enabled (REQ-5.1 — default off). */
export function isFeatureGatingEnabled(): boolean {
  return config.FEATURE_GATING;
}

/** Returns the platform API key for a provider, or undefined when unconfigured (REQ-10.3). */
export function getPlatformApiKey(provider: ProviderId): string | undefined {
  switch (provider) {
    case 'claude':
      return config.ANTHROPIC_API_KEY;
    case 'openai':
      return config.OPENAI_API_KEY;
    // BYOK-only providers — no platform-key support, so platform mode can
    // never activate for them (and their PLATFORM_DEFAULT_MODEL is absent).
    case 'gemini':
    case 'openrouter':
      return undefined;
  }
}

/** Split CORS_ALLOWED_ORIGINS into a trimmed, non-empty origin allow-list (REQ-5.1). */
export function getCorsAllowedOrigins(): string[] {
  return (config.CORS_ALLOWED_ORIGINS ?? '')
    .split(',')
    .map((origin) => origin.trim())
    .filter((origin) => origin.length > 0);
}

/** True when object storage is fully configured — endpoint + bucket + access key + secret (REQ-2.1). */
export function isObjectStorageConfigured(): boolean {
  return (
    !!config.OBJECT_STORAGE_ENDPOINT &&
    !!config.OBJECT_STORAGE_BUCKET &&
    !!config.OBJECT_STORAGE_ACCESS_KEY_ID &&
    !!config.OBJECT_STORAGE_SECRET_ACCESS_KEY
  );
}

/** True when the centralized Redis rate-limit store is configured (REQ-7.1). */
export function isRedisConfigured(): boolean {
  return !!config.REDIS_URL;
}

/** True when split-origin operation is configured — a non-empty CORS allow-list (REQ-5.1, REQ-1.3). */
export function isSplitOriginConfigured(): boolean {
  return getCorsAllowedOrigins().length > 0;
}

/** True when a non-pooled direct DB URL is configured for migrations/CLI (REQ-9.1). */
export function isDirectDatabaseConfigured(): boolean {
  return !!config.DIRECT_DATABASE_URL;
}

/**
 * True when email is fully configured — the {SMTP_HOST, EMAIL_FROM, WEB_BASE_URL}
 * trio (REQ-1.5, D2). Reads `config` LIVE per call (the isSplitOriginConfigured
 * pattern) so tests can toggle it by direct config.X mutation — no module may
 * capture its value at load time.
 */
export function isEmailConfigured(): boolean {
  return !!config.SMTP_HOST && !!config.EMAIL_FROM && !!config.WEB_BASE_URL;
}

logger.warn('Config loaded', { weekStartDay: config.WEEK_START_DAY });

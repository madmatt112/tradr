import { afterEach, describe, expect, it } from 'vitest';

import {
  assertEmailConfigCoherence,
  config,
  envSchema,
  getCorsAllowedOrigins,
  isDirectDatabaseConfigured,
  isEmailConfigured,
  isObjectStorageConfigured,
  isPostHogConfigured,
  isProSubscriptionConfigured,
  isRedisConfigured,
  isSplitOriginConfigured,
} from './config';

const baseEnv = {
  DATABASE_URL: 'postgresql://postgres:postgres@localhost:5432/tradr_test',
  SESSION_SECRET: 'test-secret-that-is-at-least-32-characters-long',
  ENCRYPTION_KEY: 'a'.repeat(64),
};

describe('envSchema.WEEK_START_DAY', () => {
  it('accepts "0" and narrows to literal 0', () => {
    const parsed = envSchema.parse({ ...baseEnv, WEEK_START_DAY: '0' });
    expect(parsed.WEEK_START_DAY).toBe(0);
  });

  it('accepts "1" and narrows to literal 1', () => {
    const parsed = envSchema.parse({ ...baseEnv, WEEK_START_DAY: '1' });
    expect(parsed.WEEK_START_DAY).toBe(1);
  });

  it('defaults to 0 when unset', () => {
    const parsed = envSchema.parse(baseEnv);
    expect(parsed.WEEK_START_DAY).toBe(0);
  });

  it.each(['2', '', 'abc', 'true'])('rejects %j', (v) => {
    const result = envSchema.safeParse({ ...baseEnv, WEEK_START_DAY: v });
    expect(result.success).toBe(false);
  });
});

describe('envSchema.SKIP_POST_MIGRATIONS', () => {
  it('parses "true" to boolean true', () => {
    const parsed = envSchema.parse({ ...baseEnv, SKIP_POST_MIGRATIONS: 'true' });
    expect(parsed.SKIP_POST_MIGRATIONS).toBe(true);
  });

  it('parses "false" to boolean false', () => {
    const parsed = envSchema.parse({ ...baseEnv, SKIP_POST_MIGRATIONS: 'false' });
    expect(parsed.SKIP_POST_MIGRATIONS).toBe(false);
  });

  it('defaults to false when unset', () => {
    const parsed = envSchema.parse(baseEnv);
    expect(parsed.SKIP_POST_MIGRATIONS).toBe(false);
  });

  it.each(['1', 'yes', '', '0'])('rejects %j', (v) => {
    const result = envSchema.safeParse({ ...baseEnv, SKIP_POST_MIGRATIONS: v });
    expect(result.success).toBe(false);
  });
});

describe('envSchema.ENCRYPTION_KEY', () => {
  it('accepts 64 hex chars (mixed case)', () => {
    const key = 'ABCDEF0123456789'.repeat(4);
    const parsed = envSchema.parse({ ...baseEnv, ENCRYPTION_KEY: key });
    expect(parsed.ENCRYPTION_KEY).toBe(key);
  });

  it.each(['', 'a'.repeat(63), 'a'.repeat(65), 'g'.repeat(64), `${' '}${'a'.repeat(63)}`])(
    'rejects malformed key %j',
    (v) => {
      const result = envSchema.safeParse({ ...baseEnv, ENCRYPTION_KEY: v });
      expect(result.success).toBe(false);
    },
  );

  it('requires the key when unset', () => {
    const { ENCRYPTION_KEY: _omit, ...withoutKey } = baseEnv;
    void _omit;
    const result = envSchema.safeParse(withoutKey);
    expect(result.success).toBe(false);
  });
});

describe('envSchema.ENCRYPTION_KEY_PREVIOUS', () => {
  it('is optional', () => {
    const parsed = envSchema.parse(baseEnv);
    expect(parsed.ENCRYPTION_KEY_PREVIOUS).toBeUndefined();
  });

  it('accepts a valid 64-hex key', () => {
    const key = 'b'.repeat(64);
    const parsed = envSchema.parse({ ...baseEnv, ENCRYPTION_KEY_PREVIOUS: key });
    expect(parsed.ENCRYPTION_KEY_PREVIOUS).toBe(key);
  });

  it('rejects a malformed key', () => {
    const result = envSchema.safeParse({ ...baseEnv, ENCRYPTION_KEY_PREVIOUS: 'a'.repeat(63) });
    expect(result.success).toBe(false);
  });
});

describe('envSchema.ENCRYPTION_KEY_FINGERPRINT', () => {
  it('is optional', () => {
    const parsed = envSchema.parse(baseEnv);
    expect(parsed.ENCRYPTION_KEY_FINGERPRINT).toBeUndefined();
  });

  it('accepts a lowercase 64-hex fingerprint', () => {
    const fp = 'a'.repeat(64);
    const parsed = envSchema.parse({ ...baseEnv, ENCRYPTION_KEY_FINGERPRINT: fp });
    expect(parsed.ENCRYPTION_KEY_FINGERPRINT).toBe(fp);
  });

  it('rejects an uppercase fingerprint', () => {
    const result = envSchema.safeParse({ ...baseEnv, ENCRYPTION_KEY_FINGERPRINT: 'A'.repeat(64) });
    expect(result.success).toBe(false);
  });
});

describe('envSchema.ADVISOR_STREAM_TIMEOUT_MS', () => {
  it('defaults to 120000 when unset', () => {
    const parsed = envSchema.parse(baseEnv);
    expect(parsed.ADVISOR_STREAM_TIMEOUT_MS).toBe(120_000);
  });

  it('coerces a numeric string', () => {
    const parsed = envSchema.parse({ ...baseEnv, ADVISOR_STREAM_TIMEOUT_MS: '5000' });
    expect(parsed.ADVISOR_STREAM_TIMEOUT_MS).toBe(5000);
  });
});

describe('envSchema.ADVISOR_MAX_IMAGES_PER_MESSAGE', () => {
  it('defaults to 4 when unset', () => {
    const parsed = envSchema.parse(baseEnv);
    expect(parsed.ADVISOR_MAX_IMAGES_PER_MESSAGE).toBe(4);
  });

  it('coerces a numeric string', () => {
    const parsed = envSchema.parse({ ...baseEnv, ADVISOR_MAX_IMAGES_PER_MESSAGE: '2' });
    expect(parsed.ADVISOR_MAX_IMAGES_PER_MESSAGE).toBe(2);
  });
});

describe('envSchema built-in persona prompt overrides', () => {
  it('are optional and undefined when unset', () => {
    const parsed = envSchema.parse(baseEnv);
    expect(parsed.ADVISOR_BUILTIN_PERSONA_PROMPT_DEFAULT_TRADING_ADVISOR).toBeUndefined();
    expect(parsed.ADVISOR_BUILTIN_PERSONA_PROMPT_RISK_COACH).toBeUndefined();
    expect(parsed.ADVISOR_BUILTIN_PERSONA_PROMPT_CHART_REVIEWER).toBeUndefined();
  });

  it('pass through provided values', () => {
    const parsed = envSchema.parse({
      ...baseEnv,
      ADVISOR_BUILTIN_PERSONA_PROMPT_DEFAULT_TRADING_ADVISOR: 'advisor prompt',
      ADVISOR_BUILTIN_PERSONA_PROMPT_RISK_COACH: 'risk prompt',
      ADVISOR_BUILTIN_PERSONA_PROMPT_CHART_REVIEWER: 'chart prompt',
    });
    expect(parsed.ADVISOR_BUILTIN_PERSONA_PROMPT_DEFAULT_TRADING_ADVISOR).toBe('advisor prompt');
    expect(parsed.ADVISOR_BUILTIN_PERSONA_PROMPT_RISK_COACH).toBe('risk prompt');
    expect(parsed.ADVISOR_BUILTIN_PERSONA_PROMPT_CHART_REVIEWER).toBe('chart prompt');
  });
});

describe('envSchema.FEATURE_GATING', () => {
  it('parses "true" to boolean true', () => {
    const parsed = envSchema.parse({ ...baseEnv, FEATURE_GATING: 'true' });
    expect(parsed.FEATURE_GATING).toBe(true);
  });

  it('parses "false" to boolean false', () => {
    const parsed = envSchema.parse({ ...baseEnv, FEATURE_GATING: 'false' });
    expect(parsed.FEATURE_GATING).toBe(false);
  });

  it('defaults to false when unset', () => {
    const parsed = envSchema.parse(baseEnv);
    expect(parsed.FEATURE_GATING).toBe(false);
  });

  it.each(['1', 'yes', '', '0', 'TRUE'])('rejects %j', (v) => {
    const result = envSchema.safeParse({ ...baseEnv, FEATURE_GATING: v });
    expect(result.success).toBe(false);
  });
});

describe('envSchema.FEATURE_GATING_ADVISOR_TURNS_PER_MONTH', () => {
  it('defaults to 200 when unset', () => {
    const parsed = envSchema.parse(baseEnv);
    expect(parsed.FEATURE_GATING_ADVISOR_TURNS_PER_MONTH).toBe(200);
  });

  it('coerces a numeric string', () => {
    const parsed = envSchema.parse({
      ...baseEnv,
      FEATURE_GATING_ADVISOR_TURNS_PER_MONTH: '50',
    });
    expect(parsed.FEATURE_GATING_ADVISOR_TURNS_PER_MONTH).toBe(50);
  });

  it.each(['0', '-1', '-200', '1.5', 'abc'])('rejects %j', (v) => {
    const result = envSchema.safeParse({
      ...baseEnv,
      FEATURE_GATING_ADVISOR_TURNS_PER_MONTH: v,
    });
    expect(result.success).toBe(false);
  });
});

describe('envSchema.SEED_ADMIN_EMAIL', () => {
  it('treats an empty string as unset (never a boot crash)', () => {
    const parsed = envSchema.parse({ ...baseEnv, SEED_ADMIN_EMAIL: '' });
    expect(parsed.SEED_ADMIN_EMAIL).toBeUndefined();
  });

  it('trims and lowercases before validating', () => {
    const parsed = envSchema.parse({ ...baseEnv, SEED_ADMIN_EMAIL: ' John@Example.com ' });
    expect(parsed.SEED_ADMIN_EMAIL).toBe('john@example.com');
  });

  it('is undefined when unset', () => {
    const parsed = envSchema.parse(baseEnv);
    expect(parsed.SEED_ADMIN_EMAIL).toBeUndefined();
  });

  it('rejects a non-email value', () => {
    const result = envSchema.safeParse({ ...baseEnv, SEED_ADMIN_EMAIL: 'not-an-email' });
    expect(result.success).toBe(false);
  });
});

describe('envSchema.CHANGELOG_GITHUB_REPO', () => {
  it.each(['owner/repo', 'owner/repo.name', 'a/repo'])('accepts valid slug %j', (v) => {
    const parsed = envSchema.parse({ ...baseEnv, CHANGELOG_GITHUB_REPO: v });
    expect(parsed.CHANGELOG_GITHUB_REPO).toBe(v);
  });

  it('defaults when unset', () => {
    const parsed = envSchema.parse(baseEnv);
    expect(parsed.CHANGELOG_GITHUB_REPO).toBe('madmatt112/tradr');
  });

  it('treats an empty string as unset (default, never a boot crash)', () => {
    const parsed = envSchema.parse({ ...baseEnv, CHANGELOG_GITHUB_REPO: '' });
    expect(parsed.CHANGELOG_GITHUB_REPO).toBe('madmatt112/tradr');
  });

  it.each(['owner/.', 'owner/..'])('rejects whole-segment dot repo %j', (v) => {
    const result = envSchema.safeParse({ ...baseEnv, CHANGELOG_GITHUB_REPO: v });
    expect(result.success).toBe(false);
  });

  it.each([
    'owner/repo%20name',
    'owner/repo?x=1',
    'owner/repo#frag',
    'owner/repo@v1',
    'owner/repo name',
    'owner/repo/extra',
    'https://github.com/owner/repo',
  ])('rejects %j (boot-fail behavior)', (v) => {
    const result = envSchema.safeParse({ ...baseEnv, CHANGELOG_GITHUB_REPO: v });
    expect(result.success).toBe(false);
  });

  it.each(['-owner/repo', 'owner-/repo'])('rejects leading/trailing hyphen in owner %j', (v) => {
    const result = envSchema.safeParse({ ...baseEnv, CHANGELOG_GITHUB_REPO: v });
    expect(result.success).toBe(false);
  });
});

describe('envSchema.CHANGELOG_GITHUB_BASE_URL', () => {
  it('defaults when unset', () => {
    const parsed = envSchema.parse(baseEnv);
    expect(parsed.CHANGELOG_GITHUB_BASE_URL).toBe('https://api.github.com');
  });

  it('treats an empty string as unset (default, never a boot crash)', () => {
    const parsed = envSchema.parse({ ...baseEnv, CHANGELOG_GITHUB_BASE_URL: '' });
    expect(parsed.CHANGELOG_GITHUB_BASE_URL).toBe('https://api.github.com');
  });

  it('accepts http://localhost:9999 (the stub seam)', () => {
    const parsed = envSchema.parse({
      ...baseEnv,
      CHANGELOG_GITHUB_BASE_URL: 'http://localhost:9999',
    });
    expect(parsed.CHANGELOG_GITHUB_BASE_URL).toBe('http://localhost:9999');
  });

  it('rejects a non-URL', () => {
    const result = envSchema.safeParse({ ...baseEnv, CHANGELOG_GITHUB_BASE_URL: 'not a url' });
    expect(result.success).toBe(false);
  });
});

describe('envSchema.POSTHOG_HOST', () => {
  it('defaults when unset', () => {
    const parsed = envSchema.parse(baseEnv);
    expect(parsed.POSTHOG_HOST).toBe('https://us.i.posthog.com');
  });

  it('treats an empty string as unset (default, never a boot crash)', () => {
    const parsed = envSchema.parse({ ...baseEnv, POSTHOG_HOST: '' });
    expect(parsed.POSTHOG_HOST).toBe('https://us.i.posthog.com');
  });

  it('preserves a provided URL', () => {
    const parsed = envSchema.parse({ ...baseEnv, POSTHOG_HOST: 'https://eu.i.posthog.com' });
    expect(parsed.POSTHOG_HOST).toBe('https://eu.i.posthog.com');
  });

  it('rejects a non-URL non-empty value (boot-fail behavior)', () => {
    const result = envSchema.safeParse({ ...baseEnv, POSTHOG_HOST: 'not a url' });
    expect(result.success).toBe(false);
  });
});

describe('envSchema backend telemetry optional strings', () => {
  it('POSTHOG_API_KEY is undefined when unset', () => {
    const parsed = envSchema.parse(baseEnv);
    expect(parsed.POSTHOG_API_KEY).toBeUndefined();
  });

  it('POSTHOG_API_KEY accepts an empty string and reads falsy', () => {
    const parsed = envSchema.parse({ ...baseEnv, POSTHOG_API_KEY: '' });
    expect(parsed.POSTHOG_API_KEY).toBe('');
    expect(!!parsed.POSTHOG_API_KEY).toBe(false);
  });

  it('passes through a provided value', () => {
    const parsed = envSchema.parse({ ...baseEnv, POSTHOG_API_KEY: 'phc_x' });
    expect(parsed.POSTHOG_API_KEY).toBe('phc_x');
  });
});

describe('isPostHogConfigured predicate', () => {
  // The predicate reads the live `config` object (parsed once at import). Mutate +
  // restore it to exercise the real predicate against each combination — the
  // established config-mutation test pattern (advisor.platform-billing.test.ts).
  const prev = { POSTHOG_API_KEY: config.POSTHOG_API_KEY };

  afterEach(() => {
    config.POSTHOG_API_KEY = prev.POSTHOG_API_KEY;
  });

  it('isPostHogConfigured is false when the key is empty (test.env pin-off)', () => {
    expect(isPostHogConfigured()).toBe(false);
  });

  it('isPostHogConfigured is true only for a non-empty key', () => {
    config.POSTHOG_API_KEY = '';
    expect(isPostHogConfigured()).toBe(false);
    config.POSTHOG_API_KEY = undefined;
    expect(isPostHogConfigured()).toBe(false);
    config.POSTHOG_API_KEY = 'phc_x';
    expect(isPostHogConfigured()).toBe(true);
  });
});

describe('isProSubscriptionConfigured predicate', () => {
  // Mutate + restore the live `config` object — the established config-mutation
  // test pattern (isPostHogConfigured above). '' reads falsy through the `!!`
  // predicate (D14 — the STRIPE_SECRET_KEY plain-optional-string precedent).
  const prev = {
    STRIPE_SECRET_KEY: config.STRIPE_SECRET_KEY,
    STRIPE_WEBHOOK_SECRET: config.STRIPE_WEBHOOK_SECRET,
    STRIPE_PRO_PRICE_ID: config.STRIPE_PRO_PRICE_ID,
  };

  afterEach(() => {
    Object.assign(config, prev);
  });

  it('is false when either Stripe or the price id is unset/empty (REQ-2.7)', () => {
    // Nothing set.
    config.STRIPE_SECRET_KEY = undefined;
    config.STRIPE_WEBHOOK_SECRET = undefined;
    config.STRIPE_PRO_PRICE_ID = undefined;
    expect(isProSubscriptionConfigured()).toBe(false);
    // Stripe configured, price id unset then empty ('' reads falsy — D14).
    config.STRIPE_SECRET_KEY = 'sk_test_x';
    config.STRIPE_WEBHOOK_SECRET = 'whsec_x';
    expect(isProSubscriptionConfigured()).toBe(false);
    config.STRIPE_PRO_PRICE_ID = '';
    expect(isProSubscriptionConfigured()).toBe(false);
    // Price id set, Stripe incomplete (webhook secret missing).
    config.STRIPE_PRO_PRICE_ID = 'price_x';
    config.STRIPE_WEBHOOK_SECRET = undefined;
    expect(isProSubscriptionConfigured()).toBe(false);
  });

  it('is true only when Stripe and the price id are both set', () => {
    config.STRIPE_SECRET_KEY = 'sk_test_x';
    config.STRIPE_WEBHOOK_SECRET = 'whsec_x';
    config.STRIPE_PRO_PRICE_ID = 'price_x';
    expect(isProSubscriptionConfigured()).toBe(true);
  });
});

describe('envSchema hosted-platform optional vars', () => {
  it('every hosted-platform var is undefined/default when unset (self-host parity, REQ-1.2)', () => {
    const parsed = envSchema.parse(baseEnv);
    expect(parsed.REDIS_URL).toBeUndefined();
    expect(parsed.DIRECT_DATABASE_URL).toBeUndefined();
    expect(parsed.DB_TRANSACTION_POOLER).toBe(false);
    expect(parsed.OBJECT_STORAGE_ENDPOINT).toBeUndefined();
    expect(parsed.OBJECT_STORAGE_BUCKET).toBeUndefined();
    expect(parsed.OBJECT_STORAGE_REGION).toBeUndefined();
    expect(parsed.OBJECT_STORAGE_ACCESS_KEY_ID).toBeUndefined();
    expect(parsed.OBJECT_STORAGE_SECRET_ACCESS_KEY).toBeUndefined();
    expect(parsed.OBJECT_STORAGE_FORCE_PATH_STYLE).toBe(true);
    expect(parsed.CORS_ALLOWED_ORIGINS).toBeUndefined();
    expect(parsed.ADVISOR_IMAGE_MAX_BYTES).toBeUndefined();
    expect(parsed.ADVISOR_MAX_REQUEST_BYTES).toBeUndefined();
  });

  it('treats an empty string as unset for the URL/preprocess vars (never a boot crash)', () => {
    const parsed = envSchema.parse({
      ...baseEnv,
      REDIS_URL: '',
      DIRECT_DATABASE_URL: '',
      OBJECT_STORAGE_ENDPOINT: '',
    });
    expect(parsed.REDIS_URL).toBeUndefined();
    expect(parsed.DIRECT_DATABASE_URL).toBeUndefined();
    expect(parsed.OBJECT_STORAGE_ENDPOINT).toBeUndefined();
  });

  it('accepts an empty string for the plain optional object-storage/CORS strings (reads falsy)', () => {
    const parsed = envSchema.parse({
      ...baseEnv,
      OBJECT_STORAGE_BUCKET: '',
      OBJECT_STORAGE_REGION: '',
      OBJECT_STORAGE_ACCESS_KEY_ID: '',
      OBJECT_STORAGE_SECRET_ACCESS_KEY: '',
      CORS_ALLOWED_ORIGINS: '',
    });
    expect(parsed.OBJECT_STORAGE_BUCKET).toBe('');
    expect(!!parsed.OBJECT_STORAGE_BUCKET).toBe(false);
    expect(parsed.CORS_ALLOWED_ORIGINS).toBe('');
  });

  it('parses provided values (URL validation, enum → boolean, coerced numbers)', () => {
    const parsed = envSchema.parse({
      ...baseEnv,
      REDIS_URL: 'redis://localhost:6379',
      DIRECT_DATABASE_URL: 'postgresql://postgres:postgres@direct:5432/tradr',
      DB_TRANSACTION_POOLER: 'true',
      OBJECT_STORAGE_ENDPOINT: 'https://account.r2.cloudflarestorage.com',
      OBJECT_STORAGE_BUCKET: 'advisor',
      OBJECT_STORAGE_REGION: 'auto',
      OBJECT_STORAGE_ACCESS_KEY_ID: 'key',
      OBJECT_STORAGE_SECRET_ACCESS_KEY: 'secret',
      OBJECT_STORAGE_FORCE_PATH_STYLE: 'false',
      CORS_ALLOWED_ORIGINS: 'https://app.tradr.cloud, https://tradr.cloud',
      ADVISOR_IMAGE_MAX_BYTES: '4500000',
      ADVISOR_MAX_REQUEST_BYTES: '20000000',
    });
    expect(parsed.REDIS_URL).toBe('redis://localhost:6379');
    expect(parsed.DB_TRANSACTION_POOLER).toBe(true);
    expect(parsed.OBJECT_STORAGE_FORCE_PATH_STYLE).toBe(false);
    expect(parsed.ADVISOR_IMAGE_MAX_BYTES).toBe(4_500_000);
    expect(parsed.ADVISOR_MAX_REQUEST_BYTES).toBe(20_000_000);
  });

  it('rejects a non-URL REDIS_URL / OBJECT_STORAGE_ENDPOINT (boot-fail)', () => {
    expect(envSchema.safeParse({ ...baseEnv, REDIS_URL: 'not a url' }).success).toBe(false);
    expect(envSchema.safeParse({ ...baseEnv, OBJECT_STORAGE_ENDPOINT: 'not a url' }).success).toBe(
      false,
    );
  });

  it.each(['1', 'yes', '', '0', 'TRUE'])('rejects DB_TRANSACTION_POOLER=%j', (v) => {
    expect(envSchema.safeParse({ ...baseEnv, DB_TRANSACTION_POOLER: v }).success).toBe(false);
  });

  it.each(['0', '-1', '1.5', 'abc'])(
    'rejects a non-positive-int ADVISOR_IMAGE_MAX_BYTES=%j',
    (v) => {
      expect(envSchema.safeParse({ ...baseEnv, ADVISOR_IMAGE_MAX_BYTES: v }).success).toBe(false);
    },
  );
});

describe('hosted-platform config predicates', () => {
  // Mutate + restore the live `config` object (parsed once at import) — the
  // established config-mutation test pattern (isPostHogConfigured above).
  const prev = {
    REDIS_URL: config.REDIS_URL,
    DIRECT_DATABASE_URL: config.DIRECT_DATABASE_URL,
    OBJECT_STORAGE_ENDPOINT: config.OBJECT_STORAGE_ENDPOINT,
    OBJECT_STORAGE_BUCKET: config.OBJECT_STORAGE_BUCKET,
    OBJECT_STORAGE_ACCESS_KEY_ID: config.OBJECT_STORAGE_ACCESS_KEY_ID,
    OBJECT_STORAGE_SECRET_ACCESS_KEY: config.OBJECT_STORAGE_SECRET_ACCESS_KEY,
    CORS_ALLOWED_ORIGINS: config.CORS_ALLOWED_ORIGINS,
  };

  afterEach(() => {
    Object.assign(config, prev);
  });

  it('all unset ⇒ every predicate false ⇒ today’s behavior (REQ-1.2)', () => {
    config.REDIS_URL = undefined;
    config.DIRECT_DATABASE_URL = undefined;
    config.OBJECT_STORAGE_ENDPOINT = undefined;
    config.OBJECT_STORAGE_BUCKET = undefined;
    config.OBJECT_STORAGE_ACCESS_KEY_ID = undefined;
    config.OBJECT_STORAGE_SECRET_ACCESS_KEY = undefined;
    config.CORS_ALLOWED_ORIGINS = undefined;
    expect(isObjectStorageConfigured()).toBe(false);
    expect(isRedisConfigured()).toBe(false);
    expect(isSplitOriginConfigured()).toBe(false);
    expect(isDirectDatabaseConfigured()).toBe(false);
    expect(getCorsAllowedOrigins()).toEqual([]);
  });

  it('empty-string config values read as unset by every predicate', () => {
    config.REDIS_URL = '';
    config.DIRECT_DATABASE_URL = '';
    config.OBJECT_STORAGE_ENDPOINT = '';
    config.OBJECT_STORAGE_BUCKET = '';
    config.OBJECT_STORAGE_ACCESS_KEY_ID = '';
    config.OBJECT_STORAGE_SECRET_ACCESS_KEY = '';
    config.CORS_ALLOWED_ORIGINS = '';
    expect(isObjectStorageConfigured()).toBe(false);
    expect(isRedisConfigured()).toBe(false);
    expect(isSplitOriginConfigured()).toBe(false);
    expect(isDirectDatabaseConfigured()).toBe(false);
    expect(getCorsAllowedOrigins()).toEqual([]);
  });

  it('isObjectStorageConfigured true only when endpoint + bucket + key + secret all present', () => {
    config.OBJECT_STORAGE_ENDPOINT = 'https://account.r2.cloudflarestorage.com';
    config.OBJECT_STORAGE_BUCKET = 'advisor';
    config.OBJECT_STORAGE_ACCESS_KEY_ID = 'key';
    config.OBJECT_STORAGE_SECRET_ACCESS_KEY = undefined;
    expect(isObjectStorageConfigured()).toBe(false);
    config.OBJECT_STORAGE_SECRET_ACCESS_KEY = 'secret';
    expect(isObjectStorageConfigured()).toBe(true);
  });

  it('isRedisConfigured / isDirectDatabaseConfigured true for a non-empty value', () => {
    config.REDIS_URL = 'redis://localhost:6379';
    expect(isRedisConfigured()).toBe(true);
    config.DIRECT_DATABASE_URL = 'postgresql://postgres:postgres@direct:5432/tradr';
    expect(isDirectDatabaseConfigured()).toBe(true);
  });

  it('isSplitOriginConfigured true for a non-empty allow-list; getCorsAllowedOrigins trims', () => {
    config.CORS_ALLOWED_ORIGINS = ' https://app.tradr.cloud , https://tradr.cloud ';
    expect(getCorsAllowedOrigins()).toEqual(['https://app.tradr.cloud', 'https://tradr.cloud']);
    expect(isSplitOriginConfigured()).toBe(true);
  });
});

describe('envSchema transactional-email vars', () => {
  it('all seven are undefined/default when unset', () => {
    const parsed = envSchema.parse(baseEnv);
    expect(parsed.SMTP_HOST).toBeUndefined();
    expect(parsed.SMTP_PORT).toBe(587);
    expect(parsed.SMTP_TLS_MODE).toBe('starttls');
    expect(parsed.SMTP_USER).toBeUndefined();
    expect(parsed.SMTP_PASS).toBeUndefined();
    expect(parsed.EMAIL_FROM).toBeUndefined();
    expect(parsed.EMAIL_FROM_NAME).toBeUndefined();
    expect(parsed.WEB_BASE_URL).toBeUndefined();
  });

  it("'' everywhere ≡ absent (compose ${VAR:-} simulation — never a boot crash)", () => {
    const parsed = envSchema.parse({
      ...baseEnv,
      SMTP_HOST: '',
      SMTP_PORT: '',
      SMTP_TLS_MODE: '',
      SMTP_USER: '',
      SMTP_PASS: '',
      EMAIL_FROM: '',
      EMAIL_FROM_NAME: '',
      WEB_BASE_URL: '',
    });
    expect(parsed.SMTP_HOST).toBeUndefined();
    expect(parsed.SMTP_PORT).toBe(587);
    expect(parsed.SMTP_TLS_MODE).toBe('starttls');
    expect(parsed.SMTP_USER).toBe('');
    expect(!!parsed.SMTP_USER).toBe(false);
    expect(parsed.SMTP_PASS).toBe('');
    expect(!!parsed.SMTP_PASS).toBe(false);
    expect(parsed.EMAIL_FROM).toBeUndefined();
    expect(parsed.EMAIL_FROM_NAME).toBeUndefined();
    expect(parsed.WEB_BASE_URL).toBeUndefined();
    expect(() => assertEmailConfigCoherence(parsed)).not.toThrow();
  });

  it('parses a full valid config', () => {
    const parsed = envSchema.parse({
      ...baseEnv,
      SMTP_HOST: 'smtp.example.com',
      SMTP_PORT: '2525',
      SMTP_TLS_MODE: 'implicit',
      SMTP_USER: 'mailer',
      SMTP_PASS: 'hunter2',
      EMAIL_FROM: 'no-reply@example.com',
      EMAIL_FROM_NAME: 'Tradr',
      WEB_BASE_URL: 'https://tradr.example.com',
    });
    expect(parsed.SMTP_HOST).toBe('smtp.example.com');
    expect(parsed.SMTP_PORT).toBe(2525);
    expect(parsed.SMTP_TLS_MODE).toBe('implicit');
    expect(parsed.SMTP_USER).toBe('mailer');
    expect(parsed.SMTP_PASS).toBe('hunter2');
    expect(parsed.EMAIL_FROM).toBe('no-reply@example.com');
    expect(parsed.EMAIL_FROM_NAME).toBe('Tradr');
    expect(parsed.WEB_BASE_URL).toBe('https://tradr.example.com');
  });

  it.each(['abc', '0', '-1', '65536', '1.5'])('rejects SMTP_PORT=%j (boot-fail)', (v) => {
    expect(envSchema.safeParse({ ...baseEnv, SMTP_PORT: v }).success).toBe(false);
  });

  it.each(['implicit', 'starttls', 'none'] as const)('accepts SMTP_TLS_MODE=%j', (v) => {
    const parsed = envSchema.parse({ ...baseEnv, SMTP_TLS_MODE: v });
    expect(parsed.SMTP_TLS_MODE).toBe(v);
  });

  it.each(['tls', 'ssl', 'STARTTLS', 'true'])('rejects SMTP_TLS_MODE=%j (boot-fail)', (v) => {
    expect(envSchema.safeParse({ ...baseEnv, SMTP_TLS_MODE: v }).success).toBe(false);
  });

  it('EMAIL_FROM trims but does NOT lowercase (sending identity, not lookup key)', () => {
    const parsed = envSchema.parse({ ...baseEnv, EMAIL_FROM: ' No-Reply@Example.com ' });
    expect(parsed.EMAIL_FROM).toBe('No-Reply@Example.com');
  });

  it('rejects a non-email EMAIL_FROM (boot-fail)', () => {
    expect(envSchema.safeParse({ ...baseEnv, EMAIL_FROM: 'not-an-email' }).success).toBe(false);
  });

  it.each(['Tradr\r\nBcc: evil@x.com', 'Tradr\nX', 'Tradr\r'])(
    'rejects EMAIL_FROM_NAME with CR/LF %j (header hygiene)',
    (v) => {
      expect(envSchema.safeParse({ ...baseEnv, EMAIL_FROM_NAME: v }).success).toBe(false);
    },
  );
});

describe('envSchema.WEB_BASE_URL', () => {
  it('strips a trailing slash — always a bare origin (D3)', () => {
    const parsed = envSchema.parse({ ...baseEnv, WEB_BASE_URL: 'https://tradr.example.com/' });
    expect(parsed.WEB_BASE_URL).toBe('https://tradr.example.com');
  });

  it('accepts an origin with an explicit port', () => {
    const parsed = envSchema.parse({ ...baseEnv, WEB_BASE_URL: 'http://localhost:5173' });
    expect(parsed.WEB_BASE_URL).toBe('http://localhost:5173');
  });

  it.each([
    'tradr.example.com', // no scheme — not an absolute URL
    '/reset-password', // relative
    'not a url',
    'https://tradr.example.com/app', // path-bearing
    'https://tradr.example.com/?x=1', // query
    'https://tradr.example.com/#frag', // fragment
    'ftp://tradr.example.com', // non-http(s) scheme
  ])('rejects %j (origin-only refine, boot-fail)', (v) => {
    expect(envSchema.safeParse({ ...baseEnv, WEB_BASE_URL: v }).success).toBe(false);
  });
});

describe('assertEmailConfigCoherence', () => {
  const trio = {
    SMTP_HOST: 'smtp.example.com',
    EMAIL_FROM: 'no-reply@example.com',
    WEB_BASE_URL: 'https://tradr.example.com',
  };

  it('is silent when email is wholly unconfigured', () => {
    expect(() => assertEmailConfigCoherence(envSchema.parse(baseEnv))).not.toThrow();
  });

  it('is silent for the full trio', () => {
    expect(() =>
      assertEmailConfigCoherence(envSchema.parse({ ...baseEnv, ...trio })),
    ).not.toThrow();
  });

  it('is silent for the full trio + coherent credential pair + display name', () => {
    const parsed = envSchema.parse({
      ...baseEnv,
      ...trio,
      SMTP_USER: 'mailer',
      SMTP_PASS: 'hunter2',
      EMAIL_FROM_NAME: 'Tradr',
    });
    expect(() => assertEmailConfigCoherence(parsed)).not.toThrow();
  });

  it('SMTP_PORT/SMTP_TLS_MODE alone are NOT presence signals (D2 — compose value defaults)', () => {
    const parsed = envSchema.parse({ ...baseEnv, SMTP_PORT: '587', SMTP_TLS_MODE: 'starttls' });
    expect(() => assertEmailConfigCoherence(parsed)).not.toThrow();
  });

  it.each([
    ['SMTP_HOST alone', { SMTP_HOST: trio.SMTP_HOST }, ['EMAIL_FROM', 'WEB_BASE_URL']],
    ['EMAIL_FROM alone', { EMAIL_FROM: trio.EMAIL_FROM }, ['SMTP_HOST', 'WEB_BASE_URL']],
    ['WEB_BASE_URL alone', { WEB_BASE_URL: trio.WEB_BASE_URL }, ['SMTP_HOST', 'EMAIL_FROM']],
    [
      'SMTP_HOST + EMAIL_FROM',
      { SMTP_HOST: trio.SMTP_HOST, EMAIL_FROM: trio.EMAIL_FROM },
      ['WEB_BASE_URL'],
    ],
    [
      'SMTP_HOST + WEB_BASE_URL',
      { SMTP_HOST: trio.SMTP_HOST, WEB_BASE_URL: trio.WEB_BASE_URL },
      ['EMAIL_FROM'],
    ],
    [
      'EMAIL_FROM + WEB_BASE_URL',
      { EMAIL_FROM: trio.EMAIL_FROM, WEB_BASE_URL: trio.WEB_BASE_URL },
      ['SMTP_HOST'],
    ],
    [
      'EMAIL_FROM_NAME alone',
      { EMAIL_FROM_NAME: 'Tradr' },
      ['SMTP_HOST', 'EMAIL_FROM', 'WEB_BASE_URL'],
    ],
    [
      'coherent credential pair without the trio',
      { SMTP_USER: 'mailer', SMTP_PASS: 'hunter2' },
      ['SMTP_HOST', 'EMAIL_FROM', 'WEB_BASE_URL'],
    ],
  ] as Array<[string, Record<string, string>, string[]]>)(
    'throws for %s, naming the missing vars',
    (_label, vars, missing) => {
      const parsed = envSchema.parse({ ...baseEnv, ...vars });
      let thrown: unknown;
      try {
        assertEmailConfigCoherence(parsed);
      } catch (e) {
        thrown = e;
      }
      expect(thrown).toBeInstanceOf(Error);
      for (const name of missing) {
        expect((thrown as Error).message).toContain(name);
      }
    },
  );

  it('throws for SMTP_USER without SMTP_PASS, naming both (incoherent pair)', () => {
    const parsed = envSchema.parse({ ...baseEnv, ...trio, SMTP_USER: 'mailer' });
    expect(() => assertEmailConfigCoherence(parsed)).toThrow(/SMTP_USER.*SMTP_PASS/s);
  });

  it('throws for SMTP_PASS without SMTP_USER, naming both (incoherent pair)', () => {
    const parsed = envSchema.parse({ ...baseEnv, ...trio, SMTP_PASS: 'hunter2' });
    expect(() => assertEmailConfigCoherence(parsed)).toThrow(/SMTP_PASS.*SMTP_USER/s);
  });
});

describe('isEmailConfigured', () => {
  // Mutate + restore the live `config` object — the established config-mutation
  // test pattern (isPostHogConfigured above). The predicate MUST read config
  // live per call; capturing at module load would break this toggle.
  const prev = {
    SMTP_HOST: config.SMTP_HOST,
    EMAIL_FROM: config.EMAIL_FROM,
    WEB_BASE_URL: config.WEB_BASE_URL,
  };

  afterEach(() => {
    Object.assign(config, prev);
  });

  it('is false in the test env (vitest workspace pin-off)', () => {
    expect(isEmailConfigured()).toBe(false);
  });

  it('is false for empty-string values (compose ${VAR:-} injection)', () => {
    config.SMTP_HOST = '';
    config.EMAIL_FROM = '';
    config.WEB_BASE_URL = '';
    expect(isEmailConfigured()).toBe(false);
  });

  it('is true only when the full trio is present (live read per call)', () => {
    config.SMTP_HOST = 'smtp.example.com';
    config.EMAIL_FROM = 'no-reply@example.com';
    config.WEB_BASE_URL = undefined;
    expect(isEmailConfigured()).toBe(false);
    config.WEB_BASE_URL = 'https://tradr.example.com';
    expect(isEmailConfigured()).toBe(true);
    config.SMTP_HOST = undefined;
    expect(isEmailConfigured()).toBe(false);
  });
});

describe('config literal-type narrowing', () => {
  it('WEEK_START_DAY is typed as 0 | 1, not number and not a single literal', () => {
    // Positive: MUST compile — proves the type is assignable to `0 | 1` (i.e., not widened to `number`).
    const _narrow: 0 | 1 = config.WEEK_START_DAY;

    // Negative: MUST fail — proves the type is NOT narrower than `0 | 1` (not `0` alone, not `1` alone).
    // If the regex/transform is ever tightened to a single literal, the @ts-expect-error becomes a
    // CI-breaking "Unused directive" error, forcing this test to be revisited intentionally.
    // @ts-expect-error — config.WEEK_START_DAY is not assignable to the narrower type `0`
    const _tooNarrow: 0 = config.WEEK_START_DAY;

    void _narrow;
    void _tooNarrow;
  });
});

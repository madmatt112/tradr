/**
 * Advisor startup + bootstrap-ordering tests (Task 28 — pinned count: 6).
 *
 * Cases:
 *  1. Unit: runDecryptCanary all-decryptable → no-op (DB transaction, real key).
 *  2. Unit: runDecryptCanary one undecryptable → process.exit(1) + startup_canary_failed log.
 *  3. Subprocess: wrong ENCRYPTION_KEY → exit 1, stderr contains startup_canary_failed.
 *  4. Subprocess: ENCRYPTION_KEY_FINGERPRINT mismatch → exit 1, stderr contains
 *     encryption_fingerprint_mismatch.
 *  5. Unit: applyBuiltinPersonaOverrides UPSERT works.
 *  6. Partial-order assertions (FIVE pairs per v4-4): mock the six bootstrap
 *     helpers via vi.doMock to push into a shared callOrder, await bootstrap(),
 *     assert the five pinned dependency pairs.
 *
 * _Requirements: 5.2, 5.3, 11.1, 11.4_
 */
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { eq } from 'drizzle-orm';
import postgres from 'postgres';
import { describe, it, expect, vi, afterEach, beforeAll } from 'vitest';

import { db } from '@/db';
import { advisorPersonas, advisorProviderKeys, users } from '@/db/schema';
import { encrypt, loadEncryptionKeyMaterial } from '@/lib/encryption';
import { logger } from '@/lib/logger';

import { HARNESS_USER_EMAIL_PREFIX } from './__fixtures__/startup-harness';
import { runDecryptCanary } from './startup';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const HARNESS = path.resolve(__dirname, '__fixtures__/startup-harness.ts');

let counter = 0;

// The vitest config sets a deterministic ENCRYPTION_KEY; load it into module
// state so encrypt()/decrypt() work in the in-process unit cases.
beforeAll(() => {
  loadEncryptionKeyMaterial();
});

async function seedUser(): Promise<string> {
  const [user] = await db
    .insert(users)
    .values({
      email: `adv-startup-${Date.now()}-${++counter}@example.com`,
      passwordHash: 'x'.repeat(60),
    })
    .returning();
  return user!.id;
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.resetModules();
});

describe('runDecryptCanary', () => {
  it('is a no-op when every sampled provider key decrypts', async () => {
    const userId = await seedUser();
    await db.insert(advisorProviderKeys).values({
      userId,
      providerId: 'openai',
      encryptedKey: encrypt('sk-good'),
      keyVersion: 1,
      defaultModel: 'gpt-4o',
      keyHintTail: 'good',
      lastUsedAt: null,
    });
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(((): never => {
      throw new Error('process.exit called');
    }) as never);

    await expect(runDecryptCanary()).resolves.toBeUndefined();
    expect(exitSpy).not.toHaveBeenCalled();
  });

  it('logs startup_canary_failed and process.exit(1) when a key is undecryptable', async () => {
    const userId = await seedUser();
    await db.insert(advisorProviderKeys).values({
      userId,
      providerId: 'openai',
      encryptedKey: 'not-a-valid-envelope',
      keyVersion: 1,
      defaultModel: 'gpt-4o',
      keyHintTail: 'bad0',
      lastUsedAt: null,
    });
    const errorSpy = vi.spyOn(logger, 'error').mockImplementation(() => {});
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => {
      // swallow so the rest of the function unwinds without killing the worker
    }) as never);

    await runDecryptCanary();

    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(errorSpy).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ event: 'startup_canary_failed' }),
    );
  });
});

describe('bootstrap subprocess startup checks', () => {
  it('exits 1 with startup_canary_failed when ENCRYPTION_KEY is wrong', async () => {
    const result = spawnSync('pnpm', ['exec', 'tsx', HARNESS, 'canary-wrong-key'], {
      cwd: path.resolve(__dirname, '../../..'),
      encoding: 'utf8',
      env: { ...process.env },
    });

    // Clean up the row the harness committed (it process.exit(1)'d before cleanup).
    await cleanupHarnessRows();

    expect(result.status).toBe(1);
    expect(result.stderr + result.stdout).toContain('startup_canary_failed');
  }, 60_000);

  it('exits 1 with encryption_fingerprint_mismatch when fingerprint does not match', () => {
    const result = spawnSync('pnpm', ['exec', 'tsx', HARNESS, 'fingerprint-mismatch'], {
      cwd: path.resolve(__dirname, '../../..'),
      encoding: 'utf8',
      env: { ...process.env },
    });

    expect(result.status).toBe(1);
    expect(result.stderr + result.stdout).toContain('encryption_fingerprint_mismatch');
  }, 60_000);
});

describe('applyBuiltinPersonaOverrides', () => {
  it('UPSERTs the env-var persona prompt onto the seeded built-in row', async () => {
    const overridePrompt = `OVERRIDDEN-${Date.now()}`;
    vi.stubEnv('ADVISOR_BUILTIN_PERSONA_PROMPT_DEFAULT_TRADING_ADVISOR', overridePrompt);
    // The override map is read from `config` at module load; re-import the module
    // so it picks up the stubbed env var.
    vi.resetModules();
    const { applyBuiltinPersonaOverrides: applyOverrides } = await import('./startup');

    await applyOverrides();

    const [row] = await db
      .select({ systemPrompt: advisorPersonas.systemPrompt })
      .from(advisorPersonas)
      .where(eq(advisorPersonas.id, 'default-trading-advisor'));

    expect(row?.systemPrompt).toBe(overridePrompt);
    vi.unstubAllEnvs();
  });
});

describe('bootstrap ordering (partial-order assertions, v4-4)', () => {
  it('runs the advisor startup helpers in a dependency-respecting order', async () => {
    const callOrder: string[] = [];

    vi.doMock('@/lib/encryption', () => ({
      loadEncryptionKeyMaterial: () => callOrder.push('loadEncryptionKeyMaterial'),
      runEncryptionFingerprintCheckIfConfigured: () =>
        callOrder.push('runEncryptionFingerprintCheckIfConfigured'),
    }));
    vi.doMock('@/db/migrate', () => ({
      runMigrations: async () => {
        callOrder.push('runMigrations');
      },
    }));
    vi.doMock('./startup', () => ({
      runDecryptCanary: async () => {
        callOrder.push('runDecryptCanary');
      },
      applyBuiltinPersonaOverrides: async () => {
        callOrder.push('applyBuiltinPersonaOverrides');
      },
    }));
    vi.doMock('./providers/registry', () => ({
      initProviderRegistry: () => callOrder.push('initProviderRegistry'),
    }));

    vi.resetModules();
    const { bootstrap } = await import('@/app');
    await bootstrap();

    // load → fingerprint-check: the fingerprint check reads the cached key from
    // loadEncryptionKeyMaterial; without the load step there is nothing to fingerprint.
    expect(callOrder.indexOf('loadEncryptionKeyMaterial')).toBeLessThan(
      callOrder.indexOf('runEncryptionFingerprintCheckIfConfigured'),
    );
    // fingerprint-check → migrations: per design v4-8, fail fast on key misconfig
    // BEFORE paying migration cost. Deploy-pipeline optimisation, not data flow
    // (see Task 28 v3-6 note above).
    expect(callOrder.indexOf('runEncryptionFingerprintCheckIfConfigured')).toBeLessThan(
      callOrder.indexOf('runMigrations'),
    );
    // migrations → canary: canary queries advisor_provider_keys which only exists post-migration.
    expect(callOrder.indexOf('runMigrations')).toBeLessThan(callOrder.indexOf('runDecryptCanary'));
    // migrations → persona-overrides: overrides UPSERT into advisor_personas which only exists post-migration.
    expect(callOrder.indexOf('runMigrations')).toBeLessThan(
      callOrder.indexOf('applyBuiltinPersonaOverrides'),
    );
    // canary → registry: registry depends on key validity proven by the canary.
    expect(callOrder.indexOf('runDecryptCanary')).toBeLessThan(
      callOrder.indexOf('initProviderRegistry'),
    );
  });
});

// Delete the user/key rows the harness committed before exiting. Cascade on
// users removes the paired advisor_provider_keys row, so the leaked
// undecryptable row cannot poison a later canary run.
async function cleanupHarnessRows(): Promise<void> {
  const databaseUrl =
    process.env.DATABASE_URL || 'postgresql://postgres:postgres@localhost:5433/tradr_test';
  const sql = postgres(databaseUrl, { max: 1 });
  try {
    await sql`DELETE FROM users WHERE email LIKE ${HARNESS_USER_EMAIL_PREFIX + '%'}`;
  } finally {
    await sql.end();
  }
}

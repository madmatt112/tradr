/**
 * Subprocess harness for startup.test.ts cases 3 and 4 (Task 28).
 *
 * Run via `tsx` with a mode argument:
 *   - `fingerprint-mismatch`: sets a wrong ENCRYPTION_KEY_FINGERPRINT and calls
 *     bootstrap(). The fingerprint check (which runs before runMigrations) exits 1
 *     and logs `encryption_fingerprint_mismatch`.
 *   - `canary-wrong-key`: seeds an advisor_provider_keys row encrypted with the
 *     CORRECT key, then boots with a WRONG ENCRYPTION_KEY. The decrypt canary
 *     (post-migrations) fails to decrypt the row, exits 1, and logs
 *     `startup_canary_failed`.
 *
 * The seeded user/key use the email prefix `startup-harness-canary-` so the
 * parent test can clean them up after the subprocess exits.
 */
/* eslint-disable no-restricted-syntax -- subprocess harness deliberately drives process.env to exercise bootstrap; it runs outside the app's config layer. */
import { fileURLToPath } from 'node:url';

import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';

const CORRECT_KEY = '00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff';
const WRONG_KEY = 'ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff';

export const HARNESS_USER_EMAIL_PREFIX = 'startup-harness-canary-';

async function seedUndecryptableRow(): Promise<void> {
  // Encrypt with the correct key so the row is only undecryptable under WRONG_KEY.
  process.env.ENCRYPTION_KEY = CORRECT_KEY;
  delete process.env.ENCRYPTION_KEY_FINGERPRINT;
  const { encrypt, loadEncryptionKeyMaterial } = await import('@/lib/encryption');
  loadEncryptionKeyMaterial();
  const ciphertext = encrypt('sk-correct-key-secret');

  const databaseUrl =
    process.env.DATABASE_URL || 'postgresql://postgres:postgres@localhost:5433/tradr_test';
  const sql = postgres(databaseUrl, { max: 1 });
  const db = drizzle(sql);
  const { users } = await import('@/db/schema');
  const { advisorProviderKeys } = await import('@/db/schema');
  try {
    const [user] = await db
      .insert(users)
      .values({
        email: `${HARNESS_USER_EMAIL_PREFIX}${Date.now()}@example.com`,
        passwordHash: 'x'.repeat(60),
      })
      .returning();
    await db.insert(advisorProviderKeys).values({
      userId: user!.id,
      providerId: 'openai',
      encryptedKey: ciphertext,
      keyVersion: 1,
      defaultModel: 'gpt-4o',
      keyHintTail: 'cret',
      lastUsedAt: null,
    });
  } finally {
    await sql.end();
  }
}

async function main(): Promise<void> {
  const mode = process.argv[2];

  if (mode === 'fingerprint-mismatch') {
    // A fingerprint that cannot match sha256(keyBytes).
    process.env.ENCRYPTION_KEY = CORRECT_KEY;
    process.env.ENCRYPTION_KEY_FINGERPRINT = '0'.repeat(64);
    const { bootstrap } = await import('@/app');
    await bootstrap();
    return;
  }

  if (mode === 'canary-wrong-key') {
    await seedUndecryptableRow();
    process.env.ENCRYPTION_KEY = WRONG_KEY;
    delete process.env.ENCRYPTION_KEY_FINGERPRINT;
    const { bootstrap } = await import('@/app');
    await bootstrap();
    return;
  }

  throw new Error(`unknown harness mode: ${mode}`);
}

// Only run when executed directly via `tsx` (the spawnSync entry point).
// When imported (e.g. startup.test.ts imports HARNESS_USER_EMAIL_PREFIX, or
// `vitest list` collects the importing test file), do NOT run — the
// module-level process.exit(1) would otherwise crash test collection.
const invokedAsEntry =
  process.argv[1] !== undefined && process.argv[1] === fileURLToPath(import.meta.url);

if (invokedAsEntry) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}

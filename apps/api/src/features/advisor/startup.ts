// Advisor bootstrap helpers (design §Bootstrap order, steps 5-6).
//
// - runDecryptCanary(): samples up to 5 advisor_provider_keys rows and attempts
//   to decrypt each. On ANY decrypt failure it logs `startup_canary_failed` and
//   process.exit(1). All-decryptable (or zero rows) is a no-op. This catches a
//   rotation mismatch in production deploys (REQ-5.2).
// - applyBuiltinPersonaOverrides(): UPSERTs the three ADVISOR_BUILTIN_PERSONA_PROMPT_*
//   env-var overrides into advisor_personas. Seeding is owned by the migration;
//   this only overwrites system_prompt when an override is set (REQ-7.10).
//
// Both run AFTER runMigrations() so the schema and seeded built-ins exist.

import { sql } from 'drizzle-orm';

import { db } from '@/db';
import { advisorPersonas, advisorProviderKeys } from '@/db/schema/advisor.schema';
import { config } from '@/lib/config';
import { decrypt, EncryptionError } from '@/lib/encryption';
import { logger } from '@/lib/logger';

const CANARY_SAMPLE_SIZE = 5;

/**
 * Sample up to 5 provider-key rows and attempt to decrypt each. On any failure,
 * log `startup_canary_failed` and process.exit(1). No-op on fresh installs.
 */
export async function runDecryptCanary(): Promise<void> {
  const rows = await db
    .select({ id: advisorProviderKeys.id, encryptedKey: advisorProviderKeys.encryptedKey })
    .from(advisorProviderKeys)
    .orderBy(sql`random()`)
    .limit(CANARY_SAMPLE_SIZE);

  if (rows.length === 0) return;

  const sampleErrors: { rowId: string; errorKind: string }[] = [];
  let decryptSuccessCount = 0;

  for (const row of rows) {
    try {
      decrypt(row.encryptedKey);
      decryptSuccessCount += 1;
    } catch (err) {
      const errorKind = err instanceof EncryptionError ? err.reason : 'unknown';
      sampleErrors.push({ rowId: row.id, errorKind });
    }
  }

  if (sampleErrors.length > 0) {
    logger.error('Startup decrypt canary failed', {
      event: 'startup_canary_failed',
      sampledTotal: rows.length,
      decryptSuccessCount,
      decryptFailureCount: sampleErrors.length,
      sampleErrors,
    });
    process.exit(1);
  }
}

// Maps each built-in persona id to its override env-var value (if set).
const PERSONA_OVERRIDES: { id: string; prompt: string | undefined }[] = [
  {
    id: 'default-trading-advisor',
    prompt: config.ADVISOR_BUILTIN_PERSONA_PROMPT_DEFAULT_TRADING_ADVISOR,
  },
  { id: 'risk-coach', prompt: config.ADVISOR_BUILTIN_PERSONA_PROMPT_RISK_COACH },
  { id: 'chart-reviewer', prompt: config.ADVISOR_BUILTIN_PERSONA_PROMPT_CHART_REVIEWER },
];

/**
 * UPSERT the ADVISOR_BUILTIN_PERSONA_PROMPT_* env-var overrides into
 * advisor_personas. Uses ON CONFLICT DO UPDATE so overrides actually apply to
 * the migration-seeded rows. Does NOT create personas the migration does not
 * seed — the row insert here only fires if the seeded row is somehow absent.
 */
export async function applyBuiltinPersonaOverrides(): Promise<void> {
  for (const { id, prompt } of PERSONA_OVERRIDES) {
    if (prompt === undefined) continue;

    await db
      .insert(advisorPersonas)
      .values({
        id,
        name: id,
        systemPrompt: prompt,
        isBuiltin: true,
        isDefault: false,
      })
      .onConflictDoUpdate({
        target: advisorPersonas.id,
        set: { systemPrompt: prompt, updatedAt: new Date() },
      });
  }
}

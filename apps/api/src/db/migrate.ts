import { readdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { drizzle } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import postgres from 'postgres';

import { config } from '@/lib/config';
import { logger } from '@/lib/logger';

import * as schema from './schema';

export const MIGRATIONS_LOCK_KEY = 7064001n;
export const POST_MIGRATIONS_LOCK_KEY = 7064002n;

const __thisDir = dirname(fileURLToPath(import.meta.url));
export const MIGRATIONS_DIR = join(__thisDir, 'migrations');
export const POST_MIGRATIONS_DIR = join(__thisDir, 'post-migrations');

const CREATE_INDEX_CONCURRENTLY_RE =
  /^[ \t]*CREATE\s+INDEX\s+CONCURRENTLY(?:\s+IF\s+NOT\s+EXISTS)?\s+(\w+)/im;

/**
 * Resolve the migration connection URL (REQ-9.1/9.3, D6).
 *
 * Migrations serialize via a SESSION-level `pg_advisory_lock` (see `:31`), which
 * is only correct on a DIRECT (non-pooled) connection: a transaction-mode pooler
 * does not guarantee the lock-holding session runs the subsequent migration
 * statements. So when `DB_TRANSACTION_POOLER` is on we REQUIRE a
 * `DIRECT_DATABASE_URL` and FAIL LOUD if it is missing (REQ-9.5) — a misconfigured
 * pooler boot must crash clearly, not race silently.
 *
 * With both unset (self-host single-Postgres) this returns `DATABASE_URL` exactly
 * as today (REQ-1.2/9.3) — no behavioral change.
 */
export function resolveMigrationUrl(
  directUrl: string | undefined,
  databaseUrl: string,
  transactionPooler: boolean,
): string {
  if (transactionPooler && !directUrl) {
    throw new Error(
      'DB_TRANSACTION_POOLER=true requires DIRECT_DATABASE_URL: the migration advisory ' +
        'lock needs a direct (non-pooled) connection. Set DIRECT_DATABASE_URL to a ' +
        'non-pooled Postgres URL, or unset DB_TRANSACTION_POOLER for self-host.',
    );
  }
  return directUrl ?? databaseUrl;
}

export async function runMigrations(): Promise<void> {
  const migrationsSql = postgres(
    resolveMigrationUrl(
      config.DIRECT_DATABASE_URL,
      config.DATABASE_URL,
      config.DB_TRANSACTION_POOLER,
    ),
    {
      max: 1,
      types: { bigint: postgres.BigInt },
    },
  );
  const migrationsDb = drizzle(migrationsSql, { schema });
  try {
    await migrationsSql`SELECT pg_advisory_lock(${MIGRATIONS_LOCK_KEY})`;
    await migrate(migrationsDb, { migrationsFolder: MIGRATIONS_DIR });
  } finally {
    try {
      await migrationsSql`SELECT pg_advisory_unlock(${MIGRATIONS_LOCK_KEY})`;
    } catch {
      // Best-effort unlock; .end() below will terminate the session and free the lock anyway.
    }
    await migrationsSql.end();
  }
}

export async function runPostMigrations(): Promise<void> {
  const sql = postgres(
    resolveMigrationUrl(
      config.DIRECT_DATABASE_URL,
      config.DATABASE_URL,
      config.DB_TRANSACTION_POOLER,
    ),
    {
      max: 1,
      types: { bigint: postgres.BigInt },
    },
  );
  try {
    await sql`SELECT pg_advisory_lock(${POST_MIGRATIONS_LOCK_KEY})`;

    const entries = await readdir(POST_MIGRATIONS_DIR);
    const sqlFiles = entries.filter((f) => f.endsWith('.sql')).sort();

    for (const filename of sqlFiles) {
      const journalRows = await sql<{ filename: string }[]>`
        SELECT filename FROM _post_migrations_journal WHERE filename = ${filename}
      `;
      if (journalRows.length > 0) {
        logger.info('post-migration skipped (already applied)', { filename });
        continue;
      }

      const filePath = join(POST_MIGRATIONS_DIR, filename);
      const sqlContents = await readFile(filePath, 'utf8');

      const indexMatch = sqlContents.match(CREATE_INDEX_CONCURRENTLY_RE);
      const indexName = indexMatch?.[1];

      if (indexName) {
        const invalidRows = await sql<{ indisvalid: boolean }[]>`
          SELECT pg_index.indisvalid
          FROM pg_class
          JOIN pg_index ON pg_index.indexrelid = pg_class.oid
          WHERE pg_class.relname = ${indexName}
        `;
        if (invalidRows.length > 0 && invalidRows[0]?.indisvalid === false) {
          logger.warn('post-migration dropping invalid index before retry', {
            filename,
            indexName,
          });
          await sql.unsafe(`DROP INDEX CONCURRENTLY IF EXISTS ${indexName}`);
        }
      }

      logger.info('post-migration applying', { filename });
      await sql.unsafe(sqlContents);

      if (indexName) {
        const postCheck = await sql<{ indisvalid: boolean }[]>`
          SELECT pg_index.indisvalid
          FROM pg_class
          JOIN pg_index ON pg_index.indexrelid = pg_class.oid
          WHERE pg_class.relname = ${indexName}
        `;
        if (postCheck.length === 0 || postCheck[0]?.indisvalid !== true) {
          throw new Error(`post-migration ${filename} produced invalid index ${indexName}`);
        }
      }

      await sql`
        INSERT INTO _post_migrations_journal (filename) VALUES (${filename})
        ON CONFLICT DO NOTHING
      `;
      logger.info('post-migration applied', { filename });
    }
  } finally {
    try {
      await sql`SELECT pg_advisory_unlock(${POST_MIGRATIONS_LOCK_KEY})`;
    } catch {
      // Best-effort unlock; .end() below frees the session-scoped lock anyway.
    }
    await sql.end();
  }
}

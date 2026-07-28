/**
 * Safe-disable + reclamation for the object-storage backend (hosted-platform
 * Task 13; design §Component 9; REQ-3.1/3.2/3.3/3.4, REQ-2.4).
 *
 * Two operator maintenance operations, both backing `tradr storage …`:
 *   - `migrateToInline` — REQ-3 branch (b): pull every object-pointer image row
 *     back to inline base64-in-JSONB so the backend can be turned off without
 *     stranding any conversation. Idempotent, resumable, report-and-continue.
 *   - `runGc` — REQ-3.2 backstop: age-guarded sweep of unreferenced bucket
 *     objects (orphans from conversation deletes / retries), with a derived age
 *     floor that never reaps an in-flight put-before-commit object.
 *
 * The DB read/write functions take an injected `postgres.Sql` and `ObjectStorage`
 * so they are exercised against a real Postgres + a fake bucket in tests. The
 * `run…` entrypoints open the CLI's own pooler-safe one-shot connection.
 */
import postgres from 'postgres';

import type { StoredContentPart } from '@tradr/shared';

import { config } from '@/lib/config';
import { logger } from '@/lib/logger';
import { getObjectStorage, type ObjectStorage } from '@/lib/object-storage';

/** Bucket prefix every advisor image lives under (`advisor/{userId}/{uuid}`, D9). */
const ADVISOR_OBJECT_PREFIX = 'advisor/';

/**
 * Fixed safety buffer added on top of the config-derived in-flight-turn bound when
 * deriving the gc age floor (REQ-3.2). Small relative to the derived term — the
 * load-bearing value is the config-derived turn bound, not this margin.
 */
const GC_AGE_FLOOR_MARGIN_MS = 60_000;

/** An `advisor_messages.content_parts` image part that is an object pointer. */
type StoredImagePointer = {
  type: 'image';
  format: 'png' | 'jpeg' | 'webp';
  storage: { kind: 'object'; key: string };
};

export interface MigrateToInlineResult {
  /** Rows scanned that still carried at least one object pointer. */
  scannedRows: number;
  /** Image parts fetched from the bucket and re-inlined as base64. */
  migratedParts: number;
  /** Image parts whose object was gone out-of-band, marked unrecoverable (REQ-3.3). */
  unrecoverableParts: number;
  /** Rows updated (each in its own transaction). */
  updatedRows: number;
}

export interface GcResult {
  /** Distinct live pointer keys referenced by `content_parts` (the protected set). */
  liveKeys: number;
  /** Objects returned by `storage.list`. */
  listed: number;
  /** Aged unreferenced objects deleted. */
  deleted: number;
  /** Objects kept because their key is still referenced (live). */
  keptReferenced: number;
  /** Objects kept because they are younger than the age floor (put-before-commit guard). */
  keptTooYoung: number;
}

/**
 * True for an `content_parts` image part that is an OBJECT pointer (not inline and
 * not already unrecoverable). `in`-narrows to the pointer variant.
 */
function isObjectPointer(part: StoredContentPart): part is StoredImagePointer {
  return part.type === 'image' && 'storage' in part && part.storage.kind === 'object';
}

/**
 * Re-inline every object-pointer image back to base64-in-JSONB so the backend can
 * be safely disabled (REQ-3, branch (b), D2).
 *
 * IDEMPOTENT: the scan only selects rows still containing an object pointer, and
 * within a row already-inline / already-unrecoverable / text / tool parts are
 * passed through untouched — so a second run migrates nothing.
 *
 * RESUMABLE: each row is updated in its own transaction (a single atomic UPDATE),
 * so an interrupted run leaves every row wholly old (still a pointer, re-selected
 * next run) or wholly new (inline/unrecoverable) — never half-converted.
 *
 * REPORT-AND-CONTINUE: a pointer whose object is gone out-of-band is marked
 * `{storage:{kind:'unrecoverable'}}` (REQ-3.3 — renders as the placeholder) and
 * `warn`-logged; the run is NEVER aborted on one gone object.
 */
export async function migrateToInline(
  sql: postgres.Sql,
  storage: ObjectStorage,
): Promise<MigrateToInlineResult> {
  // `@>` array containment matches any element carrying storage.kind='object'.
  // Already-inline and already-unrecoverable rows never match, so re-running is a
  // no-op over them (idempotent).
  const rows = await sql<{ id: string; content_parts: StoredContentPart[] }[]>`
    SELECT id, content_parts
    FROM advisor_messages
    WHERE content_parts @> '[{"storage":{"kind":"object"}}]'::jsonb
    ORDER BY id
  `;

  const result: MigrateToInlineResult = {
    scannedRows: rows.length,
    migratedParts: 0,
    unrecoverableParts: 0,
    updatedRows: 0,
  };

  for (const row of rows) {
    const nextParts: StoredContentPart[] = [];
    let migrated = 0;
    let unrecoverable = 0;

    for (const part of row.content_parts) {
      if (!isObjectPointer(part)) {
        nextParts.push(part); // inline / unrecoverable / text / tool — untouched
        continue;
      }
      const { key } = part.storage;
      try {
        const { bytes } = await storage.get(key);
        nextParts.push({
          type: 'image',
          format: part.format,
          dataBase64: Buffer.from(bytes).toString('base64'),
        });
        migrated += 1;
      } catch (err) {
        // Gone out-of-band (lifecycle rule / provider switch / manual wipe): mark
        // unrecoverable and continue — never abort the whole run (REQ-3.3, NFR M2 §19).
        logger.warn('storage migrate-to-inline: unrecoverable pointer', {
          messageId: row.id,
          key,
          error: err instanceof Error ? err.message : String(err),
        });
        nextParts.push({ type: 'image', format: part.format, storage: { kind: 'unrecoverable' } });
        unrecoverable += 1;
      }
    }

    // Per-row transaction (a single UPDATE is atomic) — resumable (REQ-3.3).
    // `sql.json` serializes the array as a jsonb value (a bare JS array would be
    // sent as a Postgres array by postgres.js).
    await sql`
      UPDATE advisor_messages
      SET content_parts = ${sql.json(nextParts as never)}
      WHERE id = ${row.id}
    `;
    result.migratedParts += migrated;
    result.unrecoverableParts += unrecoverable;
    result.updatedRows += 1;
  }

  return result;
}

/**
 * The gc age floor (REQ-3.2): an object is written to the bucket BEFORE its pointer
 * row commits (write seam, `streaming.ts`), so until the pointer commits the object
 * is unreferenced yet MUST NOT be reaped. The put→commit gap is bounded by the
 * longest an advisor turn can be in-flight — the stream timeout and the reservation
 * hold TTL (`RESERVATION_TTL_MS`, strictly greater than the per-turn wall-clock
 * budget). Take the larger of the two real config values plus a fixed margin; a
 * too-young unreferenced object is therefore always KEPT.
 */
export function deriveGcAgeFloorMs(): number {
  return (
    Math.max(config.ADVISOR_STREAM_TIMEOUT_MS, config.RESERVATION_TTL_MS) + GC_AGE_FLOOR_MARGIN_MS
  );
}

/** The set of live (referenced) object-pointer keys, from a `content_parts` jsonb scan. */
export async function collectLiveKeys(sql: postgres.Sql): Promise<Set<string>> {
  const rows = await sql<{ key: string | null }[]>`
    SELECT DISTINCT part->'storage'->>'key' AS key
    FROM advisor_messages, jsonb_array_elements(content_parts) AS part
    WHERE part->'storage'->>'kind' = 'object'
  `;
  const keys = new Set<string>();
  for (const r of rows) if (r.key) keys.add(r.key);
  return keys;
}

/**
 * Age-guarded sweep of unreferenced bucket objects (REQ-3.2 backstop). Deletes an
 * object only when its key is NOT in the live set AND it is older than the derived
 * age floor — so a live (referenced) key is never deleted and an in-flight
 * put-before-commit object (too young) is always kept.
 *
 * `now` / `ageFloorMs` are injectable for deterministic tests; production uses
 * `Date.now()` and `deriveGcAgeFloorMs()`.
 */
export async function runGc(
  sql: postgres.Sql,
  storage: ObjectStorage,
  opts: { now?: number; ageFloorMs?: number } = {},
): Promise<GcResult> {
  const now = opts.now ?? Date.now();
  const ageFloorMs = opts.ageFloorMs ?? deriveGcAgeFloorMs();

  const liveKeys = await collectLiveKeys(sql);
  const objects = await storage.list(ADVISOR_OBJECT_PREFIX);

  const result: GcResult = {
    liveKeys: liveKeys.size,
    listed: objects.length,
    deleted: 0,
    keptReferenced: 0,
    keptTooYoung: 0,
  };

  for (const obj of objects) {
    if (liveKeys.has(obj.key)) {
      result.keptReferenced += 1;
      continue;
    }
    if (now - obj.lastModified.getTime() <= ageFloorMs) {
      // Too young — could be an in-flight put-before-commit object (REQ-3.2). KEEP.
      result.keptTooYoung += 1;
      continue;
    }
    await storage.delete(obj.key);
    result.deleted += 1;
  }

  return result;
}

/**
 * The CLI's own pooler-safe one-shot connection (design §Component 7, SF-5): the
 * non-pooled `DIRECT_DATABASE_URL` when set (bypasses a transaction pooler), else
 * `DATABASE_URL`; `prepare:false` so the CLI is safe behind a transaction-mode
 * pooler regardless of the app pool. Independent of the app-runtime pool.
 */
function openMaintenanceConnection(): postgres.Sql {
  return postgres(config.DIRECT_DATABASE_URL ?? config.DATABASE_URL, {
    max: 1,
    prepare: false,
    types: { bigint: postgres.BigInt },
    onnotice: () => {},
  });
}

/** Entrypoint for `tradr storage migrate-to-inline`. Returns a process exit code. */
export async function runStorageMigrateToInline(): Promise<number> {
  const storage = getObjectStorage();
  if (!storage) {
    console.error(
      'Object storage is not configured — nothing to migrate. Configure OBJECT_STORAGE_* and ' +
        'keep it reachable, then run `tradr storage migrate-to-inline` to pull pointer rows back ' +
        'to inline BEFORE disabling the backend.',
    );
    return 2;
  }
  const sql = openMaintenanceConnection();
  try {
    const r = await migrateToInline(sql, storage);
    console.log(
      `storage migrate-to-inline complete: scanned ${r.scannedRows} pointer row(s); ` +
        `re-inlined ${r.migratedParts} image part(s); marked ${r.unrecoverableParts} ` +
        `unrecoverable; updated ${r.updatedRows} row(s).`,
    );
    return 0;
  } catch (err) {
    console.error('storage migrate-to-inline failed.');
    console.error(err instanceof Error ? err.message : String(err));
    return 2;
  } finally {
    await sql.end();
  }
}

/** Entrypoint for `tradr storage gc`. Returns a process exit code. */
export async function runStorageGc(): Promise<number> {
  const storage = getObjectStorage();
  if (!storage) {
    console.error(
      'Object storage is not configured — there is no bucket to sweep. Set OBJECT_STORAGE_* to enable gc.',
    );
    return 2;
  }
  const sql = openMaintenanceConnection();
  try {
    const r = await runGc(sql, storage);
    console.log(
      `storage gc complete: ${r.liveKeys} live key(s); listed ${r.listed} object(s); ` +
        `deleted ${r.deleted} aged-unreferenced; kept ${r.keptReferenced} referenced + ` +
        `${r.keptTooYoung} too-young.`,
    );
    return 0;
  } catch (err) {
    console.error('storage gc failed.');
    console.error(err instanceof Error ? err.message : String(err));
    return 2;
  } finally {
    await sql.end();
  }
}

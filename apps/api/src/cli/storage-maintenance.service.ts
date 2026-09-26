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
import { getObjectStorage, USER_OBJECT_PREFIXES, type ObjectStorage } from '@/lib/object-storage';
import { runGcFenced } from '@/lib/object-storage/gc-fence';
import { purgeUserObjects } from '@/lib/object-storage/purge';

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
  /** Position-image pointers fetched from the bucket and re-inlined as base64. */
  positionImagesMigrated: number;
  /** Position-image pointers whose object was gone, marked unrecoverable (REQ-3.3). */
  positionImagesUnrecoverable: number;
}

export interface GcResult {
  /** Distinct live pointer keys referenced by `content_parts` (the protected set). */
  liveKeys: number;
  /** Objects returned by `storage.list`, across every prefix. */
  listed: number;
  /** Objects returned by `storage.list`, broken down per prefix. */
  listedByPrefix: Record<string, number>;
  /** Aged unreferenced objects deleted. */
  deleted: number;
  /** Objects kept because their key is still referenced (live). */
  keptReferenced: number;
  /** Objects kept because they are younger than the age floor (put-before-commit guard). */
  keptTooYoung: number;
  /** Unfinished tombstones whose object purge completed on this run (→ `complete`). */
  tombstonesCompleted: number;
  /** Unfinished tombstones whose object purge still did not complete (left as-is). */
  tombstonesIncomplete: number;
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
    positionImagesMigrated: 0,
    positionImagesUnrecoverable: 0,
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

  // Position images (D10): one `part` object per row (not an array). `@>` object
  // containment matches only rows still carrying an object pointer, so re-running
  // is a no-op over already-inline / already-unrecoverable rows (idempotent).
  const positionRows = await sql<{ id: string; part: StoredContentPart }[]>`
    SELECT id, part
    FROM position_images
    WHERE part @> '{"storage":{"kind":"object"}}'::jsonb
    ORDER BY id
  `;

  for (const row of positionRows) {
    if (!isObjectPointer(row.part)) continue; // filter guarantees a pointer
    const { key } = row.part.storage;
    let next: StoredContentPart;
    try {
      const { bytes } = await storage.get(key);
      next = {
        type: 'image',
        format: row.part.format,
        dataBase64: Buffer.from(bytes).toString('base64'),
      };
      result.positionImagesMigrated += 1;
    } catch (err) {
      // Gone out-of-band: mark unrecoverable and continue — never abort (REQ-3.3).
      logger.warn('storage migrate-to-inline: unrecoverable position-image pointer', {
        positionImageId: row.id,
        key,
        error: err instanceof Error ? err.message : String(err),
      });
      next = { type: 'image', format: row.part.format, storage: { kind: 'unrecoverable' } };
      result.positionImagesUnrecoverable += 1;
    }
    // Per-row transaction (a single UPDATE is atomic) — resumable (REQ-3.3).
    await sql`
      UPDATE position_images
      SET part = ${sql.json(next as never)}
      WHERE id = ${row.id}
    `;
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

/**
 * The set of live (referenced) object-pointer keys, unioned across both homes:
 * the advisor's `content_parts` array (a jsonb scan) and the position-image
 * `part` object (D10). Either home keeps its own key from a gc sweep.
 */
export async function collectLiveKeys(sql: postgres.Sql): Promise<Set<string>> {
  const rows = await sql<{ key: string | null }[]>`
    SELECT DISTINCT part->'storage'->>'key' AS key
    FROM advisor_messages, jsonb_array_elements(content_parts) AS part
    WHERE part->'storage'->>'kind' = 'object'
    UNION
    SELECT DISTINCT part->'storage'->>'key' AS key
    FROM position_images
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

  // List every home's prefix and concatenate; one loop then sweeps them all.
  const listedByPrefix: Record<string, number> = {};
  const objects: Array<{ key: string; lastModified: Date }> = [];
  for (const prefix of USER_OBJECT_PREFIXES) {
    const listed = await storage.list(prefix);
    listedByPrefix[prefix] = listed.length;
    objects.push(...listed);
  }

  const result: GcResult = {
    liveKeys: liveKeys.size,
    listed: objects.length,
    listedByPrefix,
    deleted: 0,
    keptReferenced: 0,
    keptTooYoung: 0,
    tombstonesCompleted: 0,
    tombstonesIncomplete: 0,
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

  // Last step (design C9, D13; Req 5.3): complete any unfinished tombstone purge.
  // A deletion whose post-commit purge was `pending` (never ran) or `incomplete`
  // (a key remained) is retried here through the same per-user helper — the
  // operator backstop. Raw SQL over the injected connection, the `collectLiveKeys`
  // idiom. `purgeUserObjects` never throws; the tombstone is marked `complete` only
  // on an honest `complete`, otherwise it is left for the next sweep.
  const unfinished = await sql<{ user_id: string }[]>`
    SELECT user_id
    FROM account_deletions
    WHERE purge_outcome IN ('pending', 'incomplete')
  `;
  for (const { user_id } of unfinished) {
    const outcome = await purgeUserObjects(storage, user_id);
    if (outcome === 'complete') {
      await sql`
        UPDATE account_deletions
        SET purge_outcome = 'complete'
        WHERE user_id = ${user_id}
      `;
      result.tombstonesCompleted += 1;
    } else {
      result.tombstonesIncomplete += 1;
    }
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
        `unrecoverable; updated ${r.updatedRows} row(s). Position images: re-inlined ` +
        `${r.positionImagesMigrated}; marked ${r.positionImagesUnrecoverable} unrecoverable.`,
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
    const r = await runGcFenced(sql, storage);
    if (r === 'import-in-progress') {
      // gc refuses while an import holds the fence, so it never deletes an object a
      // live import wrote (design C8, Req 7.3). Nothing was listed or deleted.
      console.error(
        'storage gc skipped: an account import is in progress. gc did not delete anything — ' +
          'it will not run while an import holds the fence. Re-run `tradr storage gc` once the ' +
          'import has finished.',
      );
      return 2;
    }
    const byPrefix = Object.entries(r.listedByPrefix)
      .map(([prefix, count]) => `${prefix} ${count}`)
      .join(', ');
    console.log(
      `storage gc complete: ${r.liveKeys} live key(s); listed ${r.listed} object(s) ` +
        `(${byPrefix}); deleted ${r.deleted} aged-unreferenced; kept ${r.keptReferenced} ` +
        `referenced + ${r.keptTooYoung} too-young. Tombstones: completed ` +
        `${r.tombstonesCompleted}, still incomplete ${r.tombstonesIncomplete}.`,
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

/**
 * The gc/import advisory fence (design C8, D1; Req 7.3/7.4).
 *
 * `tradr storage gc` and an in-progress account import must not race over the
 * same objects: an import writes objects to the bucket BEFORE the restore
 * transaction commits its pointer rows, so during that window the objects are
 * unreferenced yet MUST NOT be reaped — independently of `deriveGcAgeFloorMs()`
 * and of how long the import runs. A transaction-scoped Postgres advisory lock
 * on `GC_FENCE_KEY` is the mechanism:
 *
 *   - The import restore transaction takes the SHARED lock
 *     (`holdImportFence`) before its first `storage.put`, holding it until the
 *     transaction commits or rolls back — the pointer rows and the fence release
 *     in the same commit.
 *   - gc tries the EXCLUSIVE lock non-blockingly (`runGcFenced`). It conflicts
 *     with any held shared lock, so a true result means no import holds the fence
 *     until gc commits, and every earlier import's pointers are already visible;
 *     a false result means an import is in progress — gc does nothing.
 *
 * gc never WAITS on the fence, so the two cannot deadlock (D1).
 */
import { sql } from 'drizzle-orm';
import type postgres from 'postgres';

import { runGc, type GcResult } from '@/cli/storage-maintenance.service';
import type { Transaction } from '@/db';
import type { ObjectStorage } from '@/lib/object-storage';

/**
 * The advisory-lock key that fences gc against in-progress imports. Follows the
 * migration key series (`7064001`/`7064002`, `apps/api/src/db/migrate.ts:14-15`).
 */
export const GC_FENCE_KEY = 7064003n;

/**
 * The reserved connection is idle while gc's sweep does bucket I/O (`storage.list`
 * / `storage.delete`). A `SELECT 1` every 15 s keeps the open transaction from
 * tripping `idle_in_transaction_session_timeout`, which must exceed this interval.
 */
const GC_FENCE_HEARTBEAT_MS = 15_000;

/**
 * Postgres `int8` (bigint) type OID. The advisory-lock functions take a `bigint`
 * key; binding `GC_FENCE_KEY` with this OID (`sql.typed(key, PG_INT8_OID)`) sends
 * it as `int8` — the default `postgres.Sql` type does not list `bigint` as a plain
 * serializable parameter.
 */
const PG_INT8_OID = 20;

/**
 * Take the SHARED fence inside the import's restore transaction (`Transaction`),
 * held to commit or rollback. Multiple imports may hold it at once; it only
 * conflicts with gc's exclusive try-lock.
 */
export async function holdImportFence(tx: Transaction): Promise<void> {
  await tx.execute(sql`SELECT pg_advisory_xact_lock_shared(${GC_FENCE_KEY})`);
}

/**
 * Run gc under the exclusive fence. Reserves a dedicated connection, opens one
 * transaction, and try-locks `GC_FENCE_KEY`:
 *   - false → an import is in progress: roll back and return `'import-in-progress'`
 *     without listing or deleting anything.
 *   - true  → run the unchanged `runGc` on the reserved connection (`ReservedSql`
 *     extends `Sql`), with a heartbeat, then commit and return its result.
 * Any throw rolls the transaction back. The heartbeat is cleared and the
 * connection released in `finally`.
 */
export async function runGcFenced(
  sql: postgres.Sql,
  storage: ObjectStorage,
  opts: { now?: number; ageFloorMs?: number } = {},
): Promise<GcResult | 'import-in-progress'> {
  const reserved = await sql.reserve();
  let heartbeat: ReturnType<typeof setInterval> | undefined;
  let inTransaction = false;
  try {
    await reserved`BEGIN`;
    inTransaction = true;

    const [row] = await reserved<{ locked: boolean }[]>`
      SELECT pg_try_advisory_xact_lock(${reserved.typed(GC_FENCE_KEY, PG_INT8_OID)}) AS locked
    `;
    if (!row?.locked) {
      await reserved`ROLLBACK`;
      inTransaction = false;
      return 'import-in-progress';
    }

    heartbeat = setInterval(() => {
      void reserved`SELECT 1`.catch(() => {});
    }, GC_FENCE_HEARTBEAT_MS);

    const result = await runGc(reserved, storage, opts);
    await reserved`COMMIT`;
    inTransaction = false;
    return result;
  } catch (err) {
    if (inTransaction) {
      try {
        await reserved`ROLLBACK`;
      } catch {
        // Best-effort rollback; the release below drops the connection regardless.
      }
    }
    throw err;
  } finally {
    if (heartbeat) clearInterval(heartbeat);
    reserved.release();
  }
}

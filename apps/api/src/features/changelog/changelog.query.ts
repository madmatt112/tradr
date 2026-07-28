// Changelog queries (design Component 5, REQ-5(a)(1)).
//
// Two PK-scoped statements on `users` — one indexed read for the viewer
// floor, one single-statement write for mark-viewed (no transaction needed).

import { eq, sql } from 'drizzle-orm';

import type { Database, Transaction } from '@/db';
import { users } from '@/db/schema';
import { UnauthorizedError } from '@/lib/errors';

/**
 * One indexed PK read: the per-viewer floor inputs. The effective floor is
 * `changelogViewedAt ?? createdAt` (REQ-5(a)(2) option (ii)), composed by the
 * service per request — never stored in the shared cache (REQ-5(a)(4)).
 */
export async function selectViewerState(
  db: Database | Transaction,
  userId: string,
): Promise<{ changelogViewedAt: Date | null; createdAt: Date }> {
  const rows = await db
    .select({
      changelogViewedAt: users.changelogViewedAt,
      createdAt: users.createdAt,
    })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);

  const row = rows[0];
  if (!row) {
    // Authenticated session but the user row is gone (deleted-account race) —
    // mirrors the dashboard service's mapping.
    throw new UnauthorizedError('Session no longer valid');
  }
  return row;
}

/**
 * `UPDATE users SET changelog_viewed_at = now() WHERE id = $userId` returning
 * the new value. Single statement — no transaction needed.
 */
export async function updateChangelogViewedAt(
  db: Database | Transaction,
  userId: string,
): Promise<Date> {
  const rows = await db
    .update(users)
    .set({ changelogViewedAt: sql`now()` })
    .where(eq(users.id, userId))
    .returning({ changelogViewedAt: users.changelogViewedAt });

  const row = rows[0];
  if (!row?.changelogViewedAt) {
    throw new UnauthorizedError('Session no longer valid');
  }
  return row.changelogViewedAt;
}

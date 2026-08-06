import { eq, lt, sql, count, asc, inArray } from 'drizzle-orm';
import type { SQL } from 'drizzle-orm';

import { MAX_COACH_MARKS_SEEN } from '@tradr/shared';
import type { OnboardingPatch } from '@tradr/shared';

import type { Database, Transaction } from '@/db';
import { users, sessions } from '@/db/schema';

type DB = Database | Transaction;

// `emailVerified` is OPTIONAL (MN-3): registration passes it explicitly
// (Component 7); callers that omit it (db/seed/demo.ts, any future path)
// inherit the DB default `true` — drizzle emits SQL DEFAULT for undefined.
//
// `timezone` is likewise optional. The column has no DB default, so omitting it
// stores NULL — indistinguishable from a pre-migration row, which then resolves
// through `getReportingTimezone` (user-onboarding R2.5). Registration always
// passes a value (browser-detected or the default, R2.3).
export function insertUser(
  db: DB,
  data: { email: string; passwordHash: string; emailVerified?: boolean; timezone?: string },
) {
  return db
    .insert(users)
    .values({
      email: data.email,
      passwordHash: data.passwordHash,
      emailVerified: data.emailVerified,
      timezone: data.timezone,
    })
    .returning()
    .then((rows) => rows[0]);
}

/**
 * Raw read of the user's reporting timezone. Returns the column verbatim —
 * `null` for a pre-migration row, `undefined` for no such user. Resolving
 * either to a usable zone is `getReportingTimezone`'s job, not this one's.
 */
export function selectUserTimezone(db: DB, userId: string) {
  return db
    .select({ timezone: users.timezone })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1)
    .then((rows) => rows[0]?.timezone);
}

/** Persist the reporting timezone. Zone validity is the route's Zod duty. */
export function updateUserTimezone(db: DB, userId: string, timezone: string) {
  return db.update(users).set({ timezone, updatedAt: new Date() }).where(eq(users.id, userId));
}

/**
 * Raw read of the onboarding preference column. Returns the jsonb verbatim —
 * `{}` for a row that predates the column or has never expressed a preference,
 * `undefined` for no such user. Resolving that into a usable state is
 * `getOnboardingState`'s job; every key here may be absent.
 */
export function selectUserOnboarding(db: DB, userId: string) {
  return db
    .select({ onboarding: users.onboarding })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1)
    .then((rows) => rows[0]?.onboarding);
}

/**
 * Merge a partial onboarding preference into the column IN SQL, as one
 * statement. This is the whole point of the function and it is not the obvious
 * shape, so: the alternative — SELECT, parse, spread, UPDATE the whole object —
 * loses data twice over.
 *
 * 1. UNKNOWN KEYS. `OnboardingStateSchema` STRIPS keys it does not know
 *    (deliberately, so an older deployment can read a newer one's rows). Round
 *    -tripping the parsed object back into the column therefore DELETES any key
 *    a newer deployment wrote — during a rolling deploy, the old container
 *    silently destroys the new one's onboarding data. Rewriting only the named
 *    keys with `||` and `jsonb_set` leaves everything else exactly as found.
 * 2. CONCURRENT PATCHES. Two tabs appending different coach marks in a
 *    read-modify-write both read the same array and the second write drops the
 *    first's key. As one statement, PostgreSQL's row lock serialises them and
 *    the second re-evaluates this expression against the first's committed
 *    value, so both keys survive.
 *
 * Coach-mark append is idempotent by containment test, and capped: nothing ever
 * removes a key, so an uncapped append is unbounded growth of one row's jsonb.
 * Past the cap the append is a no-op rather than an error — a coach mark is a
 * UI nicety and the cap is an order of magnitude above the surfaces R7.1 names.
 */
export function updateUserOnboarding(db: DB, userId: string, patch: OnboardingPatch) {
  // Built from the column outwards. Each clause names only the keys it changes.
  let merged: SQL = sql`${users.onboarding}`;

  if (patch.coachMarkSeen !== undefined) {
    const key = sql`to_jsonb(${patch.coachMarkSeen}::text)`;
    const seen = sql`coalesce(${users.onboarding} -> 'coachMarksSeen', '[]'::jsonb)`;
    merged = sql`
      CASE
        WHEN ${seen} @> ${key} OR jsonb_array_length(${seen}) >= ${MAX_COACH_MARKS_SEEN}
        THEN ${merged}
        ELSE jsonb_set(${merged}, '{coachMarksSeen}', ${seen} || ${key}, true)
      END`;
  }

  // status and calculatorFirstUsedAt are plain scalars, so one `||` sets both.
  // It runs after the coach-mark clause only because that clause reads the
  // column directly; the two touch disjoint keys, so the order is immaterial.
  const scalars: Record<string, string> = {};
  if (patch.status !== undefined) scalars.status = patch.status;
  if (patch.calculatorFirstUsedAt !== undefined) {
    scalars.calculatorFirstUsedAt = patch.calculatorFirstUsedAt;
  }
  if (Object.keys(scalars).length > 0) {
    merged = sql`${merged} || ${JSON.stringify(scalars)}::jsonb`;
  }

  // RETURNING gives the post-merge value without a second read — and without
  // the read-your-own-write race a follow-up SELECT would reintroduce.
  return db
    .update(users)
    .set({ onboarding: merged, updatedAt: new Date() })
    .where(eq(users.id, userId))
    .returning({ onboarding: users.onboarding })
    .then((rows) => rows[0]?.onboarding);
}

export function selectUserByEmail(db: DB, email: string) {
  return db
    .select()
    .from(users)
    .where(eq(users.email, email))
    .then((rows) => rows[0]);
}

export function selectUserById(db: DB, id: string) {
  return db
    .select()
    .from(users)
    .where(eq(users.id, id))
    .then((rows) => rows[0]);
}

export function insertSession(
  db: DB,
  data: { userId: string; tokenHash: string; expiresAt: Date },
) {
  return db
    .insert(sessions)
    .values({
      userId: data.userId,
      tokenHash: data.tokenHash,
      expiresAt: data.expiresAt,
    })
    .returning()
    .then((rows) => rows[0]);
}

export function selectSessionByTokenHash(db: DB, tokenHash: string) {
  return db
    .select()
    .from(sessions)
    .innerJoin(users, eq(sessions.userId, users.id))
    .where(eq(sessions.tokenHash, tokenHash))
    .then((rows) => rows[0]);
}

export function deleteSessionByTokenHash(db: DB, tokenHash: string) {
  return db.delete(sessions).where(eq(sessions.tokenHash, tokenHash));
}

export function deleteExpiredSessions(db: DB) {
  return db.delete(sessions).where(lt(sessions.expiresAt, sql`now()`));
}

export function countUserSessions(db: DB, userId: string) {
  return db
    .select({ count: count() })
    .from(sessions)
    .where(eq(sessions.userId, userId))
    .then((rows) => rows[0].count);
}

export function deleteOldestSession(db: DB, userId: string) {
  return db
    .delete(sessions)
    .where(
      inArray(
        sessions.id,
        db
          .select({ id: sessions.id })
          .from(sessions)
          .where(eq(sessions.userId, userId))
          .orderBy(asc(sessions.lastAccessed))
          .limit(1),
      ),
    );
}

export function touchSession(db: DB, sessionId: string) {
  return db
    .update(sessions)
    .set({ lastAccessed: sql`now()` })
    .where(eq(sessions.id, sessionId));
}

/**
 * D8's one-DELETE session revocation: reset completion revokes EVERY session
 * the account holds (a hijacker's surviving session after a password reset is
 * the classic hole — REQ-4.5). Transaction-typed: only meaningful inside the
 * completion transaction's alphabetical lock order (email_tokens → sessions →
 * users).
 */
export function deleteAllUserSessions(tx: Transaction, userId: string) {
  return tx.delete(sessions).where(eq(sessions.userId, userId));
}

/**
 * D8's credential rewrite: sets the new bcrypt hash AND flips
 * email_verified = true in one statement — a completed email-delivered reset
 * proves mailbox control, strictly stronger evidence than a verification link
 * (reset⇒verified, REQ-4.5's pinned YES). Transaction-typed (locks `users`
 * last in the completion transaction's alphabetical order).
 */
export function updateUserPasswordAndVerify(tx: Transaction, userId: string, passwordHash: string) {
  return tx.update(users).set({ passwordHash, emailVerified: true }).where(eq(users.id, userId));
}

/**
 * Verification's flag flip (Component 6): email_verified = true, NOTHING else —
 * its own small UPDATE rather than a reuse of `updateUserPasswordAndVerify`,
 * which would also rewrite the password hash. Transaction-typed: runs inside
 * verifyEmail's consume→flip transaction.
 */
export function markUserVerified(tx: Transaction, userId: string) {
  return tx.update(users).set({ emailVerified: true }).where(eq(users.id, userId));
}

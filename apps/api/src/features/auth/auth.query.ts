import { eq, lt, sql, count, asc, inArray } from 'drizzle-orm';

import type { Database, Transaction } from '@/db';
import { users, sessions } from '@/db/schema';

type DB = Database | Transaction;

// `emailVerified` is OPTIONAL (MN-3): registration passes it explicitly
// (Component 7); callers that omit it (db/seed/demo.ts, any future path)
// inherit the DB default `true` — drizzle emits SQL DEFAULT for undefined.
export function insertUser(
  db: DB,
  data: { email: string; passwordHash: string; emailVerified?: boolean },
) {
  return db
    .insert(users)
    .values({
      email: data.email,
      passwordHash: data.passwordHash,
      emailVerified: data.emailVerified,
    })
    .returning()
    .then((rows) => rows[0]);
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

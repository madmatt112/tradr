import crypto from 'node:crypto';

import { and, eq } from 'drizzle-orm';
import { describe, it, expect } from 'vitest';

import { db } from '@/db';
import { emailTokens } from '@/db/schema';
import { withTransaction } from '@/lib/transaction';

import { insertUser } from './auth.query';
import { consumeEmailToken } from './email-tokens.query';
import { issueEmailToken, RESET_TOKEN_TTL_MS, VERIFY_TOKEN_TTL_MS } from './email-tokens.service';

let userCounter = 0;
async function createUser(): Promise<string> {
  const user = await insertUser(db, {
    email: `email-token-test-${++userCounter}@example.com`,
    passwordHash: 'x',
  });
  return user.id;
}

function sha256(raw: string): string {
  return crypto.createHash('sha256').update(raw).digest('hex');
}

function consume(tokenHash: string, purpose: 'password_reset' | 'email_verification') {
  return withTransaction(db, (tx) => consumeEmailToken(tx, tokenHash, purpose));
}

function selectTokens(userId: string) {
  return db.select().from(emailTokens).where(eq(emailTokens.userId, userId));
}

describe('email tokens lifecycle', () => {
  // 1. Issue: one row, hashed at rest, expires_at = now + TTL
  it('issue stores exactly one hashed row with expires_at = now + TTL', async () => {
    const userId = await createUser();
    const before = Date.now();
    const raw = await issueEmailToken(userId, 'password_reset', RESET_TOKEN_TTL_MS);
    const after = Date.now();

    // 32-byte CSPRNG hex token — never stored raw
    expect(raw).toMatch(/^[0-9a-f]{64}$/);

    const rows = await selectTokens(userId);
    expect(rows).toHaveLength(1);
    expect(rows[0].purpose).toBe('password_reset');
    expect(rows[0].tokenHash).not.toBe(raw);
    expect(rows[0].tokenHash).toBe(sha256(raw));
    expect(rows[0].consumedAt).toBeNull();
    expect(rows[0].expiresAt.getTime()).toBeGreaterThanOrEqual(before + RESET_TOKEN_TTL_MS);
    expect(rows[0].expiresAt.getTime()).toBeLessThanOrEqual(after + RESET_TOKEN_TTL_MS);
  });

  // 2. Consume: userId exactly once; second consume → null (single-use)
  it('consume returns the userId once, then null', async () => {
    const userId = await createUser();
    const raw = await issueEmailToken(userId, 'password_reset', RESET_TOKEN_TTL_MS);

    const first = await consume(sha256(raw), 'password_reset');
    expect(first).toEqual({ userId });

    const second = await consume(sha256(raw), 'password_reset');
    expect(second).toBeNull();
  });

  // 3. Expired token → null (indistinguishable from consumed/unknown, REQ-4.2)
  it('consume returns null for an expired token', async () => {
    const userId = await createUser();
    const raw = await issueEmailToken(userId, 'password_reset', RESET_TOKEN_TTL_MS);

    // Backdate well past any plausible test-transaction start (now() in the
    // consume predicate is the frozen transaction-start timestamp).
    await db
      .update(emailTokens)
      .set({ expiresAt: new Date(Date.now() - 60 * 60 * 1000) })
      .where(eq(emailTokens.tokenHash, sha256(raw)));

    expect(await consume(sha256(raw), 'password_reset')).toBeNull();
  });

  // 4. Unknown token → null
  it('consume returns null for an unknown token', async () => {
    await createUser();
    expect(await consume(sha256('never-issued'), 'password_reset')).toBeNull();
  });

  // 5. Wrong purpose → null; cross-purpose completion is structurally impossible (D4)
  it('consume returns null for the wrong purpose and leaves the token live', async () => {
    const userId = await createUser();
    const raw = await issueEmailToken(userId, 'email_verification', VERIFY_TOKEN_TTL_MS);

    expect(await consume(sha256(raw), 'password_reset')).toBeNull();

    // The mismatched attempt consumed nothing — the right purpose still works.
    expect(await consume(sha256(raw), 'email_verification')).toEqual({ userId });
  });

  // 6. Re-issue: newest wins — old row gone, exactly one live row (REQ-3.5)
  it('re-issue deletes the prior token and leaves exactly one live row', async () => {
    const userId = await createUser();
    const raw1 = await issueEmailToken(userId, 'password_reset', RESET_TOKEN_TTL_MS);
    const raw2 = await issueEmailToken(userId, 'password_reset', RESET_TOKEN_TTL_MS);

    const rows = await db
      .select()
      .from(emailTokens)
      .where(and(eq(emailTokens.userId, userId), eq(emailTokens.purpose, 'password_reset')));
    expect(rows).toHaveLength(1);
    expect(rows[0].tokenHash).toBe(sha256(raw2));
    expect(rows[0].consumedAt).toBeNull();

    // The superseded token no longer completes; the newest one does.
    expect(await consume(sha256(raw1), 'password_reset')).toBeNull();
    expect(await consume(sha256(raw2), 'password_reset')).toEqual({ userId });
  });

  // 7. Purposes are independent: issuing one never touches the other's token
  it('re-issue for one purpose leaves the other purpose live', async () => {
    const userId = await createUser();
    const verifyRaw = await issueEmailToken(userId, 'email_verification', VERIFY_TOKEN_TTL_MS);
    await issueEmailToken(userId, 'password_reset', RESET_TOKEN_TTL_MS);

    expect(await selectTokens(userId)).toHaveLength(2);
    expect(await consume(sha256(verifyRaw), 'email_verification')).toEqual({ userId });
  });
});

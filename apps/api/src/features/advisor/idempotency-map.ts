// In-process Layer-2 idempotency map for advisor streaming (REQ-3.12, REQ-12.1).
//
// Existing-conversation flows only — new-conversation submissions (conversationId
// === null) bypass this map entirely and rely on the DB partial-unique index
// (Layer-1). The map fast-paths retries of the same (conversationId,
// clientMessageId) for a user.
//
// Lifecycle (design §Component 3 / v4-1):
//   reserve  → inserts an `in-progress` entry under a held concurrency slot.
//   markDone → transitions in-progress → done. The done entry PERSISTS until LRU
//              eviction (1-hour TTL) so a later retry hits Layer-2 (hit-done).
//              markDone does NOT delete the entry.
//   removeIdempotencyEntry → removes the entry. Called ONLY on pre-stream /
//              failed-stream paths so a failure leaves no in-progress ghost.
//              NOT called on normal completion.
//
// Keys: `${conversationId}|${clientMessageId}` within a per-user inner map.
// conversationId is REQUIRED (never null).
//
// LRU policy: per-user cap 256, global cap 100,000, max-age 1 hour. Recency is
// tracked via Map insertion order: a touched key is deleted and re-set so it
// moves to the tail; the head is the eviction candidate.

const PER_USER_CAP = 256;
const GLOBAL_CAP = 100_000;
const MAX_AGE_MS = 60 * 60 * 1000; // 1 hour

type State =
  | { kind: 'in-progress'; abortController: AbortController; createdAt: number }
  | { kind: 'done'; assistantMessageId: string; createdAt: number };

export type PeekResult =
  | { kind: 'hit-done'; assistantMessageId: string }
  | { kind: 'hit-in-progress' }
  | { kind: 'miss' };

export class IdempotencyMap {
  private byUser = new Map<string, Map<string, State>>();
  private globalCount = 0;

  private static entryKey(conversationId: string, clientMessageId: string): string {
    return `${conversationId}|${clientMessageId}`;
  }

  private getUserMap(userId: string): Map<string, State> {
    let inner = this.byUser.get(userId);
    if (!inner) {
      inner = new Map<string, State>();
      this.byUser.set(userId, inner);
    }
    return inner;
  }

  private deleteEntry(userId: string, inner: Map<string, State>, key: string): void {
    if (inner.delete(key)) {
      this.globalCount -= 1;
    }
    if (inner.size === 0) {
      this.byUser.delete(userId);
    }
  }

  // Reads an entry, evicting it if it has aged past the TTL. Returns undefined
  // when missing or expired.
  private readFresh(userId: string, inner: Map<string, State>, key: string): State | undefined {
    const entry = inner.get(key);
    if (!entry) return undefined;
    if (Date.now() - entry.createdAt >= MAX_AGE_MS) {
      this.deleteEntry(userId, inner, key);
      return undefined;
    }
    return entry;
  }

  // Non-mutating lookup (v3-2): called before the concurrency slot acquire.
  // Expired entries are evicted as a side effect, but no entry is created.
  peek(userId: string, conversationId: string, clientMessageId: string): PeekResult {
    const inner = this.byUser.get(userId);
    if (!inner) return { kind: 'miss' };
    const key = IdempotencyMap.entryKey(conversationId, clientMessageId);
    const entry = this.readFresh(userId, inner, key);
    if (!entry) return { kind: 'miss' };
    if (entry.kind === 'done') {
      return { kind: 'hit-done', assistantMessageId: entry.assistantMessageId };
    }
    return { kind: 'hit-in-progress' };
  }

  // Inserts an in-progress entry under a held concurrency slot (v3-2). The slot
  // prevents concurrent same-user submissions, so this cannot collide with an
  // existing in-progress entry for the same key that the peek already ruled out.
  reserve(
    userId: string,
    conversationId: string,
    clientMessageId: string,
    abortController: AbortController,
  ): void {
    const inner = this.getUserMap(userId);
    const key = IdempotencyMap.entryKey(conversationId, clientMessageId);
    if (!inner.has(key)) {
      this.globalCount += 1;
    }
    inner.set(key, { kind: 'in-progress', abortController, createdAt: Date.now() });
    this.evictIfNeeded(userId, inner);
  }

  // Transitions in-progress → done (v4-1). The done entry persists until LRU
  // eviction so a future retry hits Layer-2. No-op if the entry is missing.
  markDone(
    userId: string,
    conversationId: string,
    clientMessageId: string,
    assistantMessageId: string,
  ): void {
    const inner = this.byUser.get(userId);
    if (!inner) return;
    const key = IdempotencyMap.entryKey(conversationId, clientMessageId);
    if (!inner.has(key)) return;
    inner.set(key, { kind: 'done', assistantMessageId, createdAt: Date.now() });
  }

  // Removes an entry (v4-1). Called ONLY on pre-stream / failed-stream paths.
  removeIdempotencyEntry(userId: string, conversationId: string, clientMessageId: string): void {
    const inner = this.byUser.get(userId);
    if (!inner) return;
    const key = IdempotencyMap.entryKey(conversationId, clientMessageId);
    this.deleteEntry(userId, inner, key);
  }

  // Enforces per-user and global caps by evicting the oldest (head) entries.
  private evictIfNeeded(userId: string, inner: Map<string, State>): void {
    while (inner.size > PER_USER_CAP) {
      const oldest = inner.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      this.deleteEntry(userId, inner, oldest);
    }
    while (this.globalCount > GLOBAL_CAP) {
      const victimUserId = this.byUser.keys().next().value as string | undefined;
      if (victimUserId === undefined) break;
      const victimInner = this.byUser.get(victimUserId)!;
      const oldest = victimInner.keys().next().value as string | undefined;
      if (oldest === undefined) {
        this.byUser.delete(victimUserId);
        continue;
      }
      this.deleteEntry(victimUserId, victimInner, oldest);
    }
  }
}

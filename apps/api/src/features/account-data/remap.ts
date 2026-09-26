import { createHash, randomBytes } from 'node:crypto';

// Design C7 — fresh identifiers for a restored archive (Req 5.4, 5.5).
//
// Every restored row gets a new identifier and every reference is remapped, so a
// same-instance import never collides with the source (requirements D8). These are
// pure functions: no database access, no I/O beyond the CSPRNG in `newSalt`.
//
// Two id spaces, both salted so ids differ per confirm:
//   - `remapId` covers every id and group id — including user persona ids, which are
//     `crypto.randomUUID()` text (apps/api/src/features/advisor/advisor.query.ts:876)
//     — except message ids.
//   - `orderedMessageIds` covers message ids alone. A conversation's messages are
//     assigned ids by position, not per source id, so no per-message map is held
//     (design D6). The ids are sorted ascending, so a message's restored id is the
//     i-th entry of its `(created_at, id)` archive order and tie order survives the
//     database round-trip (design P5: Postgres `ORDER BY uuid` equals this JS sort).

const SALT_BYTES = 32;

/** A fresh 32-byte remap salt, drawn once per confirmed import. */
export function newSalt(): Buffer {
  return randomBytes(SALT_BYTES);
}

/**
 * Turn a 32-byte SHA-256 digest into a canonical lowercase v4 UUID: the first 16
 * bytes with the RFC-4122 version (4) and variant (10) bits forced.
 */
function uuidFromDigest(digest: Buffer): string {
  digest[6] = (digest[6] & 0x0f) | 0x40; // version 4
  digest[8] = (digest[8] & 0x3f) | 0x80; // variant 10xx
  const hex = digest.subarray(0, 16).toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

/**
 * The fresh id for `sourceId` under `salt`: SHA-256 of the salt and the id, first
 * 16 bytes, version-4 and variant bits set, as a canonical lowercase UUID.
 * Deterministic per salt and effectively collision-free.
 */
export function remapId(salt: Buffer, sourceId: string): string {
  const digest = createHash('sha256').update(salt).update(sourceId, 'utf8').digest();
  return uuidFromDigest(digest);
}

/**
 * The `count` fresh message ids for one conversation, sorted ascending. Each is a
 * salted hash of the conversation id and the message's index, so the set is
 * deterministic per `(salt, conversation, count)` and holds no per-message map.
 * A message's restored id is the entry at its archive-order index (design P5).
 */
export function orderedMessageIds(
  salt: Buffer,
  conversationSourceId: string,
  count: number,
): string[] {
  const ids: string[] = [];
  const indexBuf = Buffer.allocUnsafe(4);
  for (let i = 0; i < count; i += 1) {
    indexBuf.writeUInt32BE(i, 0);
    const digest = createHash('sha256')
      .update(salt)
      .update(conversationSourceId, 'utf8')
      .update(indexBuf)
      .digest();
    ids.push(uuidFromDigest(digest));
  }
  ids.sort();
  return ids;
}

/**
 * Resolves an advisory `covered_through_message_id` to the restored message id.
 *
 * Seeded with the summary-covered message ids the validator returns (bounded by
 * `maxCoveredThroughRefs`), it watches messages stream past and records the
 * conversation and archive-order index of each seeded id. `resolve` then yields the
 * matching `orderedMessageIds(...)` entry, or null when the id named no archived
 * message or fell past the cap (design D10 — the pointer is advisory).
 */
export interface CoveredThroughResolver {
  /** Note a streaming message; call once per message in archive order. */
  record(messageSourceId: string, conversationSourceId: string): void;
  /** The restored id for a covered-through pointer, or null when unresolvable. */
  resolve(coveredThroughMessageId: string): string | null;
}

export function createCoveredThroughResolver(
  salt: Buffer,
  coveredThroughMessageIds: ReadonlySet<string>,
): CoveredThroughResolver {
  // Running message count per conversation, so a resolved index has its total.
  const counts = new Map<string, number>();
  // Only seeded ids are retained, so the map is bounded by the cap.
  const located = new Map<string, { conversationSourceId: string; index: number }>();

  return {
    record(messageSourceId, conversationSourceId) {
      const index = counts.get(conversationSourceId) ?? 0;
      if (coveredThroughMessageIds.has(messageSourceId)) {
        located.set(messageSourceId, { conversationSourceId, index });
      }
      counts.set(conversationSourceId, index + 1);
    },
    resolve(coveredThroughMessageId) {
      const loc = located.get(coveredThroughMessageId);
      if (loc === undefined) {
        return null;
      }
      const total = counts.get(loc.conversationSourceId) ?? 0;
      return orderedMessageIds(salt, loc.conversationSourceId, total)[loc.index] ?? null;
    },
  };
}

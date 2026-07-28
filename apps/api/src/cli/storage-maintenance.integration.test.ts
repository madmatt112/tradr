/**
 * Integration tests for the storage-maintenance CLI service against a real
 * Postgres (hosted-platform Task 13; design §Component 9; REQ-3.1/3.2/3.3/3.4).
 *
 * Follows the repo's scratch-DB CLI pattern (`tradr.integration.test.ts`): a
 * dedicated scratch database with the standard migrations applied and its own
 * `max:1` connection, rather than the per-test transaction-rollback harness —
 * `migrateToInline`/`runGc` open their own connections and do per-row work, and
 * both scan the WHOLE `advisor_messages` table, so a clean isolated DB gives
 * deterministic counts. The bucket is a controllable in-memory fake.
 *
 * Cases:
 *   migrate-to-inline: re-inlines fetchable pointers, marks a gone-out-of-band
 *     pointer unrecoverable (report-and-continue), preserves inline parts, reports
 *     correct counts, and is IDEMPOTENT (a second run migrates nothing).
 *   gc: KEEPS a live (referenced) key and a too-young unreferenced object, deletes
 *     ONLY an aged unreferenced key.
 */
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { drizzle } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import postgres from 'postgres';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';

import * as schema from '@/db/schema';
import { ObjectUnreachableError, type ObjectStorage } from '@/lib/object-storage';

import { migrateToInline, runGc } from './storage-maintenance.service';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_FOLDER = path.resolve(__dirname, '../db/migrations');

const BASE_URL =
  process.env.DATABASE_URL || 'postgresql://postgres:postgres@localhost:5433/tradr_test';
const ADMIN_URL = BASE_URL.replace(/\/[^/]+$/, '/postgres');
const BASE_NO_DB = BASE_URL.replace(/\/[^/]+$/, '');

function client(url: string) {
  return postgres(url, { max: 1, prepare: false, onnotice: () => {} });
}

async function createScratchDb(name: string): Promise<string> {
  const admin = client(ADMIN_URL);
  try {
    await admin.unsafe(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
    await admin.unsafe(`CREATE DATABASE ${name}`);
  } finally {
    await admin.end();
  }
  return `${BASE_NO_DB}/${name}`;
}

async function dropScratchDb(name: string): Promise<void> {
  const admin = client(ADMIN_URL);
  try {
    await admin.unsafe(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
  } finally {
    await admin.end();
  }
}

async function applyStandardMigrations(url: string): Promise<void> {
  const sql = client(url);
  try {
    await migrate(drizzle(sql, { schema }), { migrationsFolder: MIGRATIONS_FOLDER });
  } finally {
    await sql.end();
  }
}

// --- Controllable in-memory bucket -------------------------------------------------

class FakeStorage implements ObjectStorage {
  objects = new Map<string, { bytes: Uint8Array; contentType: string; lastModified: Date }>();
  deleted: string[] = [];

  /** Seed an object with an explicit lastModified (for age-guard tests). */
  seed(key: string, bytes: Uint8Array, lastModified = new Date()): void {
    this.objects.set(key, { bytes, contentType: 'image/png', lastModified });
  }

  put(key: string, bytes: Uint8Array, contentType: string): Promise<void> {
    this.objects.set(key, { bytes, contentType, lastModified: new Date() });
    return Promise.resolve();
  }

  get(key: string): Promise<{ bytes: Uint8Array; contentType: string }> {
    const o = this.objects.get(key);
    if (!o) throw new ObjectUnreachableError(`gone: ${key}`);
    return Promise.resolve({ bytes: o.bytes, contentType: o.contentType });
  }

  delete(key: string): Promise<void> {
    this.deleted.push(key);
    this.objects.delete(key);
    return Promise.resolve();
  }

  list(prefix: string): Promise<Array<{ key: string; lastModified: Date }>> {
    return Promise.resolve(
      [...this.objects.entries()]
        .filter(([k]) => k.startsWith(prefix))
        .map(([key, o]) => ({ key, lastModified: o.lastModified })),
    );
  }
}

// --- Seed helpers (raw SQL on the scratch connection) ------------------------------

async function seedUserAndConversation(
  sql: postgres.Sql,
): Promise<{ userId: string; conversationId: string }> {
  const [u] = await sql<{ id: string }[]>`
    INSERT INTO users (email, password_hash)
    VALUES (${`u-${randomUUID()}@example.com`}, ${'x'.repeat(60)})
    RETURNING id
  `;
  const [c] = await sql<{ id: string }[]>`
    INSERT INTO advisor_conversations (user_id, title, provider_id, model)
    VALUES (${u!.id}, 'test', 'openai', 'gpt-4o')
    RETURNING id
  `;
  return { userId: u!.id, conversationId: c!.id };
}

async function insertMessage(
  sql: postgres.Sql,
  conversationId: string,
  parts: unknown[],
): Promise<string> {
  const [m] = await sql<{ id: string }[]>`
    INSERT INTO advisor_messages (conversation_id, role, content_parts)
    VALUES (${conversationId}, 'user', ${sql.json(parts as never)})
    RETURNING id
  `;
  return m!.id;
}

type Part = Record<string, unknown>;

async function partsOf(sql: postgres.Sql, messageId: string): Promise<Part[]> {
  const [row] = await sql<{ content_parts: Part[] }[]>`
    SELECT content_parts FROM advisor_messages WHERE id = ${messageId}
  `;
  return row!.content_parts;
}

// -----------------------------------------------------------------------------------

describe('migrateToInline (REQ-3.1/3.3/3.4 — idempotent, resumable, report-and-continue)', () => {
  const DB = `tradr_test_storage_migrate_${Date.now()}`;
  let url: string;

  beforeAll(async () => {
    url = await createScratchDb(DB);
    await applyStandardMigrations(url);
  });

  afterAll(async () => {
    await dropScratchDb(DB);
  });

  it('re-inlines fetchable pointers, marks a gone pointer unrecoverable, preserves inline, reports counts, and is idempotent', async () => {
    const sql = client(url);
    const storage = new FakeStorage();
    try {
      const { userId, conversationId } = await seedUserAndConversation(sql);

      const okKey = `advisor/${userId}/${randomUUID()}`;
      const goneKey = `advisor/${userId}/${randomUUID()}`;
      const okBytes = Buffer.from([1, 2, 3, 4]);
      storage.seed(okKey, okBytes); // fetchable
      // goneKey intentionally NOT seeded → storage.get throws (gone out-of-band).

      // Row 1: a fetchable pointer + a text part (inline text is preserved).
      const row1 = await insertMessage(sql, conversationId, [
        { type: 'text', text: 'chart please' },
        { type: 'image', format: 'png', storage: { kind: 'object', key: okKey } },
      ]);
      // Row 2: a gone pointer.
      const row2 = await insertMessage(sql, conversationId, [
        { type: 'image', format: 'jpeg', storage: { kind: 'object', key: goneKey } },
      ]);
      // Row 3: already inline — must be untouched and never selected.
      const row3 = await insertMessage(sql, conversationId, [
        { type: 'image', format: 'webp', dataBase64: Buffer.from([9]).toString('base64') },
      ]);

      const result = await migrateToInline(sql, storage);

      expect(result.scannedRows).toBe(2); // rows 1 + 2 (row 3 has no object pointer)
      expect(result.migratedParts).toBe(1); // okKey
      expect(result.unrecoverableParts).toBe(1); // goneKey
      expect(result.updatedRows).toBe(2);

      // Row 1: pointer → inline base64 (fetched bytes); text preserved.
      const p1 = await partsOf(sql, row1);
      expect(p1[0]).toEqual({ type: 'text', text: 'chart please' });
      expect(p1[1]).toEqual({
        type: 'image',
        format: 'png',
        dataBase64: okBytes.toString('base64'),
      });
      expect(p1[1].storage).toBeUndefined();

      // Row 2: gone pointer → unrecoverable marker (REQ-3.3).
      const p2 = await partsOf(sql, row2);
      expect(p2[0]).toEqual({ type: 'image', format: 'jpeg', storage: { kind: 'unrecoverable' } });

      // Row 3: untouched.
      const p3 = await partsOf(sql, row3);
      expect(p3[0]).toEqual({
        type: 'image',
        format: 'webp',
        dataBase64: Buffer.from([9]).toString('base64'),
      });

      // IDEMPOTENT: a second run finds no object pointers left → migrates nothing.
      const second = await migrateToInline(sql, storage);
      expect(second.scannedRows).toBe(0);
      expect(second.migratedParts).toBe(0);
      expect(second.unrecoverableParts).toBe(0);
      expect(second.updatedRows).toBe(0);

      // DB state after the second run is byte-identical to after the first.
      expect(await partsOf(sql, row1)).toEqual(p1);
      expect(await partsOf(sql, row2)).toEqual(p2);
    } finally {
      await sql.end();
    }
  });
});

describe('runGc (REQ-3.2 — age-guarded sweep protects put-before-commit)', () => {
  const DB = `tradr_test_storage_gc_${Date.now()}`;
  let url: string;

  beforeAll(async () => {
    url = await createScratchDb(DB);
    await applyStandardMigrations(url);
  });

  afterAll(async () => {
    await dropScratchDb(DB);
  });

  it('keeps a live key and a too-young orphan, deletes only an aged unreferenced key', async () => {
    const sql = client(url);
    const storage = new FakeStorage();
    try {
      const { userId, conversationId } = await seedUserAndConversation(sql);
      const now = Date.now();
      const ageFloorMs = 600_000; // 10 min

      const liveKey = `advisor/${userId}/${randomUUID()}`;
      const youngOrphan = `advisor/${userId}/${randomUUID()}`;
      const agedOrphan = `advisor/${userId}/${randomUUID()}`;

      // liveKey is referenced by a persisted pointer row → in the live set.
      await insertMessage(sql, conversationId, [
        { type: 'image', format: 'png', storage: { kind: 'object', key: liveKey } },
      ]);

      // The bucket holds all three. The live one is old (age irrelevant — referenced).
      storage.seed(liveKey, Buffer.from([1]), new Date(now - 5 * ageFloorMs));
      // Young orphan: written 1 minute ago, well under the floor — a possible
      // in-flight put-before-commit object → MUST be kept (REQ-3.2).
      storage.seed(youngOrphan, Buffer.from([2]), new Date(now - 60_000));
      // Aged orphan: older than the floor and unreferenced → the only deletion.
      storage.seed(agedOrphan, Buffer.from([3]), new Date(now - 2 * ageFloorMs));

      const result = await runGc(sql, storage, { now, ageFloorMs });

      expect(result.liveKeys).toBe(1);
      expect(result.listed).toBe(3);
      expect(result.deleted).toBe(1);
      expect(result.keptReferenced).toBe(1);
      expect(result.keptTooYoung).toBe(1);

      // Only the aged unreferenced object was deleted.
      expect(storage.deleted).toEqual([agedOrphan]);
      expect(storage.objects.has(liveKey)).toBe(true); // referenced key never deleted
      expect(storage.objects.has(youngOrphan)).toBe(true); // put-before-commit guard
      expect(storage.objects.has(agedOrphan)).toBe(false);
    } finally {
      await sql.end();
    }
  });
});

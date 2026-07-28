/**
 * Advisor object-storage READ / PROVIDER-PATH unit tests (hosted-platform
 * Task 7; design §Component 2, D10 — the convergence-critical fix; REQ-2.6,
 * REQ-2.3).
 *
 * `resolveForProvider` re-inlines every history image POINTER to inline
 * `CanonicalPart` bytes ONCE, upfront, at the provider-entry boundary, so the
 * entire downstream provider chain (redact/flatten/assemble + both adapters'
 * `prepareForTokenCount`/`countTokens`/`translate`) keeps running on narrow
 * inline parts unchanged. These tests exercise `resolveForProvider` directly
 * (no DB, no route) with a controllable in-memory object-storage fake.
 *
 * The one boundary stubbed is `@/lib/object-storage` (`getObjectStorage`): a
 * fake whose `get(key)` records calls, returns known bytes, or throws
 * `ObjectUnreachableError`. Flipped on/off via `storageMock.enabled`.
 *
 * Asserted:
 *  - a pointer resolves to inline `{type:'image',dataBase64}` (no `storage`);
 *    the resolved history then reaches the REAL Claude adapter's
 *    `prepareForTokenCount`/`translate` with a DEFINED base64 `source.data`
 *    (no `base64,undefined`, no `countTokens` 400) — native per-image pricing;
 *  - an unfetchable pointer (get throws) → `[image unavailable]` text + a warn;
 *  - a `{storage:{kind:'unrecoverable'}}` part → `[image unavailable]` + a warn;
 *  - a key shared across two messages is fetched exactly ONCE (cross-message dedup);
 *  - inline / text parts (incl. the new message's own inline images) pass through
 *    unchanged and trigger no `get`;
 *  - storage OFF ⇒ a pure passthrough with no `get`.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { CanonicalMessage, StoredContentPart } from '@tradr/shared';

import { logger } from '@/lib/logger';

// --- Controllable object-storage fake (hoisted so the vi.mock factory sees it) --

const storageMock = vi.hoisted(() => ({
  enabled: true,
  gets: [] as string[],
  objects: new Map<string, Uint8Array>(),
  failKeys: new Set<string>(),
}));

vi.mock('@/lib/object-storage', async () => {
  const actual =
    await vi.importActual<typeof import('@/lib/object-storage')>('@/lib/object-storage');
  const fake = {
    async put() {},
    async get(key: string) {
      storageMock.gets.push(key);
      if (storageMock.failKeys.has(key)) {
        throw new actual.ObjectUnreachableError('unreachable', new Error('boom'));
      }
      const bytes = storageMock.objects.get(key);
      if (!bytes) throw new actual.ObjectUnreachableError('gone', new Error('missing'));
      return { bytes, contentType: 'image/png' };
    },
    async delete() {},
    async list() {
      return [];
    },
  };
  return { ...actual, getObjectStorage: () => (storageMock.enabled ? fake : null) };
});

// Imported AFTER the mock so `getObjectStorage` resolves to the fake.
import { ClaudeAdapter } from './providers/claude';
import { ListModelsCache } from './providers/list-models-cache';
import { resolveForProvider } from './streaming';

type History = ReadonlyArray<
  | { role: 'user'; parts: readonly StoredContentPart[] }
  | { role: 'assistant'; parts: readonly StoredContentPart[] }
>;

const IMG_BYTES = new Uint8Array([0xde, 0xad, 0xbe, 0xef]);
const IMG_B64 = Buffer.from(IMG_BYTES).toString('base64');

beforeEach(() => {
  storageMock.enabled = true;
  storageMock.gets = [];
  storageMock.objects = new Map([['key-1', IMG_BYTES]]);
  storageMock.failKeys = new Set();
  vi.restoreAllMocks();
});

describe('resolveForProvider — provider-path pointer re-inline (D10, REQ-2.6)', () => {
  it('re-inlines a history pointer to inline bytes that reach Claude countTokens/translate (no 400)', async () => {
    const history: History = [
      {
        role: 'user',
        parts: [
          { type: 'text', text: 'look at this' },
          { type: 'image', format: 'png', storage: { kind: 'object', key: 'key-1' } },
        ],
      },
    ];

    const resolved = await resolveForProvider(history);

    // The pointer became an inline CanonicalPart image with the stored bytes.
    expect(resolved[0].parts).toEqual([
      { type: 'text', text: 'look at this' },
      { type: 'image', format: 'png', dataBase64: IMG_B64 },
    ]);
    expect(resolved[0].parts[1]).not.toHaveProperty('storage');
    expect(storageMock.gets).toEqual(['key-1']);

    // The UNCHANGED Claude adapter now receives DEFINED base64 image data —
    // this is the exact `prepareForTokenCount === translate` path that would
    // 400 on a bytes-less pointer (`data: undefined`).
    const adapter = new ClaudeAdapter(new ListModelsCache());
    const list = resolved as CanonicalMessage[];
    for (const payload of [adapter.prepareForTokenCount(list), adapter.translate(list)]) {
      const userMsg = payload.messages[0];
      const blocks = userMsg.content as Array<{ type: string; source?: { data?: string } }>;
      const imageBlock = blocks.find((b) => b.type === 'image');
      expect(imageBlock?.source?.data).toBe(IMG_B64);
      expect(imageBlock?.source?.data).toBeDefined();
    }
  });

  it('replaces an unfetchable pointer with "[image unavailable]" text + a warn', async () => {
    storageMock.failKeys = new Set(['key-1']);
    const warnSpy = vi.spyOn(logger, 'warn');
    const history: History = [
      {
        role: 'user',
        parts: [{ type: 'image', format: 'png', storage: { kind: 'object', key: 'key-1' } }],
      },
    ];

    const resolved = await resolveForProvider(history);

    expect(resolved[0].parts).toEqual([{ type: 'text', text: '[image unavailable]' }]);
    expect(warnSpy).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ event: 'object-store-unreachable' }),
    );
  });

  it('replaces a flagged-unrecoverable part with "[image unavailable]" text + a warn (no get)', async () => {
    const warnSpy = vi.spyOn(logger, 'warn');
    const history: History = [
      {
        role: 'assistant',
        parts: [{ type: 'image', format: 'jpeg', storage: { kind: 'unrecoverable' } }],
      },
    ];

    const resolved = await resolveForProvider(history);

    expect(resolved[0].parts).toEqual([{ type: 'text', text: '[image unavailable]' }]);
    expect(storageMock.gets).toEqual([]);
    expect(warnSpy).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ event: 'object-store-unreachable' }),
    );
  });

  it('fetches a key shared across two messages exactly once (cross-message dedup)', async () => {
    const history: History = [
      {
        role: 'user',
        parts: [{ type: 'image', format: 'png', storage: { kind: 'object', key: 'key-1' } }],
      },
      {
        role: 'assistant',
        parts: [{ type: 'image', format: 'png', storage: { kind: 'object', key: 'key-1' } }],
      },
    ];

    const resolved = await resolveForProvider(history);

    expect(storageMock.gets).toEqual(['key-1']); // ONE fetch, not two
    expect(resolved[0].parts[0]).toMatchObject({ type: 'image', dataBase64: IMG_B64 });
    expect(resolved[1].parts[0]).toMatchObject({ type: 'image', dataBase64: IMG_B64 });
  });

  it('passes inline image / text parts through unchanged (new message own images stay inline)', async () => {
    const history: History = [
      {
        role: 'user',
        parts: [
          { type: 'text', text: 'hello' },
          { type: 'image', format: 'webp', dataBase64: IMG_B64 },
        ],
      },
    ];

    const resolved = await resolveForProvider(history);

    expect(resolved).toEqual([
      {
        role: 'user',
        parts: [
          { type: 'text', text: 'hello' },
          { type: 'image', format: 'webp', dataBase64: IMG_B64 },
        ],
      },
    ]);
    expect(storageMock.gets).toEqual([]); // inline never hits the bucket
  });

  it('storage OFF ⇒ pure passthrough (no get, history unchanged)', async () => {
    storageMock.enabled = false;
    const history: History = [
      {
        role: 'user',
        parts: [
          { type: 'text', text: 'self-host' },
          { type: 'image', format: 'png', dataBase64: IMG_B64 },
        ],
      },
    ];

    const resolved = await resolveForProvider(history);

    expect(resolved).toEqual(history);
    expect(storageMock.gets).toEqual([]);
  });
});

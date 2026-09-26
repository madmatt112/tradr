import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { sql } from 'drizzle-orm';

import {
  ARCHIVE_CAPS,
  PutDashboardLayoutRequestSchema,
  type ArchiveAccount,
  type ArchiveBrokerage,
  type ArchiveBrokerageResolution,
  type ArchiveCaps,
  type ArchiveContentPart,
  type ArchiveConversation,
  type ArchiveDashboardLayout,
  type ArchiveExchangeRate,
  type ArchiveExpense,
  type ArchiveFill,
  type ArchiveImagePart,
  type ArchiveLedgerEntry,
  type ArchiveMessage,
  type ArchivePersona,
  type ArchivePersonaResolution,
  type ArchivePosition,
  type ArchivePositionImage,
  type ArchivePositionTag,
  type ArchivePreferences,
  type ArchiveSummary,
  type ArchiveSystemBrokerageRef,
  type ArchiveTag,
  type ImportPreview,
  type ImportResult,
} from '@tradr/shared';

import { db } from '@/db';
import type { Transaction } from '@/db';
import { lockUserForAccountChange } from '@/features/accounts/accounts.query';
import { AppError } from '@/lib/errors';
import { IMAGE_CONTENT_TYPES } from '@/lib/image-serving';
import {
  advisorImageKey,
  getObjectStorage,
  positionImageKey,
  type ObjectStorage,
} from '@/lib/object-storage';
import { holdImportFence } from '@/lib/object-storage/gc-fence';
import { captureServerEvent } from '@/lib/posthog';
import { withTransaction } from '@/lib/transaction';

import {
  ArchiveDigestMismatchError,
  ImportBusyError,
  ImportFailedError,
} from './account-data.errors';
import { accountDataSlot } from './account-data.slots';
import { readArchive } from './archive-reader';
import { spoolUpload } from './archive-upload';
import { validateArchive, type ValidatedArchive } from './import-validation.service';
import {
  assertTargetEmpty,
  findExistingBuiltinPersonaIds,
  findSystemBrokeragesByName,
  insertArchiveAccounts,
  insertArchiveBrokerages,
  insertArchiveConversations,
  insertArchiveExchangeRates,
  insertArchiveExpenses,
  insertArchiveFills,
  insertArchiveLedgerEntries,
  insertArchiveMessages,
  insertArchivePersonas,
  insertArchivePositionImages,
  insertArchivePositions,
  insertArchivePositionTags,
  insertArchiveSummaries,
  insertArchiveTags,
  type AccountInsert,
  type BrokerageInsert,
  type ConversationInsert,
  type ExchangeRateInsert,
  type ExpenseInsert,
  type FillInsert,
  type LedgerEntryInsert,
  type MessageInsert,
  type PersonaInsert,
  type PositionImageInsert,
  type PositionInsert,
  type PositionTagInsert,
  type SummaryInsert,
  type TagInsert,
} from './import.query';
import { newSalt, orderedMessageIds, remapId, createCoveredThroughResolver } from './remap';

// Design C6 — the import service. Two entry points: `previewImport` validates an
// uploaded archive and reports what a restore would create (Req 4.6, 4.7);
// `confirmImport` performs the whole-or-nothing restore (Req 5–7). Both spool the
// upload into their own `os.tmpdir()` directory (task 5's `spoolUpload`) and delete
// it on any close, mirroring the export service's teardown (C3).
//
// The restore writes the archived rows DIRECTLY through task 11's per-category
// inserts: no tier check, no close/fill/reverse hook, no gating counter, no ledger
// row the archive does not hold (Req 5.9, 9). Object storage stays optional — with
// none configured, images restore inline (Req 7.1). Fresh identifiers come from
// task 10 (`remapId`, `orderedMessageIds`), platform references resolve per C6
// Resolution, and the gc fence (task 4) protects the objects a restore writes.

// A `SET LOCAL lock_timeout` this long bounds the wait for the fence and the
// per-user guard; an expiry raises SQLSTATE 55P03, mapped to the 503 busy error
// (PostgreSQL 16.15, probed).
const DEFAULT_LOCK_TIMEOUT = '30s';

// Postgres SQLSTATE for a statement cancelled by `lock_timeout` (lock_not_available).
const PG_LOCK_TIMEOUT_CODE = '55P03';

// Keep the open transaction from idling through a slow object-write phase (the
// image puts, which are the only DB-idle window in the restore): a `SELECT 1`
// after this long of inactivity, matching the gc fence's heartbeat interval.
const HEARTBEAT_MS = 15_000;

// A flushed insert holds at most this many rows or this much bound text at once, so
// the streaming restore never buffers a whole large category on the 256 MB machine.
const FLUSH_MAX_ROWS = 500;
const FLUSH_MAX_BYTES = 1024 * 1024;

interface PreviewOptions {
  caps?: Partial<ArchiveCaps>;
}

interface ConfirmOptions {
  caps?: Partial<ArchiveCaps>;
  /** Overrides the restore transaction's `lock_timeout` (tests only). */
  lockTimeout?: string;
}

/**
 * Validate an uploaded archive and return its preview (design C6, Req 4.6, 4.7).
 * Spools the body into a fresh temp directory, validates it (task 9), checks the
 * target is empty (task 11) and returns the server's own counts, the source app
 * version, the export instant, the degradations and the upload's sha256 hex as the
 * `digest` the confirm must echo. Writes nothing. The temp directory is deleted on
 * any exit.
 */
export async function previewImport(
  userId: string,
  body: ReadableStream<Uint8Array> | null,
  opts?: PreviewOptions,
): Promise<ImportPreview> {
  const caps: ArchiveCaps = { ...ARCHIVE_CAPS, ...opts?.caps };
  const dir = await mkdtemp(path.join(os.tmpdir(), 'tradr-import-'));
  try {
    const { path: archivePath, sha256 } = await spoolUpload(body, dir, caps.maxUploadBytes);
    const validated = await validateArchive(archivePath, opts?.caps);
    await assertTargetEmpty(db, userId);
    return {
      counts: validated.counts,
      sourceAppVersion: validated.manifest.sourceAppVersion,
      exportedAt: validated.manifest.exportedAt,
      degradations: validated.degradations,
      digest: sha256,
    };
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

/**
 * Perform a confirmed whole-or-nothing restore (design C6, Req 5–7). Follows C6
 * steps 1–6: re-spool and digest-check the body; acquire the import slot and
 * validate; then one transaction that sets `lock_timeout`, takes the gc fence (only
 * with storage configured), the per-user guard and the in-transaction emptiness
 * re-check, streams the archive a second time to write objects then rows in FK
 * order with fresh ids and resolved platform references, overwrites preferences
 * (bar `advisor_trade_data_consent`) and replaces the dashboard layout, and commits.
 * A lock-wait expiry becomes the 503 busy error; an object-write failure the 503
 * unreachable error before any row is inserted; any other non-`AppError` the 500
 * import-failed error, with the objects the failed run wrote deleted best-effort.
 * Emits `account_imported` after commit. The temp directory is deleted and the slot
 * released on any exit.
 */
export async function confirmImport(
  userId: string,
  body: ReadableStream<Uint8Array> | null,
  digest: string,
  opts?: ConfirmOptions,
): Promise<ImportResult> {
  const startedAt = Date.now();
  const caps: ArchiveCaps = { ...ARCHIVE_CAPS, ...opts?.caps };
  const lockTimeout = opts?.lockTimeout ?? DEFAULT_LOCK_TIMEOUT;
  const storage = getObjectStorage();

  const release = await accountDataSlot('import').acquire();
  let dir: string;
  try {
    dir = await mkdtemp(path.join(os.tmpdir(), 'tradr-import-'));
  } catch (err) {
    release();
    throw err;
  }

  // Objects written by this run; deleted best-effort if the transaction rolls back
  // (Req 7.4). The fence (task 4) protects them until then.
  const writtenKeys: string[] = [];

  try {
    const { path: archivePath, sha256 } = await spoolUpload(body, dir, caps.maxUploadBytes);
    if (sha256 !== digest) throw new ArchiveDigestMismatchError();

    const validated = await validateArchive(archivePath, opts?.caps);

    const result = await withTransaction(db, async (tx) => {
      // Bound the lock waits below; an expiry raises 55P03 → the busy error.
      await tx.execute(sql`SELECT set_config('lock_timeout', ${lockTimeout}, true)`);
      // The gc fence is only meaningful when objects are written (Req 7.3).
      if (storage) await holdImportFence(tx);
      await lockUserForAccountChange(tx, userId);
      await assertTargetEmpty(tx, userId);
      return restore(tx, userId, archivePath, opts?.caps, validated, storage, writtenKeys);
    });

    emitImported(userId, validated, startedAt);
    return result;
  } catch (err) {
    if (storage && writtenKeys.length > 0) {
      await Promise.all(writtenKeys.map((key) => storage.delete(key).catch(() => {})));
    }
    if (err instanceof AppError) throw err;
    if ((err as { code?: unknown }).code === PG_LOCK_TIMEOUT_CODE) throw new ImportBusyError();
    throw new ImportFailedError();
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
    release();
  }
}

function emitImported(userId: string, validated: ValidatedArchive, startedAt: number): void {
  const properties: Record<string, number> = { durationMs: Date.now() - startedAt };
  for (const [key, value] of Object.entries(validated.counts)) properties[`count_${key}`] = value;
  captureServerEvent('account_imported', { distinctId: userId, properties });
}

// --- The streaming restore ---------------------------------------------------

// A rewritten content part destined for a jsonb column: either an inline part
// (text/tool_call/tool_result/dataBase64 image) or a stored image marker.
type RestoredPart =
  | ArchiveContentPart
  | { type: 'image'; format: string; storage: { kind: 'object'; key: string } }
  | { type: 'image'; format: string; dataBase64: string };

// Bounded per-category buffer: flushes through `flush` at FLUSH_MAX_ROWS rows or
// FLUSH_MAX_BYTES of accumulated payload, and once more on `drain`.
function makeFlusher<T>(flush: (rows: T[]) => Promise<void>): {
  push: (row: T, bytes?: number) => Promise<void>;
  drain: () => Promise<void>;
} {
  let buf: T[] = [];
  let bytes = 0;
  const send = async (): Promise<void> => {
    if (buf.length === 0) return;
    const chunk = buf;
    buf = [];
    bytes = 0;
    await flush(chunk);
  };
  return {
    async push(row, rowBytes = 0) {
      buf.push(row);
      bytes += rowBytes;
      if (buf.length >= FLUSH_MAX_ROWS || bytes >= FLUSH_MAX_BYTES) await send();
    },
    drain: send,
  };
}

// Restore the archive's rows in one pass and one transaction (design C6 steps 4–5).
async function restore(
  tx: Transaction,
  userId: string,
  archivePath: string,
  capsOverride: Partial<ArchiveCaps> | undefined,
  validated: ValidatedArchive,
  storage: ObjectStorage | null,
  writtenKeys: string[],
): Promise<ImportResult> {
  const salt = newSalt();
  const nowTs = new Date().toISOString();

  // --- Image staging (Req 7.1, 7.2) -----------------------------------------
  // Storage: each entry's bytes are put unchanged under the user's prefix; the key
  // is remembered so a referencing part becomes an object pointer. No storage: the
  // bytes are staged to a temp file and inlined as `dataBase64` when the part is
  // rewritten (keeps the whole image set off the heap during the put phase).
  const keyByEntry = new Map<string, string>();
  const fileByEntry = new Map<string, string>();
  let stagedCount = 0;

  const handleImage = async (entry: string, bytes: Uint8Array): Promise<void> => {
    const format = entry.slice(entry.lastIndexOf('.') + 1);
    if (storage) {
      const key = entry.startsWith('images/advisor/')
        ? advisorImageKey(userId)
        : positionImageKey(userId);
      await storage.put(key, bytes, IMAGE_CONTENT_TYPES[format] ?? 'application/octet-stream');
      writtenKeys.push(key);
      keyByEntry.set(entry, key);
    } else {
      const file = path.join(path.dirname(archivePath), `img-${stagedCount++}`);
      await writeFile(file, bytes);
      fileByEntry.set(entry, file);
    }
  };

  const rewritePart = async (
    part: ArchiveContentPart | ArchiveImagePart,
  ): Promise<RestoredPart> => {
    if (part.type !== 'image') return part;
    if ('storage' in part) return part; // unrecoverable marker, kept as archived
    if (storage) {
      const key = keyByEntry.get(part.entry)!;
      return { type: 'image', format: part.format, storage: { kind: 'object', key } };
    }
    const file = fileByEntry.get(part.entry)!;
    const bytes = await readFile(file);
    return { type: 'image', format: part.format, dataBase64: bytes.toString('base64') };
  };

  // --- Platform-reference resolution (design C6 Resolution, Req 6) -----------
  const pendingBrokerages: BrokerageInsert[] = [];
  const userBrokerageLowerNames = new Set<string>();
  const systemRefsByLower = new Map<string, ArchiveSystemBrokerageRef>();
  const builtinRefIds: string[] = [];

  // lower(system name) → the target brokerage id an account links to (an existing
  // system brokerage, or a created user brokerage), filled by ensureBrokerages.
  const systemTargetIdByLower = new Map<string, string>();
  const systemBrokerageResolutions: ArchiveBrokerageResolution[] = [];
  let brokeragesInserted = false;

  const ensureBrokerages = async (): Promise<void> => {
    if (brokeragesInserted) return;
    brokeragesInserted = true;

    const found = await findSystemBrokeragesByName(tx, [...systemRefsByLower.keys()]);
    const taken = new Set(userBrokerageLowerNames);
    const toInsert = [...pendingBrokerages];

    for (const [lower, ref] of systemRefsByLower) {
      const existing = found.get(lower);
      if (existing) {
        systemTargetIdByLower.set(lower, existing.id);
        systemBrokerageResolutions.push({ name: ref.name, outcome: 'linked' });
        continue;
      }
      const createdName = deriveCreatedName(ref.name, taken);
      taken.add(createdName.toLowerCase());
      const id = remapId(salt, `system-brokerage:${lower}`);
      systemTargetIdByLower.set(lower, id);
      toInsert.push({
        id,
        name: createdName,
        notes: null,
        feeSchedule:
          ref.feeSchedule === null
            ? null
            : { ...ref.feeSchedule, createdAt: nowTs, updatedAt: nowTs },
        createdAt: nowTs,
        updatedAt: nowTs,
      });
      systemBrokerageResolutions.push({
        name: ref.name,
        outcome: 'created',
        ...(createdName === ref.name ? {} : { createdName }),
      });
    }
    await insertArchiveBrokerages(tx, userId, toInsert);
  };

  const builtinExisting = new Set<string>();
  const builtinPersonaResolutions: ArchivePersonaResolution[] = [];
  let builtinResolved = false;

  const ensureBuiltins = async (): Promise<void> => {
    if (builtinResolved) return;
    builtinResolved = true;
    const present = await findExistingBuiltinPersonaIds(tx, builtinRefIds);
    for (const id of builtinRefIds) {
      const matched = present.has(id);
      if (matched) builtinExisting.add(id);
      builtinPersonaResolutions.push({ id, outcome: matched ? 'matched' : 'missing' });
    }
  };

  const resolveAccountBrokerage = (brokerage: ArchiveAccount['brokerage']): string | null => {
    if (brokerage === null) return null;
    if ('user' in brokerage) return remapId(salt, brokerage.user);
    return systemTargetIdByLower.get(brokerage.system.toLowerCase()) ?? null;
  };

  const resolvePersona = (persona: ArchiveConversation['persona']): string | null => {
    if (persona === null) return null;
    if ('user' in persona) return remapId(salt, persona.user);
    return builtinExisting.has(persona.builtin) ? persona.builtin : null;
  };

  // --- Fresh message ids (design C7, P5) ------------------------------------
  const orderedIdsCache = new Map<string, string[]>();
  const convMessageIndex = new Map<string, number>();
  const coveredResolver = createCoveredThroughResolver(salt, validated.coveredThroughMessageIds);

  const messageId = (conversationSourceId: string): string => {
    let ids = orderedIdsCache.get(conversationSourceId);
    if (!ids) {
      const total = validated.messageCountsByConversation.get(conversationSourceId) ?? 0;
      ids = orderedMessageIds(salt, conversationSourceId, total);
      orderedIdsCache.set(conversationSourceId, ids);
    }
    const idx = convMessageIndex.get(conversationSourceId) ?? 0;
    convMessageIndex.set(conversationSourceId, idx + 1);
    return ids[idx];
  };

  // --- Per-category flushers (FK order matches ARCHIVE_ENTRY_ORDER) ----------
  const accountsF = makeFlusher<AccountInsert>((rows) => insertArchiveAccounts(tx, userId, rows));
  const tagsF = makeFlusher<TagInsert>((rows) => insertArchiveTags(tx, userId, rows));
  const positionsF = makeFlusher<PositionInsert>((rows) =>
    insertArchivePositions(tx, userId, rows),
  );
  const fillsF = makeFlusher<FillInsert>((rows) => insertArchiveFills(tx, rows));
  const positionTagsF = makeFlusher<PositionTagInsert>((rows) =>
    insertArchivePositionTags(tx, rows),
  );
  const positionImagesF = makeFlusher<PositionImageInsert>((rows) =>
    insertArchivePositionImages(tx, rows),
  );
  const ledgerF = makeFlusher<LedgerEntryInsert>((rows) =>
    insertArchiveLedgerEntries(tx, userId, rows),
  );
  const ratesF = makeFlusher<ExchangeRateInsert>((rows) =>
    insertArchiveExchangeRates(tx, userId, rows),
  );
  const expensesF = makeFlusher<ExpenseInsert>((rows) => insertArchiveExpenses(tx, userId, rows));
  const personasF = makeFlusher<PersonaInsert>((rows) => insertArchivePersonas(tx, userId, rows));
  const conversationsF = makeFlusher<ConversationInsert>((rows) =>
    insertArchiveConversations(tx, userId, rows),
  );
  const messagesF = makeFlusher<MessageInsert>((rows) => insertArchiveMessages(tx, rows));
  const summariesF = makeFlusher<SummaryInsert>((rows) => insertArchiveSummaries(tx, rows));

  let prefsValue: ArchivePreferences | undefined;
  let layoutValue: ArchiveDashboardLayout | undefined;

  // --- Idle heartbeat over the image-put phase ------------------------------
  let ping: Promise<unknown> | null = null;
  const heartbeat = setInterval(() => {
    if (ping) return;
    ping = tx
      .execute(sql`SELECT 1`)
      .catch(() => {})
      .finally(() => {
        ping = null;
      });
  }, HEARTBEAT_MS);
  let heartbeatStopped = false;
  const stopHeartbeat = async (): Promise<void> => {
    if (heartbeatStopped) return;
    heartbeatStopped = true;
    clearInterval(heartbeat);
    if (ping) await ping;
  };

  try {
    for await (const event of readArchive(archivePath, capsOverride)) {
      if (event.kind === 'image') {
        await handleImage(event.entry, event.bytes);
        continue;
      }
      if (event.kind === 'json') {
        // The first JSON entry (manifest) marks the end of the image-put phase.
        await stopHeartbeat();
        if (event.entry === 'preferences.json') prefsValue = event.value as ArchivePreferences;
        else if (event.entry === 'dashboard-layout.json')
          layoutValue = event.value as ArchiveDashboardLayout;
        continue;
      }
      if (event.kind === 'entry-end') {
        await onEntryEnd(event.entry);
        continue;
      }

      await handleRow(event.entry, event.value);
    }
  } finally {
    await stopHeartbeat();
  }

  // Defensive final pass: flush anything an absent entry-end left behind, in FK
  // order. Each drain is a no-op once its entry-end already flushed it.
  await ensureBrokerages();
  await accountsF.drain();
  await tagsF.drain();
  await positionsF.drain();
  await fillsF.drain();
  await positionTagsF.drain();
  await positionImagesF.drain();
  await ledgerF.drain();
  await ratesF.drain();
  await expensesF.drain();
  await personasF.drain();
  await ensureBuiltins();
  await conversationsF.drain();
  await messagesF.drain();
  await summariesF.drain();

  await applyPreferences(tx, userId, salt, prefsValue, resolvePersona);
  await applyLayout(tx, userId, layoutValue);

  return {
    counts: validated.counts,
    degradations: validated.degradations,
    resolutions: {
      systemBrokerages: systemBrokerageResolutions,
      builtinPersonas: builtinPersonaResolutions,
    },
  };

  async function onEntryEnd(entry: string): Promise<void> {
    switch (entry) {
      case 'system-brokerages.ndjson':
        await ensureBrokerages();
        return;
      case 'accounts.ndjson':
        await accountsF.drain();
        return;
      case 'tags.ndjson':
        await tagsF.drain();
        return;
      case 'positions.ndjson':
        await positionsF.drain();
        return;
      case 'fills.ndjson':
        await fillsF.drain();
        return;
      case 'position-tags.ndjson':
        await positionTagsF.drain();
        return;
      case 'position-images.ndjson':
        await positionImagesF.drain();
        return;
      case 'ledger-entries.ndjson':
        await ledgerF.drain();
        return;
      case 'exchange-rates.ndjson':
        await ratesF.drain();
        return;
      case 'expenses.ndjson':
        await expensesF.drain();
        return;
      case 'personas.ndjson':
        await personasF.drain();
        return;
      case 'builtin-personas.ndjson':
        await ensureBuiltins();
        return;
      case 'conversations.ndjson':
        await conversationsF.drain();
        return;
      case 'messages.ndjson':
        await messagesF.drain();
        return;
      case 'summaries.ndjson':
        await summariesF.drain();
        return;
      default:
        return;
    }
  }

  async function handleRow(entry: string, value: unknown): Promise<void> {
    switch (entry) {
      case 'brokerages.ndjson': {
        const r = value as ArchiveBrokerage;
        userBrokerageLowerNames.add(r.name.toLowerCase());
        pendingBrokerages.push({
          id: remapId(salt, r.id),
          name: r.name,
          notes: r.notes,
          feeSchedule: r.feeSchedule,
          createdAt: r.createdAt,
          updatedAt: r.updatedAt,
        });
        return;
      }
      case 'system-brokerages.ndjson': {
        const r = value as ArchiveSystemBrokerageRef;
        const lower = r.name.toLowerCase();
        if (!systemRefsByLower.has(lower)) systemRefsByLower.set(lower, r);
        return;
      }
      case 'accounts.ndjson': {
        await ensureBrokerages();
        const r = value as ArchiveAccount;
        await accountsF.push({
          id: remapId(salt, r.id),
          name: r.name,
          currency: r.currency,
          timezone: r.timezone,
          brokerageId: resolveAccountBrokerage(r.brokerage),
          startingBalance: r.startingBalance,
          defaultRiskPercent: r.defaultRiskPercent,
          isDemo: r.isDemo,
          isDefault: r.isDefault,
          createdAt: r.createdAt,
          updatedAt: r.updatedAt,
        });
        return;
      }
      case 'tags.ndjson': {
        const r = value as ArchiveTag;
        await tagsF.push({
          id: remapId(salt, r.id),
          name: r.name,
          category: r.category,
          color: r.color,
          createdAt: r.createdAt,
          updatedAt: r.updatedAt,
        });
        return;
      }
      case 'positions.ndjson': {
        const r = value as ArchivePosition;
        await positionsF.push({
          id: remapId(salt, r.id),
          accountId: remapId(salt, r.accountId),
          symbol: r.symbol,
          side: r.side,
          assetType: r.assetType,
          status: r.status,
          notes: r.notes,
          targetPrice: r.targetPrice,
          stopLoss: r.stopLoss,
          openedAt: r.openedAt,
          closedAt: r.closedAt,
          lastFlatAt: r.lastFlatAt,
          lastFlatNetPnl: r.lastFlatNetPnl,
          createdAt: r.createdAt,
          updatedAt: r.updatedAt,
        });
        return;
      }
      case 'fills.ndjson': {
        const r = value as ArchiveFill;
        await fillsF.push({
          id: remapId(salt, r.id),
          positionId: remapId(salt, r.positionId),
          type: r.type,
          price: r.price,
          quantity: r.quantity,
          fees: r.fees,
          notes: r.notes,
          filledAt: r.filledAt,
          createdAt: r.createdAt,
        });
        return;
      }
      case 'position-tags.ndjson': {
        const r = value as ArchivePositionTag;
        await positionTagsF.push({
          positionId: remapId(salt, r.positionId),
          tagId: remapId(salt, r.tagId),
        });
        return;
      }
      case 'position-images.ndjson': {
        const r = value as ArchivePositionImage;
        const part = await rewritePart(r.part);
        await positionImagesF.push(
          {
            id: remapId(salt, r.id),
            positionId: remapId(salt, r.positionId),
            part,
            createdAt: r.createdAt,
          },
          approxBytes(part),
        );
        return;
      }
      case 'ledger-entries.ndjson': {
        const r = value as ArchiveLedgerEntry;
        await ledgerF.push({
          id: remapId(salt, r.id),
          accountId: remapId(salt, r.accountId),
          positionId: r.positionId === null ? null : remapId(salt, r.positionId),
          entryType: r.entryType,
          direction: r.direction,
          amount: r.amount,
          currency: r.currency,
          symbol: r.symbol,
          occurredAt: r.occurredAt,
          createdAt: r.createdAt,
          groupId: remapId(salt, r.groupId),
          reversesGroupId: r.reversesGroupId === null ? null : remapId(salt, r.reversesGroupId),
        });
        return;
      }
      case 'exchange-rates.ndjson': {
        const r = value as ArchiveExchangeRate;
        await ratesF.push({
          id: remapId(salt, r.id),
          baseCurrency: r.baseCurrency,
          quoteCurrency: r.quoteCurrency,
          rate: r.rate,
          effectiveDate: r.effectiveDate,
          createdAt: r.createdAt,
        });
        return;
      }
      case 'expenses.ndjson': {
        const r = value as ArchiveExpense;
        await expensesF.push({
          id: remapId(salt, r.id),
          category: r.category,
          description: r.description,
          amount: r.amount,
          currency: r.currency,
          occurredAt: r.occurredAt,
          notes: r.notes,
          createdAt: r.createdAt,
          updatedAt: r.updatedAt,
        });
        return;
      }
      case 'personas.ndjson': {
        const r = value as ArchivePersona;
        await personasF.push({
          id: remapId(salt, r.id),
          name: r.name,
          description: r.description,
          systemPrompt: r.systemPrompt,
          isDefault: r.isDefault,
          createdAt: r.createdAt,
          updatedAt: r.updatedAt,
        });
        return;
      }
      case 'builtin-personas.ndjson': {
        const r = value as { id: string };
        builtinRefIds.push(r.id);
        return;
      }
      case 'conversations.ndjson': {
        await ensureBuiltins();
        const r = value as ArchiveConversation;
        await conversationsF.push({
          id: remapId(salt, r.id),
          title: r.title,
          personaId: resolvePersona(r.persona),
          providerId: r.providerId,
          model: r.model,
          createdAt: r.createdAt,
          updatedAt: r.updatedAt,
        });
        return;
      }
      case 'messages.ndjson': {
        const r = value as ArchiveMessage;
        coveredResolver.record(r.id, r.conversationId);
        const id = messageId(r.conversationId);
        const contentParts: RestoredPart[] = [];
        for (const part of r.contentParts) contentParts.push(await rewritePart(part));
        await messagesF.push(
          {
            id,
            conversationId: remapId(salt, r.conversationId),
            role: r.role,
            contentParts,
            promptTokens: r.promptTokens,
            completionTokens: r.completionTokens,
            clientMessageId: r.clientMessageId,
            createdAt: r.createdAt,
          },
          approxBytes(contentParts),
        );
        return;
      }
      case 'summaries.ndjson': {
        const r = value as ArchiveSummary;
        await summariesF.push({
          id: remapId(salt, r.id),
          conversationId: remapId(salt, r.conversationId),
          prose: r.prose,
          tradeDataFigures: r.tradeDataFigures,
          coveredThroughMessageId:
            r.coveredThroughMessageId === null
              ? null
              : coveredResolver.resolve(r.coveredThroughMessageId),
          coveredThroughCreatedAt: r.coveredThroughCreatedAt,
          createdAt: r.createdAt,
          updatedAt: r.updatedAt,
        });
        return;
      }
      default:
        return;
    }
  }
}

// A rough on-heap payload size for a content-heavy row, used to flush inline-image
// batches before they accumulate; small rows report ~0 and flush purely by count.
function approxBytes(value: unknown): number {
  const part = value as { dataBase64?: string } | Array<{ dataBase64?: string }>;
  if (Array.isArray(part)) return part.reduce((sum, p) => sum + (p.dataBase64?.length ?? 0), 0);
  return part.dataBase64?.length ?? 0;
}

// Overwrite the target's preferences with the archived values, except
// `advisor_trade_data_consent` (Req 5.6). `writable_account_id` is null when the
// archive carries none (Req 9.2, resolved at read time by `resolveWritableAccountId`)
// and the remapped account otherwise; `advisor_default_persona_id` resolves like a
// conversation persona. `onboarding` travels as opaque jsonb (D13).
async function applyPreferences(
  tx: Transaction,
  userId: string,
  salt: Buffer,
  prefs: ArchivePreferences | undefined,
  resolvePersona: (persona: ArchivePreferences['advisorDefaultPersona']) => string | null,
): Promise<void> {
  if (!prefs) return;
  const writableAccountId =
    prefs.writableAccountId === null ? null : remapId(salt, prefs.writableAccountId);
  const advisorDefaultPersonaId = resolvePersona(prefs.advisorDefaultPersona);
  await tx.execute(sql`
    UPDATE users SET
      display_currency = ${prefs.displayCurrency},
      timezone = ${prefs.timezone},
      tax_jurisdiction = ${prefs.taxJurisdiction},
      theme = ${prefs.theme},
      buying_power_basis = ${prefs.buyingPowerBasis},
      advisor_default_persona_id = ${advisorDefaultPersonaId},
      writable_account_id = ${writableAccountId}::uuid,
      onboarding = ${JSON.stringify(prefs.onboarding)}::jsonb,
      updated_at = now()
    WHERE id = ${userId}
  `);
}

// Replace any existing dashboard layout with the archived one, or delete it when the
// archive carries none or the validator dropped it as unparseable (design D11).
async function applyLayout(
  tx: Transaction,
  userId: string,
  layout: ArchiveDashboardLayout | undefined,
): Promise<void> {
  const dropped =
    layout != null &&
    !PutDashboardLayoutRequestSchema.safeParse({ widgets: layout.widgets }).success;
  if (layout == null || dropped) {
    await tx.execute(sql`DELETE FROM dashboard_layouts WHERE user_id = ${userId}`);
    return;
  }
  await tx.execute(sql`
    INSERT INTO dashboard_layouts (user_id, widgets, created_at, updated_at)
    VALUES (
      ${userId},
      ${JSON.stringify(layout.widgets)}::jsonb,
      ${layout.createdAt}::timestamptz,
      ${layout.updatedAt}::timestamptz
    )
    ON CONFLICT (user_id) DO UPDATE SET
      widgets = EXCLUDED.widgets,
      created_at = EXCLUDED.created_at,
      updated_at = EXCLUDED.updated_at
  `);
}

// Rename a created-from-snapshot brokerage that collides with a user brokerage from
// the same archive: ` (imported)`, ` (imported 2)`, … with the base truncated so the
// whole name fits the 100-character column (Req 6.1).
function deriveCreatedName(name: string, taken: ReadonlySet<string>): string {
  if (!taken.has(name.toLowerCase())) return name.slice(0, 100);
  for (let n = 1; ; n += 1) {
    const suffix = n === 1 ? ' (imported)' : ` (imported ${n})`;
    const base = name.slice(0, 100 - suffix.length);
    const candidate = `${base}${suffix}`;
    if (!taken.has(candidate.toLowerCase())) return candidate;
  }
}

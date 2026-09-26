import type { ZodError } from 'zod';

import {
  ARCHIVE_CAPS,
  POSITION_IMAGE_MAX_COUNT,
  TAG_LIMITS,
  ArchiveAccountSchema,
  ArchiveBrokerageSchema,
  ArchiveBuiltinPersonaRefSchema,
  ArchiveConversationSchema,
  ArchiveDashboardLayoutSchema,
  ArchiveExchangeRateSchema,
  ArchiveExpenseSchema,
  ArchiveFillSchema,
  ArchiveLedgerEntrySchema,
  ArchiveManifestSchema,
  ArchiveMessageSchema,
  ArchivePersonaSchema,
  ArchivePositionImageSchema,
  ArchivePositionSchema,
  ArchivePositionTagSchema,
  ArchivePreferencesSchema,
  ArchiveSummarySchema,
  ArchiveSystemBrokerageRefSchema,
  ArchiveTagSchema,
  OnboardingStateSchema,
  PutDashboardLayoutRequestSchema,
  type ArchiveCaps,
  type ArchiveCounts,
  type ArchiveDegradation,
  type ArchiveManifest,
} from '@tradr/shared';

import { ArchiveEmptyError, ArchiveInvalidError } from './account-data.errors';
import { readArchive } from './archive-reader';

// Design C5 — the validator half of the archive reader/validator (Req 4.1–4.3,
// 4.5). `validateArchive` consumes `readArchive`'s events once (task 8) and parses
// every row with task 2's strict `@tradr/shared` schemas, then runs the semantic
// checks a fresh parse cannot: id uniqueness per entry, the DB-mirror uniques, every
// reference, the image bijection, the Req 4.3 invariants, the manifest counts and
// emptiness. It writes nothing and touches no database.
//
// Memory (design D6): ids are tracked in keyed-hash `Set`s bounded by the row cap,
// never as maps of parsed rows — each row is parsed, checked and discarded. The
// covered-through id set is bounded by `maxCoveredThroughRefs`.
//
// Faults are collected — up to 50 — and thrown together as `ArchiveInvalidError`
// with `{ path, code, message }` fields (design Error Handling). Container, version
// and cap errors are raised by `readArchive` and propagate unchanged.

const MAX_FAULTS = 50;

// The blocking Req 5.1 categories: an archive with no row in any of these is empty.
const EMPTY_CATEGORIES: readonly (keyof ArchiveCounts)[] = [
  'accounts',
  'positions',
  'ledgerEntries',
  'exchangeRates',
  'expenses',
  'brokerages',
  'tags',
  'conversations',
  'personas',
];

// NDJSON entry name → the `counts` key it feeds.
const COUNT_KEY: Record<string, keyof ArchiveCounts> = {
  'brokerages.ndjson': 'brokerages',
  'system-brokerages.ndjson': 'systemBrokerages',
  'accounts.ndjson': 'accounts',
  'tags.ndjson': 'tags',
  'positions.ndjson': 'positions',
  'fills.ndjson': 'fills',
  'position-tags.ndjson': 'positionTags',
  'position-images.ndjson': 'positionImages',
  'ledger-entries.ndjson': 'ledgerEntries',
  'exchange-rates.ndjson': 'exchangeRates',
  'expenses.ndjson': 'expenses',
  'personas.ndjson': 'personas',
  'builtin-personas.ndjson': 'builtinPersonas',
  'conversations.ndjson': 'conversations',
  'messages.ndjson': 'messages',
  'summaries.ndjson': 'summaries',
};

// NDJSON entry name → the fault-path label (Data Models uses these bare names).
const LABEL: Record<string, string> = {
  'brokerages.ndjson': 'brokerages',
  'system-brokerages.ndjson': 'system-brokerages',
  'accounts.ndjson': 'accounts',
  'tags.ndjson': 'tags',
  'positions.ndjson': 'positions',
  'fills.ndjson': 'fills',
  'position-tags.ndjson': 'position-tags',
  'position-images.ndjson': 'position-images',
  'ledger-entries.ndjson': 'ledger-entries',
  'exchange-rates.ndjson': 'exchange-rates',
  'expenses.ndjson': 'expenses',
  'personas.ndjson': 'personas',
  'builtin-personas.ndjson': 'builtin-personas',
  'conversations.ndjson': 'conversations',
  'messages.ndjson': 'messages',
  'summaries.ndjson': 'summaries',
};

/**
 * The result of validating an archive: the parsed manifest, the server's own counts
 * per category, the surfaced degradations (the manifest's `object_missing` set plus
 * a `dashboard_layout_unparseable` marker when the layout was dropped), the
 * per-conversation message counts and the summary-covered message ids (both feed
 * C7's fresh-id assignment), and the archive's user-brokerage names (Req 6.1
 * collision resolution).
 */
export interface ValidatedArchive {
  manifest: ArchiveManifest;
  counts: ArchiveCounts;
  degradations: ArchiveDegradation[];
  messageCountsByConversation: Map<string, number>;
  coveredThroughMessageIds: Set<string>;
  userBrokerageNames: string[];
}

/**
 * Validate a spooled archive in one streaming pass (design C5). Returns a
 * {@link ValidatedArchive} when the archive is structurally sound, non-empty and
 * every check passes. Throws {@link ArchiveInvalidError} (up to 50 faults),
 * {@link ArchiveEmptyError}, or — from {@link readArchive} — a container, version or
 * cap error. Writes nothing and never touches the database.
 */
export async function validateArchive(
  path: string,
  capsOverride?: Partial<ArchiveCaps>,
): Promise<ValidatedArchive> {
  const caps: ArchiveCaps = { ...ARCHIVE_CAPS, ...capsOverride };

  const faults: Array<{ path: string; code: string; message: string }> = [];
  const addFault = (p: string, code: string, message: string): void => {
    if (faults.length < MAX_FAULTS) faults.push({ path: p, code, message });
  };
  const addZodFaults = (base: string, error: ZodError): void => {
    for (const issue of error.issues) {
      if (faults.length >= MAX_FAULTS) break;
      const suffix = issue.path.length > 0 ? `.${issue.path.join('.')}` : '';
      addFault(`${base}${suffix}`, 'schema', issue.message);
    }
  };
  const ref = (present: boolean, p: string, message: string): void => {
    if (!present) addFault(p, 'reference', message);
  };
  const uniqueId = (set: Set<string>, id: string, p: string): void => {
    if (set.has(id)) addFault(p, 'duplicate_id', `Duplicate id ${id}.`);
    else set.add(id);
  };
  const uniqueKey = (set: Set<string>, key: string, p: string, message: string): void => {
    if (set.has(key)) addFault(p, 'duplicate', message);
    else set.add(key);
  };

  // Server-counted rows per category (Req 4.6), compared with the manifest below.
  const counts: ArchiveCounts = {
    brokerages: 0,
    systemBrokerages: 0,
    accounts: 0,
    tags: 0,
    positions: 0,
    fills: 0,
    positionTags: 0,
    positionImages: 0,
    ledgerEntries: 0,
    exchangeRates: 0,
    expenses: 0,
    personas: 0,
    builtinPersonas: 0,
    conversations: 0,
    messages: 0,
    summaries: 0,
    images: 0,
  };

  // Id sets (D6 keyed hashes) — reference targets and per-entry id uniqueness.
  const brokerageIds = new Set<string>();
  const accountIds = new Set<string>();
  const tagIds = new Set<string>();
  const positionIds = new Set<string>();
  const fillIds = new Set<string>();
  const positionImageIds = new Set<string>();
  const ledgerIds = new Set<string>();
  const rateIds = new Set<string>();
  const expenseIds = new Set<string>();
  const personaIds = new Set<string>();
  const builtinPersonaIds = new Set<string>();
  const conversationIds = new Set<string>();
  const messageIds = new Set<string>();
  const summaryIds = new Set<string>();

  // DB-mirror uniques.
  const accountLowerNames = new Set<string>();
  const brokerageLowerNames = new Set<string>();
  const tagLowerNames = new Set<string>();
  const ratePairDates = new Set<string>();
  const summaryConversations = new Set<string>();
  const positionTagPairs = new Set<string>();
  const clientMessagePairs = new Set<string>();

  // Reference support.
  const systemBrokerageNames = new Set<string>(); // lower-cased
  const imageEntries = new Set<string>();
  const imageRefCounts = new Map<string, number>();
  const groupIds = new Set<string>();
  const reversesRefs = new Map<string, string>(); // reversesGroupId → first path
  const closedPositionIds = new Set<string>();

  // Aggregates for the Req 4.3 invariants and the returned shape.
  const positionTagCounts = new Map<string, number>();
  const positionImageCounts = new Map<string, number>();
  const positionPnlGroups: Array<{ position: string; group: string }> = [];
  const reversedGroupIds = new Set<string>();
  const messageCountsByConversation = new Map<string, number>();
  const coveredThroughMessageIds = new Set<string>();
  const userBrokerageNames: string[] = [];
  let defaultAccountCount = 0;
  let defaultPersonaCount = 0;

  let manifest: ArchiveManifest | undefined;
  let dashboardLayoutDropped = false;

  const referenceImageEntry = (entry: string, p: string): void => {
    if (!imageEntries.has(entry)) {
      addFault(p, 'reference', `Image entry ${entry} is not present in the archive.`);
      return;
    }
    imageRefCounts.set(entry, (imageRefCounts.get(entry) ?? 0) + 1);
  };

  const handleJson = (entry: string, value: unknown): void => {
    if (entry === 'manifest.json') {
      const r = ArchiveManifestSchema.safeParse(value);
      if (!r.success) {
        addZodFaults('manifest', r.error);
        return;
      }
      manifest = r.data;
      return;
    }
    if (entry === 'preferences.json') {
      const r = ArchivePreferencesSchema.safeParse(value);
      if (!r.success) {
        addZodFaults('preferences', r.error);
        return;
      }
      const prefs = r.data;
      const ob = OnboardingStateSchema.safeParse(prefs.onboarding);
      if (!ob.success) addZodFaults('preferences.onboarding', ob.error);
      if (prefs.writableAccountId !== null) {
        ref(
          accountIds.has(prefs.writableAccountId),
          'preferences.writableAccountId',
          `writableAccountId ${prefs.writableAccountId} names no account in the archive.`,
        );
      }
      const persona = prefs.advisorDefaultPersona;
      if (persona !== null && 'user' in persona) {
        ref(
          personaIds.has(persona.user),
          'preferences.advisorDefaultPersona',
          `advisorDefaultPersona ${persona.user} names no persona in the archive.`,
        );
      } else if (persona !== null && 'builtin' in persona) {
        ref(
          builtinPersonaIds.has(persona.builtin),
          'preferences.advisorDefaultPersona',
          `advisorDefaultPersona builtin ${persona.builtin} is not declared in the archive.`,
        );
      }
      return;
    }
    if (entry === 'dashboard-layout.json') {
      const r = ArchiveDashboardLayoutSchema.safeParse(value);
      if (!r.success) {
        addZodFaults('dashboard-layout', r.error);
        return;
      }
      if (r.data !== null) {
        // The layout's widgets travel opaque and are checked by the target's write
        // schema (D13); a version-skew type, field or size it rejects drops the whole
        // layout as a bare degradation rather than failing the archive (C1, D11).
        const w = PutDashboardLayoutRequestSchema.safeParse({ widgets: r.data.widgets });
        if (!w.success) dashboardLayoutDropped = true;
      }
    }
  };

  const handleRow = (entry: string, index: number, value: unknown): void => {
    const key = COUNT_KEY[entry];
    if (key !== undefined) counts[key] += 1;
    const base = `${LABEL[entry] ?? entry}[${index}]`;

    switch (entry) {
      case 'brokerages.ndjson': {
        const r = ArchiveBrokerageSchema.safeParse(value);
        if (!r.success) return void addZodFaults(base, r.error);
        uniqueId(brokerageIds, r.data.id, `${base}.id`);
        uniqueKey(
          brokerageLowerNames,
          r.data.name.toLowerCase(),
          `${base}.name`,
          `Duplicate brokerage name ${r.data.name}.`,
        );
        userBrokerageNames.push(r.data.name);
        return;
      }
      case 'system-brokerages.ndjson': {
        const r = ArchiveSystemBrokerageRefSchema.safeParse(value);
        if (!r.success) return void addZodFaults(base, r.error);
        systemBrokerageNames.add(r.data.name.toLowerCase());
        return;
      }
      case 'accounts.ndjson': {
        const r = ArchiveAccountSchema.safeParse(value);
        if (!r.success) return void addZodFaults(base, r.error);
        uniqueId(accountIds, r.data.id, `${base}.id`);
        uniqueKey(
          accountLowerNames,
          r.data.name.toLowerCase(),
          `${base}.name`,
          `Duplicate account name ${r.data.name}.`,
        );
        if (r.data.isDefault) {
          defaultAccountCount += 1;
          if (r.data.isDemo) {
            addFault(base, 'invariant', 'A demo account cannot be the default account.');
          }
        }
        const brokerage = r.data.brokerage;
        if (brokerage !== null && 'user' in brokerage) {
          ref(
            brokerageIds.has(brokerage.user),
            `${base}.brokerage`,
            `brokerage ${brokerage.user} names no user brokerage in the archive.`,
          );
        } else if (brokerage !== null && 'system' in brokerage) {
          ref(
            systemBrokerageNames.has(brokerage.system.toLowerCase()),
            `${base}.brokerage`,
            `system brokerage "${brokerage.system}" has no snapshot in the archive.`,
          );
        }
        return;
      }
      case 'tags.ndjson': {
        const r = ArchiveTagSchema.safeParse(value);
        if (!r.success) return void addZodFaults(base, r.error);
        uniqueId(tagIds, r.data.id, `${base}.id`);
        uniqueKey(
          tagLowerNames,
          r.data.name.toLowerCase(),
          `${base}.name`,
          `Duplicate tag name ${r.data.name}.`,
        );
        return;
      }
      case 'positions.ndjson': {
        const r = ArchivePositionSchema.safeParse(value);
        if (!r.success) return void addZodFaults(base, r.error);
        uniqueId(positionIds, r.data.id, `${base}.id`);
        ref(
          accountIds.has(r.data.accountId),
          `${base}.accountId`,
          `accountId ${r.data.accountId} names no account in the archive.`,
        );
        if (r.data.status === 'closed') closedPositionIds.add(r.data.id);
        return;
      }
      case 'fills.ndjson': {
        const r = ArchiveFillSchema.safeParse(value);
        if (!r.success) return void addZodFaults(base, r.error);
        uniqueId(fillIds, r.data.id, `${base}.id`);
        ref(
          positionIds.has(r.data.positionId),
          `${base}.positionId`,
          `positionId ${r.data.positionId} names no position in the archive.`,
        );
        return;
      }
      case 'position-tags.ndjson': {
        const r = ArchivePositionTagSchema.safeParse(value);
        if (!r.success) return void addZodFaults(base, r.error);
        ref(
          positionIds.has(r.data.positionId),
          `${base}.positionId`,
          `positionId ${r.data.positionId} names no position in the archive.`,
        );
        ref(
          tagIds.has(r.data.tagId),
          `${base}.tagId`,
          `tagId ${r.data.tagId} names no tag in the archive.`,
        );
        uniqueKey(
          positionTagPairs,
          `${r.data.positionId}\u0000${r.data.tagId}`,
          base,
          `Duplicate position-tag pair (${r.data.positionId}, ${r.data.tagId}).`,
        );
        positionTagCounts.set(
          r.data.positionId,
          (positionTagCounts.get(r.data.positionId) ?? 0) + 1,
        );
        return;
      }
      case 'position-images.ndjson': {
        const r = ArchivePositionImageSchema.safeParse(value);
        if (!r.success) return void addZodFaults(base, r.error);
        uniqueId(positionImageIds, r.data.id, `${base}.id`);
        ref(
          positionIds.has(r.data.positionId),
          `${base}.positionId`,
          `positionId ${r.data.positionId} names no position in the archive.`,
        );
        positionImageCounts.set(
          r.data.positionId,
          (positionImageCounts.get(r.data.positionId) ?? 0) + 1,
        );
        if ('entry' in r.data.part) referenceImageEntry(r.data.part.entry, `${base}.part.entry`);
        return;
      }
      case 'ledger-entries.ndjson': {
        const r = ArchiveLedgerEntrySchema.safeParse(value);
        if (!r.success) return void addZodFaults(base, r.error);
        uniqueId(ledgerIds, r.data.id, `${base}.id`);
        ref(
          accountIds.has(r.data.accountId),
          `${base}.accountId`,
          `accountId ${r.data.accountId} names no account in the archive.`,
        );
        if (r.data.positionId !== null) {
          ref(
            positionIds.has(r.data.positionId),
            `${base}.positionId`,
            `positionId ${r.data.positionId} names no position in the archive.`,
          );
        }
        groupIds.add(r.data.groupId);
        if (r.data.reversesGroupId !== null && !reversesRefs.has(r.data.reversesGroupId)) {
          reversesRefs.set(r.data.reversesGroupId, `${base}.reversesGroupId`);
        }
        if (r.data.entryType === 'position_pnl' && r.data.positionId !== null) {
          positionPnlGroups.push({ position: r.data.positionId, group: r.data.groupId });
        }
        if (r.data.entryType === 'position_pnl_reversal' && r.data.reversesGroupId !== null) {
          reversedGroupIds.add(r.data.reversesGroupId);
        }
        return;
      }
      case 'exchange-rates.ndjson': {
        const r = ArchiveExchangeRateSchema.safeParse(value);
        if (!r.success) return void addZodFaults(base, r.error);
        uniqueId(rateIds, r.data.id, `${base}.id`);
        uniqueKey(
          ratePairDates,
          `${r.data.baseCurrency}\u0000${r.data.quoteCurrency}\u0000${r.data.effectiveDate}`,
          base,
          `Duplicate exchange rate for ${r.data.baseCurrency}/${r.data.quoteCurrency} on ${r.data.effectiveDate}.`,
        );
        return;
      }
      case 'expenses.ndjson': {
        const r = ArchiveExpenseSchema.safeParse(value);
        if (!r.success) return void addZodFaults(base, r.error);
        uniqueId(expenseIds, r.data.id, `${base}.id`);
        return;
      }
      case 'personas.ndjson': {
        const r = ArchivePersonaSchema.safeParse(value);
        if (!r.success) return void addZodFaults(base, r.error);
        uniqueId(personaIds, r.data.id, `${base}.id`);
        if (r.data.isDefault) defaultPersonaCount += 1;
        return;
      }
      case 'builtin-personas.ndjson': {
        const r = ArchiveBuiltinPersonaRefSchema.safeParse(value);
        if (!r.success) return void addZodFaults(base, r.error);
        builtinPersonaIds.add(r.data.id);
        return;
      }
      case 'conversations.ndjson': {
        const r = ArchiveConversationSchema.safeParse(value);
        if (!r.success) return void addZodFaults(base, r.error);
        uniqueId(conversationIds, r.data.id, `${base}.id`);
        const persona = r.data.persona;
        if (persona !== null && 'user' in persona) {
          ref(
            personaIds.has(persona.user),
            `${base}.persona`,
            `persona ${persona.user} names no persona in the archive.`,
          );
        } else if (persona !== null && 'builtin' in persona) {
          ref(
            builtinPersonaIds.has(persona.builtin),
            `${base}.persona`,
            `persona builtin ${persona.builtin} is not declared in the archive.`,
          );
        }
        return;
      }
      case 'messages.ndjson': {
        const r = ArchiveMessageSchema.safeParse(value);
        if (!r.success) return void addZodFaults(base, r.error);
        uniqueId(messageIds, r.data.id, `${base}.id`);
        ref(
          conversationIds.has(r.data.conversationId),
          `${base}.conversationId`,
          `conversationId ${r.data.conversationId} names no conversation in the archive.`,
        );
        messageCountsByConversation.set(
          r.data.conversationId,
          (messageCountsByConversation.get(r.data.conversationId) ?? 0) + 1,
        );
        if (r.data.clientMessageId !== null) {
          // Req 4.3: the two partial-unique client_message_id indexes (one per
          // role, per conversation, advisor.schema.ts:81-89).
          const pairKey = `${r.data.conversationId}\u0000${r.data.role}\u0000${r.data.clientMessageId}`;
          if (clientMessagePairs.has(pairKey)) {
            addFault(
              base,
              'invariant',
              `Duplicate client_message_id ${r.data.clientMessageId} for a ${r.data.role} message in one conversation.`,
            );
          } else {
            clientMessagePairs.add(pairKey);
          }
        }
        r.data.contentParts.forEach((part, j) => {
          if (part.type === 'image' && 'entry' in part) {
            referenceImageEntry(part.entry, `${base}.contentParts.${j}.entry`);
          }
        });
        return;
      }
      case 'summaries.ndjson': {
        const r = ArchiveSummarySchema.safeParse(value);
        if (!r.success) return void addZodFaults(base, r.error);
        uniqueId(summaryIds, r.data.id, `${base}.id`);
        ref(
          conversationIds.has(r.data.conversationId),
          `${base}.conversationId`,
          `conversationId ${r.data.conversationId} names no conversation in the archive.`,
        );
        uniqueKey(
          summaryConversations,
          r.data.conversationId,
          base,
          `More than one summary for conversation ${r.data.conversationId}.`,
        );
        // The covered-through id is advisory (D10): retain it up to the cap so C7 can
        // resolve it; an id past the cap restores null and is not a fault.
        if (
          r.data.coveredThroughMessageId !== null &&
          coveredThroughMessageIds.size < caps.maxCoveredThroughRefs
        ) {
          coveredThroughMessageIds.add(r.data.coveredThroughMessageId);
        }
        return;
      }
      default:
        return;
    }
  };

  for await (const event of readArchive(path, capsOverride)) {
    if (event.kind === 'image') {
      counts.images += 1;
      imageEntries.add(event.entry);
    } else if (event.kind === 'json') {
      handleJson(event.entry, event.value);
    } else if (event.kind === 'row') {
      handleRow(event.entry, event.index, event.value);
    }
  }

  // --- Cross-entry checks (deferred to the end of the stream) -----------------

  if (!manifest) addFault('manifest', 'missing_manifest', 'The archive has no manifest.json.');

  for (const [group, p] of reversesRefs) {
    if (!groupIds.has(group)) {
      addFault(p, 'reference', `reverses_group_id ${group} names no ledger group in the archive.`);
    }
  }

  for (const entry of imageEntries) {
    const c = imageRefCounts.get(entry) ?? 0;
    if (c === 0) {
      addFault('images', 'unreferenced_image', `Image entry ${entry} is referenced by no row.`);
    } else if (c > 1) {
      addFault(
        'images',
        'duplicate_image_reference',
        `Image entry ${entry} is referenced ${c} times.`,
      );
    }
  }

  if (defaultAccountCount > 1) {
    addFault('accounts', 'invariant', `The archive has ${defaultAccountCount} default accounts.`);
  }
  if (defaultPersonaCount > 1) {
    addFault('personas', 'invariant', `The archive has ${defaultPersonaCount} default personas.`);
  }
  if (counts.tags > TAG_LIMITS.perUser) {
    addFault(
      'tags',
      'invariant',
      `The archive has ${counts.tags} tags (max ${TAG_LIMITS.perUser}).`,
    );
  }
  for (const [position, n] of positionTagCounts) {
    if (n > TAG_LIMITS.perPosition) {
      addFault(
        'position-tags',
        'invariant',
        `Position ${position} has ${n} tags (max ${TAG_LIMITS.perPosition}).`,
      );
    }
  }
  for (const [position, n] of positionImageCounts) {
    if (n > POSITION_IMAGE_MAX_COUNT) {
      addFault(
        'position-images',
        'invariant',
        `Position ${position} has ${n} images (max ${POSITION_IMAGE_MAX_COUNT}).`,
      );
    }
  }
  const unreversedPnl = new Map<string, number>();
  for (const { position, group } of positionPnlGroups) {
    if (!reversedGroupIds.has(group)) {
      unreversedPnl.set(position, (unreversedPnl.get(position) ?? 0) + 1);
    }
  }
  for (const [position, n] of unreversedPnl) {
    if (n > 1) {
      addFault(
        'ledger-entries',
        'invariant',
        `Position ${position} has ${n} un-reversed position_pnl rows.`,
      );
    }
    if (!closedPositionIds.has(position)) {
      addFault(
        'ledger-entries',
        'invariant',
        `Position ${position} has an un-reversed position_pnl row but is not closed.`,
      );
    }
  }

  if (manifest) {
    for (const k of Object.keys(counts) as (keyof ArchiveCounts)[]) {
      if (manifest.counts[k] !== counts[k]) {
        addFault(
          `manifest.counts.${k}`,
          'count',
          `Manifest declares ${manifest.counts[k]} ${k} but the archive holds ${counts[k]}.`,
        );
      }
    }
  }

  if (faults.length > 0) throw new ArchiveInvalidError(faults);
  if (!manifest) throw new ArchiveInvalidError([]); // unreachable: missing manifest is a fault above

  const blocking = EMPTY_CATEGORIES.reduce((sum, k) => sum + counts[k], 0);
  if (blocking === 0) throw new ArchiveEmptyError();

  const degradations: ArchiveDegradation[] = [...manifest.degradations];
  if (dashboardLayoutDropped) degradations.push({ reason: 'dashboard_layout_unparseable' });

  return {
    manifest,
    counts,
    degradations,
    messageCountsByConversation,
    coveredThroughMessageIds,
    userBrokerageNames,
  };
}

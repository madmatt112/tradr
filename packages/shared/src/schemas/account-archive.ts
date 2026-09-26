import { z } from 'zod';

import { CURRENCY_CODES } from '../constants/currencies';
import { EXPENSE_CATEGORIES } from '../constants/expense-categories';

import { resolveTimezone } from './performance';

// The frozen v1 account-archive contract (design C1, Data Models). One place
// defines the archive shape, entry layout, caps, preview/result shapes and error
// codes, shared by export, import, the web and every test (Req 3.6). This file is
// SHAPE ONLY: it carries no API, DB or web code, and edits no existing schema.
//
// Version discipline (Req 3.4): every schema here is frozen at archive version 1.
// Any change to a payload shape increases ARCHIVE_VERSION; readers refuse a newer
// version by number, not by a parse failure.

// The archive schema version. The manifest's `format` and `archiveVersion` field
// are frozen across versions; the value increments when a payload shape changes.
export const ARCHIVE_VERSION = 1;

// The fixed entry names, in the order they appear in the archive (Data Models).
// Image entries (matching ARCHIVE_IMAGE_ENTRY_RE) come first, before
// `manifest.json`; the reader (C5) uses the regex for those. Each fixed entry
// appears at most once; an empty NDJSON entry means zero rows.
export const ARCHIVE_ENTRY_ORDER = [
  'manifest.json',
  'brokerages.ndjson',
  'system-brokerages.ndjson',
  'accounts.ndjson',
  'tags.ndjson',
  'positions.ndjson',
  'fills.ndjson',
  'position-tags.ndjson',
  'position-images.ndjson',
  'ledger-entries.ndjson',
  'exchange-rates.ndjson',
  'expenses.ndjson',
  'personas.ndjson',
  'builtin-personas.ndjson',
  'conversations.ndjson',
  'messages.ndjson',
  'summaries.ndjson',
  'preferences.json',
  'dashboard-layout.json',
] as const;

// Image entry names: `images/advisor/` or `images/positions/`, a six-digit index
// numbered from 000001, and a `.png`, `.jpeg` or `.webp` extension. Anchored at
// both ends so a path-traversal (`../`), absolute (`/images/...`) or
// wrong-directory name never matches (Req 4.4).
export const ARCHIVE_IMAGE_ENTRY_RE = /^images\/(advisor|positions)\/\d{6}\.(png|jpeg|webp)$/;

// Code-constant caps (Req 8.4). Compressed upload, total decompressed, single
// JSON/NDJSON entry, one NDJSON line, one message line, one line's structural
// budget, one image, total images, total rows and covered-through references.
export const ARCHIVE_CAPS = {
  maxUploadBytes: 536_870_912,
  maxDecompressedBytes: 2_147_483_648,
  maxJsonEntryBytes: 4_194_304,
  maxLineBytes: 1_048_576,
  maxMessageLineBytes: 4_194_304,
  maxLineStructureBytes: 524_288,
  maxImageBytes: 8_388_608,
  maxImages: 10_000,
  maxRows: 250_000,
  maxCoveredThroughRefs: 5_000,
} as const;

// All-`number` shape so `Partial<ArchiveCaps>` overrides (createExport opts,
// validateArchive caps) type-check; `typeof ARCHIVE_CAPS` would fix each to its
// literal value.
export type ArchiveCaps = Record<keyof typeof ARCHIVE_CAPS, number>;

// The eight new error codes (design Error Handling). `OBJECT_UNREACHABLE` (503)
// and `RATE_LIMITED` (429) are existing codes and are deliberately not listed.
export const ACCOUNT_DATA_ERROR_CODES = [
  'ARCHIVE_VERSION_UNSUPPORTED',
  'ARCHIVE_INVALID',
  'ARCHIVE_EMPTY',
  'ARCHIVE_DIGEST_MISMATCH',
  'IMPORT_TARGET_NOT_EMPTY',
  'ARCHIVE_TOO_LARGE',
  'IMPORT_FAILED',
  'IMPORT_BUSY',
] as const;
export type AccountDataErrorCode = (typeof ACCOUNT_DATA_ERROR_CODES)[number];

// --- Primitive value schemas -----------------------------------------------

// `T`: a microsecond-precision UTC timestamp, exactly as the export writes it
// (`to_char(col AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`, C2 P1) —
// six fractional digits and a literal `Z`.
export const ARCHIVE_TIMESTAMP_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/;

// A calendar date, `YYYY-MM-DD` (a `date` column rendered by `to_char`).
export const ARCHIVE_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

const timestamp = z.string().regex(ARCHIVE_TIMESTAMP_RE, {
  message: 'Must be a microsecond-precision UTC timestamp (…T…Z)',
});

const dateString = z
  .string()
  .regex(ARCHIVE_DATE_RE, { message: 'Must be a calendar date (YYYY-MM-DD)' });

const uuid = z.string().uuid();

const nonNegInt = z.number().int().nonnegative();

// `D(p,s)`: an exact decimal string as stored (C2 writes `col::text`), bounded to
// numeric(precision, scale). Up to `precision - scale` integer digits and up to
// `scale` fractional digits. A leading `-` is allowed only when no column CHECK
// forbids it (`signed`); the `≥0`/`>0` columns in Data Models are unsigned. The
// exact value bound (`> 0`, distinct pair …) is the validator's DB-constraint
// check (Req 4.1), not this shape.
export function archiveDecimalString(
  precision: number,
  scale: number,
  opts: { signed: boolean },
): z.ZodString {
  const intDigits = precision - scale;
  const sign = opts.signed ? '-?' : '';
  const frac = scale > 0 ? `(\\.\\d{1,${scale}})?` : '';
  const re = new RegExp(`^${sign}\\d{1,${intDigits}}${frac}$`);
  return z.string().regex(re, {
    message: `Must be a ${opts.signed ? 'signed ' : 'non-negative '}decimal within numeric(${precision},${scale})`,
  });
}

// Account trading-day timezone / reporting timezone, validated as
// schemas/account.ts:34-47 does: `resolveTimezone` is the IANA authority, so
// there is no zone list to rot and the Unicode-extension bypass is rejected.
const timezone = z
  .string()
  .max(64)
  .refine(
    (v) => {
      try {
        resolveTimezone(v);
        return true;
      } catch {
        return false;
      }
    },
    { message: 'Must be a valid IANA timezone name' },
  );

// --- Image parts ------------------------------------------------------------

const ImageFormatSchema = z.enum(['png', 'jpeg', 'webp']);

// An image that points at an archive entry (the export's normal form).
const ArchiveImageEntryPartSchema = z
  .object({
    type: z.literal('image'),
    format: ImageFormatSchema,
    entry: z.string().regex(ARCHIVE_IMAGE_ENTRY_RE),
  })
  .strict();

// An image whose source object was already unrecoverable at export. Mirrors the
// stored `unrecoverable` marker with no key. There is deliberately no `object`
// pointer arm and no `dataBase64` arm: neither is representable in the archive.
const ArchiveImageUnrecoverablePartSchema = z
  .object({
    type: z.literal('image'),
    format: ImageFormatSchema,
    storage: z.object({ kind: z.literal('unrecoverable') }).strict(),
  })
  .strict();

// A position screenshot's `part` (Data Models `ArchiveImagePart`): only the two
// image arms.
export const ArchiveImagePartSchema = z.union([
  ArchiveImageEntryPartSchema,
  ArchiveImageUnrecoverablePartSchema,
]);
export type ArchiveImagePart = z.infer<typeof ArchiveImagePartSchema>;

// A message content part (Data Models `ArchiveContentPart`): the text, tool_call
// and tool_result shapes mirror schemas/advisor.ts:31-67 but strict, plus the two
// image arms. No inline `dataBase64` and no `storage.kind 'object'` (design).
export const ArchiveContentPartSchema = z.union([
  z.object({ type: z.literal('text'), text: z.string() }).strict(),
  z
    .object({
      type: z.literal('tool_call'),
      id: z.string(),
      name: z.string(),
      arguments: z.unknown(),
    })
    .strict(),
  z
    .object({
      type: z.literal('tool_result'),
      toolCallId: z.string(),
      status: z.enum(['ok', 'error']),
      content: z.unknown(),
    })
    .strict(),
  ArchiveImageEntryPartSchema,
  ArchiveImageUnrecoverablePartSchema,
]);
export type ArchiveContentPart = z.infer<typeof ArchiveContentPartSchema>;

// --- Platform-reference sub-shapes ------------------------------------------

// A builtin persona is referenced by its platform id (a text slug such as
// `default-trading-advisor`), not a UUID (advisor.schema.ts, migration 0009).
const builtinPersonaId = z.string().min(1).max(128);

// A persona reference: none, a user persona by source id, or a builtin by slug.
const PersonaRefSchema = z.union([
  z.null(),
  z.object({ user: uuid }).strict(),
  z.object({ builtin: builtinPersonaId }).strict(),
]);

// An account's brokerage: none, a user brokerage by source id, or a system
// brokerage by name (resolved on import, Req 6.1).
const AccountBrokerageRefSchema = z.union([
  z.null(),
  z.object({ user: uuid }).strict(),
  z.object({ system: z.string().max(100) }).strict(),
]);

// The seven fee-schedule values (fee_schedules numeric(18,8); no CHECK, so
// signed). Kept as a field map so the system-brokerage snapshot and the
// user-brokerage schedule share them.
const feeScheduleValues = {
  stockPerShareCommission: archiveDecimalString(18, 8, { signed: true }),
  stockMinPerFill: archiveDecimalString(18, 8, { signed: true }),
  stockMaxPerFill: archiveDecimalString(18, 8, { signed: true }),
  optionsPerContractCommission: archiveDecimalString(18, 8, { signed: true }),
  optionsPerContractExchangeFee: archiveDecimalString(18, 8, { signed: true }),
  optionsMinPerFill: archiveDecimalString(18, 8, { signed: true }),
  optionsMaxPerFill: archiveDecimalString(18, 8, { signed: true }),
};

const SystemFeeScheduleSchema = z.object({ ...feeScheduleValues }).strict();

const BrokerageFeeScheduleSchema = z
  .object({ ...feeScheduleValues, createdAt: timestamp, updatedAt: timestamp })
  .strict();

// --- Manifest, counts and degradations --------------------------------------

// The per-category count block the manifest, preview and result carry: one count
// per NDJSON entry plus the image total (Data Models `counts {per NDJSON entry,
// images}`). preferences.json and dashboard-layout.json are single objects and
// are not counted.
export const ArchiveCountsSchema = z
  .object({
    brokerages: nonNegInt,
    systemBrokerages: nonNegInt,
    accounts: nonNegInt,
    tags: nonNegInt,
    positions: nonNegInt,
    fills: nonNegInt,
    positionTags: nonNegInt,
    positionImages: nonNegInt,
    ledgerEntries: nonNegInt,
    exchangeRates: nonNegInt,
    expenses: nonNegInt,
    personas: nonNegInt,
    builtinPersonas: nonNegInt,
    conversations: nonNegInt,
    messages: nonNegInt,
    summaries: nonNegInt,
    images: nonNegInt,
  })
  .strict();
export type ArchiveCounts = z.infer<typeof ArchiveCountsSchema>;

// An image whose source object was missing at export time (C2/C3): the affected
// entry, the row's source id, the content-part index and the reason. This is the
// only degradation the manifest carries.
export const ArchiveObjectMissingDegradationSchema = z
  .object({
    entry: z.string(),
    rowId: z.string(),
    partIndex: nonNegInt,
    reason: z.literal('object_missing'),
  })
  .strict();

// The bare degradation the validator emits when a version-skew dashboard layout
// is dropped rather than failing the archive (C5, D11). It names no row.
export const ArchiveDashboardLayoutUnparseableDegradationSchema = z
  .object({ reason: z.literal('dashboard_layout_unparseable') })
  .strict();

// The degradation union surfaced by preview and result (design C1).
export const ArchiveDegradationSchema = z.union([
  ArchiveObjectMissingDegradationSchema,
  ArchiveDashboardLayoutUnparseableDegradationSchema,
]);
export type ArchiveDegradation = z.infer<typeof ArchiveDegradationSchema>;

export const ArchiveManifestSchema = z
  .object({
    format: z.literal('tradr-account-archive'),
    archiveVersion: z.literal(ARCHIVE_VERSION),
    // APP_VERSION at export, or 'unknown'.
    sourceAppVersion: z.string(),
    exportedAt: timestamp,
    counts: ArchiveCountsSchema,
    degradations: z.array(ArchiveObjectMissingDegradationSchema),
  })
  .strict();
export type ArchiveManifest = z.infer<typeof ArchiveManifestSchema>;

// --- Payload row schemas (one strict schema per entry, Data Models) ---------

// A user-created brokerage with its fee schedule.
export const ArchiveBrokerageSchema = z
  .object({
    id: uuid,
    name: z.string().max(100),
    notes: z.string().nullable(),
    feeSchedule: BrokerageFeeScheduleSchema.nullable(),
    createdAt: timestamp,
    updatedAt: timestamp,
  })
  .strict();
export type ArchiveBrokerage = z.infer<typeof ArchiveBrokerageSchema>;

// A reference to a system brokerage an account uses: its name plus a snapshot of
// its fee-schedule values (Req 6.1).
export const ArchiveSystemBrokerageRefSchema = z
  .object({
    name: z.string().max(100),
    feeSchedule: SystemFeeScheduleSchema.nullable(),
  })
  .strict();
export type ArchiveSystemBrokerageRef = z.infer<typeof ArchiveSystemBrokerageRefSchema>;

export const ArchiveAccountSchema = z
  .object({
    id: uuid,
    name: z.string().max(100),
    currency: z.enum(CURRENCY_CODES as [string, ...string[]]),
    timezone,
    brokerage: AccountBrokerageRefSchema,
    startingBalance: archiveDecimalString(18, 4, { signed: true }),
    defaultRiskPercent: archiveDecimalString(5, 2, { signed: true }).nullable(),
    isDemo: z.boolean(),
    isDefault: z.boolean(),
    createdAt: timestamp,
    updatedAt: timestamp,
  })
  .strict();
export type ArchiveAccount = z.infer<typeof ArchiveAccountSchema>;

export const ArchiveTagSchema = z
  .object({
    id: uuid,
    name: z.string().max(40),
    // The stored category (tags_category_chk); Data Models pins the four values.
    category: z.enum(['setup', 'emotion', 'mistake', 'general']),
    // The raw stored colour string (tags.color varchar(16), no CHECK), not the
    // wire palette enum — Data Models says `color≤16|null`.
    color: z.string().max(16).nullable(),
    createdAt: timestamp,
    updatedAt: timestamp,
  })
  .strict();
export type ArchiveTag = z.infer<typeof ArchiveTagSchema>;

export const ArchivePositionSchema = z
  .object({
    id: uuid,
    accountId: uuid,
    symbol: z.string().max(20),
    side: z.enum(['long', 'short']),
    assetType: z.enum(['stock', 'option']),
    status: z.enum(['draft', 'open', 'closed']),
    notes: z.string().nullable(),
    targetPrice: archiveDecimalString(18, 8, { signed: true }).nullable(),
    stopLoss: archiveDecimalString(18, 8, { signed: true }).nullable(),
    openedAt: timestamp.nullable(),
    closedAt: timestamp.nullable(),
    lastFlatAt: timestamp.nullable(),
    lastFlatNetPnl: archiveDecimalString(18, 4, { signed: true }).nullable(),
    createdAt: timestamp,
    updatedAt: timestamp,
  })
  .strict();
export type ArchivePosition = z.infer<typeof ArchivePositionSchema>;

export const ArchiveFillSchema = z
  .object({
    id: uuid,
    positionId: uuid,
    type: z.enum(['entry', 'exit']),
    price: archiveDecimalString(18, 8, { signed: true }),
    quantity: archiveDecimalString(18, 8, { signed: true }),
    fees: archiveDecimalString(18, 8, { signed: true }),
    notes: z.string().nullable(),
    filledAt: timestamp,
    createdAt: timestamp,
  })
  .strict();
export type ArchiveFill = z.infer<typeof ArchiveFillSchema>;

export const ArchivePositionTagSchema = z.object({ positionId: uuid, tagId: uuid }).strict();
export type ArchivePositionTag = z.infer<typeof ArchivePositionTagSchema>;

export const ArchivePositionImageSchema = z
  .object({
    id: uuid,
    positionId: uuid,
    part: ArchiveImagePartSchema,
    createdAt: timestamp,
  })
  .strict();
export type ArchivePositionImage = z.infer<typeof ArchivePositionImageSchema>;

export const ArchiveLedgerEntrySchema = z
  .object({
    id: uuid,
    accountId: uuid,
    positionId: uuid.nullable(),
    entryType: z.enum([
      'position_pnl',
      'position_pnl_reversal',
      'balance_adjustment',
      'deposit',
      'withdrawal',
      'deposit_reversal',
      'withdrawal_reversal',
    ]),
    direction: z.enum(['credit', 'debit']),
    // ledger_amount_nonneg_chk: `amount >= 0`, so unsigned.
    amount: archiveDecimalString(18, 4, { signed: false }),
    currency: z.string().length(3),
    symbol: z.string().max(20).nullable(),
    occurredAt: timestamp,
    createdAt: timestamp,
    groupId: uuid,
    reversesGroupId: uuid.nullable(),
  })
  .strict();
export type ArchiveLedgerEntry = z.infer<typeof ArchiveLedgerEntrySchema>;

export const ArchiveExchangeRateSchema = z
  .object({
    id: uuid,
    baseCurrency: z.string().length(3),
    quoteCurrency: z.string().length(3),
    // exchange_rates_rate_positive_chk: `rate > 0`, so unsigned.
    rate: archiveDecimalString(24, 12, { signed: false }),
    effectiveDate: dateString,
    createdAt: timestamp,
  })
  .strict()
  // exchange_rates_distinct_currencies_chk: base ≠ quote.
  .refine((r) => r.baseCurrency !== r.quoteCurrency, {
    message: 'baseCurrency and quoteCurrency must differ',
    path: ['quoteCurrency'],
  });
export type ArchiveExchangeRate = z.infer<typeof ArchiveExchangeRateSchema>;

export const ArchiveExpenseSchema = z
  .object({
    id: uuid,
    category: z.enum(EXPENSE_CATEGORIES as unknown as [string, ...string[]]),
    description: z.string().max(200),
    // expenses_amount_positive_chk: `amount > 0`, so unsigned.
    amount: archiveDecimalString(18, 4, { signed: false }),
    currency: z.enum(CURRENCY_CODES as [string, ...string[]]),
    occurredAt: dateString,
    notes: z.string().nullable(),
    createdAt: timestamp,
    updatedAt: timestamp,
  })
  .strict();
export type ArchiveExpense = z.infer<typeof ArchiveExpenseSchema>;

// A user-created persona. No `userId`, no `isBuiltin` (imported rows are owned by
// the importing user with is_builtin false, Req 5.8).
export const ArchivePersonaSchema = z
  .object({
    id: uuid,
    name: z.string().max(80),
    description: z.string().max(500).nullable(),
    systemPrompt: z.string(),
    isDefault: z.boolean(),
    createdAt: timestamp,
    updatedAt: timestamp,
  })
  .strict();
export type ArchivePersona = z.infer<typeof ArchivePersonaSchema>;

// A reference to a builtin persona the user's data names, by platform id (Req 6.2).
export const ArchiveBuiltinPersonaRefSchema = z.object({ id: builtinPersonaId }).strict();
export type ArchiveBuiltinPersonaRef = z.infer<typeof ArchiveBuiltinPersonaRefSchema>;

export const ArchiveConversationSchema = z
  .object({
    id: uuid,
    title: z.string().max(200),
    persona: PersonaRefSchema,
    // The stored provider id string, kept as archived — NOT the ProviderId enum
    // (Data Models; Req 6.3 imports it whatever the target supports).
    providerId: z.string().max(16),
    model: z.string().max(64),
    createdAt: timestamp,
    updatedAt: timestamp,
  })
  .strict();
export type ArchiveConversation = z.infer<typeof ArchiveConversationSchema>;

export const ArchiveMessageSchema = z
  .object({
    id: uuid,
    conversationId: uuid,
    role: z.enum(['user', 'assistant']),
    contentParts: z.array(ArchiveContentPartSchema),
    promptTokens: z.number().int().nullable(),
    completionTokens: z.number().int().nullable(),
    clientMessageId: uuid.nullable(),
    createdAt: timestamp,
  })
  .strict();
export type ArchiveMessage = z.infer<typeof ArchiveMessageSchema>;

export const ArchiveSummarySchema = z
  .object({
    id: uuid,
    conversationId: uuid,
    prose: z.string(),
    tradeDataFigures: z.string().nullable(),
    // Advisory pointer only (no FK); an unknown or capped id restores null (D10).
    coveredThroughMessageId: uuid.nullable(),
    coveredThroughCreatedAt: timestamp,
    createdAt: timestamp,
    updatedAt: timestamp,
  })
  .strict();
export type ArchiveSummary = z.infer<typeof ArchiveSummarySchema>;

// The single preferences object (preferences.json). `onboarding` is carried as a
// raw JSON object so the app's own jsonb round-trips unchanged; the validator
// separately parses it with OnboardingStateSchema (C5). `advisor_trade_data_consent`
// is exported but kept at the target's value on import (Req 5.6).
export const ArchivePreferencesSchema = z
  .object({
    // users.display_currency: varchar(3), no CHECK — a bare three-letter code,
    // not the CURRENCY_CODES enum (Data Models `^[A-Z]{3}$|null`).
    displayCurrency: z
      .string()
      .regex(/^[A-Z]{3}$/, { message: 'Must be a three-letter currency code' })
      .nullable(),
    timezone: timezone.nullable(),
    // users_tax_jurisdiction_chk.
    taxJurisdiction: z.enum(['US', 'CA', 'other']).nullable(),
    // users_theme_chk.
    theme: z.enum(['light', 'dark', 'system']),
    // users_buying_power_basis_chk.
    buyingPowerBasis: z.enum(['cash', 'balance']),
    advisorDefaultPersona: PersonaRefSchema,
    advisorTradeDataConsent: z.boolean(),
    writableAccountId: uuid.nullable(),
    onboarding: z.record(z.string(), z.unknown()),
  })
  .strict();
export type ArchivePreferences = z.infer<typeof ArchivePreferencesSchema>;

// The dashboard layout (dashboard-layout.json): null, or the widgets carried as a
// raw JSON array plus its timestamps. The validator checks each widget with
// WidgetPlacementSchema and drops an unparseable layout as a degradation (C5, D11).
export const ArchiveDashboardLayoutSchema = z.union([
  z.null(),
  z
    .object({
      widgets: z.array(z.unknown()),
      createdAt: timestamp,
      updatedAt: timestamp,
    })
    .strict(),
]);
export type ArchiveDashboardLayout = z.infer<typeof ArchiveDashboardLayoutSchema>;

// --- Preview and result -----------------------------------------------------

// The outcome of resolving a system brokerage on import (Req 6.1): linked to an
// existing target brokerage, or created as a user brokerage (with `createdName`
// when a name collision forced a deterministic suffix).
export const ArchiveBrokerageResolutionSchema = z
  .object({
    name: z.string(),
    outcome: z.enum(['linked', 'created']),
    createdName: z.string().optional(),
  })
  .strict();
export type ArchiveBrokerageResolution = z.infer<typeof ArchiveBrokerageResolutionSchema>;

// The outcome of resolving a builtin persona reference (Req 6.2): matched on the
// target, or missing (the reference is set null).
export const ArchivePersonaResolutionSchema = z
  .object({
    id: z.string(),
    outcome: z.enum(['matched', 'missing']),
  })
  .strict();
export type ArchivePersonaResolution = z.infer<typeof ArchivePersonaResolutionSchema>;

// The preview returned after validation (Req 4.6): the server's own counts, the
// source app version, the export instant, the degradations and the upload digest
// (sha256 hex) that confirm must echo (Req 4.7).
export const ImportPreviewSchema = z
  .object({
    counts: ArchiveCountsSchema,
    sourceAppVersion: z.string(),
    exportedAt: timestamp,
    degradations: z.array(ArchiveDegradationSchema),
    digest: z.string().regex(/^[0-9a-f]{64}$/, { message: 'Must be a sha256 hex digest' }),
  })
  .strict();
export type ImportPreview = z.infer<typeof ImportPreviewSchema>;

// The result returned when an import commits (Req 5.10): the created counts, the
// degradations and every platform-reference resolution (Req 6).
export const ImportResultSchema = z
  .object({
    counts: ArchiveCountsSchema,
    degradations: z.array(ArchiveDegradationSchema),
    resolutions: z
      .object({
        systemBrokerages: z.array(ArchiveBrokerageResolutionSchema),
        builtinPersonas: z.array(ArchivePersonaResolutionSchema),
      })
      .strict(),
  })
  .strict();
export type ImportResult = z.infer<typeof ImportResultSchema>;

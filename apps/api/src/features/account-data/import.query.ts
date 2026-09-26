import { sql, type SQL } from 'drizzle-orm';

import type { Database, Transaction } from '@/db';

import { ImportTargetNotEmptyError } from './account-data.errors';

// Design C6 — the import's query layer. These are the direct writes a confirmed
// restore makes: the Req 5.1 emptiness check, one batched insert per archive
// category, and the two platform-reference lookups C6 Resolution needs.
//
// Nothing here calls another feature's service, a close/fill/reverse hook, a
// gating counter or a tier check (Req 5.9, 9.1): a restore writes the archived
// rows and nothing else.
//
// Every value is bound as a parameter and every archive-preserving column is
// bound as TEXT with an explicit cast — `::timestamptz`, `::numeric`, `::date`,
// `::jsonb` — never through the Drizzle timestamp/numeric mapper, which
// round-trips timestamps through `new Date`/`toISOString` and would truncate the
// microseconds the archive carries (design P1b, Req 5.5). Column and table names
// are code constants written with `sql.raw`; user input never reaches them.

// Either the pool handle or an open transaction; both expose `.execute`.
type ImportDb = Database | Transaction;

// --- Emptiness check (Req 5.1) ----------------------------------------------

// The nine categories that block an import: user-owned data plus USER-CREATED
// brokerages and personas only. Every one of these tables carries `user_id`, so
// a single `WHERE user_id = $1` predicate excludes system brokerages and builtin
// personas (both have a NULL `user_id`). Preferences, a dashboard layout, API
// keys and wallet/billing state deliberately do NOT block (Req 5.1).
export const IMPORT_BLOCKING_CATEGORIES = [
  { label: 'accounts', table: 'accounts' },
  { label: 'positions', table: 'positions' },
  { label: 'ledger entries', table: 'ledger_entries' },
  { label: 'exchange rates', table: 'exchange_rates' },
  { label: 'expenses', table: 'expenses' },
  { label: 'brokerages', table: 'brokerages' },
  { label: 'tags', table: 'tags' },
  { label: 'conversations', table: 'advisor_conversations' },
  { label: 'personas', table: 'advisor_personas' },
] as const;

/**
 * Throws a 409 `IMPORT_TARGET_NOT_EMPTY` naming every non-empty Req 5.1 category
 * when the target user already holds data. One round trip: an `EXISTS` probe per
 * category. Callable on the pool (preview) or inside the restore transaction
 * after the per-user guard is held (confirm re-check, Req 5.3).
 */
export async function assertTargetEmpty(db: ImportDb, userId: string): Promise<void> {
  const probes = IMPORT_BLOCKING_CATEGORIES.map(
    (c, i) =>
      sql`EXISTS(SELECT 1 FROM ${sql.raw(`"${c.table}"`)} WHERE user_id = ${userId}) AS ${sql.raw(`c${i}`)}`,
  );
  const rows = (await db.execute(
    sql`SELECT ${sql.join(probes, sql.raw(', '))}`,
  )) as unknown as Array<Record<string, boolean>>;
  const row = rows[0] ?? {};
  const nonEmpty = IMPORT_BLOCKING_CATEGORIES.filter((_, i) => row[`c${i}`]).map((c) => c.label);
  if (nonEmpty.length > 0) throw new ImportTargetNotEmptyError(nonEmpty);
}

// --- Platform-reference lookups (C6 Resolution, Req 6.1, 6.2) ---------------

/**
 * The system brokerages on the target whose lower-cased name matches one of
 * `names` (design C6 Resolution; `brokerages_system_name_unique` at
 * brokerages.schema.ts:32-34). Keyed by lower-cased name so the caller can link
 * an account to the existing row or, on a miss, create a user brokerage from the
 * archived snapshot (Req 6.1). Names are bound as parameters, never interpolated.
 */
export async function findSystemBrokeragesByName(
  db: ImportDb,
  names: readonly string[],
): Promise<Map<string, { id: string; name: string }>> {
  const found = new Map<string, { id: string; name: string }>();
  const lowered = [...new Set(names.map((n) => n.toLowerCase()))];
  if (lowered.length === 0) return found;
  const list = sql.join(
    lowered.map((n) => sql`${n}`),
    sql.raw(', '),
  );
  const rows = (await db.execute(
    sql`SELECT id, name FROM brokerages WHERE is_system = true AND lower(name) IN (${list})`,
  )) as unknown as Array<{ id: string; name: string }>;
  for (const r of rows) found.set(r.name.toLowerCase(), { id: r.id, name: r.name });
  return found;
}

/**
 * The subset of `ids` that name a builtin persona present on the target (design
 * C6 Resolution, seeded by migration 0009_advisor_core.sql:78-82). A referenced
 * id absent here restores its reference to null (Req 6.2).
 */
export async function findExistingBuiltinPersonaIds(
  db: ImportDb,
  ids: readonly string[],
): Promise<Set<string>> {
  const present = new Set<string>();
  const unique = [...new Set(ids)];
  if (unique.length === 0) return present;
  const list = sql.join(
    unique.map((id) => sql`${id}`),
    sql.raw(', '),
  );
  const rows = (await db.execute(
    sql`SELECT id FROM advisor_personas WHERE is_builtin = true AND id IN (${list})`,
  )) as unknown as Array<{ id: string }>;
  for (const r of rows) present.add(r.id);
  return present;
}

// --- Batched text-bind insert ------------------------------------------------

// A statement holds at most this many rows, or this many bytes of bound text,
// whichever comes first — so param count and message size stay bounded on the
// 256 MiB machine. A single row larger than the byte budget still goes in its
// own statement (a row is never split).
const MAX_ROWS_PER_STATEMENT = 500;
const MAX_BIND_BYTES_PER_STATEMENT = 2 * 1024 * 1024;

type Cast = 'plain' | 'timestamptz' | 'numeric' | 'date' | 'jsonb';
interface Column {
  name: string;
  cast: Cast;
}

// The value actually bound: jsonb is serialized to its text form, everything
// else is bound as given (a string for cast columns, or a native uuid/int/bool).
function boundValue(value: unknown, cast: Cast): unknown {
  if (value === null || value === undefined) return null;
  if (cast === 'jsonb') return JSON.stringify(value);
  return value;
}

// The bound cell with its cast applied. A null still carries the cast so a
// nullable column resolves to the right type (`NULL::timestamptz`).
function cellFragment(bound: unknown, cast: Cast): SQL {
  switch (cast) {
    case 'timestamptz':
      return sql`${bound}::timestamptz`;
    case 'numeric':
      return sql`${bound}::numeric`;
    case 'date':
      return sql`${bound}::date`;
    case 'jsonb':
      return sql`${bound}::jsonb`;
    default:
      return sql`${bound}`;
  }
}

function bindBytes(bound: unknown): number {
  if (bound === null) return 0;
  return typeof bound === 'string' ? Buffer.byteLength(bound) : Buffer.byteLength(String(bound));
}

/**
 * Insert `rows` (each a value array aligned to `columns`) into `table` as one or
 * more multi-row `INSERT` statements, split at `MAX_ROWS_PER_STATEMENT` rows or
 * `MAX_BIND_BYTES_PER_STATEMENT` of bound text.
 */
async function batchInsert(
  tx: ImportDb,
  table: string,
  columns: Column[],
  rows: unknown[][],
): Promise<void> {
  if (rows.length === 0) return;

  const prepared = rows.map((row) => {
    const cells: SQL[] = [];
    let bytes = 0;
    for (let i = 0; i < columns.length; i += 1) {
      const bound = boundValue(row[i], columns[i].cast);
      cells.push(cellFragment(bound, columns[i].cast));
      bytes += bindBytes(bound);
    }
    return { frag: sql`(${sql.join(cells, sql.raw(', '))})`, bytes };
  });

  const columnList = sql.raw(columns.map((c) => `"${c.name}"`).join(', '));
  const tableRef = sql.raw(`"${table}"`);

  let start = 0;
  while (start < prepared.length) {
    let end = start;
    let bytes = 0;
    while (end < prepared.length && end - start < MAX_ROWS_PER_STATEMENT) {
      // Always take at least one row; then grow while under the byte budget.
      if (end > start && bytes + prepared[end].bytes > MAX_BIND_BYTES_PER_STATEMENT) break;
      bytes += prepared[end].bytes;
      end += 1;
    }
    const values = prepared.slice(start, end).map((p) => p.frag);
    await tx.execute(
      sql`INSERT INTO ${tableRef} (${columnList}) VALUES ${sql.join(values, sql.raw(', '))}`,
    );
    start = end;
  }
}

// --- Per-category insert row shapes -----------------------------------------
//
// Each shape is the target row AFTER task 10's remapping and C6's resolution:
// ids are fresh, references point at target rows (or null), and archive-preserved
// values arrive as their exact text. `user_id`, `is_system` and `is_builtin` are
// NOT carried here — the insert function sets them (Req 5.8).

export interface BrokerageFeeScheduleInsert {
  stockPerShareCommission: string;
  stockMinPerFill: string;
  stockMaxPerFill: string;
  optionsPerContractCommission: string;
  optionsPerContractExchangeFee: string;
  optionsMinPerFill: string;
  optionsMaxPerFill: string;
  createdAt: string;
  updatedAt: string;
}

export interface BrokerageInsert {
  id: string;
  name: string;
  notes: string | null;
  feeSchedule: BrokerageFeeScheduleInsert | null;
  createdAt: string;
  updatedAt: string;
}

export interface AccountInsert {
  id: string;
  name: string;
  currency: string;
  timezone: string;
  brokerageId: string | null;
  startingBalance: string;
  defaultRiskPercent: string | null;
  isDemo: boolean;
  isDefault: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface TagInsert {
  id: string;
  name: string;
  category: string;
  color: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface PositionInsert {
  id: string;
  accountId: string;
  symbol: string;
  side: string;
  assetType: string;
  status: string;
  notes: string | null;
  targetPrice: string | null;
  stopLoss: string | null;
  openedAt: string | null;
  closedAt: string | null;
  lastFlatAt: string | null;
  lastFlatNetPnl: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface FillInsert {
  id: string;
  positionId: string;
  type: string;
  price: string;
  quantity: string;
  fees: string;
  notes: string | null;
  filledAt: string;
  createdAt: string;
}

export interface PositionTagInsert {
  positionId: string;
  tagId: string;
}

export interface PositionImageInsert {
  id: string;
  positionId: string;
  part: unknown;
  createdAt: string;
}

export interface LedgerEntryInsert {
  id: string;
  accountId: string;
  positionId: string | null;
  entryType: string;
  direction: string;
  amount: string;
  currency: string;
  symbol: string | null;
  occurredAt: string;
  createdAt: string;
  groupId: string;
  reversesGroupId: string | null;
}

export interface ExchangeRateInsert {
  id: string;
  baseCurrency: string;
  quoteCurrency: string;
  rate: string;
  effectiveDate: string;
  createdAt: string;
}

export interface ExpenseInsert {
  id: string;
  category: string;
  description: string;
  amount: string;
  currency: string;
  occurredAt: string;
  notes: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface PersonaInsert {
  id: string;
  name: string;
  description: string | null;
  systemPrompt: string;
  isDefault: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface ConversationInsert {
  id: string;
  title: string;
  personaId: string | null;
  providerId: string;
  model: string;
  createdAt: string;
  updatedAt: string;
}

export interface MessageInsert {
  id: string;
  conversationId: string;
  role: string;
  contentParts: unknown;
  promptTokens: number | null;
  completionTokens: number | null;
  clientMessageId: string | null;
  createdAt: string;
}

export interface SummaryInsert {
  id: string;
  conversationId: string;
  prose: string;
  tradeDataFigures: string | null;
  coveredThroughMessageId: string | null;
  coveredThroughCreatedAt: string;
  createdAt: string;
  updatedAt: string;
}

// --- Column layouts ----------------------------------------------------------

const BROKERAGE_COLUMNS: Column[] = [
  { name: 'id', cast: 'plain' },
  { name: 'user_id', cast: 'plain' },
  { name: 'name', cast: 'plain' },
  { name: 'notes', cast: 'plain' },
  { name: 'is_system', cast: 'plain' },
  { name: 'created_at', cast: 'timestamptz' },
  { name: 'updated_at', cast: 'timestamptz' },
];

const FEE_SCHEDULE_COLUMNS: Column[] = [
  { name: 'brokerage_id', cast: 'plain' },
  { name: 'stock_per_share_commission', cast: 'numeric' },
  { name: 'stock_min_per_fill', cast: 'numeric' },
  { name: 'stock_max_per_fill', cast: 'numeric' },
  { name: 'options_per_contract_commission', cast: 'numeric' },
  { name: 'options_per_contract_exchange_fee', cast: 'numeric' },
  { name: 'options_min_per_fill', cast: 'numeric' },
  { name: 'options_max_per_fill', cast: 'numeric' },
  { name: 'created_at', cast: 'timestamptz' },
  { name: 'updated_at', cast: 'timestamptz' },
];

const ACCOUNT_COLUMNS: Column[] = [
  { name: 'id', cast: 'plain' },
  { name: 'user_id', cast: 'plain' },
  { name: 'name', cast: 'plain' },
  { name: 'currency', cast: 'plain' },
  { name: 'timezone', cast: 'plain' },
  { name: 'brokerage_id', cast: 'plain' },
  { name: 'starting_balance', cast: 'numeric' },
  { name: 'default_risk_percent', cast: 'numeric' },
  { name: 'is_demo', cast: 'plain' },
  { name: 'is_default', cast: 'plain' },
  { name: 'created_at', cast: 'timestamptz' },
  { name: 'updated_at', cast: 'timestamptz' },
];

const TAG_COLUMNS: Column[] = [
  { name: 'id', cast: 'plain' },
  { name: 'user_id', cast: 'plain' },
  { name: 'name', cast: 'plain' },
  { name: 'category', cast: 'plain' },
  { name: 'color', cast: 'plain' },
  { name: 'created_at', cast: 'timestamptz' },
  { name: 'updated_at', cast: 'timestamptz' },
];

const POSITION_COLUMNS: Column[] = [
  { name: 'id', cast: 'plain' },
  { name: 'user_id', cast: 'plain' },
  { name: 'account_id', cast: 'plain' },
  { name: 'symbol', cast: 'plain' },
  { name: 'side', cast: 'plain' },
  { name: 'asset_type', cast: 'plain' },
  { name: 'status', cast: 'plain' },
  { name: 'notes', cast: 'plain' },
  { name: 'target_price', cast: 'numeric' },
  { name: 'stop_loss', cast: 'numeric' },
  { name: 'opened_at', cast: 'timestamptz' },
  { name: 'closed_at', cast: 'timestamptz' },
  { name: 'last_flat_at', cast: 'timestamptz' },
  { name: 'last_flat_net_pnl', cast: 'numeric' },
  { name: 'created_at', cast: 'timestamptz' },
  { name: 'updated_at', cast: 'timestamptz' },
];

const FILL_COLUMNS: Column[] = [
  { name: 'id', cast: 'plain' },
  { name: 'position_id', cast: 'plain' },
  { name: 'type', cast: 'plain' },
  { name: 'price', cast: 'numeric' },
  { name: 'quantity', cast: 'numeric' },
  { name: 'fees', cast: 'numeric' },
  { name: 'notes', cast: 'plain' },
  { name: 'filled_at', cast: 'timestamptz' },
  { name: 'created_at', cast: 'timestamptz' },
];

const POSITION_TAG_COLUMNS: Column[] = [
  { name: 'position_id', cast: 'plain' },
  { name: 'tag_id', cast: 'plain' },
];

const POSITION_IMAGE_COLUMNS: Column[] = [
  { name: 'id', cast: 'plain' },
  { name: 'position_id', cast: 'plain' },
  { name: 'part', cast: 'jsonb' },
  { name: 'created_at', cast: 'timestamptz' },
];

const LEDGER_ENTRY_COLUMNS: Column[] = [
  { name: 'id', cast: 'plain' },
  { name: 'user_id', cast: 'plain' },
  { name: 'account_id', cast: 'plain' },
  { name: 'position_id', cast: 'plain' },
  { name: 'entry_type', cast: 'plain' },
  { name: 'direction', cast: 'plain' },
  { name: 'amount', cast: 'numeric' },
  { name: 'currency', cast: 'plain' },
  { name: 'symbol', cast: 'plain' },
  { name: 'occurred_at', cast: 'timestamptz' },
  { name: 'created_at', cast: 'timestamptz' },
  { name: 'group_id', cast: 'plain' },
  { name: 'reverses_group_id', cast: 'plain' },
];

const EXCHANGE_RATE_COLUMNS: Column[] = [
  { name: 'id', cast: 'plain' },
  { name: 'user_id', cast: 'plain' },
  { name: 'base_currency', cast: 'plain' },
  { name: 'quote_currency', cast: 'plain' },
  { name: 'rate', cast: 'numeric' },
  { name: 'effective_date', cast: 'date' },
  { name: 'created_at', cast: 'timestamptz' },
];

const EXPENSE_COLUMNS: Column[] = [
  { name: 'id', cast: 'plain' },
  { name: 'user_id', cast: 'plain' },
  { name: 'category', cast: 'plain' },
  { name: 'description', cast: 'plain' },
  { name: 'amount', cast: 'numeric' },
  { name: 'currency', cast: 'plain' },
  { name: 'occurred_at', cast: 'date' },
  { name: 'notes', cast: 'plain' },
  { name: 'created_at', cast: 'timestamptz' },
  { name: 'updated_at', cast: 'timestamptz' },
];

const PERSONA_COLUMNS: Column[] = [
  { name: 'id', cast: 'plain' },
  { name: 'user_id', cast: 'plain' },
  { name: 'name', cast: 'plain' },
  { name: 'description', cast: 'plain' },
  { name: 'system_prompt', cast: 'plain' },
  { name: 'is_builtin', cast: 'plain' },
  { name: 'is_default', cast: 'plain' },
  { name: 'created_at', cast: 'timestamptz' },
  { name: 'updated_at', cast: 'timestamptz' },
];

const CONVERSATION_COLUMNS: Column[] = [
  { name: 'id', cast: 'plain' },
  { name: 'user_id', cast: 'plain' },
  { name: 'title', cast: 'plain' },
  { name: 'persona_id', cast: 'plain' },
  { name: 'provider_id', cast: 'plain' },
  { name: 'model', cast: 'plain' },
  { name: 'created_at', cast: 'timestamptz' },
  { name: 'updated_at', cast: 'timestamptz' },
];

const MESSAGE_COLUMNS: Column[] = [
  { name: 'id', cast: 'plain' },
  { name: 'conversation_id', cast: 'plain' },
  { name: 'role', cast: 'plain' },
  { name: 'content_parts', cast: 'jsonb' },
  { name: 'prompt_tokens', cast: 'plain' },
  { name: 'completion_tokens', cast: 'plain' },
  { name: 'client_message_id', cast: 'plain' },
  { name: 'created_at', cast: 'timestamptz' },
];

const SUMMARY_COLUMNS: Column[] = [
  { name: 'id', cast: 'plain' },
  { name: 'conversation_id', cast: 'plain' },
  { name: 'prose', cast: 'plain' },
  { name: 'trade_data_figures', cast: 'plain' },
  { name: 'covered_through_message_id', cast: 'plain' },
  { name: 'covered_through_created_at', cast: 'timestamptz' },
  { name: 'created_at', cast: 'timestamptz' },
  { name: 'updated_at', cast: 'timestamptz' },
];

// --- Per-category insert functions ------------------------------------------

/** Insert user brokerages (`is_system` false) and their fee schedules. */
export async function insertArchiveBrokerages(
  tx: ImportDb,
  userId: string,
  rows: BrokerageInsert[],
): Promise<void> {
  await batchInsert(
    tx,
    'brokerages',
    BROKERAGE_COLUMNS,
    rows.map((r) => [r.id, userId, r.name, r.notes, false, r.createdAt, r.updatedAt]),
  );
  const feeRows: unknown[][] = [];
  for (const r of rows) {
    const fs = r.feeSchedule;
    if (fs === null) continue;
    feeRows.push([
      r.id,
      fs.stockPerShareCommission,
      fs.stockMinPerFill,
      fs.stockMaxPerFill,
      fs.optionsPerContractCommission,
      fs.optionsPerContractExchangeFee,
      fs.optionsMinPerFill,
      fs.optionsMaxPerFill,
      fs.createdAt,
      fs.updatedAt,
    ]);
  }
  await batchInsert(tx, 'fee_schedules', FEE_SCHEDULE_COLUMNS, feeRows);
}

export async function insertArchiveAccounts(
  tx: ImportDb,
  userId: string,
  rows: AccountInsert[],
): Promise<void> {
  await batchInsert(
    tx,
    'accounts',
    ACCOUNT_COLUMNS,
    rows.map((r) => [
      r.id,
      userId,
      r.name,
      r.currency,
      r.timezone,
      r.brokerageId,
      r.startingBalance,
      r.defaultRiskPercent,
      r.isDemo,
      r.isDefault,
      r.createdAt,
      r.updatedAt,
    ]),
  );
}

export async function insertArchiveTags(
  tx: ImportDb,
  userId: string,
  rows: TagInsert[],
): Promise<void> {
  await batchInsert(
    tx,
    'tags',
    TAG_COLUMNS,
    rows.map((r) => [r.id, userId, r.name, r.category, r.color, r.createdAt, r.updatedAt]),
  );
}

export async function insertArchivePositions(
  tx: ImportDb,
  userId: string,
  rows: PositionInsert[],
): Promise<void> {
  await batchInsert(
    tx,
    'positions',
    POSITION_COLUMNS,
    rows.map((r) => [
      r.id,
      userId,
      r.accountId,
      r.symbol,
      r.side,
      r.assetType,
      r.status,
      r.notes,
      r.targetPrice,
      r.stopLoss,
      r.openedAt,
      r.closedAt,
      r.lastFlatAt,
      r.lastFlatNetPnl,
      r.createdAt,
      r.updatedAt,
    ]),
  );
}

export async function insertArchiveFills(tx: ImportDb, rows: FillInsert[]): Promise<void> {
  await batchInsert(
    tx,
    'fills',
    FILL_COLUMNS,
    rows.map((r) => [
      r.id,
      r.positionId,
      r.type,
      r.price,
      r.quantity,
      r.fees,
      r.notes,
      r.filledAt,
      r.createdAt,
    ]),
  );
}

export async function insertArchivePositionTags(
  tx: ImportDb,
  rows: PositionTagInsert[],
): Promise<void> {
  await batchInsert(
    tx,
    'position_tags',
    POSITION_TAG_COLUMNS,
    rows.map((r) => [r.positionId, r.tagId]),
  );
}

export async function insertArchivePositionImages(
  tx: ImportDb,
  rows: PositionImageInsert[],
): Promise<void> {
  await batchInsert(
    tx,
    'position_images',
    POSITION_IMAGE_COLUMNS,
    rows.map((r) => [r.id, r.positionId, r.part, r.createdAt]),
  );
}

export async function insertArchiveLedgerEntries(
  tx: ImportDb,
  userId: string,
  rows: LedgerEntryInsert[],
): Promise<void> {
  await batchInsert(
    tx,
    'ledger_entries',
    LEDGER_ENTRY_COLUMNS,
    rows.map((r) => [
      r.id,
      userId,
      r.accountId,
      r.positionId,
      r.entryType,
      r.direction,
      r.amount,
      r.currency,
      r.symbol,
      r.occurredAt,
      r.createdAt,
      r.groupId,
      r.reversesGroupId,
    ]),
  );
}

export async function insertArchiveExchangeRates(
  tx: ImportDb,
  userId: string,
  rows: ExchangeRateInsert[],
): Promise<void> {
  await batchInsert(
    tx,
    'exchange_rates',
    EXCHANGE_RATE_COLUMNS,
    rows.map((r) => [
      r.id,
      userId,
      r.baseCurrency,
      r.quoteCurrency,
      r.rate,
      r.effectiveDate,
      r.createdAt,
    ]),
  );
}

export async function insertArchiveExpenses(
  tx: ImportDb,
  userId: string,
  rows: ExpenseInsert[],
): Promise<void> {
  await batchInsert(
    tx,
    'expenses',
    EXPENSE_COLUMNS,
    rows.map((r) => [
      r.id,
      userId,
      r.category,
      r.description,
      r.amount,
      r.currency,
      r.occurredAt,
      r.notes,
      r.createdAt,
      r.updatedAt,
    ]),
  );
}

/** Insert user personas (`is_builtin` false). */
export async function insertArchivePersonas(
  tx: ImportDb,
  userId: string,
  rows: PersonaInsert[],
): Promise<void> {
  await batchInsert(
    tx,
    'advisor_personas',
    PERSONA_COLUMNS,
    rows.map((r) => [
      r.id,
      userId,
      r.name,
      r.description,
      r.systemPrompt,
      false,
      r.isDefault,
      r.createdAt,
      r.updatedAt,
    ]),
  );
}

export async function insertArchiveConversations(
  tx: ImportDb,
  userId: string,
  rows: ConversationInsert[],
): Promise<void> {
  await batchInsert(
    tx,
    'advisor_conversations',
    CONVERSATION_COLUMNS,
    rows.map((r) => [
      r.id,
      userId,
      r.title,
      r.personaId,
      r.providerId,
      r.model,
      r.createdAt,
      r.updatedAt,
    ]),
  );
}

export async function insertArchiveMessages(tx: ImportDb, rows: MessageInsert[]): Promise<void> {
  await batchInsert(
    tx,
    'advisor_messages',
    MESSAGE_COLUMNS,
    rows.map((r) => [
      r.id,
      r.conversationId,
      r.role,
      r.contentParts,
      r.promptTokens,
      r.completionTokens,
      r.clientMessageId,
      r.createdAt,
    ]),
  );
}

export async function insertArchiveSummaries(tx: ImportDb, rows: SummaryInsert[]): Promise<void> {
  await batchInsert(
    tx,
    'advisor_summaries',
    SUMMARY_COLUMNS,
    rows.map((r) => [
      r.id,
      r.conversationId,
      r.prose,
      r.tradeDataFigures,
      r.coveredThroughMessageId,
      r.coveredThroughCreatedAt,
      r.createdAt,
      r.updatedAt,
    ]),
  );
}

import { once } from 'node:events';
import { createWriteStream } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { finished } from 'node:stream/promises';

import { sql, type SQL } from 'drizzle-orm';

import type { ArchiveCounts } from '@tradr/shared';

import type { Transaction } from '@/db';

// Design C2 — the export's stage-1 reader. It runs inside the caller's single
// repeatable-read, read-only transaction (the snapshot form at
// performance.service.ts:73-80) and spools one text-mode NDJSON file per Data
// Models category plus the two single-object JSON entries to a temp directory,
// so stage 2 (C3) can assemble the zip without holding the snapshot open.
//
// Every value is rendered in SQL, never by the Drizzle timestamp mapper: that
// mapper round-trips through `new Date`/`toISOString` and would truncate
// microseconds to milliseconds (P1b). Timestamps use `to_char(... AT TIME ZONE
// 'UTC', …US"Z")`, dates `to_char(…, 'YYYY-MM-DD')` and numerics `col::text`
// (P1), so the archive carries the stored precision exactly (Req 3.5).
//
// This file is READ ONLY: it never decodes an image (that is C3 Pass A) and
// never writes the user's email. Image parts (position_images.part,
// advisor_messages.content_parts) are spooled as their raw stored jsonb; C3
// rewrites them to archive `{ entry }` refs when it builds the zip.

// The two large categories are paged so the scan never holds more than one
// fetch group of message/image content in memory (Architecture, 256 MB
// envelope): metadata is read a page at a time, then full rows are fetched in
// groups bounded by 8 MiB.
const PAGE_SIZE = 500;
const MAX_GROUP_BYTES = 8 * 1024 * 1024;

// Per-category NDJSON row counts (design C2 `SpoolSummary`). `images` is
// deliberately absent: the image total is the count of image ENTRIES the export
// service writes in Pass A (a recoverable object per image), which stage 1
// cannot know without reading storage, so C3 fills it into the manifest.
export type SpoolCounts = Omit<ArchiveCounts, 'images'>;

export interface SpoolSummary {
  counts: SpoolCounts;
  // The user's email, for C3's completion email only. It is NEVER written to
  // any spooled file (Req 2.2, Req 3.2).
  email: string;
}

// --- SQL rendering helpers (column names are code constants, never input) ---

function ts(column: string): SQL {
  return sql.raw(`to_char(${column} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`);
}

function dateCol(column: string): SQL {
  return sql.raw(`to_char(${column}, 'YYYY-MM-DD')`);
}

function num(column: string): SQL {
  return sql.raw(`${column}::text`);
}

// --- File writers -----------------------------------------------------------

// A newline-delimited JSON writer with backpressure, so a spool of many rows or
// large message content never buffers the whole file in memory.
class LineWriter {
  private readonly stream;
  private writeError: Error | undefined;

  constructor(filePath: string) {
    this.stream = createWriteStream(filePath, { encoding: 'utf8' });
    this.stream.on('error', (err: Error) => {
      this.writeError = err;
    });
  }

  async write(row: unknown): Promise<void> {
    if (this.writeError) throw this.writeError;
    if (!this.stream.write(`${JSON.stringify(row)}\n`)) {
      await once(this.stream, 'drain');
    }
  }

  async close(): Promise<void> {
    this.stream.end();
    await finished(this.stream);
  }
}

type Row = Record<string, unknown>;

async function execRows(tx: Transaction, query: SQL): Promise<Row[]> {
  return (await tx.execute(query)) as unknown as Row[];
}

// Spool a flat category whose SELECT already aliases every column to its archive
// field name — the raw row is the archive row.
async function spoolFlat(
  tx: Transaction,
  dir: string,
  filename: string,
  query: SQL,
): Promise<number> {
  const rows = await execRows(tx, query);
  const writer = new LineWriter(path.join(dir, filename));
  try {
    for (const row of rows) await writer.write(row);
  } finally {
    await writer.close();
  }
  return rows.length;
}

async function spoolMapped(
  tx: Transaction,
  dir: string,
  filename: string,
  query: SQL,
  map: (row: Row) => unknown,
): Promise<number> {
  const rows = await execRows(tx, query);
  const writer = new LineWriter(path.join(dir, filename));
  try {
    for (const row of rows) await writer.write(map(row));
  } finally {
    await writer.close();
  }
  return rows.length;
}

// --- Category readers --------------------------------------------------------

function feeScheduleValues(row: Row): Record<string, unknown> {
  return {
    stockPerShareCommission: row.feeStockPerShareCommission,
    stockMinPerFill: row.feeStockMinPerFill,
    stockMaxPerFill: row.feeStockMaxPerFill,
    optionsPerContractCommission: row.feeOptionsPerContractCommission,
    optionsPerContractExchangeFee: row.feeOptionsPerContractExchangeFee,
    optionsMinPerFill: row.feeOptionsMinPerFill,
    optionsMaxPerFill: row.feeOptionsMaxPerFill,
  };
}

const FEE_COLUMNS = (alias: string): SQL => sql`
  ${num(`${alias}.stock_per_share_commission`)} AS "feeStockPerShareCommission",
  ${num(`${alias}.stock_min_per_fill`)} AS "feeStockMinPerFill",
  ${num(`${alias}.stock_max_per_fill`)} AS "feeStockMaxPerFill",
  ${num(`${alias}.options_per_contract_commission`)} AS "feeOptionsPerContractCommission",
  ${num(`${alias}.options_per_contract_exchange_fee`)} AS "feeOptionsPerContractExchangeFee",
  ${num(`${alias}.options_min_per_fill`)} AS "feeOptionsMinPerFill",
  ${num(`${alias}.options_max_per_fill`)} AS "feeOptionsMaxPerFill"
`;

function spoolBrokerages(tx: Transaction, userId: string, dir: string): Promise<number> {
  return spoolMapped(
    tx,
    dir,
    'brokerages.ndjson',
    sql`
      SELECT b.id, b.name, b.notes,
        ${ts('b.created_at')} AS "createdAt", ${ts('b.updated_at')} AS "updatedAt",
        ${FEE_COLUMNS('fs')},
        ${ts('fs.created_at')} AS "feeCreatedAt", ${ts('fs.updated_at')} AS "feeUpdatedAt"
      FROM brokerages b
      LEFT JOIN fee_schedules fs ON fs.brokerage_id = b.id
      WHERE b.user_id = ${userId}
      ORDER BY b.created_at, b.id
    `,
    (row) => ({
      id: row.id,
      name: row.name,
      notes: row.notes,
      feeSchedule:
        row.feeCreatedAt !== null
          ? { ...feeScheduleValues(row), createdAt: row.feeCreatedAt, updatedAt: row.feeUpdatedAt }
          : null,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    }),
  );
}

function spoolSystemBrokerages(tx: Transaction, userId: string, dir: string): Promise<number> {
  return spoolMapped(
    tx,
    dir,
    'system-brokerages.ndjson',
    sql`
      SELECT b.name, fs.brokerage_id AS "feePresent", ${FEE_COLUMNS('fs')}
      FROM brokerages b
      LEFT JOIN fee_schedules fs ON fs.brokerage_id = b.id
      WHERE b.is_system = true
        AND EXISTS (
          SELECT 1 FROM accounts a WHERE a.user_id = ${userId} AND a.brokerage_id = b.id
        )
      ORDER BY lower(b.name), b.name
    `,
    (row) => ({
      name: row.name,
      feeSchedule: row.feePresent !== null ? feeScheduleValues(row) : null,
    }),
  );
}

function spoolAccounts(tx: Transaction, userId: string, dir: string): Promise<number> {
  return spoolMapped(
    tx,
    dir,
    'accounts.ndjson',
    sql`
      SELECT a.id, a.name, a.currency, a.timezone,
        a.brokerage_id AS "brokerageId", br.is_system AS "brokerageIsSystem",
        br.name AS "brokerageName",
        ${num('a.starting_balance')} AS "startingBalance",
        ${num('a.default_risk_percent')} AS "defaultRiskPercent",
        a.is_demo AS "isDemo", a.is_default AS "isDefault",
        ${ts('a.created_at')} AS "createdAt", ${ts('a.updated_at')} AS "updatedAt"
      FROM accounts a
      LEFT JOIN brokerages br ON br.id = a.brokerage_id
      WHERE a.user_id = ${userId}
      ORDER BY a.created_at, a.id
    `,
    (row) => {
      let brokerage: unknown = null;
      if (row.brokerageId !== null) {
        brokerage = row.brokerageIsSystem
          ? { system: row.brokerageName }
          : { user: row.brokerageId };
      }
      return {
        id: row.id,
        name: row.name,
        currency: row.currency,
        timezone: row.timezone,
        brokerage,
        startingBalance: row.startingBalance,
        defaultRiskPercent: row.defaultRiskPercent,
        isDemo: row.isDemo,
        isDefault: row.isDefault,
        createdAt: row.createdAt,
        updatedAt: row.updatedAt,
      };
    },
  );
}

function spoolConversations(tx: Transaction, userId: string, dir: string): Promise<number> {
  return spoolMapped(
    tx,
    dir,
    'conversations.ndjson',
    sql`
      SELECT c.id, c.title, c.persona_id AS "personaId", ap.is_builtin AS "personaIsBuiltin",
        c.provider_id AS "providerId", c.model,
        ${ts('c.created_at')} AS "createdAt", ${ts('c.updated_at')} AS "updatedAt"
      FROM advisor_conversations c
      LEFT JOIN advisor_personas ap ON ap.id = c.persona_id
      WHERE c.user_id = ${userId}
      ORDER BY c.created_at, c.id
    `,
    (row) => ({
      id: row.id,
      title: row.title,
      persona: personaRef(row.personaId, row.personaIsBuiltin),
      providerId: row.providerId,
      model: row.model,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    }),
  );
}

function personaRef(personaId: unknown, isBuiltin: unknown): unknown {
  if (personaId === null || personaId === undefined) return null;
  return isBuiltin ? { builtin: personaId } : { user: personaId };
}

// --- Paged readers (messages, position images) -------------------------------

async function fetchGroup(
  tx: Transaction,
  ids: string[],
  select: (idList: SQL) => SQL,
): Promise<Row[]> {
  const idList = sql.join(
    ids.map((id) => sql`${id}::uuid`),
    sql`, `,
  );
  const rows = await execRows(tx, select(idList));
  const byId = new Map(rows.map((row) => [row.id as string, row]));
  // Preserve the metadata order, which the group ids already carry.
  return ids.map((id) => byId.get(id)).filter((row): row is Row => row !== undefined);
}

// Drive a keyset-paged, byte-bounded spool: read a page of {id, bytes} metadata,
// break it into ≤ 8 MiB fetch groups, fetch each group's full rows in order and
// write them.
async function spoolPaged(
  tx: Transaction,
  dir: string,
  filename: string,
  metadataPage: (cursor: string[] | null) => SQL,
  fetchSelect: (idList: SQL) => SQL,
  cursorOf: (meta: Row) => string[],
): Promise<number> {
  const writer = new LineWriter(path.join(dir, filename));
  let count = 0;
  try {
    let cursor: string[] | null = null;
    for (;;) {
      const page = await execRows(tx, metadataPage(cursor));
      if (page.length === 0) break;

      let group: string[] = [];
      let groupBytes = 0;
      for (const meta of page) {
        const bytes = Number(meta.bytes);
        if (group.length > 0 && groupBytes + bytes > MAX_GROUP_BYTES) {
          for (const row of await fetchGroup(tx, group, fetchSelect)) await writer.write(row);
          count += group.length;
          group = [];
          groupBytes = 0;
        }
        group.push(meta.id as string);
        groupBytes += bytes;
      }
      if (group.length > 0) {
        for (const row of await fetchGroup(tx, group, fetchSelect)) await writer.write(row);
        count += group.length;
      }

      cursor = cursorOf(page[page.length - 1]);
      if (page.length < PAGE_SIZE) break;
    }
  } finally {
    await writer.close();
  }
  return count;
}

function spoolMessages(tx: Transaction, userId: string, dir: string): Promise<number> {
  return spoolPaged(
    tx,
    dir,
    'messages.ndjson',
    // Transcript order: grouped by conversation, then (created_at, id) within it
    // (advisor.query.ts:377). `created_at::text` keeps microsecond precision in
    // the keyset cursor, which a JS Date would truncate.
    (cursor) => {
      const keyset = cursor
        ? sql`AND (m.conversation_id, m.created_at, m.id) > (${cursor[0]}::uuid, ${cursor[1]}::timestamptz, ${cursor[2]}::uuid)`
        : sql``;
      return sql`
        SELECT m.id, m.conversation_id AS "cid", m.created_at::text AS "cts",
          octet_length(m.content_parts::text) AS "bytes"
        FROM advisor_messages m
        JOIN advisor_conversations c ON c.id = m.conversation_id
        WHERE c.user_id = ${userId}
          ${keyset}
        ORDER BY m.conversation_id, m.created_at, m.id
        LIMIT ${PAGE_SIZE}
      `;
    },
    (idList) => sql`
      SELECT m.id, m.conversation_id AS "conversationId", m.role,
        m.content_parts AS "contentParts",
        m.prompt_tokens AS "promptTokens", m.completion_tokens AS "completionTokens",
        m.client_message_id AS "clientMessageId",
        ${ts('m.created_at')} AS "createdAt"
      FROM advisor_messages m
      WHERE m.id IN (${idList})
    `,
    (meta) => [meta.cid as string, meta.cts as string, meta.id as string],
  );
}

function spoolPositionImages(tx: Transaction, userId: string, dir: string): Promise<number> {
  return spoolPaged(
    tx,
    dir,
    'position-images.ndjson',
    (cursor) => {
      const keyset = cursor
        ? sql`AND (pi.created_at, pi.id) > (${cursor[0]}::timestamptz, ${cursor[1]}::uuid)`
        : sql``;
      return sql`
        SELECT pi.id, pi.created_at::text AS "cts", octet_length((pi.part)::text) AS "bytes"
        FROM position_images pi
        JOIN positions p ON p.id = pi.position_id
        WHERE p.user_id = ${userId}
          ${keyset}
        ORDER BY pi.created_at, pi.id
        LIMIT ${PAGE_SIZE}
      `;
    },
    (idList) => sql`
      SELECT pi.id, pi.position_id AS "positionId", pi.part,
        ${ts('pi.created_at')} AS "createdAt"
      FROM position_images pi
      WHERE pi.id IN (${idList})
    `,
    (meta) => [meta.cts as string, meta.id as string],
  );
}

// --- Single-object entries ---------------------------------------------------

async function spoolPreferences(tx: Transaction, userId: string, dir: string): Promise<string> {
  const rows = await execRows(
    tx,
    sql`
      SELECT u.display_currency AS "displayCurrency", u.timezone,
        u.tax_jurisdiction AS "taxJurisdiction", u.theme, u.buying_power_basis AS "buyingPowerBasis",
        u.advisor_default_persona_id AS "advisorDefaultPersonaId",
        dp.is_builtin AS "defaultPersonaIsBuiltin",
        u.advisor_trade_data_consent AS "advisorTradeDataConsent",
        u.writable_account_id AS "writableAccountId", u.onboarding, u.email
      FROM users u
      LEFT JOIN advisor_personas dp ON dp.id = u.advisor_default_persona_id
      WHERE u.id = ${userId}
    `,
  );
  const row = rows[0];
  if (!row) throw new Error(`export: no user row for ${userId}`);

  const preferences = {
    displayCurrency: row.displayCurrency,
    timezone: row.timezone,
    taxJurisdiction: row.taxJurisdiction,
    theme: row.theme,
    buyingPowerBasis: row.buyingPowerBasis,
    advisorDefaultPersona: personaRef(row.advisorDefaultPersonaId, row.defaultPersonaIsBuiltin),
    advisorTradeDataConsent: row.advisorTradeDataConsent,
    writableAccountId: row.writableAccountId,
    onboarding: row.onboarding,
  };
  await writeFile(path.join(dir, 'preferences.json'), JSON.stringify(preferences), 'utf8');
  // The email is returned for C3's completion email; it is never spooled.
  return row.email as string;
}

async function spoolDashboardLayout(tx: Transaction, userId: string, dir: string): Promise<void> {
  const rows = await execRows(
    tx,
    sql`
      SELECT widgets, ${ts('created_at')} AS "createdAt", ${ts('updated_at')} AS "updatedAt"
      FROM dashboard_layouts
      WHERE user_id = ${userId}
    `,
  );
  const row = rows[0];
  const layout =
    row !== undefined
      ? { widgets: row.widgets, createdAt: row.createdAt, updatedAt: row.updatedAt }
      : null;
  await writeFile(path.join(dir, 'dashboard-layout.json'), JSON.stringify(layout), 'utf8');
}

// --- Orchestrator ------------------------------------------------------------

/**
 * Stage-1 export reader (design C2). Reads every archive category for `userId`
 * from the caller's snapshot transaction and spools NDJSON/JSON files to `dir`.
 * Every query filters by `user_id` or joins through an owned parent, so no other
 * user's row is ever read. Returns the per-category counts and the user's email;
 * it writes no `manifest.json` (C3 Pass B) and never writes the email.
 */
export async function spoolAccountData(
  tx: Transaction,
  userId: string,
  dir: string,
): Promise<SpoolSummary> {
  const counts: SpoolCounts = {
    brokerages: await spoolBrokerages(tx, userId, dir),
    systemBrokerages: await spoolSystemBrokerages(tx, userId, dir),
    accounts: await spoolAccounts(tx, userId, dir),
    tags: await spoolFlat(
      tx,
      dir,
      'tags.ndjson',
      sql`
        SELECT id, name, category, color,
          ${ts('created_at')} AS "createdAt", ${ts('updated_at')} AS "updatedAt"
        FROM tags WHERE user_id = ${userId} ORDER BY created_at, id
      `,
    ),
    positions: await spoolFlat(
      tx,
      dir,
      'positions.ndjson',
      sql`
        SELECT id, account_id AS "accountId", symbol, side, asset_type AS "assetType", status, notes,
          ${num('target_price')} AS "targetPrice", ${num('stop_loss')} AS "stopLoss",
          ${ts('opened_at')} AS "openedAt", ${ts('closed_at')} AS "closedAt",
          ${ts('last_flat_at')} AS "lastFlatAt", ${num('last_flat_net_pnl')} AS "lastFlatNetPnl",
          ${ts('created_at')} AS "createdAt", ${ts('updated_at')} AS "updatedAt"
        FROM positions WHERE user_id = ${userId} ORDER BY created_at, id
      `,
    ),
    fills: await spoolFlat(
      tx,
      dir,
      'fills.ndjson',
      sql`
        SELECT f.id, f.position_id AS "positionId", f.type,
          ${num('f.price')} AS "price", ${num('f.quantity')} AS "quantity",
          ${num('f.fees')} AS "fees", f.notes,
          ${ts('f.filled_at')} AS "filledAt", ${ts('f.created_at')} AS "createdAt"
        FROM fills f
        JOIN positions p ON p.id = f.position_id
        WHERE p.user_id = ${userId}
        ORDER BY f.created_at, f.id
      `,
    ),
    positionTags: await spoolFlat(
      tx,
      dir,
      'position-tags.ndjson',
      sql`
        SELECT pt.position_id AS "positionId", pt.tag_id AS "tagId"
        FROM position_tags pt
        JOIN positions p ON p.id = pt.position_id
        WHERE p.user_id = ${userId}
        ORDER BY pt.position_id, pt.tag_id
      `,
    ),
    positionImages: await spoolPositionImages(tx, userId, dir),
    ledgerEntries: await spoolFlat(
      tx,
      dir,
      'ledger-entries.ndjson',
      sql`
        SELECT id, account_id AS "accountId", position_id AS "positionId",
          entry_type AS "entryType", direction, ${num('amount')} AS "amount",
          currency, symbol, ${ts('occurred_at')} AS "occurredAt",
          ${ts('created_at')} AS "createdAt", group_id AS "groupId",
          reverses_group_id AS "reversesGroupId"
        FROM ledger_entries WHERE user_id = ${userId} ORDER BY created_at, id
      `,
    ),
    exchangeRates: await spoolFlat(
      tx,
      dir,
      'exchange-rates.ndjson',
      sql`
        SELECT id, base_currency AS "baseCurrency", quote_currency AS "quoteCurrency",
          ${num('rate')} AS "rate", ${dateCol('effective_date')} AS "effectiveDate",
          ${ts('created_at')} AS "createdAt"
        FROM exchange_rates WHERE user_id = ${userId} ORDER BY created_at, id
      `,
    ),
    expenses: await spoolFlat(
      tx,
      dir,
      'expenses.ndjson',
      sql`
        SELECT id, category, description, ${num('amount')} AS "amount", currency,
          ${dateCol('occurred_at')} AS "occurredAt", notes,
          ${ts('created_at')} AS "createdAt", ${ts('updated_at')} AS "updatedAt"
        FROM expenses WHERE user_id = ${userId} ORDER BY created_at, id
      `,
    ),
    personas: await spoolFlat(
      tx,
      dir,
      'personas.ndjson',
      sql`
        SELECT id, name, description, system_prompt AS "systemPrompt", is_default AS "isDefault",
          ${ts('created_at')} AS "createdAt", ${ts('updated_at')} AS "updatedAt"
        FROM advisor_personas WHERE user_id = ${userId} ORDER BY created_at, id
      `,
    ),
    builtinPersonas: await spoolFlat(
      tx,
      dir,
      'builtin-personas.ndjson',
      sql`
        SELECT ap.id
        FROM advisor_personas ap
        WHERE ap.is_builtin = true
          AND (
            EXISTS (
              SELECT 1 FROM advisor_conversations c
              WHERE c.user_id = ${userId} AND c.persona_id = ap.id
            )
            OR EXISTS (
              SELECT 1 FROM users u
              WHERE u.id = ${userId} AND u.advisor_default_persona_id = ap.id
            )
          )
        ORDER BY ap.id
      `,
    ),
    conversations: await spoolConversations(tx, userId, dir),
    messages: await spoolMessages(tx, userId, dir),
    summaries: await spoolFlat(
      tx,
      dir,
      'summaries.ndjson',
      sql`
        SELECT s.id, s.conversation_id AS "conversationId", s.prose,
          s.trade_data_figures AS "tradeDataFigures",
          s.covered_through_message_id AS "coveredThroughMessageId",
          ${ts('s.covered_through_created_at')} AS "coveredThroughCreatedAt",
          ${ts('s.created_at')} AS "createdAt", ${ts('s.updated_at')} AS "updatedAt"
        FROM advisor_summaries s
        JOIN advisor_conversations c ON c.id = s.conversation_id
        WHERE c.user_id = ${userId}
        ORDER BY s.created_at, s.id
      `,
    ),
  };

  const email = await spoolPreferences(tx, userId, dir);
  await spoolDashboardLayout(tx, userId, dir);

  return { counts, email };
}

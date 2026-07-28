// Deterministic ledger-entries fixture generator for the accounting bench.
//
// Produces newline-terminated TSV rows suitable for `COPY ledger_entries (...)
// FROM STDIN` (postgres.js default — tab-delimited cells, no header). The
// column order in `streamLedgerCopy` MUST match the COPY column list.
//
// Plain Drizzle inserts of 100k rows take minutes on a dev box. COPY drops it
// to ~1-2 seconds.

import { randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';

import { mulberry32 } from '@/db/seed/rng';

export interface LedgerFixtureParams {
  userId: string;
  /** account ids — entries are distributed round-robin across them. */
  accountIds: string[];
  /** total ledger rows to emit. */
  count: number;
  /** earliest occurredAt (inclusive). */
  start: Date;
  /** latest occurredAt (exclusive). */
  end: Date;
  /** PRNG seed — pin for byte-stable output. */
  rngSeed: number;
  /** currency used for every emitted row. */
  currency: string;
}

// Columns emitted, in the EXACT order the COPY statement names them.
// id, user_id, account_id, position_id, entry_type, direction, amount,
// currency, symbol, occurred_at, created_at, group_id, reverses_group_id
export const LEDGER_COPY_COLUMNS = [
  'id',
  'user_id',
  'account_id',
  'position_id',
  'entry_type',
  'direction',
  'amount',
  'currency',
  'symbol',
  'occurred_at',
  'created_at',
  'group_id',
  'reverses_group_id',
] as const;

// Postgres COPY's default text format uses `\N` for NULL.
const NULL_TOKEN = '\\N';

function escapeTsv(value: string): string {
  // COPY text format: tab, newline, carriage return, and backslash are the
  // four characters that need escaping. Our generated values (UUIDs, ISO
  // timestamps, fixed strings) contain none of these, so this is a defensive
  // pass — keeps the helper safe if a caller widens the symbol set.
  return value
    .replace(/\\/g, '\\\\')
    .replace(/\t/g, '\\t')
    .replace(/\n/g, '\\n')
    .replace(/\r/g, '\\r');
}

/**
 * Returns a `Readable` stream of TSV-formatted ledger rows. Pipe straight into
 * the writable returned by `sql\`COPY ledger_entries (...) FROM STDIN\`.writable()`.
 *
 * Determinism: same `rngSeed` + same params → byte-identical output.
 */
export function buildLedgerCopyStream(params: LedgerFixtureParams): Readable {
  const { userId, accountIds, count, start, end, rngSeed, currency } = params;
  if (accountIds.length === 0) {
    throw new Error('buildLedgerCopyStream: accountIds must be non-empty');
  }
  const rng = mulberry32(rngSeed);
  const spanMs = end.getTime() - start.getTime();
  if (spanMs <= 0) {
    throw new Error('buildLedgerCopyStream: end must be strictly after start');
  }

  let emitted = 0;
  return new Readable({
    read() {
      // Emit in batches to keep the JS<->stream handoff cheap.
      const BATCH = 1000;
      let chunk = '';
      const upper = Math.min(emitted + BATCH, count);
      for (let i = emitted; i < upper; i++) {
        const accountId = accountIds[i % accountIds.length];
        // ~50/50 credit/debit; small amounts so SUM stays well within
        // numeric(18,4) range.
        const direction = rng() < 0.5 ? 'credit' : 'debit';
        // Amount in [0.01, 100.00] at 2dp — well inside numeric(18,4).
        const amountCents = 1 + Math.floor(rng() * 9999);
        const amountStr = (amountCents / 100).toFixed(4);
        const occurredAt = new Date(start.getTime() + rng() * spanMs).toISOString();
        const id = randomUUID();
        const groupId = randomUUID();
        const cells = [
          id,
          userId,
          accountId,
          NULL_TOKEN, // position_id — null (the rows being benched do not need a real position FK)
          'position_pnl',
          direction,
          amountStr,
          currency,
          NULL_TOKEN, // symbol
          occurredAt,
          occurredAt, // created_at — same as occurred_at for the fixture
          groupId,
          NULL_TOKEN, // reverses_group_id
        ];
        chunk += cells.map(escapeTsv).join('\t') + '\n';
      }
      emitted = upper;
      if (chunk.length > 0) this.push(chunk);
      if (emitted >= count) this.push(null);
    },
  });
}

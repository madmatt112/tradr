import { Decimal } from 'decimal.js';

import {
  CURRENCY_CODES,
  type CsvPreviewRequest,
  type CsvPreviewResponse,
  type LocatedError,
  type LocatedWarning,
  type ProposedPosition,
} from '@tradr/shared';

import type { Database, Transaction } from '@/db';
import {
  countAccountsByUser,
  findAccountById,
  resolveWritableAccountId,
} from '@/features/accounts/accounts.query';
import { getTierContext } from '@/features/billing/tier.query';
import { countPositionsByUser } from '@/features/positions/positions.query';
import {
  addFillTx,
  closePositionTx,
  createPositionTx,
  openPositionTx,
} from '@/features/positions/positions.service';
import { config } from '@/lib/config';
import { AppError, NotFoundError, ValidationError } from '@/lib/errors';
import { captureServerEvent } from '@/lib/posthog';
import { withTransaction } from '@/lib/transaction';

import {
  claimStaged,
  deleteClaimedStaged,
  finalizeStaged,
  incrementCsvImportCounter,
  insertStaged,
  measureStagedBytes,
  reapStaging,
  selectAccountFillKeys,
  selectCsvImportCount,
  selectStagedByToken,
  type AccountFillKey,
  type CommittedResult,
} from './csv-import.query';
import { guardRowCount } from './csv-import.upload';
import { parseCsv } from './csv-parse';
import { runPipeline, toInstant } from './csv-pipeline';
import type { Segment } from './csv-segment';

// ---------------------------------------------------------------------------
// Preview service (design Component 6) — the write-free preview that guarantees
// a clean preview ⇒ no commit rollback. Parses, runs the pure pipeline
// (`runPipeline`, design Component 5: map → normalize → contract resolution →
// segment → per-segment validation + P&L), scans for duplicates, then writes
// EXACTLY ONE `csv_import_staging` row keyed to a single-use token. No
// positions/fills/ledger writes happen here (REQ-6.1).
//
// Formula/CSV injection is neutralized at ONE point — `neutralizeCsvCell` is
// applied to every string cell value as it enters the response/staging payload
// (design Security; round-1 MF-1).
// ---------------------------------------------------------------------------

/** True for a Postgres unique-violation (SQLSTATE 23505). */
function isUniqueViolation(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    'code' in err &&
    (err as { code?: string }).code === '23505'
  );
}

/** Per-response error/warning cap (REQ-11.4; design Component 6). */
const RESPONSE_CAP = 1000;
/** ≥ this incoming-overlap ratio blocks with requiresDuplicateAffirmation (REQ-9.1). */
const DUPLICATE_BLOCK_RATIO = 0.9;

/**
 * Neutralize a CSV cell value against formula injection (design Security NFR).
 * Any string whose first character is `=`, `+`, `-`, `@`, a tab, or a carriage
 * return is prefixed with a single quote so a spreadsheet never evaluates it.
 * Applied at the SINGLE point where string cell values enter the preview
 * payload, so the neutralized form is what is staged and returned.
 */
export function neutralizeCsvCell(value: string): string {
  if (value.length === 0) return value;
  const first = value[0];
  if (
    first === '=' ||
    first === '+' ||
    first === '-' ||
    first === '@' ||
    first === '\t' ||
    first === '\r'
  ) {
    return `'${value}`;
  }
  return value;
}

/** Cap an error/warning list at RESPONSE_CAP, appending a "+N more" sentinel. */
function capList<T extends LocatedError>(items: T[]): T[] {
  if (items.length <= RESPONSE_CAP) return items;
  const kept = items.slice(0, RESPONSE_CAP);
  const overflow = items.length - RESPONSE_CAP;
  kept.push({
    rowNumber: 0,
    code: 'TRUNCATED',
    message: `+${overflow} more (response capped at ${RESPONSE_CAP}).`,
  } as T);
  return kept;
}

function capWarnings(items: LocatedWarning[]): LocatedWarning[] {
  if (items.length <= RESPONSE_CAP) return items;
  const kept = items.slice(0, RESPONSE_CAP);
  const overflow = items.length - RESPONSE_CAP;
  kept.push({
    kind: 'rounded',
    message: `+${overflow} more warnings (response capped at ${RESPONSE_CAP}).`,
  });
  return kept;
}

/**
 * Build a duplicate match-key (design Component 12). The account is already
 * scoped by the query, so the key is `symbol + filledAt(instant) + price +
 * quantity + type`. Numerics are canonicalized via Decimal so `"10"` (incoming)
 * and `"10.00000000"` (the `numeric(18,8)` column) compare equal, and the
 * timestamp is a canonical UTC instant so offset-form and `Z`-form agree.
 */
function dupKey(
  symbol: string,
  filledAt: string,
  price: string,
  quantity: string,
  type: string,
): string {
  const p = new Decimal(price).toString();
  const q = new Decimal(quantity).toString();
  return `${symbol} ${toInstant(filledAt)} ${p} ${q} ${type}`;
}

function existingKey(k: AccountFillKey): string {
  return dupKey(k.symbol, k.filledAt.toISOString(), k.price, k.quantity, k.type);
}

/**
 * Preview an import (design Component 6). Runs the full pure pipeline, validates
 * field- and invariant-level, scans for duplicates against the account's
 * existing fills, then stages ONE row. Returns the preview + single-use token.
 *
 * The only write is the staging row; all P&L is computed in memory.
 */
export async function previewImport(
  db: Database,
  userId: string,
  accountId: string,
  fileBytes: Uint8Array,
  request: CsvPreviewRequest,
): Promise<CsvPreviewResponse> {
  // Account ownership + currency (REQ-7) — read-only.
  const [account] = await findAccountById(db, accountId, userId);
  if (!account) throw new NotFoundError('Account', accountId);

  const errors: LocatedError[] = [];
  const warnings: LocatedWarning[] = [];

  // 1) Parse.
  const parsed = parseCsv(fileBytes, {
    delimiter: request.mapping.delimiter,
    hasHeader: request.mapping.hasHeader,
  });

  if (parsed.rowCount === 0) {
    throw new ValidationError('No importable rows found in the file.', {
      code: 'CSV_NO_ROWS',
    });
  }

  // Row-count guard (design Component 11, REQ-11.1) — trip at CSV_IMPORT_MAX_ROWS
  // BEFORE building the full in-memory result → 413 CSV_IMPORT_TOO_MANY_ROWS.
  guardRowCount(parsed.rowCount);

  // No `fees` column mapped → fills default fees to 0 (REQ-10.2).
  if (!request.mapping.columns.fees) {
    warnings.push({
      kind: 'no_fees_column',
      message: 'No fees column was mapped; fills default to 0 fees.',
    });
  }

  // Currency hint mismatch (REQ-7.3) — surface a warning, never convert.
  const currencyHint = detectCurrencyHint(parsed.headers, parsed.rows);
  if (currencyHint && currencyHint !== account.currency) {
    warnings.push({
      kind: 'currency_hint_mismatch',
      message: `The file appears to use ${currencyHint} but the account is ${account.currency}; values are imported as-is, not converted.`,
    });
  }

  // 2–6) Pure pipeline (design Component 5): mapping shape, map + transform
  // (excluding mapping-errored rows), normalize, contract resolution, segment,
  // per-segment field validation + invariant dry-run + P&L. DB-free — the
  // conformance test runs this same code path. Placed after the two warnings
  // above so today's warning order is preserved.
  const pipeline = runPipeline(parsed, request, account.currency);
  errors.push(...pipeline.errors);
  warnings.push(...pipeline.warnings);
  const proposedPositions = pipeline.proposedPositions;
  const totalFills = pipeline.totalFills;

  // 7) Duplicate scan (design Component 12) — windowed to the file's date span.
  let requiresDuplicateAffirmation = false;
  if (proposedPositions.length > 0) {
    requiresDuplicateAffirmation = await scanDuplicates(
      db,
      userId,
      accountId,
      pipeline.segments,
      warnings,
    );
  }

  // Classification: committable iff no blocking errors remain.
  const committable = errors.length === 0;

  // Summary counts.
  const rowsWithErrors = new Set(errors.map((e) => e.rowNumber).filter((n) => n > 0)).size;
  const summary = {
    rowsParsed: parsed.rowCount,
    rowsValid: parsed.rowCount - rowsWithErrors,
    rowsWithErrors,
    positions: proposedPositions.length,
    fills: totalFills,
  };

  const cappedErrors = capList(errors);
  const cappedWarnings = capWarnings(warnings);

  // Build the staged `result` payload, neutralizing string cells at this single
  // boundary so the neutralized form is BOTH staged and returned.
  const stagedResult = {
    positions: proposedPositions.map(neutralizePosition),
    errors: cappedErrors.map(neutralizeLocatedError),
    warnings: cappedWarnings.map(neutralizeLocatedWarning),
    summary,
    timezone: request.timezone,
    committable,
    requiresDuplicateAffirmation,
  };

  // Enforce the staged-byte cap (Component 8) → 413.
  const bytes = measureStagedBytes(stagedResult);
  if (bytes > config.CSV_IMPORT_MAX_STAGED_BYTES) {
    throw new AppError(
      413,
      'CSV_IMPORT_RESULT_TOO_LARGE',
      'Import has too many rows/errors to stage; split the file.',
    );
  }

  // Stage exactly one row (supersession enforced inside insertStaged), after a
  // lazy reap. The widened one-active-per-user unique index collides if a live
  // `committing` row exists — map that 23505 to 409 CSV_IMPORT_IN_PROGRESS
  // (design Component 8 / 11, SF-C), never a raw 500.
  let token: string;
  try {
    token = await withTransaction(db, async (tx) => {
      await reapStaging(tx, userId);
      return insertStaged(tx, userId, accountId, stagedResult);
    });
  } catch (err) {
    if (isUniqueViolation(err)) {
      throw new AppError(
        409,
        'CSV_IMPORT_IN_PROGRESS',
        'An import is finishing; try again shortly.',
      );
    }
    throw err;
  }

  return {
    token,
    summary: stagedResult.summary,
    positions: stagedResult.positions,
    errors: stagedResult.errors,
    warnings: stagedResult.warnings,
    timezone: stagedResult.timezone,
    committable: stagedResult.committable,
    requiresDuplicateAffirmation: stagedResult.requiresDuplicateAffirmation,
  };
}

// ---------------------------------------------------------------------------
// Commit service (design Component 7) — two-phase commit.
//
// Phase A (its OWN short tx, commits immediately): re-checks then the atomic
// conditional claim that flips `staged → committing`. Phase B (its OWN bulk
// withTransaction): the upfront account guard, the Component 7a lifecycle
// replay, then the status-guarded finalize — all atomic with the data. A
// Phase-B failure deletes the claimed row (compensating) and re-throws.
//
// The two phases are SEPARATE transactions: `committing` is durable before the
// bulk tx runs, so it is observable (failure-injection / concurrent claimer)
// and deterministically recoverable (Component 8). The finalize's
// `AND status='committing'` guard closes the lazy-recovery race.
// ---------------------------------------------------------------------------

/** The staged `result` payload shape, as written by `previewImport`. */
interface StagedResult {
  positions: ProposedPosition[];
  committable: boolean;
  requiresDuplicateAffirmation: boolean;
}

/**
 * Commit a previewed import (design Component 7). Idempotent, atomic, and
 * recoverable. Returns the `CommitSummary` (REQ-8.7) the UI uses to route to
 * the imported positions. All writes drive the live `*Tx` lifecycle services,
 * so the ledger close-hook fires inside the bulk transaction.
 *
 * Plan-tiers (design C8/D9): the L6/L1-writability/L2 tier checks run in
 * Phase A, BEFORE `claimStaged` — a tier refusal leaves the staged import
 * intact (the Phase-B compensating delete would destroy it), so the user can
 * re-designate/upgrade and re-commit the SAME token without re-uploading. The
 * L6 counter increment lands in Phase B immediately before `finalizeStaged`,
 * atomic with the created positions (REQ-10.4). Routes pass `isAdmin` from
 * AuthEnv — services never read Hono context (D9).
 */
export async function commitImport(
  db: Database,
  userId: string,
  token: string,
  confirmDuplicates: boolean,
  // Routes pass `isAdmin` from AuthEnv (plan-tiers D9) — required so no call
  // site can silently skip the admin/gating pass-through.
  gate: { isAdmin: boolean },
): Promise<CommittedResult> {
  type ClaimOutcome = { idempotent: CommittedResult } | { result: StagedResult; accountId: string };

  // --- Phase A: re-check + atomic claim (own short tx, commits immediately).
  const claimed = await withTransaction(db, async (tx): Promise<ClaimOutcome> => {
    // Lazy reap first (Component 8) — recovers any orphaned committing row for
    // this user so a stale claim never blocks a legitimate retry.
    await reapStaging(tx, userId);

    const row = await selectStagedByToken(tx, userId, token);
    if (!row) throw new NotFoundError('Import', token);

    // Idempotent return: an already-committed token returns its stored summary
    // (REQ-8.6) — never a second import.
    if (row.status === 'committed' && row.committedResult) {
      return { idempotent: row.committedResult };
    }
    if (row.status === 'superseded') {
      throw new AppError(
        409,
        'CSV_IMPORT_SUPERSEDED',
        'This preview was replaced by a newer one — re-preview to import it.',
      );
    }
    if (row.status === 'expired' || row.expiresAt < new Date()) {
      throw new AppError(
        409,
        'CSV_IMPORT_EXPIRED',
        'This preview has expired — re-preview to import.',
      );
    }
    if (row.status === 'committing') {
      throw new AppError(
        409,
        'CSV_IMPORT_IN_PROGRESS',
        'An import for this preview is already running.',
      );
    }

    const result = row.result as StagedResult;
    if (!result.committable) {
      throw new AppError(
        409,
        'CSV_IMPORT_BLOCKED',
        'This preview has blocking errors and cannot be imported.',
      );
    }
    if (result.requiresDuplicateAffirmation && !confirmDuplicates) {
      throw new AppError(
        409,
        'CSV_IMPORT_DUPLICATES_UNCONFIRMED',
        'These look like duplicates — confirm to import anyway.',
      );
    }

    // Account still exists/owned and its currency is unchanged since preview
    // (the ledger hook throws on a minor-unit mismatch). Re-read by id.
    const [account] = await findAccountById(tx, row.accountId, userId);
    if (!account) {
      throw new AppError(
        409,
        'CSV_IMPORT_BLOCKED',
        'The account changed since preview — re-preview to import.',
      );
    }

    // Plan-tiers tier checks (design C8/D9/D12) — Phase A, BEFORE the claim,
    // as peers of the refusals above: a 403 here leaves the staged row intact
    // and the SAME token re-committable after re-designation/upgrade (no
    // re-upload). Order: L6 → L1-writability → L2. Admin / gating-off pass
    // through (REQ-10.5/6.7). 403s are terminal-for-state — never 429, no
    // Retry-After. Indexed count(*) reads; the accepted concurrent-overshoot
    // posture (REQ-6.3) applies.
    const tier = await getTierContext(tx, { userId, isAdmin: gate.isAdmin });
    if (tier.enforced) {
      // L6: lifetime committed-import allowance (REQ-10.1). Only successful
      // commits ever incremented this counter, so previews / validation
      // failures / expired staging never consumed it.
      if (tier.limits.csvImports !== null) {
        const committedImports = await selectCsvImportCount(tx, userId);
        if (committedImports >= tier.limits.csvImports) {
          captureServerEvent('tier_limit_hit', {
            distinctId: userId,
            properties: { lever: 'csvImports' },
          });
          throw new AppError(
            403,
            'TIER_LIMIT_CSV_IMPORTS',
            `Your plan includes ${tier.limits.csvImports} lifetime CSV imports and all have been used. Upgrade to Pro for unlimited imports.`,
          );
        }
      }
      // L1 writability (D18): while over the account cap, new trading data may
      // only target the effective writable designation.
      if (tier.limits.accounts !== null) {
        const accountCount = await countAccountsByUser(tx, userId);
        if (accountCount > tier.limits.accounts) {
          const writableAccountId = await resolveWritableAccountId(tx, userId);
          if (row.accountId !== writableAccountId) {
            captureServerEvent('tier_limit_hit', {
              distinctId: userId,
              properties: { lever: 'accounts' },
            });
            throw new AppError(
              403,
              'TIER_ACCOUNT_NOT_WRITABLE',
              'This account is not writable on your current plan. CSV imports can only target your designated writable account — change the designation or upgrade to Pro.',
            );
          }
        }
      }
      // L2: positions count + staged batch size — atomic whole-batch refusal
      // (REQ-6.2); the message states the cap AND the batch size.
      if (tier.limits.positions !== null) {
        const batchSize = result.positions.length;
        const positionCount = await countPositionsByUser(tx, userId);
        if (positionCount + batchSize > tier.limits.positions) {
          captureServerEvent('tier_limit_hit', {
            distinctId: userId,
            properties: { lever: 'positions' },
          });
          throw new AppError(
            403,
            'TIER_LIMIT_POSITIONS',
            `This import would create ${batchSize} positions, but your plan allows ${tier.limits.positions} positions in total. Upgrade to Pro for unlimited positions.`,
          );
        }
      }
    }

    // Atomic, non-blocking claim. A concurrent double-submit has exactly one
    // winner; the loser matches zero rows.
    const won = await claimStaged(tx, userId, token);
    if (!won) {
      // Lost the race (or recovery deleted the row); re-read and branch.
      const after = await selectStagedByToken(tx, userId, token);
      if (after?.status === 'committed' && after.committedResult) {
        return { idempotent: after.committedResult };
      }
      throw new AppError(
        409,
        'CSV_IMPORT_IN_PROGRESS',
        'An import for this preview is already running.',
      );
    }

    return { result, accountId: row.accountId };
  });

  if ('idempotent' in claimed) return claimed.idempotent;

  // --- Phase B: bulk replay (own tx). On any failure, the bulk tx rolls back
  // positions + fills + ledger + the committed flag together; the claimed row
  // is then deleted so a retry must re-preview.
  const { result, accountId } = claimed;
  try {
    return await withTransaction(db, async (tx) => {
      // Upfront account guard (Component 7a) — one re-verify before any insert.
      const [account] = await findAccountById(tx, accountId, userId);
      if (!account) {
        throw new AppError(
          409,
          'CSV_IMPORT_BLOCKED',
          'The account changed since preview — re-preview to import.',
        );
      }

      const positionIds: string[] = [];
      let fillsCreated = 0;
      for (const proposed of result.positions) {
        const id = await replaySegment(tx, userId, accountId, proposed);
        positionIds.push(id);
        fillsCreated += proposed.fills.length;
      }

      const summary: CommittedResult = {
        positionsCreated: positionIds.length,
        fillsCreated,
        positionIds,
        accountId,
      };

      // L6 lifetime counter increment (plan-tiers C8, REQ-10.2/10.4) — inside
      // the bulk tx immediately before finalize, so it commits atomically with
      // the created positions: a crashed commit consumes nothing, and a
      // Phase-A refusal never reached this line. Counting is always-on (the
      // D11 "counting is not a limit" doctrine — admin and gating-off commits
      // count too); only the L6 CHECK is gated.
      await incrementCsvImportCounter(tx, userId);

      // Status-guarded finalize INSIDE the bulk tx — the committed flag commits
      // atomically with the data. If a concurrent recovery reset/deleted the
      // row, this matches zero rows: we raise to roll the whole import back.
      const finalized = await finalizeStaged(tx, token, summary);
      if (!finalized) {
        throw new AppError(
          409,
          'CSV_IMPORT_IN_PROGRESS',
          'The import claim was lost; re-preview to retry.',
        );
      }

      return summary;
    });
  } catch (err) {
    // Compensating delete of the claimed `committing` row (own tiny tx). The
    // bulk tx already rolled back all data, so nothing persisted under it.
    await withTransaction(db, (tx) => deleteClaimedStaged(tx, token)).catch(() => {
      /* best-effort; orphan recovery (Component 8) reaps it later regardless */
    });
    throw err;
  }
}

/**
 * Replay one proposed position through the live `*Tx` lifecycle services
 * (design Component 7a). The stored fills are ALREADY ordered (REQ-4.2) and
 * canonicalized to Z-form ISO at staging — replay them VERBATIM (no re-parse,
 * re-normalize, or re-canonicalize). Returns the created position id.
 *
 * Open rule: open exactly once, before the first `exit`; else, if still draft
 * after all fills, open once (entry-only residual → 'open', REQ-4.5). Close
 * when the segment `closes` (fires the ledger hook inside this tx).
 */
async function replaySegment(
  tx: Transaction,
  userId: string,
  accountId: string,
  proposed: ProposedPosition,
): Promise<string> {
  const pos = await createPositionTx(tx, userId, {
    accountId,
    symbol: proposed.scope.symbol,
    side: proposed.side,
    assetType: proposed.scope.assetType,
  });

  const fills = proposed.fills;
  const firstExecTs = fills[0]!.filledAt;
  const lastExecTs = fills[fills.length - 1]!.filledAt;

  let opened = false;
  for (const fill of fills) {
    if (!opened && fill.type === 'exit') {
      await openPositionTx(tx, pos.id, userId, firstExecTs);
      opened = true;
    }
    await addFillTx(tx, pos.id, userId, {
      type: fill.type,
      price: fill.price,
      quantity: fill.quantity,
      fees: fill.fees,
      filledAt: fill.filledAt,
    });
  }

  // Entry-only residual → leave a non-draft end-state.
  if (!opened) {
    await openPositionTx(tx, pos.id, userId, firstExecTs);
  }

  if (proposed.closes) {
    await closePositionTx(tx, pos.id, userId, lastExecTs);
  }

  return pos.id;
}

// ---------------------------------------------------------------------------
// Duplicate detection (design Component 12)
// ---------------------------------------------------------------------------

async function scanDuplicates(
  db: Database,
  userId: string,
  accountId: string,
  segments: Segment[],
  warnings: LocatedWarning[],
): Promise<boolean> {
  // Collect incoming fill keys + their date window.
  interface Incoming {
    key: string;
    sourceRow: number;
    symbol: string;
  }
  const incoming: Incoming[] = [];
  let min: Date | null = null;
  let max: Date | null = null;
  for (const seg of segments) {
    for (const exec of seg.executions) {
      const filled = new Date(exec.filledAt);
      if (min === null || filled < min) min = filled;
      if (max === null || filled > max) max = filled;
      incoming.push({
        key: dupKey(seg.scope.symbol, exec.filledAt, exec.price, exec.quantity, exec.type),
        sourceRow: exec.sourceRow,
        symbol: seg.scope.symbol,
      });
    }
  }
  if (incoming.length === 0 || min === null || max === null) return false;

  // Within-file duplicates → warnings (REQ-9.4).
  const seenInFile = new Set<string>();
  for (const inc of incoming) {
    if (seenInFile.has(inc.key)) {
      warnings.push({
        rowNumber: inc.sourceRow,
        kind: 'within_file_duplicate',
        message: `Row ${inc.sourceRow} duplicates an earlier row in this file.`,
      });
    } else {
      seenInFile.add(inc.key);
    }
  }

  // Windowed scan vs existing account fills.
  const existing = await selectAccountFillKeys(db, userId, accountId, min, max);
  const existingSet = new Set(existing.map(existingKey));

  let matched = 0;
  for (const inc of incoming) {
    if (existingSet.has(inc.key)) matched += 1;
  }
  if (matched === 0) return false;

  const ratio = matched / incoming.length;
  if (ratio >= DUPLICATE_BLOCK_RATIO) {
    // ≥0.90 overlap → blocking; released only by confirmDuplicates at commit.
    return true;
  }

  // Partial overlap → per-fill warnings (REQ-9.1).
  for (const inc of incoming) {
    if (existingSet.has(inc.key)) {
      warnings.push({
        rowNumber: inc.sourceRow,
        kind: 'partial_duplicate',
        message: `Row ${inc.sourceRow} matches an existing fill in this account.`,
      });
    }
  }
  return false;
}

// ---------------------------------------------------------------------------
// Currency hint detection (REQ-7.3) — read-only, never converts.
// ---------------------------------------------------------------------------

/**
 * Detect a currency hint from the parsed file: a column whose header looks like
 * a currency column, taking the first non-empty 3-letter known currency code.
 * Returns undefined when no recognizable hint is present.
 */
function detectCurrencyHint(headers: string[], rows: string[][]): string | undefined {
  const codes = new Set<string>(CURRENCY_CODES);
  const idx = headers.findIndex((h) => /\b(currency|ccy)\b/i.test(h));
  if (idx === -1) return undefined;
  for (const row of rows) {
    const cell = (row[idx] ?? '').trim().toUpperCase();
    if (cell && codes.has(cell)) return cell;
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Formula-injection neutralization at the response/staging boundary (single
// point — design Security). Applied to every string cell that enters the
// payload.
// ---------------------------------------------------------------------------

function neutralizePosition(p: ProposedPosition): ProposedPosition {
  return {
    scope: { symbol: neutralizeCsvCell(p.scope.symbol), assetType: p.scope.assetType },
    side: p.side,
    closes: p.closes,
    fills: p.fills.map((f) => ({
      type: f.type,
      price: neutralizeCsvCell(f.price),
      quantity: neutralizeCsvCell(f.quantity),
      fees: neutralizeCsvCell(f.fees),
      filledAt: neutralizeCsvCell(f.filledAt),
      sourceRow: f.sourceRow,
    })),
    proposedPnl: p.proposedPnl,
  };
}

function neutralizeLocatedError(e: LocatedError): LocatedError {
  return {
    rowNumber: e.rowNumber,
    csvColumn: e.csvColumn !== undefined ? neutralizeCsvCell(e.csvColumn) : undefined,
    tradrField: e.tradrField,
    code: e.code,
    message: neutralizeCsvCell(e.message),
  };
}

function neutralizeLocatedWarning(w: LocatedWarning): LocatedWarning {
  return {
    rowNumber: w.rowNumber,
    csvColumn: w.csvColumn !== undefined ? neutralizeCsvCell(w.csvColumn) : undefined,
    kind: w.kind,
    message: neutralizeCsvCell(w.message),
  };
}

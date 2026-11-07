// Save/read/remove service for IBKR Flex connections (design C2, Req 1), plus
// the fetch-and-preview orchestration (design C6, Req 2).
// Ownership is checked with findAccountById so a save or removal on an
// unowned account 404s before any ciphertext is written (Req 1.3, 5.7).

import { CSV_IMPORT_PRESETS } from '@tradr/shared';
import type { CsvPreviewRequest, CsvPreviewResponse, IbkrConnectionSave } from '@tradr/shared';

import type { Database } from '@/db';
import { findAccountById } from '@/features/accounts/accounts.query';
import { previewImport } from '@/features/csv-import/csv-import.service';
import { parseCsv } from '@/features/csv-import/csv-parse';
import {
  decrypt,
  encrypt,
  ENCRYPTION_KEY_VERSION_CURRENT,
  EncryptionError,
} from '@/lib/encryption';
import { AppError, NotFoundError } from '@/lib/errors';
import { logger } from '@/lib/logger';
import { withTransaction } from '@/lib/transaction';

import { proveSingleAccount, reportTradeSpan } from './flex-report';
import type { FetchFlexDeps } from './flex.client';
import { fetchFlexReport } from './flex.client';
import {
  type ConnectionMasked,
  deleteConnection,
  listConnections,
  recordFetch,
  replaceConnection,
  selectConnectionCiphertext,
} from './ibkr.query';

/** The user's connections, masked (Req 1.2). */
export async function getConnections(db: Database, userId: string): Promise<ConnectionMasked[]> {
  return listConnections(db, userId);
}

/**
 * Save (or replace) the account's connection (Req 1.1, 1.4). The ownership
 * check and the replace run in one transaction so an unowned account never
 * reaches storage. Makes no call to IBKR (Req 1.7).
 */
export async function saveConnection(
  db: Database,
  userId: string,
  accountId: string,
  input: IbkrConnectionSave,
): Promise<ConnectionMasked> {
  return withTransaction(db, async (tx) => {
    const [account] = await findAccountById(tx, accountId, userId);
    if (!account) throw new NotFoundError('Account', accountId);

    const row = await replaceConnection(tx, {
      userId,
      accountId,
      encryptedToken: encrypt(input.token),
      encryptedQueryId: encrypt(input.queryId),
      keyVersion: ENCRYPTION_KEY_VERSION_CURRENT,
      tokenHintTail: input.token.slice(-4),
    });

    return {
      accountId: row.accountId,
      tokenHintTail: row.tokenHintTail,
      lastFetchedAt: row.lastFetchedAt,
      lastPeriodStart: row.lastPeriodStart,
      lastPeriodEnd: row.lastPeriodEnd,
    };
  });
}

/** Hard-delete the account's connection, scoped by userId (Req 1.5, 5.7). */
export async function removeConnection(
  db: Database,
  userId: string,
  accountId: string,
): Promise<void> {
  const deleted = await deleteConnection(db, userId, accountId);
  if (deleted === 0) throw new NotFoundError('Connection', accountId);
}

const FLEX_PRESET_ID = 'interactive-brokers';

/**
 * The preview request IBKR Flex fetches always use — built once from the
 * `interactive-brokers` preset, the same values `ColumnMapper.applyPreset`
 * sends (design C6; `ColumnMapper.tsx:98-122`).
 */
function buildFlexPreviewRequest(accountId: string): CsvPreviewRequest {
  const preset = CSV_IMPORT_PRESETS.find((p) => p.id === FLEX_PRESET_ID);
  if (!preset) throw new Error(`Missing CSV import preset: ${FLEX_PRESET_ID}`);

  return {
    accountId,
    rowShape: preset.rowShape,
    mapping: {
      ...preset.mapping,
      rowShape: preset.rowShape,
      contractForm: preset.mapping.contractForm ?? 'occ-symbol',
      expiryFormat: preset.mapping.expiryFormat ?? 'iso',
    },
    presetId: FLEX_PRESET_ID,
    timezone: 'UTC',
    dateFormat: preset.dateFormat,
    numberFormat: preset.numberFormat,
  };
}

/**
 * Orchestrate one IBKR Flex fetch and preview it (design C6, Req 2). Runs the
 * eight post-conditions in order: read + decrypt the connection, fetch the
 * report with no transaction or held connection spanning the outbound call,
 * parse it, refuse on zero rows or an unproven account, then hand the raw
 * bytes to the existing preview pipeline (`source: 'flex'`) and record the
 * fetch. A failed `recordFetch` after a successful preview only logs a
 * warning — the preview itself still returns (Req 4.2, 7.3, NFR Reliability).
 */
export async function fetchAndPreview(
  db: Database,
  userId: string,
  accountId: string,
  deps: FetchFlexDeps = {},
): Promise<CsvPreviewResponse> {
  // 1) Read the connection, scoped by userId (Req 5.7).
  const connection = await selectConnectionCiphertext(db, userId, accountId);
  if (!connection) throw new NotFoundError('Connection', accountId);

  // 2) Decrypt both values; an unreadable envelope 409s (Req 4.1).
  let token: string;
  let queryId: string;
  try {
    token = decrypt(connection.encryptedToken);
    queryId = decrypt(connection.encryptedQueryId);
  } catch (err) {
    if (err instanceof EncryptionError) {
      throw new AppError(
        409,
        'IBKR_CONNECTION_UNREADABLE',
        'This connection cannot be read; remove and re-save it.',
      );
    }
    throw err;
  }

  // 3) The outbound two-step call — no transaction or held connection spans
  // this (design C6 step 3). Any `AppError` it throws (token/query rejected,
  // rate limited, unavailable, not ready, too large) passes through unchanged.
  const reportBytes = await fetchFlexReport({ token, queryId }, deps);

  const request = buildFlexPreviewRequest(accountId);

  // 4) Parse with the preset's delimiter options; any parse failure (e.g. not
  // valid UTF-8) gives IBKR_FLEX_UNAVAILABLE rather than the upload path's
  // own coded error.
  let parsed: ReturnType<typeof parseCsv>;
  try {
    parsed = parseCsv(reportBytes, {
      delimiter: request.mapping.delimiter,
      hasHeader: request.mapping.hasHeader,
    });
  } catch {
    throw new AppError(503, 'IBKR_FLEX_UNAVAILABLE', 'IBKR is unavailable; try again later.');
  }

  // 5) Zero rows: record the fetch with a null span, then refuse (Req 2.7, 7.1).
  if (parsed.rowCount === 0) {
    await recordFetch(db, connection.id, {
      fetchedAt: new Date(),
      periodStart: null,
      periodEnd: null,
    });
    throw new AppError(422, 'IBKR_FLEX_NO_TRADES', 'This Flex report has no trades.');
  }

  // 6) Prove the report names exactly one IBKR account (Req 2.8).
  proveSingleAccount(parsed);

  // 7) Hand the raw bytes to the existing preview pipeline.
  const preview = await previewImport(db, userId, accountId, reportBytes, request, {
    source: 'flex',
  });

  // 8) Record the fetch time and the report's trade-date span. A failure here
  // logs a warning only — the preview already staged, so it still returns.
  const span = reportTradeSpan(preview);
  try {
    await recordFetch(db, connection.id, {
      fetchedAt: new Date(),
      periodStart: span?.start ?? null,
      periodEnd: span?.end ?? null,
    });
  } catch (err) {
    logger.warn('ibkr_flex_record_fetch_failed', {
      accountId,
      error: err instanceof Error ? err.message : String(err),
    });
  }

  return preview;
}

import Decimal from 'decimal.js';

import type { Database } from '@/db';
import { ConflictError, NotFoundError } from '@/lib/errors';
import { withTransaction } from '@/lib/transaction';

import { findPositionById, findPositionForUpdate } from './positions.query';
import {
  deleteTransferLinkByExitFillId,
  findEntryFillForLink,
  findFillInPosition,
  findTransferCandidates,
  findTransferLinkByEntryFillId,
  findTransferLinkByExitFillId,
  findTransferLinkView,
  insertTransferLink,
} from './transfer-links.query';

interface PgError {
  code?: string;
  constraint_name?: string;
}
function isPgError(err: unknown): err is PgError {
  return typeof err === 'object' && err !== null && 'code' in err;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type RawPositionRow = Record<string, any>;

export async function getTransferLink(
  db: Database,
  positionId: string,
  fillId: string,
  userId: string,
) {
  const posRows = await findPositionById(db, positionId, userId);
  if (posRows.length === 0) throw new NotFoundError('Position', positionId);
  const position = posRows[0];

  const fillRows = await findFillInPosition(db, fillId, positionId);
  if (fillRows.length === 0 || fillRows[0].type !== 'exit') {
    throw new NotFoundError('Fill', fillId);
  }
  const exitFill = fillRows[0];

  const linkRows = await findTransferLinkView(db, fillId);
  const link = linkRows[0] ?? null;

  const candidates = await findTransferCandidates(
    db,
    userId,
    position.accountId,
    position.symbol,
    position.side,
    exitFill.quantity,
  );

  return { link, candidates };
}

export async function setTransferLink(
  db: Database,
  positionId: string,
  fillId: string,
  userId: string,
  entryFillId: string,
) {
  return withTransaction(db, async (tx) => {
    const entryRows = await findEntryFillForLink(tx, entryFillId, userId);
    const entryInfo = entryRows[0];
    if (!entryInfo || entryInfo.type !== 'entry') {
      throw new ConflictError('not_an_entry: the given fill is not one of your entry fills');
    }

    const positionIds = Array.from(new Set([positionId, entryInfo.positionId])).sort();
    const lockedById = new Map<string, RawPositionRow>();
    for (const id of positionIds) {
      const rows = (await findPositionForUpdate(tx, id, userId)) as RawPositionRow[];
      if (rows.length === 0) throw new NotFoundError('Position', id);
      lockedById.set(id, rows[0]);
    }
    const exitPosition = lockedById.get(positionId)!;
    const entryPosition = lockedById.get(entryInfo.positionId)!;

    const exitFillRows = await findFillInPosition(tx, fillId, positionId);
    if (exitFillRows.length === 0) throw new NotFoundError('Fill', fillId);
    const exitFill = exitFillRows[0];

    if (exitPosition.account_id === entryPosition.account_id) {
      throw new ConflictError('same_account: the entry fill must sit in a different account');
    }
    if (exitPosition.symbol !== entryPosition.symbol || exitPosition.side !== entryPosition.side) {
      throw new ConflictError(
        'different_security: the entry fill must share the symbol and side being exited',
      );
    }
    if (!new Decimal(exitFill.quantity).equals(new Decimal(entryInfo.quantity))) {
      throw new ConflictError(
        'quantity_mismatch: the entry fill quantity must equal the exit fill quantity',
      );
    }
    if ((await findTransferLinkByExitFillId(tx, fillId)).length > 0) {
      throw new ConflictError('exit_already_linked: this exit fill already has a transfer link');
    }
    if ((await findTransferLinkByEntryFillId(tx, entryFillId)).length > 0) {
      throw new ConflictError('entry_already_linked: this entry fill already has a transfer link');
    }

    try {
      const [row] = await insertTransferLink(tx, { userId, exitFillId: fillId, entryFillId });
      return {
        id: row.id,
        exitFillId: row.exitFillId,
        entryFillId: row.entryFillId,
        entryPositionId: entryInfo.positionId,
        entryAccountId: entryInfo.accountId,
        entryAccountName: entryInfo.accountName,
        createdAt: row.createdAt,
      };
    } catch (err: unknown) {
      // Backstop for the race the application-level checks above already
      // serialize through the shared position lock (design C7 post-condition
      // 1): the loser's unique-violation maps to the same 409, not a 500.
      if (isPgError(err) && err.code === '23505') {
        if (err.constraint_name === 'fill_transfer_links_exit_unique') {
          throw new ConflictError(
            'exit_already_linked: this exit fill already has a transfer link',
          );
        }
        if (err.constraint_name === 'fill_transfer_links_entry_unique') {
          throw new ConflictError(
            'entry_already_linked: this entry fill already has a transfer link',
          );
        }
      }
      throw err;
    }
  });
}

export async function removeTransferLink(
  db: Database,
  positionId: string,
  fillId: string,
  userId: string,
) {
  const posRows = await findPositionById(db, positionId, userId);
  if (posRows.length === 0) throw new NotFoundError('Position', positionId);

  const fillRows = await findFillInPosition(db, fillId, positionId);
  if (fillRows.length === 0) throw new NotFoundError('Fill', fillId);

  const deleted = await deleteTransferLinkByExitFillId(db, fillId);
  if (deleted.length === 0) throw new NotFoundError('Transfer link', fillId);
}

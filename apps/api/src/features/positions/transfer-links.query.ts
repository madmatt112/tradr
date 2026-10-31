import { and, eq, ne, or, isNull } from 'drizzle-orm';

import type { Database, Transaction } from '@/db';
import { accounts, fillTransferLinks, fills, positions } from '@/db/schema';

export function findFillInPosition(db: Database | Transaction, fillId: string, positionId: string) {
  return db
    .select()
    .from(fills)
    .where(and(eq(fills.id, fillId), eq(fills.positionId, positionId)))
    .limit(1);
}

// Resolves a candidate entry fill scoped to the caller — never filtered
// separately by type, so a wrong-type fill and a fill belonging to another
// user are indistinguishable to the caller (NFR Security, AC 6.1).
export function findEntryFillForLink(db: Database | Transaction, fillId: string, userId: string) {
  return db
    .select({
      fillId: fills.id,
      type: fills.type,
      quantity: fills.quantity,
      positionId: positions.id,
      symbol: positions.symbol,
      side: positions.side,
      accountId: positions.accountId,
      accountName: accounts.name,
    })
    .from(fills)
    .innerJoin(positions, eq(positions.id, fills.positionId))
    .innerJoin(accounts, eq(accounts.id, positions.accountId))
    .where(and(eq(fills.id, fillId), eq(positions.userId, userId)))
    .limit(1);
}

export function findTransferLinkByExitFillId(db: Database | Transaction, exitFillId: string) {
  return db.select().from(fillTransferLinks).where(eq(fillTransferLinks.exitFillId, exitFillId));
}

export function findTransferLinkByEntryFillId(db: Database | Transaction, entryFillId: string) {
  return db.select().from(fillTransferLinks).where(eq(fillTransferLinks.entryFillId, entryFillId));
}

// Either side — used by the editFill quantity guard (design C7 post-condition
// 3), since the edited fill may be the exit or the entry half of a link.
export function findTransferLinkByFillId(db: Database | Transaction, fillId: string) {
  return db
    .select()
    .from(fillTransferLinks)
    .where(or(eq(fillTransferLinks.exitFillId, fillId), eq(fillTransferLinks.entryFillId, fillId)));
}

export function insertTransferLink(
  tx: Transaction,
  data: { userId: string; exitFillId: string; entryFillId: string },
) {
  return tx.insert(fillTransferLinks).values(data).returning();
}

export function deleteTransferLinkByExitFillId(db: Database | Transaction, exitFillId: string) {
  return db
    .delete(fillTransferLinks)
    .where(eq(fillTransferLinks.exitFillId, exitFillId))
    .returning();
}

// An established link's view (design C7 TransferLinkView), joined through
// the entry fill to its position and account.
export function findTransferLinkView(db: Database | Transaction, exitFillId: string) {
  return db
    .select({
      id: fillTransferLinks.id,
      exitFillId: fillTransferLinks.exitFillId,
      entryFillId: fillTransferLinks.entryFillId,
      entryPositionId: positions.id,
      entryAccountId: positions.accountId,
      entryAccountName: accounts.name,
      createdAt: fillTransferLinks.createdAt,
    })
    .from(fillTransferLinks)
    .innerJoin(fills, eq(fills.id, fillTransferLinks.entryFillId))
    .innerJoin(positions, eq(positions.id, fills.positionId))
    .innerJoin(accounts, eq(accounts.id, positions.accountId))
    .where(eq(fillTransferLinks.exitFillId, exitFillId))
    .limit(1);
}

// The caller's eligible entry fills in other accounts: same symbol and side,
// equal quantity, in no link (design C7 route doc, AC 6.5).
export function findTransferCandidates(
  db: Database | Transaction,
  userId: string,
  excludeAccountId: string,
  symbol: string,
  side: string,
  quantity: string,
) {
  return db
    .select({
      entryFillId: fills.id,
      positionId: positions.id,
      accountId: positions.accountId,
      accountName: accounts.name,
      filledAt: fills.filledAt,
      price: fills.price,
      quantity: fills.quantity,
    })
    .from(fills)
    .innerJoin(positions, eq(positions.id, fills.positionId))
    .innerJoin(accounts, eq(accounts.id, positions.accountId))
    .leftJoin(fillTransferLinks, eq(fillTransferLinks.entryFillId, fills.id))
    .where(
      and(
        eq(fills.type, 'entry'),
        eq(positions.userId, userId),
        eq(positions.symbol, symbol),
        eq(positions.side, side),
        eq(fills.quantity, quantity),
        ne(positions.accountId, excludeAccountId),
        isNull(fillTransferLinks.id),
      ),
    );
}

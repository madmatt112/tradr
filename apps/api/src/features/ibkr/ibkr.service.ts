// Save/read/remove service for IBKR Flex connections (design C2, Req 1).
// Ownership is checked with findAccountById so a save or removal on an
// unowned account 404s before any ciphertext is written (Req 1.3, 5.7).

import type { IbkrConnectionSave } from '@tradr/shared';

import type { Database } from '@/db';
import { findAccountById } from '@/features/accounts/accounts.query';
import { encrypt, ENCRYPTION_KEY_VERSION_CURRENT } from '@/lib/encryption';
import { NotFoundError } from '@/lib/errors';
import { withTransaction } from '@/lib/transaction';

import {
  type ConnectionMasked,
  deleteConnection,
  listConnections,
  replaceConnection,
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

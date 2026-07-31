import { Hono } from 'hono';
import { z } from 'zod';

import {
  CreateExchangeRateInputSchema,
  PreviewRateChangeInputSchema,
  ReconcileBalanceInputSchema,
} from '@tradr/shared/schemas/accounting';

import { db } from '@/db';
import { validate } from '@/lib/validation';
import { authMiddleware } from '@/middleware/auth.middleware';

import { listLedgerEntriesForAccount } from './accounting.query';
import {
  computeDashboardTotal,
  createExchangeRate,
  deleteExchangeRate,
  getUserDisplayCurrency,
  listExchangeRates,
  previewRateChangeImpact,
  reconcileAccountBalance,
  setUserDisplayCurrency,
} from './accounting.service';

type AuthEnv = {
  Variables: {
    userId: string;
    isAdmin: boolean;
  };
};

const accountingRouter = new Hono<AuthEnv>();

accountingRouter.use(authMiddleware);

// ---------------------------------------------------------------------------
// Schemas (local — request shapes only; response schemas live in @tradr/shared)
// ---------------------------------------------------------------------------

const AccountIdParamSchema = z.object({ accountId: z.string().uuid() });
const IdParamSchema = z.object({ id: z.string().uuid() });

const LedgerQuerySchema = z.object({
  page: z.coerce.number().int().positive().default(1),
  pageSize: z.coerce.number().int().positive().max(200).default(50),
});

const DisplayCurrencyBodySchema = z.object({
  currency: z
    .string()
    .length(3)
    .regex(/^[A-Z]{3}$/, { message: 'Must be a 3-letter uppercase currency code' }),
});

// ---------------------------------------------------------------------------
// Ledger
// ---------------------------------------------------------------------------

accountingRouter.get(
  '/ledger/:accountId',
  validate('param', AccountIdParamSchema),
  validate('query', LedgerQuerySchema),
  async (c) => {
    const userId = c.get('userId');
    const { accountId } = c.req.valid('param');
    const { page, pageSize } = c.req.valid('query');
    const offset = (page - 1) * pageSize;

    const result = await listLedgerEntriesForAccount(db, {
      userId,
      accountId,
      limit: pageSize,
      offset,
    });

    return c.json(
      {
        entries: result.entries,
        runningBalanceAtFirstRow: result.runningBalanceAtFirstRow,
        page,
        pageSize,
        hasMore: result.hasMore,
      },
      200,
    );
  },
);

/**
 * @swagger
 * /api/ledger/{accountId}/reconcile:
 *   post:
 *     summary: Reconcile an account's cash balance to a stated figure.
 *     description: >
 *       Posts a single `balance_adjustment` ledger entry for the difference
 *       between the account's current derived balance and `targetBalance`, so
 *       the balance afterwards equals `targetBalance` exactly.
 *
 *       The client sends the TARGET balance, never a delta — the server computes
 *       the difference inside the transaction that writes the row, behind a row
 *       lock on the account, so a concurrent position close cannot race it.
 *
 *       The balance being reconciled is Tradr's cash balance for the account:
 *       starting balance plus realized P&L from closed trades. Tradr holds no
 *       mark-to-market, so it excludes the market value of open positions. Open
 *       positions do not block or alter this operation.
 *
 *       Append-only: this adds a row and never edits or deletes one. A wrong
 *       figure is corrected by reconciling again; both entries persist.
 *     tags: [Accounting]
 *     security:
 *       - cookieAuth: []
 *     parameters:
 *       - in: path
 *         name: accountId
 *         required: true
 *         schema: { type: string, format: uuid }
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [targetBalance]
 *             properties:
 *               targetBalance:
 *                 type: string
 *                 description: >
 *                   Decimal string with at most 4 fractional digits, and no more
 *                   than the account currency's minor units. May be negative (a
 *                   margin/debit balance).
 *                 example: '10250.00'
 *     responses:
 *       201:
 *         description: The adjustment entry, plus the balance either side of it.
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 entry: { type: object }
 *                 previousBalance: { type: string, example: '10000.0000' }
 *                 newBalance: { type: string, example: '10250.0000' }
 *       400: { description: targetBalance is malformed or too precise for the currency. }
 *       401: { description: Not authenticated. }
 *       404: { description: No such account for this user. }
 *       409: { description: The balance already equals targetBalance — nothing to adjust. }
 */
accountingRouter.post(
  '/ledger/:accountId/reconcile',
  validate('param', AccountIdParamSchema),
  validate('json', ReconcileBalanceInputSchema),
  async (c) => {
    const userId = c.get('userId');
    const { accountId } = c.req.valid('param');
    const { targetBalance } = c.req.valid('json');

    const result = await reconcileAccountBalance(db, userId, accountId, targetBalance);
    return c.json(result, 201);
  },
);

// ---------------------------------------------------------------------------
// Exchange rates
// ---------------------------------------------------------------------------

accountingRouter.get('/exchange-rates', async (c) => {
  const userId = c.get('userId');
  const rows = await listExchangeRates(db, userId);
  return c.json(rows, 200);
});

accountingRouter.post(
  '/exchange-rates',
  validate('json', CreateExchangeRateInputSchema),
  async (c) => {
    const userId = c.get('userId');
    const input = c.req.valid('json');
    const row = await createExchangeRate(db, userId, input);
    return c.json(row, 201);
  },
);

accountingRouter.delete('/exchange-rates/:id', validate('param', IdParamSchema), async (c) => {
  const userId = c.get('userId');
  const { id } = c.req.valid('param');
  await deleteExchangeRate(db, userId, id);
  return c.body(null, 204);
});

accountingRouter.post(
  '/exchange-rates/preview',
  validate('json', PreviewRateChangeInputSchema),
  async (c) => {
    const userId = c.get('userId');
    const change = c.req.valid('json');
    const result = await previewRateChangeImpact(db, userId, change);
    return c.json(result, 200);
  },
);

// ---------------------------------------------------------------------------
// User display currency
// ---------------------------------------------------------------------------

accountingRouter.get('/users/me/display-currency', async (c) => {
  const userId = c.get('userId');
  const currency = await getUserDisplayCurrency(db, userId);
  return c.json({ currency }, 200);
});

accountingRouter.put(
  '/users/me/display-currency',
  validate('json', DisplayCurrencyBodySchema),
  async (c) => {
    const userId = c.get('userId');
    const { currency } = c.req.valid('json');
    await setUserDisplayCurrency(db, userId, currency);
    return c.json({ currency }, 200);
  },
);

// ---------------------------------------------------------------------------
// Dashboard totals
// ---------------------------------------------------------------------------

accountingRouter.get('/dashboard/totals', async (c) => {
  const userId = c.get('userId');
  const result = await computeDashboardTotal(db, userId);
  // `missingPairs` is omitted from the response when empty so the consumer
  // can use `result.missingPairs?.length` as the missing-rate signal.
  const body: {
    displayCurrency: string | null;
    total: string | null;
    missingPairs?: typeof result.missingPairs;
  } = {
    displayCurrency: result.displayCurrency,
    total: result.total,
  };
  if (result.missingPairs.length > 0) {
    body.missingPairs = result.missingPairs;
  }
  return c.json(body, 200);
});

export default accountingRouter;

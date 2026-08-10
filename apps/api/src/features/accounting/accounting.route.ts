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

/**
 * @swagger
 * /api/ledger/{accountId}:
 *   get:
 *     summary: List an account's ledger entries.
 *     description: >
 *       Authed. The ledger is the cash record for one account: deposits,
 *       withdrawals, and the cash effect of each fill, newest first.
 *       `runningBalanceAtFirstRow` is the balance as at the first row on this
 *       page, so a client can reconstruct the running balance down the page
 *       without fetching the whole history.
 *     tags: [Accounting]
 *     parameters:
 *       - in: path
 *         name: accountId
 *         required: true
 *         schema: { type: string, format: uuid }
 *       - in: query
 *         name: page
 *         schema: { type: integer, minimum: 1, default: 1 }
 *       - in: query
 *         name: pageSize
 *         schema: { type: integer, minimum: 1, maximum: 200, default: 50 }
 *     responses:
 *       200:
 *         description: One page of ledger entries.
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 entries: { type: array, items: { type: object } }
 *                 runningBalanceAtFirstRow: { type: string, nullable: true }
 *                 page: { type: integer }
 *                 pageSize: { type: integer }
 *                 hasMore: { type: boolean }
 *       404: { description: No such account for this user. }
 */
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

/**
 * @swagger
 * /api/exchange-rates:
 *   get:
 *     summary: List the user's exchange rates.
 *     description: >
 *       Authed. Tradr does not fetch rates from any market feed — you supply
 *       them. Each rate is a base/quote pair with a value and an effective
 *       date, and conversions use the latest rate on or before the date being
 *       converted.
 *     tags: [Accounting]
 *     responses:
 *       200: { description: The user's exchange rates. }
 */
accountingRouter.get('/exchange-rates', async (c) => {
  const userId = c.get('userId');
  const rows = await listExchangeRates(db, userId);
  return c.json(rows, 200);
});

/**
 * @swagger
 * /api/exchange-rates:
 *   post:
 *     summary: Add or update an exchange rate.
 *     description: >
 *       Authed. A rate is keyed by base, quote, and effective date, so posting
 *       the same three again replaces the value rather than adding a duplicate.
 *       Because a rate change moves historical converted totals, call the
 *       preview endpoint first if you want to show the impact before saving.
 *     tags: [Accounting]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [baseCurrency, quoteCurrency, rate, effectiveDate]
 *             properties:
 *               baseCurrency: { type: string, minLength: 3, maxLength: 3, example: USD }
 *               quoteCurrency: { type: string, minLength: 3, maxLength: 3, example: EUR }
 *               rate: { type: string, description: Positive decimal. }
 *               effectiveDate: { type: string, format: date }
 *     responses:
 *       201: { description: The stored rate. }
 *       400: { description: 'Validation error, or baseCurrency equal to quoteCurrency.' }
 */
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

/**
 * @swagger
 * /api/exchange-rates/{id}:
 *   delete:
 *     summary: Delete an exchange rate.
 *     description: >
 *       Authed. Removing a rate can leave a currency pair unconvertible for
 *       some dates, which surfaces as `missingPairs` on the dashboard totals.
 *     tags: [Accounting]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string, format: uuid }
 *     responses:
 *       204: { description: Deleted. }
 *       404: { description: No such exchange rate for this user. }
 */
accountingRouter.delete('/exchange-rates/:id', validate('param', IdParamSchema), async (c) => {
  const userId = c.get('userId');
  const { id } = c.req.valid('param');
  await deleteExchangeRate(db, userId, id);
  return c.body(null, 204);
});

/**
 * @swagger
 * /api/exchange-rates/preview:
 *   post:
 *     summary: Preview what a rate change would do to the dashboard total.
 *     description: >
 *       Authed. Read-only — it stores nothing. Computes the converted total
 *       before and after a proposed rate upsert or deletion so the change can
 *       be confirmed before it is applied. `exceedsThreshold` marks a move
 *       large enough to be worth an explicit confirmation.
 *     tags: [Accounting]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             oneOf:
 *               - type: object
 *                 required: [intent, rate]
 *                 properties:
 *                   intent: { type: string, enum: [upsert] }
 *                   rate:
 *                     type: object
 *                     required: [baseCurrency, quoteCurrency, rate, effectiveDate]
 *                     properties:
 *                       baseCurrency: { type: string, minLength: 3, maxLength: 3 }
 *                       quoteCurrency: { type: string, minLength: 3, maxLength: 3 }
 *                       rate: { type: string }
 *                       effectiveDate: { type: string, format: date }
 *               - type: object
 *                 required: [intent, rateId]
 *                 properties:
 *                   intent: { type: string, enum: [delete] }
 *                   rateId: { type: string, format: uuid }
 *     responses:
 *       200:
 *         description: The before/after comparison.
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 displayCurrency: { type: string, nullable: true }
 *                 beforeTotal: { type: string, nullable: true }
 *                 afterTotal: { type: string, nullable: true }
 *                 exceedsThreshold: { type: boolean }
 *       400: { description: Validation error. }
 *       404: { description: The rate named for deletion does not exist. }
 */
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

/**
 * @swagger
 * /api/users/me/display-currency:
 *   get:
 *     summary: Get the display currency.
 *     description: >
 *       Authed. The single currency cross-account totals are reported in.
 *       `null` means the user has not chosen one.
 *     tags: [Accounting]
 *     responses:
 *       200:
 *         description: The display currency.
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 currency: { type: string, nullable: true, example: USD }
 */
accountingRouter.get('/users/me/display-currency', async (c) => {
  const userId = c.get('userId');
  const currency = await getUserDisplayCurrency(db, userId);
  return c.json({ currency }, 200);
});

/**
 * @swagger
 * /api/users/me/display-currency:
 *   put:
 *     summary: Set the display currency.
 *     description: >
 *       Authed. Changing it re-expresses cross-account totals; it does not
 *       convert or alter any stored amount. Accounts keep their own currencies.
 *     tags: [Accounting]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [currency]
 *             properties:
 *               currency:
 *                 type: string
 *                 minLength: 3
 *                 maxLength: 3
 *                 description: Three-letter uppercase ISO 4217 code.
 *                 example: USD
 *     responses:
 *       200: { description: The stored display currency. }
 *       400: { description: Not a 3-letter uppercase currency code. }
 */
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

/**
 * @swagger
 * /api/dashboard/totals:
 *   get:
 *     summary: Get the combined balance across all accounts.
 *     description: >
 *       Authed. Sums every account balance into the user's display currency.
 *       `missingPairs` is present only when at least one account could not be
 *       converted for want of a rate — its absence is the "total is complete"
 *       signal, so check for the key rather than an empty array. When it is
 *       present the total covers only the accounts that could be converted.
 *     tags: [Accounting]
 *     responses:
 *       200:
 *         description: The combined total.
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 displayCurrency: { type: string, nullable: true }
 *                 total: { type: string, nullable: true }
 *                 missingPairs:
 *                   type: array
 *                   description: Omitted entirely when every account converted.
 *                   items: { type: object }
 */
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

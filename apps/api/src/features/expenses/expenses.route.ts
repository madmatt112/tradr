import { Hono } from 'hono';
import { z } from 'zod';

import {
  CreateExpenseInputSchema,
  ExpenseListQuerySchema,
  ExpenseListResponseSchema,
  ExpenseSchema,
  FeeRollupResponseSchema,
  TaxSummaryResponseSchema,
  UpdateExpenseInputSchema,
  UpdateTaxJurisdictionInputSchema,
  UpdateTaxLotMethodInputSchema,
} from '@tradr/shared/schemas/expense';

import { db } from '@/db';
import { InvariantViolationError } from '@/lib/errors';
import { validate } from '@/lib/validation';
import { authMiddleware } from '@/middleware/auth.middleware';

import { getUserTaxJurisdiction } from './expenses.query';
import {
  createExpense,
  getFeeRollup,
  getTaxLotMethod,
  getTaxSummary,
  listExpensesForUser,
  removeExpense,
  setTaxJurisdiction,
  setTaxLotMethod,
  updateExpense,
} from './expenses.service';

type AuthEnv = {
  Variables: {
    userId: string;
    isAdmin: boolean;
  };
};

/**
 * @swagger
 * components:
 *   schemas:
 *     Expense:
 *       type: object
 *       description: A cost of trading that is not a per-fill commission.
 *       properties:
 *         id: { type: string, format: uuid }
 *         userId: { type: string, format: uuid }
 *         category:
 *           type: string
 *           enum: [data_subscription, platform_fee, software, education, hardware, other]
 *         description: { type: string }
 *         amount: { type: string, description: 'Positive decimal, at most 4 fractional digits.' }
 *         currency: { type: string, minLength: 3, maxLength: 3 }
 *         occurredAt: { type: string, format: date }
 *         notes: { type: string, nullable: true }
 *         createdAt: { type: string, format: date-time }
 *         updatedAt: { type: string, format: date-time }
 */
const expensesRouter = new Hono<AuthEnv>();

expensesRouter.use(authMiddleware);

// ---------------------------------------------------------------------------
// Local schemas
// ---------------------------------------------------------------------------

const ExpenseIdParamSchema = z.object({ expenseId: z.string().uuid() });

const YearQuerySchema = z.object({
  year: z.coerce.number().int().min(1900).max(9999),
});

const TaxJurisdictionResponseSchema = z
  .object({ taxJurisdiction: z.enum(['US', 'CA', 'other']).nullable() })
  .strict();

const TaxLotMethodResponseSchema = z
  .object({
    taxLotMethod: z.enum(['fifo', 'average']).nullable(),
    effectiveMethod: z.enum(['fifo', 'average']),
    isDefault: z.boolean(),
  })
  .strict();

// ---------------------------------------------------------------------------
// Response-validation helper (matches accounting.route.ts convention)
// ---------------------------------------------------------------------------

function assertResponse<T>(schema: z.ZodType<T>, value: unknown, label: string): T {
  const result = schema.safeParse(value);
  if (!result.success) {
    throw new InvariantViolationError(
      `${label} response failed schema validation: ${JSON.stringify(result.error.issues)}`,
    );
  }
  return result.data;
}

// ---------------------------------------------------------------------------
// /expenses CRUD
// ---------------------------------------------------------------------------

/**
 * @swagger
 * /api/expenses:
 *   get:
 *     summary: List trading expenses.
 *     description: >
 *       Authed. Expenses are the costs of trading that are not per-fill
 *       commissions — data subscriptions, platform fees, software, hardware,
 *       education. Commissions belong to fills and appear in the fee rollup
 *       instead. `filterTotals` covers the whole active filter, not just the
 *       page. Note `page` is zero-based here.
 *     tags: [Expenses]
 *     parameters:
 *       - in: query
 *         name: year
 *         schema: { type: integer, minimum: 1900, maximum: 9999 }
 *         description: Omit for all years.
 *       - in: query
 *         name: page
 *         schema: { type: integer, minimum: 0, default: 0 }
 *       - in: query
 *         name: pageSize
 *         schema: { type: integer, minimum: 1, maximum: 500, default: 100 }
 *     responses:
 *       200:
 *         description: One page of expenses plus the totals for the active filter.
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 expenses: { type: array, items: { $ref: '#/components/schemas/Expense' } }
 *                 page: { type: integer }
 *                 pageSize: { type: integer }
 *                 hasMore: { type: boolean }
 *                 filterTotals: { type: object }
 */
expensesRouter.get('/expenses', validate('query', ExpenseListQuerySchema), async (c) => {
  const userId = c.get('userId');
  const { year, page, pageSize } = c.req.valid('query');
  const result = await listExpensesForUser(userId, { year, page, pageSize });
  const body = assertResponse(ExpenseListResponseSchema, result, 'GET /expenses');
  return c.json(body, 200);
});

/**
 * @swagger
 * /api/expenses:
 *   post:
 *     summary: Record an expense.
 *     tags: [Expenses]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [category, description, amount, currency, occurredAt]
 *             properties:
 *               category: { type: string, enum: [data_subscription, platform_fee, software, education, hardware, other] }
 *               description: { type: string, minLength: 1, maxLength: 200 }
 *               amount:
 *                 type: string
 *                 description: Positive decimal, at most 4 fractional digits. Zero is rejected.
 *               currency: { type: string, minLength: 3, maxLength: 3 }
 *               occurredAt: { type: string, format: date }
 *               notes: { type: string, maxLength: 5000, nullable: true }
 *     responses:
 *       201: { description: The created expense. }
 *       400: { description: Validation error. }
 */
expensesRouter.post('/expenses', validate('json', CreateExpenseInputSchema), async (c) => {
  const userId = c.get('userId');
  const input = c.req.valid('json');
  const row = await createExpense(userId, input);
  const body = assertResponse(
    ExpenseSchema,
    {
      id: row.id,
      userId: row.userId,
      category: row.category,
      description: row.description,
      amount: row.amount,
      currency: row.currency,
      occurredAt: row.occurredAt,
      notes: row.notes,
      createdAt:
        row.createdAt instanceof Date ? row.createdAt.toISOString() : String(row.createdAt),
      updatedAt:
        row.updatedAt instanceof Date ? row.updatedAt.toISOString() : String(row.updatedAt),
    },
    'POST /expenses',
  );
  return c.json(body, 201);
});

/**
 * @swagger
 * /api/expenses/{expenseId}:
 *   patch:
 *     summary: Edit an expense.
 *     description: Authed. A partial update — only the fields you send change.
 *     tags: [Expenses]
 *     parameters:
 *       - in: path
 *         name: expenseId
 *         required: true
 *         schema: { type: string, format: uuid }
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               category: { type: string, enum: [data_subscription, platform_fee, software, education, hardware, other] }
 *               description: { type: string, minLength: 1, maxLength: 200 }
 *               amount: { type: string, description: 'Positive decimal, at most 4 fractional digits.' }
 *               currency: { type: string, minLength: 3, maxLength: 3 }
 *               occurredAt: { type: string, format: date }
 *               notes: { type: string, maxLength: 5000, nullable: true }
 *     responses:
 *       200: { description: The updated expense. }
 *       400: { description: 'Validation error, or an unknown field.' }
 *       404: { description: No such expense for this user. }
 */
expensesRouter.patch(
  '/expenses/:expenseId',
  validate('param', ExpenseIdParamSchema),
  validate('json', UpdateExpenseInputSchema),
  async (c) => {
    const userId = c.get('userId');
    const { expenseId } = c.req.valid('param');
    const patch = c.req.valid('json');
    const row = await updateExpense(userId, expenseId, patch);
    const body = assertResponse(
      ExpenseSchema,
      {
        id: row.id,
        userId: row.userId,
        category: row.category,
        description: row.description,
        amount: row.amount,
        currency: row.currency,
        occurredAt: row.occurredAt,
        notes: row.notes,
        createdAt:
          row.createdAt instanceof Date ? row.createdAt.toISOString() : String(row.createdAt),
        updatedAt:
          row.updatedAt instanceof Date ? row.updatedAt.toISOString() : String(row.updatedAt),
      },
      'PATCH /expenses/:expenseId',
    );
    return c.json(body, 200);
  },
);

/**
 * @swagger
 * /api/expenses/{expenseId}:
 *   delete:
 *     summary: Delete an expense.
 *     tags: [Expenses]
 *     parameters:
 *       - in: path
 *         name: expenseId
 *         required: true
 *         schema: { type: string, format: uuid }
 *     responses:
 *       204: { description: Deleted. }
 *       404: { description: No such expense for this user. }
 */
expensesRouter.delete(
  '/expenses/:expenseId',
  validate('param', ExpenseIdParamSchema),
  async (c) => {
    const userId = c.get('userId');
    const { expenseId } = c.req.valid('param');
    await removeExpense(userId, expenseId);
    return c.body(null, 204);
  },
);

// ---------------------------------------------------------------------------
// /expenses/fee-rollup + /expenses/tax-summary
// ---------------------------------------------------------------------------

/**
 * @swagger
 * /api/expenses/fee-rollup:
 *   get:
 *     summary: Total the commissions paid in a year.
 *     description: >
 *       Authed. Sums the fees recorded on fills for the year, split by account
 *       and by stock versus options, then again per currency. These are per-fill
 *       commissions, not the tracked expenses above, and they are already netted
 *       into realised P&L — do not add the two together.
 *     tags: [Expenses]
 *     parameters:
 *       - in: query
 *         name: year
 *         required: true
 *         schema: { type: integer, minimum: 1900, maximum: 9999 }
 *     responses:
 *       200:
 *         description: Fee totals for the year.
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 year: { type: integer }
 *                 totalsByAccount:
 *                   type: array
 *                   items:
 *                     type: object
 *                     properties:
 *                       accountId: { type: string, format: uuid }
 *                       accountName: { type: string }
 *                       currency: { type: string, minLength: 3, maxLength: 3 }
 *                       stockFees: { type: string }
 *                       optionsFees: { type: string }
 *                       totalFees: { type: string }
 *                 perCurrencyTotals:
 *                   type: array
 *                   items:
 *                     type: object
 *                     properties:
 *                       currency: { type: string, minLength: 3, maxLength: 3 }
 *                       totalFees: { type: string }
 *       400: { description: Missing or invalid year. }
 */
expensesRouter.get('/expenses/fee-rollup', validate('query', YearQuerySchema), async (c) => {
  const userId = c.get('userId');
  const { year } = c.req.valid('query');
  const result = await getFeeRollup(userId, year);
  const body = assertResponse(FeeRollupResponseSchema, result, 'GET /expenses/fee-rollup');
  return c.json(body, 200);
});

/**
 * @swagger
 * /api/expenses/tax-summary:
 *   get:
 *     summary: Summarise a tax year.
 *     description: >
 *       Authed. Realised P&L (split short- and long-term), tracked expenses by
 *       category, and wash-sale or superficial-loss flags for the user's
 *       jurisdiction. Deliberately reports no single net taxable figure: fees
 *       are already inside realised P&L, and combining the numbers correctly
 *       depends on rules Tradr does not model.
 *
 *
 *       Under the FIFO lot method, `realisedPnl` is computed from matched lots
 *       and `lotRealisations` carries one row per (exit fill, lot) pair, each
 *       with its own term for `US`. Under average cost, `lotRealisations` is
 *       empty and the figures are the pooled per-position totals, as today.
 *
 *
 *       This is a reporting aid, not tax advice, and it is not a filing.
 *     tags: [Expenses]
 *     parameters:
 *       - in: query
 *         name: year
 *         required: true
 *         schema: { type: integer, minimum: 1900, maximum: 9999 }
 *     responses:
 *       200:
 *         description: The summary for the year.
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 year: { type: integer }
 *                 jurisdiction: { type: string, enum: [US, CA, other], nullable: true }
 *                 lotMethod: { type: string, enum: [fifo, average] }
 *                 displayCurrency: { type: string, nullable: true }
 *                 realisedPnl: { type: object }
 *                 trackedExpenses: { type: object }
 *                 flags:
 *                   type: object
 *                   description: Wash sales (US) or superficial losses (CA), matched at the lot level (each entry fill is a lot), with the counterparty positions and lots.
 *                 lotRealisations:
 *                   type: array
 *                   description: One row per (exit fill, lot) pair under FIFO; empty under average cost.
 *                   items:
 *                     type: object
 *                     properties:
 *                       exitFillId: { type: string, format: uuid }
 *                       entryFillId: { type: string, format: uuid }
 *                       positionId: { type: string, format: uuid }
 *                       accountId: { type: string, format: uuid }
 *                       symbol: { type: string }
 *                       currency: { type: string }
 *                       lotOpenedAt: { type: string, format: date-time }
 *                       realisedAt: { type: string, format: date-time }
 *                       quantity: { type: string, description: Decimal. }
 *                       proceeds: { type: string, description: Decimal. }
 *                       basis: { type: string, description: Decimal. }
 *                       fees: { type: string, description: Decimal. }
 *                       net: { type: string, description: Decimal. }
 *                       term: { type: string, enum: [short, long], nullable: true }
 *       400: { description: Missing or invalid year. }
 */
expensesRouter.get('/expenses/tax-summary', validate('query', YearQuerySchema), async (c) => {
  const userId = c.get('userId');
  const { year } = c.req.valid('query');
  const result = await getTaxSummary(userId, year);
  const body = assertResponse(TaxSummaryResponseSchema, result, 'GET /expenses/tax-summary');
  return c.json(body, 200);
});

// ---------------------------------------------------------------------------
// /users/me/tax-jurisdiction (exposes the raw column value, including NULL)
// ---------------------------------------------------------------------------

/**
 * @swagger
 * /api/users/me/tax-jurisdiction:
 *   get:
 *     summary: Get the tax jurisdiction.
 *     description: >
 *       Authed. Selects which loss rules the tax summary applies. `null` means
 *       the user has not chosen one.
 *     tags: [Expenses]
 *     responses:
 *       200:
 *         description: The stored jurisdiction.
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 taxJurisdiction: { type: string, enum: [US, CA, other], nullable: true }
 */
expensesRouter.get('/users/me/tax-jurisdiction', async (c) => {
  const userId = c.get('userId');
  const taxJurisdiction = await getUserTaxJurisdiction(db, userId);
  const body = assertResponse(
    TaxJurisdictionResponseSchema,
    { taxJurisdiction },
    'GET /users/me/tax-jurisdiction',
  );
  return c.json(body, 200);
});

/**
 * @swagger
 * /api/users/me/tax-jurisdiction:
 *   patch:
 *     summary: Set the tax jurisdiction.
 *     description: >
 *       Authed. `US` applies wash-sale rules, `CA` superficial-loss rules;
 *       `other` and `null` apply neither. Changing it re-derives the tax
 *       summary and alters nothing that is stored.
 *     tags: [Expenses]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [taxJurisdiction]
 *             properties:
 *               taxJurisdiction: { type: string, enum: [US, CA, other], nullable: true }
 *     responses:
 *       200: { description: The stored jurisdiction. }
 *       400: { description: Validation error. }
 */
expensesRouter.patch(
  '/users/me/tax-jurisdiction',
  validate('json', UpdateTaxJurisdictionInputSchema),
  async (c) => {
    const userId = c.get('userId');
    const { taxJurisdiction } = c.req.valid('json');
    await setTaxJurisdiction(userId, taxJurisdiction);
    const stored = await getUserTaxJurisdiction(db, userId);
    const body = assertResponse(
      TaxJurisdictionResponseSchema,
      { taxJurisdiction: stored },
      'PATCH /users/me/tax-jurisdiction',
    );
    return c.json(body, 200);
  },
);

// ---------------------------------------------------------------------------
// /users/me/tax-lot-method
// ---------------------------------------------------------------------------

/**
 * @swagger
 * /api/users/me/tax-lot-method:
 *   get:
 *     summary: Get the tax lot method.
 *     description: >
 *       Authed. The effective method is the stored value if one is set,
 *       otherwise the jurisdiction default (average cost for CA, FIFO
 *       otherwise).
 *     tags: [Expenses]
 *     responses:
 *       200:
 *         description: The stored and effective lot method.
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 taxLotMethod: { type: string, enum: [fifo, average], nullable: true }
 *                 effectiveMethod: { type: string, enum: [fifo, average] }
 *                 isDefault: { type: boolean }
 */
expensesRouter.get('/users/me/tax-lot-method', async (c) => {
  const userId = c.get('userId');
  const result = await getTaxLotMethod(userId);
  const body = assertResponse(TaxLotMethodResponseSchema, result, 'GET /users/me/tax-lot-method');
  return c.json(body, 200);
});

/**
 * @swagger
 * /api/users/me/tax-lot-method:
 *   patch:
 *     summary: Set the tax lot method.
 *     description: >
 *       Authed. `fifo` or `average` overrides the jurisdiction default;
 *       `null` returns to it. Changes only the stored method — no fill,
 *       lot choice or ledger row changes.
 *     tags: [Expenses]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [taxLotMethod]
 *             properties:
 *               taxLotMethod: { type: string, enum: [fifo, average], nullable: true }
 *     responses:
 *       200: { description: The stored and effective lot method. }
 *       400: { description: Validation error. }
 */
expensesRouter.patch(
  '/users/me/tax-lot-method',
  validate('json', UpdateTaxLotMethodInputSchema),
  async (c) => {
    const userId = c.get('userId');
    const { taxLotMethod } = c.req.valid('json');
    await setTaxLotMethod(userId, taxLotMethod);
    const result = await getTaxLotMethod(userId);
    const body = assertResponse(
      TaxLotMethodResponseSchema,
      result,
      'PATCH /users/me/tax-lot-method',
    );
    return c.json(body, 200);
  },
);

export default expensesRouter;

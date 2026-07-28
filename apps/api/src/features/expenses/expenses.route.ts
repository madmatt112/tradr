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
} from '@tradr/shared/schemas/expense';

import { db } from '@/db';
import { InvariantViolationError } from '@/lib/errors';
import { validate } from '@/lib/validation';
import { authMiddleware } from '@/middleware/auth.middleware';

import { getUserTaxJurisdiction } from './expenses.query';
import {
  createExpense,
  getFeeRollup,
  getTaxSummary,
  listExpensesForUser,
  removeExpense,
  setTaxJurisdiction,
  updateExpense,
} from './expenses.service';

type AuthEnv = {
  Variables: {
    userId: string;
    isAdmin: boolean;
  };
};

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

expensesRouter.get('/expenses', validate('query', ExpenseListQuerySchema), async (c) => {
  const userId = c.get('userId');
  const { year, page, pageSize } = c.req.valid('query');
  const result = await listExpensesForUser(userId, { year, page, pageSize });
  const body = assertResponse(ExpenseListResponseSchema, result, 'GET /expenses');
  return c.json(body, 200);
});

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

expensesRouter.get('/expenses/fee-rollup', validate('query', YearQuerySchema), async (c) => {
  const userId = c.get('userId');
  const { year } = c.req.valid('query');
  const result = await getFeeRollup(userId, year);
  const body = assertResponse(FeeRollupResponseSchema, result, 'GET /expenses/fee-rollup');
  return c.json(body, 200);
});

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

export default expensesRouter;

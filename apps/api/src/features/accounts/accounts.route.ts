import { Hono } from 'hono';
import { z } from 'zod';

import { CreateAccountSchema, UpdateAccountSchema } from '@tradr/shared/schemas/account';
import { SetWritableAccountSchema } from '@tradr/shared/schemas/tier';

import { db } from '@/db';
import { captureServerEvent } from '@/lib/posthog';
import { validate } from '@/lib/validation';
import { authMiddleware } from '@/middleware/auth.middleware';

import { seedDemoAccount } from './accounts.demo';
import { countPositionsByAccount } from './accounts.query';
import {
  listAccounts,
  getAccount,
  createAccount,
  editAccount,
  removeAccount,
  setWritableAccount,
} from './accounts.service';

type AuthEnv = {
  Variables: {
    userId: string;
    isAdmin: boolean;
  };
};

const accounts = new Hono<AuthEnv>();

accounts.use(authMiddleware);

const ParamSchema = z.object({ id: z.string().uuid() });

accounts.get('/', async (c) => {
  const userId = c.get('userId');
  const rows = await listAccounts(db, userId);
  return c.json(rows, 200);
});

accounts.get('/:id/position-count', validate('param', ParamSchema), async (c) => {
  const userId = c.get('userId');
  const { id } = c.req.valid('param');
  const account = await getAccount(db, id, userId);
  const [{ count }] = await countPositionsByAccount(db, account.id);
  return c.json({ count }, 200);
});

accounts.get('/:id', validate('param', ParamSchema), async (c) => {
  const userId = c.get('userId');
  const { id } = c.req.valid('param');
  const account = await getAccount(db, id, userId);
  return c.json(account, 200);
});

/**
 * @swagger
 * /api/accounts:
 *   post:
 *     summary: Create an account.
 *     description: >
 *       Authed. Creates a trading account for the current user. When feature gating is
 *       enabled and the user is a non-admin Free user at the account cap, the create is
 *       refused with `403 TIER_LIMIT_ACCOUNTS` — admins and gating-off deployments pass
 *       through unchanged.
 *     tags: [Accounts]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [name, currency]
 *             properties:
 *               name: { type: string, minLength: 1 }
 *               currency: { type: string, minLength: 3, maxLength: 3 }
 *               brokerageId: { type: string, format: uuid, nullable: true }
 *               startingBalance: { type: string }
 *               timezone:
 *                 type: string
 *                 description: >
 *                   IANA zone name (canonical spelling, e.g. `America/New_York`,
 *                   `Etc/UTC`). Defines the account's trading day. Omitted
 *                   defaults to `America/New_York`; an unknown zone is a 400.
 *                 example: America/New_York
 *               defaultRiskPercent:
 *                 type: string
 *                 description: >
 *                   Share of the account balance risked per trade, as a decimal
 *                   string above 0 and up to 100 with at most 2 decimal places.
 *                   Seeds the position-size calculator. Omitted means no rule is
 *                   set, which leaves the calculator's field empty as before.
 *                   Unlike `PUT /api/accounts/{id}`, an explicit `null` is a 400
 *                   here — there is no rule to clear on create.
 *                 example: '1.00'
 *     responses:
 *       201: { description: The created account. }
 *       400: { description: Validation error. }
 *       403: { description: TIER_LIMIT_ACCOUNTS (account cap reached on the current plan) or FORBIDDEN (cross-user brokerage). }
 *       409: { description: Duplicate account name. }
 */
accounts.post('/', validate('json', CreateAccountSchema), async (c) => {
  const userId = c.get('userId');
  const isAdmin = c.get('isAdmin');
  const data = c.req.valid('json');
  const account = await createAccount(db, userId, data, { isAdmin });
  captureServerEvent('account_created', { distinctId: userId });
  return c.json(account, 201);
});

/**
 * @swagger
 * /api/accounts/demo:
 *   post:
 *     summary: Add sample data.
 *     description: >
 *       Authed. Creates one flagged sample account for the current user, seeded with a
 *       fixed set of trades — closed, open and planned — driven through the normal
 *       position lifecycle so realized P&L and its ledger entries are derived exactly as
 *       they are for real trades. The fixture is identical on every run, so support,
 *       the documentation screenshots and the end-to-end tests all describe the same
 *       figures.
 *
 *
 *       Refused with `409` when the user already has an account. Sample figures are kept
 *       out of real ones by keeping sample and real data mutually exclusive, so there is
 *       no supported state in which both exist. Seeding is all-or-nothing: a failure
 *       leaves no account behind, and a retry is safe.
 *
 *
 *       Available identically to self-hosted and hosted deployments — it needs no
 *       optional integration configured.
 *     tags: [Accounts]
 *     responses:
 *       201: { description: The created sample account. }
 *       409: { description: The user already has an account. }
 */
accounts.post('/demo', async (c) => {
  const userId = c.get('userId');
  const account = await seedDemoAccount(db, userId);
  return c.json(account, 201);
});

/**
 * @swagger
 * /api/accounts/writable:
 *   put:
 *     summary: Set the writable-account designation.
 *     description: >
 *       Authed, always-on. Stores which of the user's accounts stays writable for new
 *       trading data while over the Free-tier account cap. A plain stored preference —
 *       independent of gating/tier/over-cap state; it only takes effect when
 *       the writable-account rule is enforced. The account must belong to the
 *       current user (404 otherwise).
 *     tags: [Accounts]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [accountId]
 *             properties:
 *               accountId: { type: string, format: uuid }
 *     responses:
 *       200: { description: '{ writableAccountId } — the stored designation.' }
 *       400: { description: Validation error. }
 *       404: { description: Account not found (or not owned by the user). }
 */
// Mount-order pin (D18): Hono matches same-method routes in registration
// order, so this static route MUST be registered BEFORE `PUT /:id` below —
// otherwise the param route captures `/writable`, fails its uuid param
// schema, and 400s from the wrong handler.
accounts.put('/writable', validate('json', SetWritableAccountSchema), async (c) => {
  const userId = c.get('userId');
  const { accountId } = c.req.valid('json');
  const result = await setWritableAccount(db, userId, accountId);
  return c.json(result, 200);
});

/**
 * @swagger
 * /api/accounts/{id}:
 *   put:
 *     summary: Update an account.
 *     description: >
 *       Authed. All fields optional. `startingBalance` is deliberately absent —
 *       it is creation-only. `timezone` IS editable: it changes only subsequent
 *       trading-day evaluations and rewrites no history, and `defaultRiskPercent`
 *       is editable for the same reason.
 *     tags: [Accounts]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string, format: uuid }
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               name: { type: string, minLength: 1 }
 *               currency: { type: string, minLength: 3, maxLength: 3 }
 *               brokerageId: { type: string, format: uuid, nullable: true }
 *               timezone:
 *                 type: string
 *                 description: IANA zone name (canonical spelling). Unknown zone is a 400.
 *                 example: America/New_York
 *               defaultRiskPercent:
 *                 type: string
 *                 nullable: true
 *                 description: >
 *                   Share of the account balance risked per trade (decimal string
 *                   above 0, up to 100, at most 2 decimal places). Omitting the
 *                   key leaves the stored value untouched; sending an explicit
 *                   `null` clears the rule back to unset.
 *                 example: '1.00'
 *     responses:
 *       200: { description: The updated account. }
 *       400: { description: Validation error (includes an unknown IANA timezone). }
 *       403: { description: FORBIDDEN (cross-user brokerage). }
 *       404: { description: Account not found. }
 *       409: { description: Duplicate account name, or currency change while positions exist. }
 */
accounts.put(
  '/:id',
  validate('param', ParamSchema),
  validate('json', UpdateAccountSchema),
  async (c) => {
    const userId = c.get('userId');
    const { id } = c.req.valid('param');
    const data = c.req.valid('json');
    const account = await editAccount(db, id, userId, data);
    return c.json(account, 200);
  },
);

accounts.delete('/:id', validate('param', ParamSchema), async (c) => {
  const userId = c.get('userId');
  const { id } = c.req.valid('param');
  await removeAccount(db, id, userId);
  captureServerEvent('account_deleted', { distinctId: userId });
  return c.body(null, 204);
});

export default accounts;

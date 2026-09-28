import { Hono } from 'hono';
import { z } from 'zod';

import { TradingRuleInputSchema } from '@tradr/shared/schemas/trading-rule';

import { db } from '@/db';
import { validate } from '@/lib/validation';
import { authMiddleware } from '@/middleware/auth.middleware';

import {
  createTradingRule,
  editTradingRule,
  listTradingRules,
  removeTradingRule,
} from './trading-rules.service';

type AuthEnv = {
  Variables: {
    userId: string;
    isAdmin: boolean;
  };
};

const tradingRulesRouter = new Hono<AuthEnv>();

tradingRulesRouter.use(authMiddleware);

const ParamSchema = z.object({ id: z.string().uuid() });

/**
 * @swagger
 * /api/trading-rules:
 *   get:
 *     summary: List the user's trading rules.
 *     description: >
 *       Authed. Returns every rule the user owns, oldest first, each with a
 *       generated one-line description of its type and parameters. Rules are
 *       scored on read and never block a trade.
 *     tags: [Trading rules]
 *     responses:
 *       200: { description: The user's trading rules, oldest first. }
 *       401: { description: No valid session. }
 */
tradingRulesRouter.get('/', async (c) => {
  const userId = c.get('userId');
  const rules = await listTradingRules(db, userId);
  return c.json(rules, 200);
});

/**
 * @swagger
 * /api/trading-rules:
 *   post:
 *     summary: Create a trading rule.
 *     description: >
 *       Authed. The body carries the rule definition (type and parameters), a
 *       weight, an enabled flag and optional account and tag scopes. A scoped
 *       amount rule's currency must equal the account's currency. Subject to a
 *       per-user cap; an exact duplicate (same type, scope and parameters) is
 *       refused.
 *     tags: [Trading rules]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [definition, weight, enabled, accountId, tagId]
 *             properties:
 *               definition:
 *                 type: object
 *                 required: [type, params]
 *                 properties:
 *                   type: { type: string }
 *                   params: { type: object }
 *               weight:
 *                 type: string
 *                 enum: [critical, important, nice_to_have]
 *               enabled: { type: boolean }
 *               accountId: { type: string, format: uuid, nullable: true }
 *               tagId: { type: string, format: uuid, nullable: true }
 *     responses:
 *       201: { description: The created rule. }
 *       400: { description: Validation error, including an unowned scope or a currency mismatch. }
 *       401: { description: No valid session. }
 *       409:
 *         description: >
 *           `TRADING_RULE_LIMIT_REACHED` — the per-user rule cap has been
 *           reached; or `TRADING_RULE_DUPLICATE` — a rule with the same type,
 *           scope and parameters already exists.
 */
tradingRulesRouter.post('/', validate('json', TradingRuleInputSchema), async (c) => {
  const userId = c.get('userId');
  const input = c.req.valid('json');
  const rule = await createTradingRule(db, userId, input);
  return c.json(rule, 201);
});

/**
 * @swagger
 * /api/trading-rules/{id}:
 *   put:
 *     summary: Replace a trading rule.
 *     description: >
 *       Authed. A full replacement — the whole rule, definition included, is
 *       sent. The same scope, currency and duplicate rules apply as on create.
 *     tags: [Trading rules]
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
 *             required: [definition, weight, enabled, accountId, tagId]
 *             properties:
 *               definition:
 *                 type: object
 *                 required: [type, params]
 *                 properties:
 *                   type: { type: string }
 *                   params: { type: object }
 *               weight:
 *                 type: string
 *                 enum: [critical, important, nice_to_have]
 *               enabled: { type: boolean }
 *               accountId: { type: string, format: uuid, nullable: true }
 *               tagId: { type: string, format: uuid, nullable: true }
 *     responses:
 *       200: { description: The updated rule. }
 *       400: { description: Validation error, including an unowned scope or a currency mismatch. }
 *       401: { description: No valid session. }
 *       404: { description: No such rule for this user. }
 *       409:
 *         description: >
 *           `TRADING_RULE_DUPLICATE` — a rule with the same type, scope and
 *           parameters already exists.
 */
tradingRulesRouter.put(
  '/:id',
  validate('param', ParamSchema),
  validate('json', TradingRuleInputSchema),
  async (c) => {
    const userId = c.get('userId');
    const { id } = c.req.valid('param');
    const input = c.req.valid('json');
    const rule = await editTradingRule(db, id, userId, input);
    return c.json(rule, 200);
  },
);

/**
 * @swagger
 * /api/trading-rules/{id}:
 *   delete:
 *     summary: Delete a trading rule.
 *     description: Authed. Removes an owned rule; it is never refused for being in use.
 *     tags: [Trading rules]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string, format: uuid }
 *     responses:
 *       204: { description: Deleted. }
 *       401: { description: No valid session. }
 *       404: { description: No such rule for this user. }
 */
tradingRulesRouter.delete('/:id', validate('param', ParamSchema), async (c) => {
  const userId = c.get('userId');
  const { id } = c.req.valid('param');
  await removeTradingRule(db, id, userId);
  return c.body(null, 204);
});

export default tradingRulesRouter;

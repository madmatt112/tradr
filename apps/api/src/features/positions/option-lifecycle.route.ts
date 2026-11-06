// Option lifecycle routes (design C8), mounted at /api/positions beside the
// other sub-resource routers. Handlers stay thin: validate, call the core,
// shape the response. Services scope every lookup by userId, so a foreign id
// reads 404.

import Decimal from 'decimal.js';
import { Hono } from 'hono';
import { z } from 'zod';

import {
  CaptureEntryGreeksInputSchema,
  RollLegInputSchema,
  SettleLegInputSchema,
} from '@tradr/shared/schemas/option-lifecycle';

import { db } from '@/db';
import { validate } from '@/lib/validation';
import { authMiddleware } from '@/middleware/auth.middleware';
import { createRateLimiter } from '@/middleware/rate-limit.middleware';

import { captureEntryGreeks } from './entry-greeks.service';
import { rollLeg } from './option-roll.service';
import { getSettlementContext, settleLeg, unsettle } from './option-settlement.service';

type AuthEnv = {
  Variables: {
    userId: string;
    isAdmin: boolean;
  };
};

const optionLifecycleRouter = new Hono<AuthEnv>();

optionLifecycleRouter.use(authMiddleware);

const PositionParamSchema = z.object({ id: z.string().uuid() });
const SettlementParamSchema = z.object({
  id: z.string().uuid(),
  settlementId: z.string().uuid(),
});

// Design C8: the context route takes its own limiter, 30 per 60 s per user —
// the symbols.route.ts quote-limiter precedent, keyed on userId so NAT'd users
// never collide and one user across IPs cannot double it.
const settlementContextRateLimit = createRateLimiter({
  name: 'settlement-context',
  max: 30,
  windowMs: 60_000,
  keyGenerator: (c) => c.get('userId'),
  fallbackMax: 30,
});

const decimalOrNull = (value: string | null): number | null =>
  value === null ? null : new Decimal(value).toNumber();

/**
 * @swagger
 * /api/positions/{id}/settlement-context:
 *   get:
 *     summary: Legal outcomes, expiry instant, premium, held rows and a pre-selection suggestion.
 *     description: >
 *       Authed. `legalOutcomes` is `['worthless','assigned']` for a short leg
 *       or `['worthless','exercised']` for a long leg. `suggestedOutcome` is
 *       non-null only once the New York date equals the leg's expiration and
 *       now is past the expiry instant, with the quote provider configured;
 *       a quote failure gives null. Per-user rate limited to 30 reads per 60 s.
 *     tags: [Positions]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string, format: uuid }
 *     responses:
 *       200:
 *         description: The settlement context.
 *       401: { description: No authenticated session (UNAUTHORIZED). }
 *       404: { description: No such position for this user (NOT_FOUND). }
 *       429: { description: Per-user limit reached, 30 / 60 s (RATE_LIMITED). }
 */
optionLifecycleRouter.get(
  '/:id/settlement-context',
  validate('param', PositionParamSchema),
  settlementContextRateLimit,
  async (c) => {
    const userId = c.get('userId');
    const { id } = c.req.valid('param');
    const context = await getSettlementContext(db, userId, id);
    return c.json(
      {
        legalOutcomes: context.legalOutcomes,
        expiryInstant: context.expiryInstant,
        premium: new Decimal(context.premium).toNumber(),
        heldRows: context.heldRows.map((row) => ({
          positionId: row.positionId,
          symbol: row.symbol,
          openUnits: new Decimal(row.openUnits).toNumber(),
          openedAt: row.openedAt,
        })),
        suggestedOutcome: context.suggestedOutcome,
      },
      200,
    );
  },
);

/**
 * @swagger
 * /api/positions/{id}/settle:
 *   post:
 *     summary: Settle an open option leg worthless, assigned or exercised (design C3).
 *     description: >
 *       Authed. `outcome` must be legal for the leg's side (short:
 *       worthless/assigned, long: worthless/exercised), else 400 with no
 *       write. A stock-side outcome opens or exits stock rows per design
 *       C3's table.
 *     tags: [Positions]
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
 *             required: [outcome]
 *             properties:
 *               outcome: { type: string, enum: [worthless, assigned, exercised] }
 *               settledAt: { type: string, format: date-time }
 *               quantity: { type: string, description: Decimal. }
 *               fees: { type: string, description: Decimal. }
 *               stockRowOrder:
 *                 type: array
 *                 items: { type: string, format: uuid }
 *     responses:
 *       200:
 *         description: The settlement result.
 *       400: { description: Illegal outcome for the side, or an invalid date/quantity (VALIDATION_ERROR). }
 *       401: { description: No authenticated session (UNAUTHORIZED). }
 *       404: { description: No such position for this user (NOT_FOUND). }
 *       409: { description: The leg is not open, has no open units, or the holdings changed. }
 */
optionLifecycleRouter.post(
  '/:id/settle',
  validate('param', PositionParamSchema),
  validate('json', SettleLegInputSchema),
  async (c) => {
    const userId = c.get('userId');
    const { id } = c.req.valid('param');
    const input = c.req.valid('json');
    const result = await settleLeg(db, userId, id, input);
    return c.json(
      {
        settlementId: result.settlementId,
        legId: result.legId,
        outcome: result.outcome,
        premium: new Decimal(result.premium).toNumber(),
        quantity: new Decimal(result.quantity).toNumber(),
        settledAt: result.settledAt,
        openedPositionIds: result.openedPositionIds,
        exitedPositionIds: result.exitedPositionIds,
      },
      200,
    );
  },
);

/**
 * @swagger
 * /api/positions/{id}/settlements/{settlementId}/unsettle:
 *   post:
 *     summary: Undo a settlement exactly (design C5).
 *     description: >
 *       Authed. Refused with 409 and a reason when any touched row or fill
 *       has moved since the settlement, when a written fill carries a
 *       transfer link, or when an opened row has joined a group.
 *     tags: [Positions]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string, format: uuid }
 *       - in: path
 *         name: settlementId
 *         required: true
 *         schema: { type: string, format: uuid }
 *     responses:
 *       204: { description: Undone. }
 *       401: { description: No authenticated session (UNAUTHORIZED). }
 *       404: { description: No such settlement for this user and leg (NOT_FOUND). }
 *       409: { description: A touched row or fill moved since the settlement; unsettle refused. }
 */
optionLifecycleRouter.post(
  '/:id/settlements/:settlementId/unsettle',
  validate('param', SettlementParamSchema),
  async (c) => {
    const userId = c.get('userId');
    const { id, settlementId } = c.req.valid('param');
    await unsettle(db, userId, id, settlementId);
    return c.body(null, 204);
  },
);

/**
 * @swagger
 * /api/positions/{id}/roll:
 *   post:
 *     summary: Roll an open leg into a new contract (design C6).
 *     description: >
 *       Authed. The new contract must share the underlying and differ from
 *       the current one. A grouped leg rolls within the group, re-validated
 *       as a set; an admin-gated batch-create check applies to the new leg.
 *     tags: [Positions]
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
 *             required: [newSymbol, quantity, closePrice, openPrice, rolledAt]
 *             properties:
 *               newSymbol: { type: string }
 *               quantity: { type: string, description: Decimal. }
 *               closePrice: { type: string, description: Decimal. }
 *               openPrice: { type: string, description: Decimal. }
 *               closeFees: { type: string, description: Decimal. }
 *               openFees: { type: string, description: Decimal. }
 *               rolledAt: { type: string, format: date-time }
 *     responses:
 *       200:
 *         description: The roll result.
 *       400: { description: Invalid contract, quantity or date (VALIDATION_ERROR). }
 *       401: { description: No authenticated session (UNAUTHORIZED). }
 *       404: { description: No such position for this user (NOT_FOUND). }
 *       409: { description: The group changed; try again. }
 */
optionLifecycleRouter.post(
  '/:id/roll',
  validate('param', PositionParamSchema),
  validate('json', RollLegInputSchema),
  async (c) => {
    const userId = c.get('userId');
    const { id } = c.req.valid('param');
    const input = c.req.valid('json');
    const result = await rollLeg(db, userId, id, input, { isAdmin: c.get('isAdmin') });
    return c.json(result, 200);
  },
);

/**
 * @swagger
 * /api/positions/{id}/entry-greeks:
 *   put:
 *     summary: Capture a leg's entry Greeks, by Black-Scholes or the live chain (design C7).
 *     description: >
 *       Authed. A second capture replaces the first. Black-Scholes prices
 *       with `T` from the leg's expiry instant less its first entry fill's
 *       `filledAt`, over 365 days; a non-positive `T` or an out-of-bounds
 *       input is 400. The chain source carries no further input and fetches
 *       the live contract.
 *     tags: [Positions]
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
 *             oneOf:
 *               - type: object
 *                 required: [source, volatility, spot, rate]
 *                 properties:
 *                   source: { type: string, enum: [black_scholes] }
 *                   volatility: { type: number }
 *                   spot: { type: number }
 *                   rate: { type: number }
 *                   dividendYield: { type: number }
 *               - type: object
 *                 required: [source]
 *                 properties:
 *                   source: { type: string, enum: [chain] }
 *     responses:
 *       200:
 *         description: The captured entry Greeks.
 *       400: { description: Invalid Black-Scholes input or non-positive T (VALIDATION_ERROR). }
 *       401: { description: No authenticated session (UNAUTHORIZED). }
 *       404: { description: No such position for this user (NOT_FOUND). }
 *       409: { description: The chain contract is missing, expired or missing a required Greek. }
 */
optionLifecycleRouter.put(
  '/:id/entry-greeks',
  validate('param', PositionParamSchema),
  validate('json', CaptureEntryGreeksInputSchema),
  async (c) => {
    const userId = c.get('userId');
    const { id } = c.req.valid('param');
    const input = c.req.valid('json');
    const row = await captureEntryGreeks(db, userId, id, input);
    return c.json(
      {
        delta: new Decimal(row.delta).toNumber(),
        gamma: new Decimal(row.gamma).toNumber(),
        thetaPerDay: new Decimal(row.thetaPerDay).toNumber(),
        vegaPerPct: new Decimal(row.vegaPerPct).toNumber(),
        rhoPerPct: decimalOrNull(row.rhoPerPct),
        source: row.source,
        volatility: decimalOrNull(row.volatility),
        spot: decimalOrNull(row.spot),
        rate: decimalOrNull(row.rate),
        dividendYield: decimalOrNull(row.dividendYield),
        capturedAt: row.capturedAt.toISOString(),
      },
      200,
    );
  },
);

export default optionLifecycleRouter;

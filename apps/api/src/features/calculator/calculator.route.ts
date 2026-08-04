import { Hono } from 'hono';

import { BuyingPowerBasisBodySchema, CalculatorInputSchema, calculateTrade } from '@tradr/shared';

import { db } from '@/db';
import { ValidationError } from '@/lib/errors';
import { validate } from '@/lib/validation';
import { authMiddleware } from '@/middleware/auth.middleware';

import { getBuyingPowerBasis, setBuyingPowerBasis } from './calculator.query';

type AuthEnv = {
  Variables: {
    userId: string;
    isAdmin: boolean;
  };
};

const calculatorRouter = new Hono<AuthEnv>();

calculatorRouter.use(authMiddleware);

// No service file — calculateTrade is a pure shared function with no DB access
/**
 * @swagger
 * /api/calculator:
 *   post:
 *     summary: Size a trade from a risk basis, with fee and buying-power modelling.
 *     description: >
 *       Authed and stateless — the whole calculation is a pure function of the
 *       request body (no DB read, no account id). Supply the trade shape
 *       (`entryPrice`, `stopLoss`, `direction`, `mode`) plus **exactly one** risk
 *       basis: a direct `dollarRisk`, OR a `balance` + `riskPercent` (the dollar
 *       risk is then derived as `balance × riskPercent ÷ 100` at full precision).
 *       Supplying both bases, or neither, is a 400. The position size is also
 *       capped to what the account can fund at entry —
 *       `floor(capBasis ÷ (entry × multiplier))` — where `capBasis` is
 *       `buyingPower` when supplied (**either** risk basis), else `balance` on
 *       the percent basis, else no cap at all on the dollar basis. The risk
 *       budget is always a percent of `balance`; only the cap consults
 *       `buyingPower`. `derivedDollarRisk` remains percent-only, but
 *       `sizingStatus` and `buyingPowerLimited` can now appear on a dollar-basis
 *       result whenever `buyingPower` is supplied. Non-sizing outcomes
 *       (non-positive balance, derived risk over the ceiling, insufficient risk,
 *       cap basis funds zero units) are valid **200**s with `positionSize: 0`
 *       and a `sizingStatus` discriminator — not 400s.
 *     tags: [Calculator]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [entryPrice, stopLoss, direction, mode]
 *             description: Provide exactly one risk basis — `dollarRisk`, or `balance` + `riskPercent`.
 *             properties:
 *               entryPrice: { type: string, description: 'Positive decimal up to 9,999,999.99.' }
 *               stopLoss: { type: string, description: 'Positive decimal up to 9,999,999.99.' }
 *               direction: { type: string, enum: [long, short] }
 *               mode: { type: string, enum: [stock, options] }
 *               dollarRisk:
 *                 type: string
 *                 description: >
 *                   Dollar-basis risk (positive decimal up to 99,999,999.99).
 *                   Required in dollar mode; omit (or send empty ⇒ treated as
 *                   absent) in percent mode.
 *               balance:
 *                 type: string
 *                 description: >
 *                   Percent-basis balance the RISK BUDGET is derived from, and the
 *                   default basis for the buying-power cap. Sign-agnostic finite
 *                   decimal within the account-balance domain (a losing account's
 *                   balance can be ≤ 0). Percent basis requires both `balance` and
 *                   `riskPercent`.
 *               buyingPower:
 *                 type: string
 *                 description: >
 *                   Optional figure the BUYING-POWER CAP is computed against, valid
 *                   in EITHER risk basis. Absent ⇒ the percent basis caps against
 *                   `balance` (the original behaviour) and the dollar basis is
 *                   uncapped (likewise). Supply an account's `cash` here to stop
 *                   the calculator sizing a position the account cannot fund:
 *                   total equity overstates fundable capital by whatever is
 *                   already deployed, and a direct dollar risk overshoots just as
 *                   readily as a percentage one. Sign-agnostic — a fully-deployed
 *                   or margined account can present ≤ 0 cash, which yields
 *                   `sizingStatus: buying-power-zero`. Never affects the risk
 *                   budget.
 *               riskPercent:
 *                 type: string
 *                 description: Percent of `balance` to risk (0 < p ≤ 100). Always a percent of balance, never of `buyingPower`.
 *               targetPrice: { type: string, description: Optional positive decimal for R:R. }
 *               feeSchedule: { type: object, description: Optional brokerage fee schedule (mutually exclusive with manualFees). }
 *               manualFees: { type: string, description: Optional flat fee estimate (mutually exclusive with feeSchedule). }
 *     responses:
 *       200:
 *         description: >
 *           A CalculatorOutput. Always carries `positionSize`, `perUnitRisk`,
 *           `actualDollarRisk`, `totalPositionValue`; `perUnitReward` /
 *           `riskRewardRatio` when a target is set, and the fee fields when fees
 *           are supplied. Percent basis additionally echoes `derivedDollarRisk`
 *           (2dp, when balance > 0). `sizingStatus`
 *           (`nothing-to-size-against` | `exceeds-maximum` | `buying-power-zero`)
 *           on the zero-position outcomes and `buyingPowerLimited: true` when the
 *           cap set the size appear on EITHER basis — the latter two require only
 *           that a cap basis existed, which on the dollar basis means
 *           `buyingPower` was supplied.
 *       400: { description: 'Validation error — both/neither risk basis, riskPercent ∉ (0,100], bad balance/price format, or a structural price error.' }
 *       401: { description: Authentication required. }
 */
calculatorRouter.post('/', validate('json', CalculatorInputSchema), async (c) => {
  const input = c.req.valid('json');
  try {
    const result = calculateTrade(input);
    return c.json(result, 200);
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Calculation error';
    throw new ValidationError(message);
  }
});

// ---------------------------------------------------------------------------
// User buying-power basis
//
// A stored preference, unlike POST /api/calculator above, which stays a pure
// function of its request body. The preference decides which account figure a
// CLIENT sends as `buyingPower`; the calculation itself never reads it. Keeping
// the sizing endpoint stateless means an API consumer picks its own basis
// explicitly rather than inheriting a setting it cannot see.
//
// It gets its OWN router because the per-preference convention is an absolute
// `/api/users/me/<preference>` path — as with `/users/me/display-currency`
// (accounting) and `/users/me/tax-jurisdiction` (expenses) — and those live on
// routers mounted bare at `/api`. `calculatorRouter` is mounted at
// `/api/calculator`, so a `/users/me/...` path declared on it would resolve to
// `/api/calculator/users/me/...`. Mounted at `/api` in app.ts.
// ---------------------------------------------------------------------------

export const calculatorPreferencesRouter = new Hono<AuthEnv>();

calculatorPreferencesRouter.use(authMiddleware);

/**
 * @swagger
 * /api/users/me/buying-power-basis:
 *   get:
 *     summary: Get the calculator's buying-power basis.
 *     description: >
 *       Authed. Which account figure the position-sizing calculator caps position
 *       size against — `cash` (balance less the cost basis of open positions) or
 *       `balance` (total equity). Never null; the column defaults to `cash`.
 *     tags: [Calculator]
 *     responses:
 *       200:
 *         description: The stored basis.
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 basis: { type: string, enum: [cash, balance], example: cash }
 *       401: { description: Authentication required. }
 */
calculatorPreferencesRouter.get('/users/me/buying-power-basis', async (c) => {
  const userId = c.get('userId');
  const basis = await getBuyingPowerBasis(db, userId);
  return c.json({ basis }, 200);
});

/**
 * @swagger
 * /api/users/me/buying-power-basis:
 *   put:
 *     summary: Set the calculator's buying-power basis.
 *     description: >
 *       Authed. `cash` caps position size at what the account can actually deploy;
 *       `balance` caps at total equity, which overstates fundable capital by
 *       whatever is already tied up in open positions. Affects only the cap — the
 *       risk budget stays `riskPercent × balance` either way. Changes nothing
 *       stored beyond the preference itself.
 *     tags: [Calculator]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [basis]
 *             properties:
 *               basis: { type: string, enum: [cash, balance] }
 *     responses:
 *       200: { description: The stored basis. }
 *       400: { description: Not one of cash | balance. }
 *       401: { description: Authentication required. }
 */
calculatorPreferencesRouter.put(
  '/users/me/buying-power-basis',
  validate('json', BuyingPowerBasisBodySchema),
  async (c) => {
    const userId = c.get('userId');
    const { basis } = c.req.valid('json');
    await setBuyingPowerBasis(db, userId, basis);
    return c.json({ basis }, 200);
  },
);

export default calculatorRouter;

import { Hono } from 'hono';

import { CalculatorInputSchema, calculateTrade } from '@tradr/shared';

import { ValidationError } from '@/lib/errors';
import { validate } from '@/lib/validation';
import { authMiddleware } from '@/middleware/auth.middleware';

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
 *       Supplying both bases, or neither, is a 400. In the percent basis the
 *       position size is also capped to what the balance can fund at entry
 *       (`floor(balance ÷ (entry × multiplier))`); the three percent-only response
 *       fields (`derivedDollarRisk`, `sizingStatus`, `buyingPowerLimited`) are
 *       absent from dollar-basis results. Non-sizing outcomes (non-positive
 *       balance, derived risk over the ceiling, insufficient risk, balance funds
 *       zero units) are valid **200**s with `positionSize: 0` and a `sizingStatus`
 *       discriminator — not 400s.
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
 *                   Percent-basis balance to size against and cap against.
 *                   Sign-agnostic finite decimal within the account-balance domain
 *                   (a losing account's balance can be ≤ 0). Percent basis requires
 *                   both `balance` and `riskPercent`.
 *               riskPercent:
 *                 type: string
 *                 description: Percent of balance to risk (0 < p ≤ 100).
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
 *           (2dp, when balance > 0), `sizingStatus`
 *           (`nothing-to-size-against` | `exceeds-maximum` | `buying-power-zero`)
 *           on the zero-position outcomes, and `buyingPowerLimited: true` when the
 *           buying-power cap set the size.
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

export default calculatorRouter;

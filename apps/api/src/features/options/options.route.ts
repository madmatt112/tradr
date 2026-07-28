import { Hono } from 'hono';

import {
  BlackScholesInputSchema,
  OccEncodeInputSchema,
  OccParseInputSchema,
  blackScholes,
  encodeOccSymbol,
  parseOccSymbol,
} from '@tradr/shared';

import { ValidationError } from '@/lib/errors';
import { validate } from '@/lib/validation';
import { authMiddleware } from '@/middleware/auth.middleware';

type AuthEnv = { Variables: { userId: string; isAdmin: boolean } };

const optionsRouter = new Hono<AuthEnv>();

optionsRouter.use(authMiddleware);

/**
 * @swagger-example occ-parse-form1 {"input":"AAPL  250620C00150000"} → {"underlying":"AAPL","expiration":"2025-06-20","type":"call","strike":"150.000"}
 * @swagger-example occ-parse-form2 {"input":"AAPL    250620C00150000"} → {"underlying":"AAPL","expiration":"2025-06-20","type":"call","strike":"150.000"}
 * @swagger-example occ-parse-form3 {"input":"AAPL250620C00150000"} → {"underlying":"AAPL","expiration":"2025-06-20","type":"call","strike":"150.000"}
 * @swagger-example occ-parse-form4 {"input":"AAPL250620C150"} → {"underlying":"AAPL","expiration":"2025-06-20","type":"call","strike":"150.000"}
 */
optionsRouter.post('/occ/parse', validate('json', OccParseInputSchema), async (c) => {
  const { input } = c.req.valid('json');
  const result = parseOccSymbol(input);
  if (!result.ok) {
    throw new ValidationError(result.error.message, { input: result.error.message }, [
      { path: 'input', code: result.error.code, message: result.error.message },
    ]);
  }
  return c.json(result.value, 200);
});

/**
 * @swagger-example occ-encode-canonical {"underlying":"AAPL","expiration":"2025-06-20","type":"call","strike":"150"} → {"symbol":"AAPL  250620C00150000"}
 */
optionsRouter.post('/occ/encode', validate('json', OccEncodeInputSchema), async (c) => {
  const input = c.req.valid('json');
  const result = encodeOccSymbol(input);
  if (!result.ok) {
    throw new ValidationError(result.error.message, { input: result.error.message }, [
      { path: 'input', code: result.error.code, message: result.error.message },
    ]);
  }
  return c.json({ symbol: result.value }, 200);
});

/**
 * @swagger-example bs-atm-call {"S":150,"K":150,"T":0.5,"sigma":0.30,"r":0.04,"q":0,"type":"call"} → {"price":"14.0857","delta":"5.79395e-1","gamma":"1.22884e-2","thetaPerDay":"-4.20684e-2","vegaPerPct":"4.14735e-1","rhoPerPct":"3.64118e-1"}
 * @swagger-example bs-q-omitted {"S":150,"K":150,"T":0.5,"sigma":0.30,"r":0.04,"type":"call"} → {"price":"14.0857","delta":"5.79395e-1","gamma":"1.22884e-2","thetaPerDay":"-4.20684e-2","vegaPerPct":"4.14735e-1","rhoPerPct":"3.64118e-1"}
 * @swagger-example bs-negative-r {"S":100,"K":100,"T":1.0,"sigma":0.20,"r":-0.005,"q":0,"type":"call"} → {"price":"7.73740","delta":"5.29893e-1","gamma":"1.98911e-2","thetaPerDay":"-1.02793e-2","vegaPerPct":"3.97822e-1","rhoPerPct":"4.52519e-1"}
 */
optionsRouter.post('/black-scholes', validate('json', BlackScholesInputSchema), async (c) => {
  const input = c.req.valid('json');
  const output = blackScholes(input);
  return c.json(output, 200);
});

export default optionsRouter;

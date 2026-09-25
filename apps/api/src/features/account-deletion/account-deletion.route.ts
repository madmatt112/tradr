import { Hono } from 'hono';
import { setCookie } from 'hono/cookie';

import { AccountDeletionRequestSchema } from '@tradr/shared';

import { sessionCookieOptions } from '@/lib/cookie-policy';
import { validate } from '@/lib/validation';
import { authMiddleware } from '@/middleware/auth.middleware';
import { createRateLimiter } from '@/middleware/rate-limit.middleware';

import {
  cancelScheduledDeletion,
  getDeletionStatus,
  requestSelfDeletion,
} from './account-deletion.service';

// ---------------------------------------------------------------------------
// Self-service account-deletion routes (design C7). Mounted at
// `/api/users/me/deletion` (app.ts) so the three handlers own `/`. The router
// carries router-level `authMiddleware`, so every handler is behind a session
// (401 without one) and reads the actor from `c.get('userId')`.
//
// Handlers are thin: the state machine, guard pre-checks, Stripe not-renew and
// the password gate all live in account-deletion.service.ts. Hand-authored
// `@swagger` blocks (billing/admin route style), NOT `@hono/zod-openapi`.
// ---------------------------------------------------------------------------

type AuthEnv = {
  Variables: {
    userId: string;
    isAdmin: boolean;
  };
};

const accountDeletionRouter = new Hono<AuthEnv>();

accountDeletionRouter.use(authMiddleware);

// Per-user deletion limiter (Req 9.1). Keyed on the authenticated userId (not
// IP) per the admin/billing precedent, so NAT'd users do not collide and one
// user across IPs cannot bypass it. The Redis-outage fallback TIGHTENS to 3.
const deletionRateLimit = createRateLimiter({
  name: 'account-deletion',
  max: 5,
  windowMs: 15 * 60 * 1000,
  fallbackMax: 3,
  keyGenerator: (c) => c.get('userId'),
});

/**
 * @swagger
 * /api/users/me/deletion:
 *   get:
 *     summary: The current scheduled-deletion status for the signed-in user.
 *     description: >
 *       Authed. Returns the pending/scheduled deletion, or nulls when none
 *       exists, so the Account settings section can render its state.
 *     tags: [Account deletion]
 *     responses:
 *       200:
 *         description: >
 *           AccountDeletionStatus — `{ scheduledFor, state }`, both null when no
 *           deletion is scheduled.
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 scheduledFor: { type: string, format: date-time, nullable: true }
 *                 state:
 *                   type: string
 *                   nullable: true
 *                   enum: [pending, scheduled, cancelling, firing]
 *       401: { description: No valid session. }
 */
accountDeletionRouter.get('/', async (c) => {
  return c.json(await getDeletionStatus(c.get('userId')), 200);
});

/**
 * @swagger
 * /api/users/me/deletion:
 *   post:
 *     summary: Request deletion of the signed-in user's own account.
 *     description: >
 *       Authed and DESTRUCTIVE. Requires the account password (checked
 *       server-side). With no renewing subscription the account is deleted
 *       immediately and the `session` cookie is cleared; otherwise deletion is
 *       scheduled for when billing resolves and the response carries that
 *       instant. Rate limited to 5 requests per 15 minutes per user, tightening
 *       to 3 while the shared rate-limit store is unavailable.
 *     tags: [Account deletion]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [password]
 *             properties:
 *               password: { type: string, minLength: 8, maxLength: 72 }
 *     responses:
 *       200:
 *         description: >
 *           AccountDeletionResult — `{ outcome: 'deleted' }` (session cleared) or
 *           `{ outcome: 'scheduled', scheduledFor }`.
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 outcome: { type: string, enum: [deleted, scheduled] }
 *                 scheduledFor: { type: string, format: date-time }
 *       400: { description: "VALIDATION_ERROR — the password is missing or outside 8-72 characters." }
 *       401: { description: No valid session. }
 *       403: { description: "INVALID_PASSWORD — the password does not match." }
 *       409: { description: "LAST_ADMIN, SUBSCRIPTION_UNRESOLVED, or DELETION_IN_PROGRESS." }
 *       429: { description: Rate limit exceeded (5 / 15 min per user). }
 *       502: { description: "STRIPE_CANCEL_FAILED — the subscription could not be updated; nothing was deleted." }
 */
accountDeletionRouter.post(
  '/',
  deletionRateLimit,
  validate('json', AccountDeletionRequestSchema),
  async (c) => {
    const { password } = c.req.valid('json');
    const result = await requestSelfDeletion(c.get('userId'), password);

    // On an immediate delete the session is gone (the cascade removed it);
    // clear the cookie as logout does (auth.route.ts) so the client lands
    // signed out.
    if (result.outcome === 'deleted') {
      setCookie(c, 'session', '', { ...sessionCookieOptions(), maxAge: 0 });
    }

    return c.json(result, 200);
  },
);

/**
 * @swagger
 * /api/users/me/deletion:
 *   delete:
 *     summary: Cancel the signed-in user's scheduled deletion.
 *     description: >
 *       Authed. Cancels a scheduled deletion and re-enables any subscription
 *       renewal it had turned off. A `cancelling` or `firing` schedule cannot be
 *       cancelled.
 *     tags: [Account deletion]
 *     responses:
 *       200:
 *         description: The schedule was cancelled; the status is back to nulls.
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 scheduledFor: { type: string, nullable: true }
 *                 state: { type: string, nullable: true }
 *       401: { description: No valid session. }
 *       402: { description: "BILLING_NOT_AVAILABLE — billing is unconfigured, so a renewal cannot be restored." }
 *       404: { description: "NO_DELETION_SCHEDULED — nothing is scheduled to cancel." }
 *       409: { description: "DELETION_IN_PROGRESS — the deletion is already cancelling or firing." }
 *       502: { description: "STRIPE_REENABLE_FAILED — the subscription renewal could not be restored." }
 */
accountDeletionRouter.delete('/', async (c) => {
  await cancelScheduledDeletion(c.get('userId'));
  return c.json({ scheduledFor: null, state: null }, 200);
});

export default accountDeletionRouter;

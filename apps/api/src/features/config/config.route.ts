import { Hono } from 'hono';

import { isRegistrationEnabled } from '@/lib/config';

// ---------------------------------------------------------------------------
// Public configuration (REQ-9.4/9.5).
//
// The SPA has never learned anything from the server at startup, so the
// register route had no way to know whether sign-up is open — it could only
// discover the answer by letting a visitor fill in a form and refusing at
// submit. This endpoint is the bootstrap that makes that unnecessary.
//
// Route-only slice, matching health.route.ts: no service and no query layer,
// because there is no business logic and nothing is read from the database.
//
// POSTURE ONLY — the field list is an allow-list, not a starting point.
// The obvious next step is to return the is*Configured() results the app
// already computes. Do not. This endpoint is unauthenticated and ships on
// EVERY self-hosted instance, so any such field publishes which providers,
// object storage, billing and database a stranger's deployment has wired.
// REQ-9.5 makes that a hard boundary; config.test.ts asserts the response key
// set EQUALS ['registrationEnabled'], so adding a second field reds the build
// rather than leaking quietly.
// ---------------------------------------------------------------------------

// One minute. The value is boot-time config, so it only ever changes across a
// restart — but an operator who opens sign-up at launch (REQ-9.7: config change,
// no SPA rebuild) should not watch a stale "closed" page for long, and a visitor
// who reloads should get the new answer. `public` is safe because the response
// carries no per-user or per-credential variation: every caller on an instance
// gets the same byte for the same deployment. Not `immutable`, and not hours —
// that would trade a rare cache miss for a launch that looks broken.
const CACHE_CONTROL = 'public, max-age=60';

const configRouter = new Hono();

/**
 * @swagger
 * /api/config:
 *   get:
 *     summary: Public instance posture the SPA needs before rendering a form.
 *     description: >
 *       Unauthenticated and cacheable (`Cache-Control - public, max-age=60`).
 *       Returns exactly one field, `registrationEnabled`, so the web app can
 *       render either the sign-up form or the "signups open at launch" notice
 *       instead of letting a visitor complete a form that the server will
 *       refuse. This surface is posture only - by design it never reports
 *       secrets, provider keys, database details, or which optional
 *       capabilities an instance has configured. The field list is an
 *       allow-list pinned by a test; it grows only by explicit decision.
 *     tags: [Platform]
 *     responses:
 *       200:
 *         description: Instance posture.
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               required: [registrationEnabled]
 *               additionalProperties: false
 *               properties:
 *                 registrationEnabled:
 *                   type: boolean
 *                   description: >
 *                     False when the operator set DISABLE_REGISTRATION, in
 *                     which case POST /api/auth/register answers 403
 *                     REGISTRATION_DISABLED. The server refusal is the control;
 *                     this field only spares the visitor a wasted form.
 */
configRouter.get('/', (c) => {
  c.header('Cache-Control', CACHE_CONTROL);
  return c.json({ registrationEnabled: isRegistrationEnabled() }, 200);
});

export { configRouter };

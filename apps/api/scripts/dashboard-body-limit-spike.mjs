// validated against hono@4.12.8 / node@24.13 on 2026-05-25 — OUTCOME (a) FICTIONAL: default HTTPException machinery handles bodyLimit throws cleanly; bespoke onError retained for envelope shape
// Run: pnpm --filter @tradr/api exec tsx apps/api/scripts/dashboard-body-limit-spike.mjs
// (tsx is used because @tradr/shared is .ts-source — node cannot resolve workspace .ts imports natively.)
// Re-run before any Hono major-version upgrade. v4-1: CHECKED-IN, NOT deletable.

import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { BODY_LIMIT_BYTES } from '@tradr/shared';

let unhandledRejectionCaptured = null;
process.once('unhandledRejection', (err) => {
  unhandledRejectionCaptured = err;
});

function buildStream() {
  return new ReadableStream({
    start(controller) {
      const chunk = new TextEncoder().encode('x'.repeat(1700));
      for (let i = 0; i < 10; i++) controller.enqueue(chunk);
      controller.close();
    },
  });
}

function makeApp() {
  return new Hono().put(
    '/test',
    bodyLimit({
      maxSize: BODY_LIMIT_BYTES,
      onError: (c) => c.json({ err: 'caught' }, 413),
    }),
    async (c) => {
      const body = await c.req.json().catch((e) => {
        if (e?.name === 'BodyLimitError') throw e; // let bodyLimit's post-next onError fire
        return null;
      });
      return c.json({ ok: true, gotBytes: body == null ? 0 : JSON.stringify(body).length });
    },
  );
}

function makeAppNoBespoke() {
  return new Hono().put(
    '/test',
    bodyLimit({ maxSize: BODY_LIMIT_BYTES }), // default onError throws HTTPException(413)
    async (c) => {
      const body = await c.req.json().catch((e) => {
        if (e?.name === 'BodyLimitError') throw e; // let bodyLimit's post-next onError fire
        return null;
      });
      return c.json({ ok: true, gotBytes: body == null ? 0 : JSON.stringify(body).length });
    },
  );
}

// --- Bespoke run ---
const app1 = makeApp();
const res1 = await app1.request('/test', {
  method: 'PUT',
  body: buildStream(),
  duplex: 'half',
  headers: { 'content-type': 'application/json' },
});
const body1 = await res1.json().catch(() => null);
console.log('BESPOKE status:', res1.status);
console.log('BESPOKE body:', JSON.stringify(body1));
console.log('BESPOKE unhandledRejection:', unhandledRejectionCaptured?.message ?? null);

// --- Default run ---
unhandledRejectionCaptured = null;
const app2 = makeAppNoBespoke();
let res2 = null;
let requestRejected = null;
try {
  res2 = await app2.request('/test', {
    method: 'PUT',
    body: buildStream(),
    duplex: 'half',
    headers: { 'content-type': 'application/json' },
  });
} catch (err) {
  requestRejected = err;
}
let body2 = null;
if (res2) body2 = await res2.json().catch(() => null);
// Give Node a tick to flush any pending unhandled rejection.
await new Promise((r) => setTimeout(r, 50));
console.log('DEFAULT status:', res2?.status ?? '(app.request rejected)');
console.log('DEFAULT body:', JSON.stringify(body2));
console.log('DEFAULT unhandledRejection:', unhandledRejectionCaptured?.message ?? null);
console.log('DEFAULT requestRejected:', requestRejected?.message ?? null);

// --- Binary gate evaluation ---
const bespokeOk =
  res1.status === 413 &&
  body1 &&
  body1.err === 'caught' &&
  unhandledRejectionCaptured === null;
console.log('GATE bespoke:', bespokeOk ? 'PASS (413 + {err:caught} + null unhandledRejection)' : 'FAIL');

let outcome;
if (requestRejected || unhandledRejectionCaptured || res2?.status === 500) {
  outcome = '(b) regression reproduces — proceed with 5 test cases';
} else if (res2?.status === 413) {
  outcome = '(a) regression FICTIONAL — Hono outer chain catches throw; escalate';
} else {
  outcome = '(c) ambiguous — escalate';
}
console.log('GATE default outcome:', outcome);

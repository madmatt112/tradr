import Decimal from 'decimal.js';
import { Hono } from 'hono';

import { runMigrations } from '@/db/migrate';
import accountingRouter from '@/features/accounting/accounting.route';
import {
  insertPositionCloseLedgerEntries,
  postFillLedgerEntries,
  reversePositionCloseLedgerEntries,
} from '@/features/accounting/ledger-hook';
import accounts from '@/features/accounts/accounts.route';
import { adminRouter } from '@/features/admin/admin.route';
import { advisorRouter } from '@/features/advisor/advisor.route';
import { ListModelsCache } from '@/features/advisor/providers/list-models-cache';
import { initProviderRegistry } from '@/features/advisor/providers/registry';
import { applyBuiltinPersonaOverrides, runDecryptCanary } from '@/features/advisor/startup';
import auth, { userPreferencesRouter } from '@/features/auth/auth.route';
import passwordResetRouter from '@/features/auth/password-reset.route';
import verificationRouter from '@/features/auth/verification.route';
import { billingRouter, billingWebhookRouter } from '@/features/billing/billing.route';
import brokeragesRouter from '@/features/brokerages/brokerages.route';
import calculatorRouter, {
  calculatorPreferencesRouter,
} from '@/features/calculator/calculator.route';
import { changelogRouter } from '@/features/changelog/changelog.route';
import { initChangelogCache } from '@/features/changelog/changelog.service';
import { configRouter } from '@/features/config/config.route';
import csvImport from '@/features/csv-import/csv-import.route';
import { dashboardRoute } from '@/features/dashboard/dashboard.route';
import { initDashboardCache } from '@/features/dashboard/dashboard.service';
import expensesRouter from '@/features/expenses/expenses.route';
import health from '@/features/health/health.route';
import optionsRouter from '@/features/options/options.route';
import performance from '@/features/performance/performance.route';
import fillsRouter from '@/features/positions/fills.route';
import positions from '@/features/positions/positions.route';
import {
  assertLedgerHooksCoRegistered,
  replaceCloseHook,
  replaceFillHook,
  replaceReverseHook,
} from '@/features/positions/positions.service';
import { initStockQuoteCache } from '@/features/symbols/stock-quote.client';
import symbolsRouter from '@/features/symbols/symbols.route';
import { syncSymbolsIfStale } from '@/features/symbols/symbols.service';
import { isMetricsConfigured } from '@/lib/config';
import {
  loadEncryptionKeyMaterial,
  runEncryptionFingerprintCheckIfConfigured,
} from '@/lib/encryption';
import { logger } from '@/lib/logger';
import { corsMiddleware } from '@/middleware/cors.middleware';
import { csrfMiddleware } from '@/middleware/csrf.middleware';
import { errorHandler } from '@/middleware/error.middleware';
import { loggingMiddleware } from '@/middleware/logging.middleware';
import { metricsMiddleware } from '@/middleware/metrics.middleware';

const app = new Hono();

// Global middleware
app.use(loggingMiddleware);

// HTTP metrics (REQ-1.4) — registered only when METRICS_ENABLED. Placed AFTER
// loggingMiddleware so a metrics failure can never prevent the request log, and
// before every app.route() mount below so it wraps route dispatch.
//
// Two classes of short-circuit therefore label a request by something other than
// its route pattern, both pinned in metrics.middleware.test.ts so nobody reads
// them as a bug:
//
//  1. GLOBAL — corsMiddleware/csrfMiddleware sit AFTER this and can return
//     without calling next() (csrfMiddleware returns 403 CSRF_FORBIDDEN). Route
//     dispatch never happens, so the request resolves to a global middleware's
//     /* and is labelled route="unmatched" alongside genuine 404s. Only on the
//     split-origin hosted tier — both are pure pass-through when
//     isSplitOriginConfigured() is false.
//  2. PER-ROUTER — the feature routers below call router.use(authMiddleware),
//     which returns 401 without next() when unauthenticated. That resolves to
//     the router's MOUNT WILDCARD (e.g. route="/api/positions/*"), not
//     "unmatched" — a third bucket a dashboard shows next to /api/positions/:id.
//     This is the highest-volume case, since 401s are routine.
//
// Both satisfy REQ-5.7's letter (no app route's handler ever matched) and stay
// bounded: one extra label value per mounted router (REQ-8.2).
if (isMetricsConfigured()) app.use(metricsMiddleware);

// Split-origin CORS + anti-CSRF (REQ-5/6, design §Component 4/5). Both gate on
// the single isSplitOriginConfigured() predicate (evaluated per request), so
// they are inseparable (REQ-6.4): unconfigured ⇒ pure pass-through — no CORS
// headers, no CSRF enforcement, same-origin Lax flow unchanged (REQ-6.3).
// Mounted BEFORE all app.route() calls so anti-CSRF covers every cookie-auth
// mutating route (stream POST, auth, accounts, admin, …); the Stripe webhook is
// path-exempt inside csrfMiddleware. CORS runs first so a rejected cross-origin
// request can still be read by the browser.
app.use(corsMiddleware);
app.use(csrfMiddleware);

// Routes
app.route('/api/health', health);
// Public instance posture (newsletter REQ-9.4/9.5). Mounted next to health
// rather than in the alphabetical block below so this file shows the whole
// unauthenticated, un-gated surface in one place: these two routers are the
// only ones a stranger can read without a session. configRouter deliberately
// returns one field — see the allow-list note in config.route.ts.
app.route('/api/config', configRouter);
app.route('/api/auth', auth);
// Password reset: a SECOND router on the same /api/auth base (the
// positions/fillsRouter double-mount precedent below) so the frozen
// auth.route.ts surface stays untouched (transactional-email REQ-1.1). The
// global CORS + anti-CSRF middleware above cover it automatically.
app.route('/api/auth', passwordResetRouter);
// Email verification: a THIRD router on the same /api/auth base (same
// precedent) — verify-email is public, verify-email/resend is authed (D11).
app.route('/api/auth', verificationRouter);
app.route('/api/accounts', accounts);
// Admin: gating (auth → admin → rate limit) is router-level inside adminRouter
// (admin-platform design Component 1, REQ-1.4).
app.route('/api/admin', adminRouter);
app.route('/api/advisor', advisorRouter);
// Billing: the PUBLIC webhook is mounted distinctly at /api/billing/webhook so
// session auth never wraps it and it receives the unmodified raw body
// (design §Component 4, REQ-3.1). The authed router serves the rest.
app.route('/api/billing/webhook', billingWebhookRouter);
app.route('/api/billing', billingRouter);
app.route('/api/brokerages', brokeragesRouter);
app.route('/api/calculator', calculatorRouter);
app.route('/api/changelog', changelogRouter);
app.route('/api/csv-import', csvImport);
app.route('/api/dashboard', dashboardRoute);
app.route('/api/options', optionsRouter);
app.route('/api/positions', positions);
app.route('/api/positions', fillsRouter);
app.route('/api/performance', performance);
app.route('/api/symbols', symbolsRouter);
// Mounted bare at /api so it can own the absolute /api/users/me/buying-power-basis
// path, matching the accounting and expenses preference routes below.
app.route('/api', calculatorPreferencesRouter);
app.route('/api', accountingRouter);
app.route('/api', expensesRouter);
// Same bare-/api reason as the three above: it owns the absolute
// /api/users/me/timezone path, which cannot be declared on the /api/auth router.
app.route('/api', userPreferencesRouter);

// Error handler
app.onError(errorHandler);

// --- bootstrap (design.md §Component 4) ---
// One-time process-wide initialization invoked by `index.ts main()` after
// post-migrations and before `serve()`. Defined here (not invoked at module
// load) so test harnesses can import `app` without side-effects.
//
// - `Decimal.set` mutates global decimal.js config. decimal.js v10 reads
//   config per-call rather than caching it on construction, so any
//   `new Decimal(...)` instances created before this call still observe the
//   pinned `ROUND_HALF_UP` rounding mode and 20-digit precision when they
//   participate in arithmetic. This means we never need a module-top-level
//   `new Decimal(...)` to "lock in" the config.
// - `replaceCloseHook` (not `registerCloseHook`) keeps `bootstrap()`
//   idempotent: calling it twice — e.g., from a test harness re-init —
//   overwrites the existing entry rather than throwing
//   `HookAlreadyRegisteredError`.
//
// Advisor startup ordering (Task 28, design §Bootstrap order):
//   prelude
//     → loadEncryptionKeyMaterial
//     → runEncryptionFingerprintCheckIfConfigured
//     → runMigrations
//     → runDecryptCanary
//     → applyBuiltinPersonaOverrides
//     → initProviderRegistry(new ListModelsCache())
// Steps 2–3 (load + fingerprint) run BEFORE runMigrations per design v4-8 so a
// misconfigured key fails the deploy before paying migration cost.
export async function bootstrap(): Promise<void> {
  // --- prelude ---
  Decimal.set({ rounding: Decimal.ROUND_HALF_UP, precision: 20 });
  replaceCloseHook('ledger', insertPositionCloseLedgerEntries);
  // Reverse hook, co-registered with the close hook (Req 7.5/7.8). The
  // co-registration invariant below is the state-machine guard that replaces the
  // dropped `ledger_position_pnl_unique_idx` (task 26) — every close hook MUST
  // have a same-named reverse hook or bootstrap throws.
  replaceReverseHook('ledger', reversePositionCloseLedgerEntries);
  // Fill hook (Req 9): posts the realized-P&L delta on every fill mutation, so a
  // partial exit moves the balance immediately instead of waiting for the
  // position to go flat. Co-registered with the other two — the invariant below
  // requires all three, because partial P&L posted by the fill hook must be
  // reversible on reopen.
  replaceFillHook('ledger', postFillLedgerEntries);
  assertLedgerHooksCoRegistered();
  initDashboardCache();
  initChangelogCache();
  initStockQuoteCache();

  // --- advisor startup ordering ---
  loadEncryptionKeyMaterial();
  runEncryptionFingerprintCheckIfConfigured();
  await runMigrations();
  // SEC symbols population — fire-and-forget so it can never block or crash
  // startup (REQ-2.3). Runs AFTER runMigrations() so the symbol_sync_state
  // table exists before the first read. Not forced: skips when data is fresh.
  void syncSymbolsIfStale({ force: false }).catch((e) =>
    logger.warn('symbols population kickoff failed', {
      error: e instanceof Error ? e.message : String(e),
    }),
  );
  await runDecryptCanary();
  await applyBuiltinPersonaOverrides();
  initProviderRegistry(new ListModelsCache());
}

export default app;

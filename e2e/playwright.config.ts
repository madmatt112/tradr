import { defineConfig, devices } from '@playwright/test';

/**
 * Playwright config for the Tradr e2e suite.
 *
 * Playwright owns the full stack lifecycle via the `webServer` array below: it
 * boots a local Unusual Whales stub (e2e/support/uw-stub-server.ts), the API
 * (with `UNUSUAL_WHALES_BASE_URL` pointed at the stub so UW calls are
 * deterministic and never hit the live host), and the web dev server, then
 * tears them all down. Postgres must already be reachable at `DATABASE_URL`
 * (CI runs a postgres service; locally use your dev DB). The API runs its own
 * migrations on boot, so no separate migrate step is needed.
 *
 * In CI the `e2e` job in .github/workflows/ci.yml starts the postgres service,
 * installs Playwright browsers, and runs `pnpm --filter @tradr/e2e test`;
 * Playwright boots web + api + stub itself.
 *
 * `BASE_URL` is read from the env so CI can point at a preview deploy or a
 * locally-bound port other than 5173. When `BASE_URL` is set the bundled
 * `webServer` for web is skipped (Playwright reuses the external server).
 */
// Playwright runs as a standalone CLI outside the apps/api boot path, so it
// reads its own knobs from the env directly. Disable the project-wide
// `process.env` ban for this config — there is no `@/lib/config` module in
// scope here.
/* eslint-disable no-restricted-syntax */
const isCI = Boolean(process.env.CI);

/**
 * Reusing an already-running server is opt-in rather than the default.
 *
 * It used to be on for every local run, and it attaches to whatever happens to
 * hold the port — including a dev server from a DIFFERENT checkout. The suite
 * then exercises code that is not the code under test and reports confident,
 * wrong results, with no signal that anything is amiss. Off by default a busy
 * port fails loudly instead, which is the outcome you want.
 *
 * CI never reused (it sets CI, and this stays false there), so this changes
 * nothing about the GitHub Actions run.
 */
const reuseExistingServer = !isCI && process.env.E2E_REUSE_SERVER === '1';
const baseURL = process.env.BASE_URL ?? 'http://localhost:5173';

const apiPort = Number(process.env.API_PORT ?? 3100);
const uwStubPort = Number(process.env.UW_STUB_PORT ?? 4599);
const githubStubPort = Number(process.env.GITHUB_STUB_PORT ?? 4601);
const secStubPort = Number(process.env.SEC_STUB_PORT ?? 4602);
const quoteStubPort = Number(process.env.QUOTE_STUB_PORT ?? 4603);
const webPort = new URL(baseURL).port || '5173';

// Env forwarded to the booted API. Defaults are CI-safe; real secrets/DB come
// from the CI job env (or the local shell). The key line is
// UNUSUAL_WHALES_BASE_URL → the local stub, the residual round-3 blocker.
//
// NODE_ENV MUST be 'development' (not 'test'): apps/api/src/index.ts gates its
// auto-boot on `NODE_ENV !== 'test'` so vitest can import the app without
// spawning a server. Under 'test' the e2e server-under-test would never start.
const apiEnv: Record<string, string> = {
  NODE_ENV: 'development',
  PORT: String(apiPort),
  // 5433, not 5432: a native Postgres owns 5433 locally and shadows the compose
  // container, which is why every vitest project points there too. CI overrides
  // DATABASE_URL from the workflow env (its service container is on 5432), so
  // this default is only ever the local path.
  DATABASE_URL:
    process.env.DATABASE_URL ?? 'postgresql://postgres:postgres@localhost:5433/tradr_test',
  SESSION_SECRET:
    process.env.SESSION_SECRET ?? 'e2e-session-secret-that-is-at-least-32-characters-long',
  ENCRYPTION_KEY:
    process.env.ENCRYPTION_KEY ??
    '0000000000000000000000000000000000000000000000000000000000000000',
  UNUSUAL_WHALES_BASE_URL: `http://localhost:${uwStubPort}`,
  // Changelog REQ-3.6 seam: point the GitHub releases client at the local stub
  // (e2e/support/github-stub-server.ts) so release fetches are deterministic
  // and never hit the live api.github.com. The repo slug is a fixture value —
  // the stub serves the same fixtures for any owner/repo path.
  CHANGELOG_GITHUB_BASE_URL: `http://localhost:${githubStubPort}`,
  CHANGELOG_GITHUB_REPO: 'e2e-fixtures/tradr-changelog',
  // ─── Symbol search + delayed quotes (symbol-search-quotes Task 14) ────────
  // SEC_TICKERS_URL is set UNCONDITIONALLY → the local SEC stub. The e2e API
  // boots NODE_ENV=development, so Task 9's bootstrap `void syncSymbolsIfStale()`
  // runs on EVERY boot and would otherwise hit the LIVE https://www.sec.gov file
  // (the per-IP 403/rate-limit hazard REQ-2.4(c) exists to prevent, plus a flake
  // source). Pointing the seam at the stub means no e2e boot ever touches live
  // SEC — the stub serves a deterministic columnar fixture (and 403s on demand
  // via POST /__mode for the graceful-absence scenario).
  SEC_TICKERS_URL: `http://localhost:${secStubPort}/company_tickers_exchange.json`,
  // STOCK_QUOTE_BASE_URL → the quote stub (always, so no boot can reach the live
  // API Ninjas host). The capability is ARMED only when STOCK_QUOTE_API_KEY is
  // also exported: then `isStockQuoteConfigured()` is true and the pull-quote
  // button paints (stock-path spec). Left empty by default (`''` reads falsy via
  // the `!!` predicate) so the DEFAULT run is the absent-key path — the pull-quote
  // button is absent and the armed stock-path case skips cleanly.
  STOCK_QUOTE_BASE_URL: `http://localhost:${quoteStubPort}`,
  STOCK_QUOTE_API_KEY: process.env.STOCK_QUOTE_API_KEY ?? '',
  // Trust the loopback proxy so specs can send a unique `X-Forwarded-For` per
  // request and dodge the per-IP auth register limit (5 / 15 min). Without a
  // trusted proxy the limiter keys every request off the shared socket IP, so a
  // suite registering >5 users trips 429 (advisor-tools.spec.ts relies on this).
  TRUSTED_PROXIES: process.env.TRUSTED_PROXIES ?? '127.0.0.1',
  // ─── Transactional email pass-through (transactional-email Task 17) ──────
  // Mailpit being reachable does NOT configure the API — these exports do.
  // Every default is '' (config.ts's empty-tolerant preprocess: all-empty ⇒
  // isEmailConfigured() false, no coherence throw), so a run with nothing
  // exported boots the API byte-identical to before this block existed. To
  // arm an email round-trip run, export the .env.example dev-Mailpit values
  // (SMTP_HOST=localhost SMTP_PORT=1025 SMTP_TLS_MODE=none
  // EMAIL_FROM=dev@tradr.local) before `pnpm test` —
  // tests/transactional-email.spec.ts un-skips itself when the API is armed
  // AND the Mailpit API answers on :8025.
  //
  // Partial exports, honestly: exporting a subset that includes SMTP_HOST or
  // any other presence-signal var (EMAIL_FROM / SMTP_USER / SMTP_PASS /
  // EMAIL_FROM_NAME) fails the API boot LOUDLY — the config coherence assert
  // names the missing vars and the webServer health check times out with the
  // crash on piped stderr. A LONE `WEB_BASE_URL` export is the one deliberate
  // exception: the arming conditional below masks it to '' (clean
  // unconfigured run, not fail-loud), because the emailed links MUST land on
  // the Playwright web origin — never whatever the shell happened to export.
  SMTP_HOST: process.env.SMTP_HOST ?? '',
  SMTP_PORT: process.env.SMTP_PORT ?? '',
  SMTP_TLS_MODE: process.env.SMTP_TLS_MODE ?? '',
  SMTP_USER: process.env.SMTP_USER ?? '',
  SMTP_PASS: process.env.SMTP_PASS ?? '',
  EMAIL_FROM: process.env.EMAIL_FROM ?? '',
  EMAIL_FROM_NAME: process.env.EMAIL_FROM_NAME ?? '',
  WEB_BASE_URL: process.env.SMTP_HOST ? (process.env.WEB_BASE_URL ?? new URL(baseURL).origin) : '',
};

// When BASE_URL points at an externally-managed stack, Playwright should not
// try to boot its own servers.
const manageStack = !process.env.BASE_URL;
/* eslint-enable no-restricted-syntax */

export default defineConfig({
  testDir: './tests',
  fullyParallel: false,
  forbidOnly: isCI,
  retries: isCI ? 1 : 0,
  workers: 1,
  reporter: isCI ? [['github'], ['list']] : 'list',
  use: {
    baseURL,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  // Boot the full stack: UW stub → GitHub stub → SEC stub → quote stub → API
  // (all upstream base URLs → stubs) → web dev server.
  // Skipped entirely when BASE_URL targets an external stack.
  webServer: manageStack
    ? [
        {
          command: 'pnpm --filter @tradr/e2e exec tsx support/uw-stub-server.ts',
          url: `http://localhost:${uwStubPort}/__health`,
          reuseExistingServer,
          timeout: 30_000,
          env: { UW_STUB_PORT: String(uwStubPort) },
        },
        {
          command: 'pnpm --filter @tradr/e2e exec tsx support/github-stub-server.ts',
          url: `http://localhost:${githubStubPort}/__health`,
          reuseExistingServer,
          timeout: 30_000,
          env: { GITHUB_STUB_PORT: String(githubStubPort) },
        },
        {
          // SEC company-tickers stub — the API's SEC_TICKERS_URL points here so
          // bootstrap symbol population is deterministic and never hits live SEC.
          command: 'pnpm --filter @tradr/e2e exec tsx support/sec-tickers-stub-server.ts',
          url: `http://localhost:${secStubPort}/__health`,
          reuseExistingServer,
          timeout: 30_000,
          env: { SEC_STUB_PORT: String(secStubPort) },
        },
        {
          // Delayed-quote provider stub — the API's STOCK_QUOTE_BASE_URL points
          // here so pull-quote lookups are deterministic and never hit live API
          // Ninjas. Only reached when STOCK_QUOTE_API_KEY arms the capability.
          command: 'pnpm --filter @tradr/e2e exec tsx support/stock-quote-stub-server.ts',
          url: `http://localhost:${quoteStubPort}/__health`,
          reuseExistingServer,
          timeout: 30_000,
          env: { QUOTE_STUB_PORT: String(quoteStubPort) },
        },
        {
          command: 'pnpm --filter @tradr/api exec tsx src/index.ts',
          url: `http://localhost:${apiPort}/api/health`,
          reuseExistingServer,
          timeout: 120_000,
          stdout: 'pipe',
          stderr: 'pipe',
          env: apiEnv,
        },
        {
          // Serve the STATIC production SPA (build → `vite preview`), NOT the
          // Vite dev server. The dev server compiles on demand and slows late in
          // the full suite, so a reload's serve+render can exceed even a bumped
          // 15s (the intermittent "Your dashboard is empty" flake). A prebuilt
          // bundle renders at constant speed. `preview` mirrors the dev `/api`
          // proxy (apps/web/vite.config.ts), so requests route identically. The
          // longer timeout covers the one-time build before the server is up.
          command: `pnpm --filter @tradr/web build && pnpm --filter @tradr/web exec vite preview --port ${webPort} --strictPort`,
          url: baseURL,
          reuseExistingServer,
          timeout: 180_000,
        },
      ]
    : undefined,
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
      testIgnore: /drawer\.mobile\.spec\.ts/,
    },
    {
      // v2-10 (dashboard spec Task 46): mobile coverage is mandatory.
      // iPhone 13 matches `(pointer: coarse)` AND viewport-width < md (768px).
      name: 'Mobile Chrome',
      use: { ...devices['iPhone 13'] },
      testIgnore: /drawer\.mobile\.spec\.ts/,
    },
    {
      // side-drawer Task 18 (v4-5 split): mobile drawer case runs on iPhone 13
      // viewport ONLY — the body-scroll-lock assertion (`position: fixed`)
      // only holds below the md breakpoint. Default desktop projects ignore
      // this file; this project matches ONLY this file.
      name: 'iphone-13',
      use: { ...devices['iPhone 13'] },
      testMatch: /drawer\.mobile\.spec\.ts/,
    },
  ],
});

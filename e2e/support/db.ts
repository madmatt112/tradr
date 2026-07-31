// e2e-only DB seam (admin-platform Task 23).
//
// The booted stack has no API route for creating the FIRST admin (the bootstrap
// path is the documented operator SQL — design §Admin bootstrap), and
// `SEED_ADMIN_EMAIL` is a boot-order dead-end here: Playwright's `webServer`
// boots the API before any spec can register a user, and the harness has no
// restart seam. So this helper runs the documented promotion statement directly
// against the stack's Postgres, using the SAME driver the API uses (porsager
// `postgres`, devDependency of @tradr/e2e) and the SAME `DATABASE_URL`
// resolution as playwright.config.ts `apiEnv` — env first, then the CI-safe
// default — so the helper always hits the database the booted API is using.
//
// This file is the e2e suite's only direct DB access; production code is
// untouched.

import postgres from 'postgres';

// Playwright specs run outside the apps/api boot path — no `@/lib/config` in
// scope, so the env is read directly (same exemption playwright.config.ts and
// wallet-billing.spec.ts take).
// 5433, not 5432 — matching playwright.config.ts. A native Postgres owns 5433
// locally and shadows the compose container, so a local run with no
// DATABASE_URL exported hit 5432, got ECONNREFUSED, and failed the only two
// specs that open a direct connection (admin-platform, symbol-search-quotes).
// The two files disagreeing on the default was the whole bug; CI is unaffected
// either way because the workflow exports DATABASE_URL explicitly.
const DATABASE_URL =
  // eslint-disable-next-line no-restricted-syntax
  process.env.DATABASE_URL ?? 'postgresql://postgres:postgres@localhost:5433/tradr_test';

/**
 * Promote a registered user to admin — the documented bootstrap statement:
 *   UPDATE users SET is_admin = true WHERE email = '<registered email>';
 *
 * Takes effect on the user's NEXT request: the auth middleware reads
 * `users.is_admin` from the DB per request (auth.middleware.ts), so no
 * re-login is needed. Throws if the email did not match exactly one row.
 */
export async function promoteToAdmin(email: string): Promise<void> {
  const sql = postgres(DATABASE_URL, { max: 1 });
  try {
    const result = await sql`UPDATE users SET is_admin = true WHERE email = ${email}`;
    if (result.count !== 1) {
      throw new Error(
        `promoteToAdmin: expected to update exactly 1 row for ${email}, updated ${result.count}. ` +
          `Connected to ${DATABASE_URL.replace(/\/\/[^@]*@/, '//<redacted>@')} — if Playwright ` +
          'reused an already-running API (reuseExistingServer), make sure DATABASE_URL in your ' +
          "shell matches that server's database.",
      );
    }
  } finally {
    await sql.end();
  }
}

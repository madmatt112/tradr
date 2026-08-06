-- Users who predate onboarding start out already ONBOARDED (user-onboarding R3.6).
--
-- 0027 added `users.onboarding` as NOT NULL DEFAULT '{}' with no backfill, on
-- the reasoning that '{}' parses to status 'pending' and 'pending' is "exactly
-- where a brand-new user is". That is true of a brand-new user and false of
-- everyone else: the fast default put EVERY pre-existing row at 'pending' too,
-- including people who have been trading in Tradr for years.
--
-- It matters because 'pending' is what the zero-state gate keys on. R3.6 says
-- the zero-state SHALL NOT reappear for a returning user who deletes their last
-- account — "a returning user with history is not an onboarding user" — and the
-- gate implements that by retiring on status 'done'. But 'done' is only ever
-- reached by completing all four checklist items, and item 2 needs
-- `calculatorFirstUsedAt`, which nothing wrote before this feature existed. So
-- without this backfill a user with years of history who deletes their last
-- account is shown "Welcome to Tradr". This is the one-time correction.
--
-- WHY A MIGRATION AND NOT A READ-TIME DERIVATION. The alternative — resolving
-- 'pending' to 'done' on every GET /users/me/onboarding when the user has
-- history — would put an EXISTS over accounts and positions on a preference
-- read that is deliberately the CHEAP one (it is what gates the two expensive
-- checklist reads), and it would keep paying for a fact that can only be true
-- once. "Predates the feature" is a property of a moment that has already
-- passed, so it is stored once, at that moment, and never asked again.
--
-- WHO COUNTS AS PRE-EXISTING. Two conditions, and each does a distinct job:
--
--   1. `onboarding = '{}'` — the column has never been written. Every row that
--      predates the feature is '{}', and any row that is NOT '{}' has expressed
--      a preference this migration must not overwrite. It is also what makes
--      the statement IDEMPOTENT: a backfilled row is no longer '{}', so a
--      re-run is a no-op. (Deliberately not `onboarding -> 'status' IS NULL`,
--      which would also catch a row whose only key is `calculatorFirstUsedAt`
--      or `coachMarksSeen` — a preference expressed through the PATCH endpoint
--      0027 already shipped, and therefore not a pre-existing row at all.)
--
--   2. History — at least one account or position. A timestamp comparison
--      cannot do this job: every row that exists when this runs was created
--      before it, so `created_at < now()` marks the whole table, including
--      someone who registered a minute before the deploy and is genuinely new.
--      History is the signal R3.6 itself names, and it separates the two
--      cleanly — a minute-old registration has none.
--
--      A user with neither is not being wronged. They have no accounts and no
--      positions, so the zero-state is the accurate screen for them whether
--      they registered a minute ago or two years ago: there is no history for
--      it to contradict. That is also the honest limit of this migration —
--      someone who had already deleted every account AND every position before
--      the deploy leaves no trace to find, and is indistinguishable from a new
--      registration. Going forward they are covered, because they are marked
--      'done' here while the history still exists and deleting it later cannot
--      un-mark them.
--
--      Both arms are index-backed (accounts_user_id_idx, positions_user_id_idx)
--      and short-circuit on the first row. The positions arm is redundant today
--      — positions.account_id is ON DELETE RESTRICT and the service refuses to
--      delete an account that still has positions, so positions imply accounts
--      — but "has ever created a position" is half of what R3.6 means by
--      history, and stating it here means a future relaxation of that FK cannot
--      quietly narrow this rule.
--
-- ADDITIVE AND ROLLING-DEPLOY SAFE: no DDL, and 'done' is a value the currently
-- deployed code already understands (OnboardingStatusSchema shipped with 0027),
-- so an instance running the old build reads a backfilled row without error.
UPDATE "users" u
SET "onboarding" = jsonb_set(u."onboarding", '{status}', '"done"'::jsonb, true),
    "updated_at" = now()
WHERE u."onboarding" = '{}'::jsonb
  AND (
    EXISTS (SELECT 1 FROM "accounts" a WHERE a."user_id" = u."id")
    OR EXISTS (SELECT 1 FROM "positions" p WHERE p."user_id" = u."id")
  );

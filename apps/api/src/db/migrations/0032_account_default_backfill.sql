-- Give every existing user a default account.
--
-- 0031 added `accounts.is_default` with a fast NOT NULL DEFAULT false, so at
-- this point NO existing account is anyone's default — but the feature's rule
-- is "the first account a user creates is the default", and for every user who
-- already has accounts that moment has passed. This is the one-time correction,
-- exactly as 0028 was for the onboarding status: apply the rule to the rows
-- that predate it, using the trace that still exists.
--
-- WHO GETS ONE: each user's oldest non-demo account (created_at, then id, so
-- the pick is total even under same-transaction timestamp ties). The sample
-- account never qualifies — it is not an account the user chose, and making it
-- the default would preselect invented data in every picker.
--
-- IDEMPOTENT AND RACE-SAFE BY THE SAME PREDICATE: the NOT EXISTS arm skips any
-- user who already has a default, so a re-run is a no-op, and a user whose
-- first account is created mid-deploy (new code sets is_default on create) is
-- left alone rather than double-flagged. The partial unique index from 0031
-- (`accounts_one_default_per_user`) backstops all of it.
--
-- ADDITIVE AND ROLLING-DEPLOY SAFE: no DDL, and an instance running the old
-- build never reads the column.
UPDATE "accounts" a
SET "is_default" = true,
    "updated_at" = now()
WHERE a."id" = (
    SELECT b."id" FROM "accounts" b
    WHERE b."user_id" = a."user_id" AND b."is_demo" = false
    ORDER BY b."created_at" ASC, b."id" ASC
    LIMIT 1
  )
  AND NOT EXISTS (
    SELECT 1 FROM "accounts" c
    WHERE c."user_id" = a."user_id" AND c."is_default" = true
  );

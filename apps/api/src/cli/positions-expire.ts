/**
 * `tradr positions expire` (design C11, Req 9): the self-host cron
 * replacement for a boot-time sweep. There is deliberately no scheduler in
 * this product (design C13, Req 11.2) — an operator's own cron entry calls
 * this command instead, which lists past-expiry-unsettled option legs and,
 * given `--settle`, closes them through the same `settleLeg` the `/settle`
 * route uses.
 *
 * `runPositionsExpire(argv, deps)` is the testable core: it takes an
 * injectable `Database` handle and never touches `process.env` or
 * `process.exit`. `runPositionsExpireCli(argv)` is `main()`'s entrypoint — it
 * opens the CLI's own one-connection drizzle handle (pooler-safe, matching
 * `runResetPassword`/`runUnlock`) and closes it on the way out.
 *
 * This command calls `initLedgerRuntime()` itself rather than `bootstrap()`:
 * `bootstrap()` also runs migrations, which a one-shot operator command must
 * never do, and without `initLedgerRuntime()` no ledger hook is registered in
 * this process, so `settleLeg`'s fill would write no ledger row at all
 * (`positions.service.ts`'s `runFillHooks` returns early with nothing
 * registered).
 */
import { eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';

import type { Database } from '@/db';
import * as schema from '@/db/schema';
import {
  findFlaggedOptionLegs,
  findOptionLegOwner,
} from '@/features/positions/option-settlement.query';
import { settleLeg, type SettlementOutcome } from '@/features/positions/option-settlement.service';
import { config } from '@/lib/config';
import { initLedgerRuntime } from '@/lib/ledger-runtime';

interface SettleRequest {
  legId: string;
  outcome: string;
}

interface ParsedExpireArgs {
  user?: string;
  allUsers: boolean;
  settles: SettleRequest[];
  settledAt?: string;
  quantity?: string;
  fees?: string;
  error?: string;
}

/**
 * Parses `[--user <email>] [--all-users] [--settle <legId>=<outcome>]*
 * [--date <iso>] [--quantity <n>] [--fees <amount>]` (design C11 synopsis).
 * Pure (no IO), so the grammar — including the Restriction "exactly one of
 * --user and --all-users" and AC 9.2's "no outcome is assumed" (a bare
 * `--settle <legId>` with no `=<outcome>`) — is unit-testable without a
 * database. `--date`/`--quantity`/`--fees` apply to every `--settle` in the
 * run, matching the one-value-per-run shape of the synopsis.
 */
export function parsePositionsExpireArgs(args: string[]): ParsedExpireArgs {
  let user: string | undefined;
  let allUsers = false;
  const settles: SettleRequest[] = [];
  let settledAt: string | undefined;
  let quantity: string | undefined;
  let fees: string | undefined;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--user') {
      user = args[++i];
      if (user === undefined) return { allUsers, settles, error: '--user requires a value' };
    } else if (arg === '--all-users') {
      allUsers = true;
    } else if (arg === '--settle') {
      const value = args[++i];
      if (value === undefined) return { allUsers, settles, error: '--settle requires a value' };
      const eqIdx = value.indexOf('=');
      const legId = eqIdx === -1 ? value : value.slice(0, eqIdx);
      const outcome = eqIdx === -1 ? '' : value.slice(eqIdx + 1);
      if (eqIdx === -1 || legId === '' || outcome === '') {
        return {
          allUsers,
          settles,
          error: `--settle requires <legId>=<outcome>, got: ${value}`,
        };
      }
      settles.push({ legId, outcome });
    } else if (arg === '--date') {
      settledAt = args[++i];
      if (settledAt === undefined) return { allUsers, settles, error: '--date requires a value' };
    } else if (arg === '--quantity') {
      quantity = args[++i];
      if (quantity === undefined)
        return { allUsers, settles, error: '--quantity requires a value' };
    } else if (arg === '--fees') {
      fees = args[++i];
      if (fees === undefined) return { allUsers, settles, error: '--fees requires a value' };
    } else {
      return { allUsers, settles, error: `Unexpected argument: ${arg}` };
    }
  }

  if (user === undefined && !allUsers) {
    return { user, allUsers, settles, error: 'Exactly one of --user or --all-users is required' };
  }
  if (user !== undefined && allUsers) {
    return { user, allUsers, settles, error: 'Specify only one of --user or --all-users' };
  }

  return { user, allUsers, settles, settledAt, quantity, fees };
}

/**
 * Entrypoint used by both `runPositionsExpireCli` and the integration test,
 * which passes its own per-test transaction handle (the "injectable database
 * handle" the task prompt calls for).
 *
 * `--user` resolves to that user's flagged legs and, for `--settle`, settles
 * through that resolved owner — so a leg belonging to someone else fails
 * exactly as `settleLeg` already fails a foreign id (`lockLegs` scopes by
 * `userId` and finds nothing, so `settleLegTx` throws `NotFoundError`).
 * `--all-users` lists and settles across every user, looking up each
 * `--settle` leg's real owner first (AC 9.4 continues past that single
 * failure when the leg does not exist at all).
 */
export async function runPositionsExpire(argv: string[], deps: { db: Database }): Promise<number> {
  const parsed = parsePositionsExpireArgs(argv);
  if (parsed.error !== undefined) {
    console.error(parsed.error);
    return 2;
  }

  try {
    initLedgerRuntime();

    let scopedUserId: string | undefined;
    if (parsed.user !== undefined) {
      const rows = await deps.db
        .select({ id: schema.users.id })
        .from(schema.users)
        .where(eq(schema.users.email, parsed.user))
        .limit(1);
      const found = rows[0];
      if (!found) {
        console.error(`No account found for ${parsed.user}.`);
        return 1;
      }
      scopedUserId = found.id;
    }

    const flagged = await findFlaggedOptionLegs(deps.db, scopedUserId);
    for (const leg of flagged) {
      console.log(`Flagged: ${leg.id} ${leg.symbol}`);
    }

    if (parsed.settles.length === 0) {
      return 0;
    }

    let anyFailed = false;
    for (const { legId, outcome } of parsed.settles) {
      try {
        let ownerId = scopedUserId;
        if (ownerId === undefined) {
          const owner = await findOptionLegOwner(deps.db, legId);
          if (owner === undefined) {
            throw new Error(`No such position: ${legId}`);
          }
          ownerId = owner;
        }
        await settleLeg(deps.db, ownerId, legId, {
          outcome: outcome as SettlementOutcome,
          settledAt: parsed.settledAt,
          quantity: parsed.quantity,
          fees: parsed.fees,
        });
        console.log(`Settled: ${legId}`);
      } catch (err) {
        anyFailed = true;
        console.error(`Failed: ${legId} — ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    return anyFailed ? 1 : 0;
  } catch (err) {
    console.error('Cannot complete positions expire.');
    console.error(err instanceof Error ? err.message : String(err));
    return 2;
  }
}

/**
 * Entrypoint for `tradr positions expire`. Opens the CLI's own pooler-safe,
 * one-connection drizzle handle over `DIRECT_DATABASE_URL` or
 * `DATABASE_URL` — never the app pool, and never full `bootstrap()`, which
 * runs migrations.
 */
export async function runPositionsExpireCli(argv: string[]): Promise<number> {
  const sql = postgres(config.DIRECT_DATABASE_URL ?? config.DATABASE_URL, {
    max: 1,
    prepare: false,
    onnotice: () => {},
  });
  const db = drizzle(sql, { schema }) as Database;
  try {
    return await runPositionsExpire(argv, { db });
  } finally {
    await sql.end();
  }
}

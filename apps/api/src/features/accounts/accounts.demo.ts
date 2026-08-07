import { and, eq, isNull } from 'drizzle-orm';

import type { Database, Transaction } from '@/db';
import { users } from '@/db/schema';
import {
  addFillTx,
  closePositionTx,
  createPositionTx,
  openPositionTx,
} from '@/features/positions/positions.service';
import { ConflictError } from '@/lib/errors';
import { withTransaction } from '@/lib/transaction';

import {
  clearDisplayCurrency,
  countAccountsByUser,
  deleteAccount,
  deleteLedgerEntriesByAccount,
  deletePositionsByAccount,
  findAccountById,
  insertAccount,
  selectDemoMarker,
  setDemoMarker,
} from './accounts.query';

/**
 * Sample-data seeding for a user who wants to see a populated product before
 * typing their own trades in.
 *
 * Why this drives the real service layer instead of inserting rows: realized
 * P&L is NOT stored on the position — it is derived by the accounting hooks
 * that fire inside `addFillTx` and `closePositionTx`, and those derived ledger
 * rows are what the balance, equity curve, performance widgets and tax summary
 * all aggregate from. Inserting positions and fills directly would produce an
 * account that looks right in the positions table and reads as zero everywhere
 * else. So each sample trade goes through the same path the UI uses:
 *
 *   createPositionTx -> addFillTx(entry) -> openPositionTx
 *                    -> addFillTx(exit)  -> closePositionTx
 *
 * `apps/api/src/db/seed/demo.ts` establishes this pattern for the local dev
 * fixture; this is the per-user, single-account version of it.
 */

const DEMO_ACCOUNT_NAME = 'Demo Account';
const DEMO_CURRENCY = 'USD';
const DEMO_STARTING_BALANCE = '25000.00';
/** Seeds the position-size calculator, so the sample account demonstrates it. */
const DEMO_RISK_PERCENT = '1.00';
/** A flat per-fill commission. Constant so every figure below stays checkable by hand. */
const DEMO_FILL_FEE = '1.00';

interface DemoTradeBase {
  symbol: string;
  side: 'long' | 'short';
  quantity: string;
  entryPrice: string;
  entryAt: string;
  notes?: string;
  stopLoss?: string;
  targetPrice?: string;
}

interface DemoClosedTrade extends DemoTradeBase {
  status: 'closed';
  exitPrice: string;
  exitAt: string;
}
interface DemoOpenTrade extends DemoTradeBase {
  status: 'open';
}
/** A planned trade: the entry fill is recorded but the position was never opened. */
interface DemoDraftTrade extends DemoTradeBase {
  status: 'draft';
}

type DemoTrade = DemoClosedTrade | DemoOpenTrade | DemoDraftTrade;

/**
 * The sample trades, written out in full rather than generated.
 *
 * Everything here is a literal — symbols, sizes, prices and timestamps — so the
 * account is byte-for-byte the same on every machine and every run. That is
 * load-bearing rather than tidy: the documentation screenshots and the
 * end-to-end assertions are both written against these exact figures, so a
 * value that moved between runs would silently invalidate both. Reading the
 * table is also the only way a docs author can quote a number without booting
 * the stack.
 *
 * The timestamps are absolute, not offsets from the seeding time, for the same
 * reason — a "30 days ago" trade would put a different date on every screenshot
 * and break any assertion that names one. The trade-off is that the window ages:
 * when it drifts too far into the past to look current, move the dates forward
 * here in one deliberate change and regenerate the screenshots alongside it.
 *
 * Deliberately a mix: seven winners and three losers across long and short,
 * three positions still open, and one planned trade never opened — enough for
 * the win rate, the equity curve, the open-position table and the drafts view
 * to each have something real to show. Every closed trade exits its full entry
 * quantity in one fill, which keeps each realized figure exact to the cent.
 *
 * Realized P&L works out to +1,728.00 over the ten closed trades, against a
 * 25,000.00 opening balance.
 */
const DEMO_TRADES: readonly DemoTrade[] = [
  {
    status: 'closed',
    symbol: 'AAPL',
    side: 'long',
    quantity: '50',
    entryPrice: '182.40',
    entryAt: '2026-02-03T14:45:00.000Z',
    exitPrice: '191.20',
    exitAt: '2026-02-19T18:20:00.000Z',
    notes: 'Breakout above the January range on volume',
  },
  {
    status: 'closed',
    symbol: 'MSFT',
    side: 'long',
    quantity: '20',
    entryPrice: '402.50',
    entryAt: '2026-02-10T15:10:00.000Z',
    exitPrice: '418.75',
    exitAt: '2026-03-02T17:05:00.000Z',
  },
  {
    status: 'closed',
    symbol: 'NVDA',
    side: 'long',
    quantity: '40',
    entryPrice: '118.25',
    entryAt: '2026-02-24T14:35:00.000Z',
    exitPrice: '109.50',
    exitAt: '2026-03-04T19:30:00.000Z',
    notes: 'Cut it early — the thesis broke on the guidance',
  },
  {
    status: 'closed',
    symbol: 'TSLA',
    side: 'short',
    quantity: '30',
    entryPrice: '248.60',
    entryAt: '2026-03-09T16:00:00.000Z',
    exitPrice: '236.40',
    exitAt: '2026-03-18T15:45:00.000Z',
    notes: 'Faded the opening gap',
  },
  {
    status: 'closed',
    symbol: 'AMD',
    side: 'long',
    quantity: '60',
    entryPrice: '152.80',
    entryAt: '2026-03-23T14:40:00.000Z',
    exitPrice: '146.20',
    exitAt: '2026-03-31T18:55:00.000Z',
  },
  {
    status: 'closed',
    symbol: 'SPY',
    side: 'long',
    quantity: '25',
    entryPrice: '528.40',
    entryAt: '2026-04-06T13:45:00.000Z',
    exitPrice: '545.60',
    exitAt: '2026-04-24T19:10:00.000Z',
    notes: 'Trend continuation, added on the pullback',
  },
  {
    status: 'closed',
    symbol: 'META',
    side: 'long',
    quantity: '15',
    entryPrice: '486.00',
    entryAt: '2026-04-13T15:25:00.000Z',
    exitPrice: '512.50',
    exitAt: '2026-05-01T17:40:00.000Z',
  },
  {
    status: 'closed',
    symbol: 'GOOGL',
    side: 'long',
    quantity: '45',
    entryPrice: '172.60',
    entryAt: '2026-05-11T14:50:00.000Z',
    exitPrice: '168.90',
    exitAt: '2026-05-19T18:15:00.000Z',
    notes: 'Stopped out at the structural low',
  },
  {
    status: 'closed',
    symbol: 'AMZN',
    side: 'long',
    quantity: '35',
    entryPrice: '178.20',
    entryAt: '2026-06-01T15:05:00.000Z',
    exitPrice: '189.40',
    exitAt: '2026-06-17T18:30:00.000Z',
  },
  {
    status: 'closed',
    symbol: 'QQQ',
    side: 'long',
    quantity: '20',
    entryPrice: '462.80',
    entryAt: '2026-06-22T14:30:00.000Z',
    exitPrice: '478.30',
    exitAt: '2026-07-08T19:00:00.000Z',
    notes: 'Scaled out into strength',
  },
  {
    status: 'open',
    symbol: 'NFLX',
    side: 'long',
    quantity: '10',
    entryPrice: '638.40',
    entryAt: '2026-07-13T15:20:00.000Z',
    stopLoss: '612.00',
    targetPrice: '690.00',
  },
  {
    status: 'open',
    symbol: 'JPM',
    side: 'long',
    quantity: '55',
    entryPrice: '198.75',
    entryAt: '2026-07-20T14:55:00.000Z',
    stopLoss: '191.50',
    targetPrice: '214.00',
  },
  {
    status: 'open',
    symbol: 'PLTR',
    side: 'long',
    quantity: '200',
    entryPrice: '32.40',
    entryAt: '2026-07-27T16:10:00.000Z',
    stopLoss: '30.20',
    targetPrice: '37.50',
  },
  {
    status: 'draft',
    symbol: 'UBER',
    side: 'long',
    quantity: '80',
    entryPrice: '68.90',
    entryAt: '2026-07-30T13:50:00.000Z',
    stopLoss: '66.00',
    targetPrice: '74.50',
    notes: 'Waiting for a close above the range high before taking it',
  },
];

/**
 * Create the sample account and everything booked against it for one user.
 *
 * Refused when the user already has any account. Sample figures are kept out of
 * real ones by keeping the two mutually exclusive, not by filtering the demo
 * account out of every aggregate — so seeding alongside a real account would
 * quietly corrupt the user's own totals. This is the seeding half of that rule;
 * the delete-and-replace half lives in account creation.
 *
 * The whole seed runs in one transaction: a failure part-way through leaves no
 * account, no positions, no fills and no ledger rows rather than a half-built
 * account the user would have to clean up by hand.
 *
 * Uses no optional integration — no object storage, no cache, no quote
 * provider, no billing — so a self-hosted deployment with nothing configured
 * gets exactly the same sample data a hosted one does.
 */
export async function seedDemoAccount(db: Database, userId: string) {
  return withTransaction(db, async (tx) => {
    const accountCount = await countAccountsByUser(tx, userId);
    if (accountCount > 0) {
      throw new ConflictError('Sample data can only be added to an empty account list');
    }

    const [row] = await insertAccount(tx, {
      userId,
      name: DEMO_ACCOUNT_NAME,
      currency: DEMO_CURRENCY,
      startingBalance: DEMO_STARTING_BALANCE,
      defaultRiskPercent: DEMO_RISK_PERCENT,
      isDemo: true,
    });

    // Same first-writer-wins materialization real account creation performs, so
    // the sample account reports in a currency instead of leaving the totals
    // that need one blank. Only fires when the user has never had an account.
    const latched = await tx
      .update(users)
      .set({ displayCurrency: DEMO_CURRENCY })
      .where(and(eq(users.id, userId), isNull(users.displayCurrency)))
      .returning({ id: users.id });

    // Whether that fired has to be written down now. It is the one thing about
    // this seed that outlives the data: nothing else in the app ever writes the
    // column again, so afterwards a currency the sample data set is
    // indistinguishable from one the user's own first account set — and only
    // the first of those is teardown's to undo.
    await setDemoMarker(tx, userId, {
      accountId: row.id,
      latchedDisplayCurrency: latched.length > 0,
    });

    for (const trade of DEMO_TRADES) {
      const position = await createPositionTx(tx, userId, {
        accountId: row.id,
        symbol: trade.symbol,
        side: trade.side,
        assetType: 'stock',
        notes: trade.notes ?? null,
        stopLoss: trade.stopLoss ?? null,
        targetPrice: trade.targetPrice ?? null,
      });

      // Drafts get their entry fill too, so the user can open one from the UI
      // exactly as they would their own planned trade.
      await addFillTx(tx, position.id, userId, {
        type: 'entry',
        price: trade.entryPrice,
        quantity: trade.quantity,
        fees: DEMO_FILL_FEE,
        filledAt: trade.entryAt,
      });
      if (trade.status === 'draft') continue;

      await openPositionTx(tx, position.id, userId, trade.entryAt);
      if (trade.status === 'open') continue;

      await addFillTx(tx, position.id, userId, {
        type: 'exit',
        price: trade.exitPrice,
        quantity: trade.quantity,
        fees: DEMO_FILL_FEE,
        filledAt: trade.exitAt,
      });
      await closePositionTx(tx, position.id, userId, trade.exitAt);
    }

    const joined = await findAccountById(tx, row.id, userId);
    return joined[0];
  });
}

/**
 * Remove the sample account and everything booked against it — the inverse of
 * the seed above.
 *
 * NO CHECKING HAPPENS HERE. The caller has already established that the account
 * belongs to this user and that its stored flag marks it as sample data, and
 * this function deletes unconditionally on the strength of that. It must never
 * be reached any other way.
 *
 * Order is dictated by the references: ledger rows and positions both hold a
 * restricted reference to the account, so they go first, and a position's fills
 * follow it automatically because that one cascades. Nothing can be quietly
 * missed — a surviving row would stop the account delete and take the whole
 * transaction down with it rather than being left dangling.
 *
 * Positions are deleted directly rather than through the position service,
 * which would post reversal entries into a ledger that is about to cease to
 * exist. Real trading history is corrected by reversal because it is a record;
 * sample data is not a record of anything, and leaves no trace instead.
 */
export async function teardownDemoAccount(tx: Transaction, userId: string, accountId: string) {
  await deleteLedgerEntriesByAccount(tx, accountId);
  await deletePositionsByAccount(tx, accountId);
  await deleteAccount(tx, accountId, userId);

  const marker = await selectDemoMarker(tx, userId);

  // The seed sets a display currency for a user who has none, so the sample
  // figures have something to report in. Left behind, that is a permanent
  // preference change made by disposable data: nothing else writes the column,
  // so a real account created afterwards in another currency would go on
  // reporting in the sample one for good. Undone only when the seed is what set
  // it — and only with nothing of the user's own left to report on, since
  // clearing it out from under a real account would leave that account's cross
  // -currency totals blank with no way to restore them.
  if (marker?.latchedDisplayCurrency && (await countAccountsByUser(tx, userId)) === 0) {
    await clearDisplayCurrency(tx, userId);
  }

  // The id stays behind deliberately: it is what lets a second teardown of the
  // same account be a success rather than a 404, without that answer ever being
  // available for an id that was never this user's.
  await setDemoMarker(tx, userId, { accountId });
}

/**
 * Was this account the user's sample account? Answered from the marker alone,
 * which survives the row, so a teardown arriving after the account is already
 * gone can be told apart from one naming an id the user never had.
 */
export async function wasDemoAccount(
  tx: Transaction,
  userId: string,
  accountId: string,
): Promise<boolean> {
  const marker = await selectDemoMarker(tx, userId);
  return marker?.accountId === accountId;
}

/**
 * Demo / dummy data generator for local development.
 *
 * Populates the dev database with believable, internally-consistent data for a
 * couple of demo users so every screen (dashboard, positions, performance,
 * accounting/ledger, expenses/tax, advisor, wallet, admin) has something real
 * to render.
 *
 * Why it drives the service layer instead of raw inserts: ledger P&L entries
 * are NOT stored directly — they are derived by the accounting close-hook that
 * fires inside `closePositionTx()` when a position transitions to `closed`
 * (see apps/api/src/features/accounting/ledger-hook.ts). Account balances, the
 * equity curve and the performance widgets all aggregate from those derived
 * rows. So each closed position is created through the real lifecycle
 * (createPosition → addFill(entry) → openPosition → addFill(exit) →
 * closePosition); the ledger falls out automatically and stays correct as the
 * business logic evolves. Fees are computed with the same `calculateFees` the
 * app uses.
 *
 * Repeatable: deterministic (mulberry32 RNG) and idempotent. Each run resets
 * the demo users' data (keeping the user rows so logins are preserved) and
 * regenerates from scratch — same picture every time.
 *
 * Usage:
 *   pnpm --filter @tradr/api seed     # or: make seed-demo  (no API server needed)
 *
 * Logins it creates (password is `devpass123` for all):
 *   dev@example.com    — admin, USD, rich data + advisor + wallet
 *   demo2@example.com  — non-admin, CAD, lighter data
 */
import { randomUUID } from 'node:crypto';

import bcrypt from 'bcrypt';
import { eq } from 'drizzle-orm';

import { calculateFees } from '@tradr/shared';
import type { FeeScheduleInput } from '@tradr/shared';

import { bootstrap } from '@/app';
import { db, sql, type Transaction } from '@/db';
import {
  accounts,
  advisorConversations,
  advisorMessages,
  advisorProviderKeys,
  advisorTurnCounters,
  brokerages,
  csvImportStaging,
  dashboardLayouts,
  exchangeRates,
  expenses,
  externalApiKeys,
  feeSchedules,
  ledgerEntries,
  positions,
  usageRecords,
  users,
  walletTransactions,
  wallets,
} from '@/db/schema';
import { insertUser, selectUserByEmail } from '@/features/auth/auth.query';
import { buildDefaultLayout } from '@/features/dashboard/dashboard.service';
import {
  addFillTx,
  closePositionTx,
  createPositionTx,
  openPositionTx,
} from '@/features/positions/positions.service';
import { logger } from '@/lib/logger';

import { mulberry32 } from './rng';

// --- Static, believable inputs ------------------------------------------------

const DEMO_PASSWORD = 'devpass123';
const BCRYPT_COST = 10;
const DAY_MS = 86_400_000;

// name -> rough current price, used as an anchor for generated entry prices.
const STOCK_ANCHORS: Record<string, number> = {
  AAPL: 195,
  MSFT: 420,
  NVDA: 122,
  TSLA: 250,
  AMZN: 182,
  GOOGL: 176,
  META: 505,
  SPY: 542,
  QQQ: 472,
  AMD: 158,
  NFLX: 655,
  JPM: 202,
  DIS: 108,
  BA: 178,
  COIN: 232,
  PLTR: 34,
  SOFI: 9,
  UBER: 71,
  INTC: 31,
  F: 12,
};
const STOCK_SYMBOLS = Object.keys(STOCK_ANCHORS);
// Option premium anchors (per-share price; contract multiplier ×100 is applied
// by the P&L engine).
const OPTION_ANCHORS: Record<string, number> = {
  SPY: 4.2,
  QQQ: 3.8,
  AAPL: 2.6,
  NVDA: 5.5,
  TSLA: 6.4,
};
const OPTION_SYMBOLS = Object.keys(OPTION_ANCHORS);

const TRADE_NOTES = [
  'Breakout above resistance on volume',
  'Earnings momentum play',
  'Oversold bounce off the 200DMA',
  'Trend continuation, added on pullback',
  'Cut early — thesis broke',
  'Scaled out into strength',
  'Gap-fill reversal',
  'News catalyst, quick scalp',
];

// Fee schedules, keyed by the per-user brokerage we create below. Values mirror
// the test fixtures in brokerages.seed.ts so behaviour matches existing tests.
const BROKER_SCHEDULES: Record<string, FeeScheduleInput> = {
  Robinhood: {
    stockPerShareCommission: '0',
    stockMinPerFill: '0',
    stockMaxPerFill: '0',
    optionsPerContractCommission: '0',
    optionsPerContractExchangeFee: '0.03',
    optionsMinPerFill: '0',
    optionsMaxPerFill: '0',
  },
  'Interactive Brokers': {
    stockPerShareCommission: '0.005',
    stockMinPerFill: '1.00',
    stockMaxPerFill: '0',
    optionsPerContractCommission: '0.65',
    optionsPerContractExchangeFee: '0.15',
    optionsMinPerFill: '1.00',
    optionsMaxPerFill: '0',
  },
  'Legacy Full-Service': {
    stockPerShareCommission: '0.01',
    stockMinPerFill: '4.95',
    stockMaxPerFill: '9.95',
    optionsPerContractCommission: '1.25',
    optionsPerContractExchangeFee: '0.30',
    optionsMinPerFill: '4.95',
    optionsMaxPerFill: '0',
  },
};

const EXPENSE_ITEMS: Record<string, Array<[string, number]>> = {
  data_subscription: [
    ['TradingView Premium', 59.95],
    ['Benzinga Pro', 99],
    ['Koyfin Plus', 39],
  ],
  platform_fee: [
    ['Broker platform fee', 14.99],
    ['Level 2 data', 24.5],
  ],
  software: [
    ['TraderSync journal', 29.95],
    ['Microsoft 365', 9.99],
    ['Notion', 8],
  ],
  education: [
    ['Options mastery course', 199],
    ['"Trading in the Zone"', 18.99],
    ['Live webinar', 49],
  ],
  hardware: [
    ['27" 4K monitor', 329],
    ['Mechanical keyboard', 89],
    ['Laptop stand', 45],
  ],
  other: [
    ['Co-working day pass', 25],
    ['Research coffee', 6.5],
  ],
};

// FX anchors (base/USD). Direct EUR/USD covers both directions via inverse lookup.
const FX_ANCHORS: Record<string, number> = { EUR: 1.08, GBP: 1.27, CAD: 0.73 };

// --- Config -------------------------------------------------------------------

interface AccountSpec {
  name: string;
  currency: string;
  broker: keyof typeof BROKER_SCHEDULES;
  weight: number; // share of this user's positions, and whether it favours options
  optionHeavy?: boolean;
}

interface DemoUserConfig {
  email: string;
  isAdmin: boolean;
  displayCurrency: string;
  taxJurisdiction: 'US' | 'CA' | 'other';
  theme: 'light' | 'dark' | 'system';
  rngSeed: number;
  positionCount: number;
  expenseCount: number;
  accounts: AccountSpec[];
  withAdvisor: boolean;
  withWallet: boolean;
  withCsvHistory: boolean;
}

const DEMO_USERS: DemoUserConfig[] = [
  {
    email: 'dev@example.com',
    isAdmin: true,
    displayCurrency: 'USD',
    taxJurisdiction: 'US',
    theme: 'dark',
    rngSeed: 1337,
    positionCount: 110,
    expenseCount: 36,
    withAdvisor: true,
    withWallet: true,
    withCsvHistory: true,
    accounts: [
      { name: 'Main Brokerage', currency: 'USD', broker: 'Robinhood', weight: 4 },
      { name: 'Swing Account', currency: 'USD', broker: 'Interactive Brokers', weight: 3 },
      {
        name: 'Options Account',
        currency: 'USD',
        broker: 'Interactive Brokers',
        weight: 2,
        optionHeavy: true,
      },
      { name: 'Euro Account', currency: 'EUR', broker: 'Legacy Full-Service', weight: 1 },
    ],
  },
  {
    email: 'demo2@example.com',
    isAdmin: false,
    displayCurrency: 'CAD',
    taxJurisdiction: 'CA',
    theme: 'light',
    rngSeed: 4242,
    positionCount: 28,
    expenseCount: 10,
    withAdvisor: false,
    withWallet: false,
    withCsvHistory: false,
    accounts: [{ name: 'TFSA', currency: 'CAD', broker: 'Interactive Brokers', weight: 1 }],
  },
];

// --- RNG helpers --------------------------------------------------------------

type Rng = () => number;
const pick = <T>(rng: Rng, arr: readonly T[]): T => arr[Math.floor(rng() * arr.length)];
const between = (rng: Rng, min: number, max: number) => min + rng() * (max - min);
const randInt = (rng: Rng, min: number, max: number) => Math.floor(between(rng, min, max + 1));
const chance = (rng: Rng, p: number) => rng() < p;
const r2 = (n: number) => n.toFixed(2);

function feeFor(
  schedule: FeeScheduleInput,
  assetType: 'stock' | 'option',
  qty: number,
  price: number,
  side: 'buy' | 'sell',
): string {
  return calculateFees(
    [{ quantity: String(qty), price: r2(price), type: assetType, side }],
    schedule,
  ).perFillFees[0];
}

// --- Reset (keep the user row + builtin personas) -----------------------------

async function resetUserData(tx: Transaction, userId: string) {
  // Order respects FK edges: child-before-parent, and RESTRICT edges
  // (positions→accounts, ledger→accounts, accounts→brokerages) deleted first.
  await tx.delete(walletTransactions).where(eq(walletTransactions.userId, userId));
  await tx.delete(usageRecords).where(eq(usageRecords.userId, userId));
  await tx.delete(wallets).where(eq(wallets.userId, userId));
  await tx.delete(advisorTurnCounters).where(eq(advisorTurnCounters.userId, userId));
  await tx.delete(advisorProviderKeys).where(eq(advisorProviderKeys.userId, userId));
  await tx.delete(externalApiKeys).where(eq(externalApiKeys.userId, userId));
  await tx.delete(advisorConversations).where(eq(advisorConversations.userId, userId)); // cascades messages
  await tx.delete(csvImportStaging).where(eq(csvImportStaging.userId, userId));
  await tx.delete(ledgerEntries).where(eq(ledgerEntries.userId, userId));
  await tx.delete(positions).where(eq(positions.userId, userId)); // cascades fills
  await tx.delete(expenses).where(eq(expenses.userId, userId));
  await tx.delete(exchangeRates).where(eq(exchangeRates.userId, userId));
  await tx.delete(dashboardLayouts).where(eq(dashboardLayouts.userId, userId));
  await tx.delete(accounts).where(eq(accounts.userId, userId));
  await tx.delete(brokerages).where(eq(brokerages.userId, userId)); // cascades fee_schedules
}

// --- Builders -----------------------------------------------------------------

async function ensureUser(cfg: DemoUserConfig): Promise<string> {
  const existing = await selectUserByEmail(db, cfg.email);
  if (existing) return existing.id;
  const passwordHash = await bcrypt.hash(DEMO_PASSWORD, BCRYPT_COST);
  const user = await insertUser(db, { email: cfg.email, passwordHash });
  return user.id;
}

async function createBrokerages(tx: Transaction, userId: string, specs: AccountSpec[]) {
  const names = [...new Set(specs.map((s) => s.broker))];
  const map = new Map<string, { id: string; schedule: FeeScheduleInput }>();
  for (const name of names) {
    const [row] = await tx.insert(brokerages).values({ userId, name }).returning();
    const schedule = BROKER_SCHEDULES[name];
    await tx.insert(feeSchedules).values({ brokerageId: row.id, ...schedule });
    map.set(name, { id: row.id, schedule });
  }
  return map;
}

interface SeededAccount extends AccountSpec {
  id: string;
  schedule: FeeScheduleInput;
}

async function createAccounts(
  tx: Transaction,
  userId: string,
  specs: AccountSpec[],
  brokerMap: Map<string, { id: string; schedule: FeeScheduleInput }>,
): Promise<SeededAccount[]> {
  const out: SeededAccount[] = [];
  for (const spec of specs) {
    const broker = brokerMap.get(spec.broker)!;
    const [row] = await tx
      .insert(accounts)
      .values({ userId, name: spec.name, currency: spec.currency, brokerageId: broker.id })
      .returning();
    out.push({ ...spec, id: row.id, schedule: broker.schedule });
  }
  return out;
}

// Strike rounding interval by underlying price (mirrors typical listed strikes).
function strikeInterval(price: number): number {
  if (price < 25) return 1;
  if (price < 200) return 5;
  return 10;
}

// UTC Friday on or after `d` (listed options expire on Fridays).
function nextFriday(d: Date): Date {
  const r = new Date(d);
  r.setUTCDate(r.getUTCDate() + ((5 - r.getUTCDay() + 7) % 7));
  return r;
}

// Build a compact OCC option symbol (Form 4) that `parseOccSymbol` decodes into
// underlying + expiry + call/put + strike, e.g. NVDA260321C120. ≤15 chars, so it
// fits positions.symbol varchar(20). This is the v1 "compact display form" the
// app stores option symbols in (see packages/shared/src/lib/occ.ts).
function buildOptionSymbol(rng: Rng, underlying: string, openedAt: Date): string {
  const spot = STOCK_ANCHORS[underlying] ?? 100;
  const interval = strikeInterval(spot);
  const strike = Math.max(
    interval,
    Math.round((spot + randInt(rng, -3, 3) * interval) / interval) * interval,
  );
  const type = chance(rng, 0.6) ? 'C' : 'P';
  const exp = nextFriday(new Date(openedAt.getTime() + randInt(rng, 21, 112) * DAY_MS));
  const yy = String(exp.getUTCFullYear() - 2000).padStart(2, '0');
  const mm = String(exp.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(exp.getUTCDate()).padStart(2, '0');
  return `${underlying}${yy}${mm}${dd}${type}${strike}`;
}

interface PositionTally {
  closed: number;
  open: number;
  draft: number;
}

async function generatePositions(
  tx: Transaction,
  userId: string,
  accts: SeededAccount[],
  count: number,
  rng: Rng,
  now: number,
): Promise<PositionTally> {
  const tally: PositionTally = { closed: 0, open: 0, draft: 0 };
  const totalWeight = accts.reduce((s, a) => s + a.weight, 0);
  const start = now - 14 * 30 * DAY_MS; // ~14 months back

  for (let i = 0; i < count; i++) {
    // Weighted account pick.
    let roll = rng() * totalWeight;
    const account = accts.find((a) => (roll -= a.weight) < 0) ?? accts[0];

    const assetType: 'stock' | 'option' = chance(rng, account.optionHeavy ? 0.6 : 0.1)
      ? 'option'
      : 'stock';
    const symbol = pick(rng, assetType === 'option' ? OPTION_SYMBOLS : STOCK_SYMBOLS);
    const side: 'long' | 'short' = chance(rng, 0.78) ? 'long' : 'short';

    const statusRoll = rng();
    const status = statusRoll < 0.72 ? 'closed' : statusRoll < 0.9 ? 'open' : 'draft';

    // Entry price + quantity.
    const anchor = (assetType === 'option' ? OPTION_ANCHORS : STOCK_ANCHORS)[symbol];
    const entryPrice = anchor * between(rng, 0.9, 1.12);
    const qty =
      assetType === 'option'
        ? randInt(rng, 1, 15)
        : Math.max(1, Math.round((2000 + rng() * 14000) / entryPrice));

    // Timeline.
    let openedAt: Date;
    let closedAt: Date | null = null;
    if (status === 'closed') {
      openedAt = new Date(between(rng, start, now - 4 * DAY_MS));
      const hold = between(rng, 0.25, 45) * DAY_MS;
      closedAt = new Date(Math.min(openedAt.getTime() + hold, now - DAY_MS));
    } else if (status === 'open') {
      openedAt = new Date(between(rng, now - 100 * DAY_MS, now - DAY_MS));
    } else {
      openedAt = new Date(between(rng, now - 14 * DAY_MS, now));
    }

    const notes = chance(rng, 0.3) ? pick(rng, TRADE_NOTES) : null;

    const positionSymbol =
      assetType === 'option' ? buildOptionSymbol(rng, symbol, openedAt) : symbol;

    // 1. Create draft.
    const pos = await createPositionTx(tx, userId, {
      accountId: account.id,
      symbol: positionSymbol,
      side,
      assetType,
      notes,
    });

    // 2. Entry fill (drafts get one too, so they can be opened later in the UI).
    const entryFee = feeFor(
      account.schedule,
      assetType,
      qty,
      entryPrice,
      side === 'long' ? 'buy' : 'sell',
    );
    await addFillTx(tx, pos.id, userId, {
      type: 'entry',
      price: r2(entryPrice),
      quantity: String(qty),
      fees: entryFee,
      filledAt: openedAt.toISOString(),
    });

    if (status === 'draft') {
      tally.draft++;
      continue;
    }

    // 3. Open.
    await openPositionTx(tx, pos.id, userId, openedAt.toISOString());

    if (status === 'open') {
      tally.open++;
      continue;
    }

    // 4. Exit fill(s) — must reconcile to the entry quantity. Win/lose decides
    //    the exit price direction (P&L engine negates for shorts).
    const win = chance(rng, 0.56);
    const optScale = assetType === 'option' ? 4 : 1;
    const mag = Math.min(0.9, between(rng, 0.005, 0.16) * optScale);
    const priceDir = (side === 'long') === win ? 1 : -1;
    const exitPrice = entryPrice * (1 + priceDir * mag);

    const exitSide = side === 'long' ? 'sell' : 'buy';
    const exitTime = closedAt!.getTime();
    const splits =
      qty > 1 && chance(rng, 0.25) ? [Math.floor(qty / 2), qty - Math.floor(qty / 2)] : [qty];
    for (let s = 0; s < splits.length; s++) {
      const q = splits[s];
      const exFee = feeFor(account.schedule, assetType, q, exitPrice, exitSide);
      await addFillTx(tx, pos.id, userId, {
        type: 'exit',
        price: r2(exitPrice),
        quantity: String(q),
        fees: exFee,
        filledAt: new Date(exitTime - (splits.length - 1 - s) * 3_600_000).toISOString(),
      });
    }

    // 5. Close — fires the accounting close-hook, deriving the ledger P&L entry.
    await closePositionTx(tx, pos.id, userId, closedAt!.toISOString());
    tally.closed++;
  }

  return tally;
}

async function seedExpenses(
  tx: Transaction,
  userId: string,
  currency: string,
  count: number,
  rng: Rng,
  now: number,
) {
  const categories = Object.keys(EXPENSE_ITEMS);
  const start = now - 14 * 30 * DAY_MS;
  const rows = Array.from({ length: count }, () => {
    const category = pick(rng, categories);
    const [description, base] = pick(rng, EXPENSE_ITEMS[category]);
    const amount = base * between(rng, 0.95, 1.05);
    const occurredAt = new Date(between(rng, start, now)).toISOString().slice(0, 10);
    return {
      userId,
      category,
      description,
      amount: amount.toFixed(2),
      currency,
      occurredAt,
    };
  });
  await tx.insert(expenses).values(rows);
}

async function seedExchangeRates(
  tx: Transaction,
  userId: string,
  accts: SeededAccount[],
  displayCurrency: string,
  rng: Rng,
  now: number,
) {
  const foreign = [...new Set(accts.map((a) => a.currency))].filter((c) => c !== displayCurrency);
  const rows: Array<typeof exchangeRates.$inferInsert> = [];
  for (const currency of foreign) {
    const anchor = FX_ANCHORS[currency] ?? 1;
    // Monthly rates for the last 15 months, jittered around the anchor.
    for (let m = 15; m >= 0; m--) {
      const d = new Date(now - m * 30 * DAY_MS);
      const effectiveDate = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-01`;
      rows.push({
        userId,
        baseCurrency: currency,
        quoteCurrency: displayCurrency,
        rate: (anchor * between(rng, 0.97, 1.03)).toFixed(6),
        effectiveDate,
      });
    }
  }
  if (rows.length > 0) {
    await tx.insert(exchangeRates).values(rows).onConflictDoNothing();
  }
}

// A few canned advisor exchanges, plus the wallet usage they imply.
const ADVISOR_THREADS: Array<{ persona: string; turns: Array<[string, string]> }> = [
  {
    persona: 'default-trading-advisor',
    turns: [
      [
        'I keep getting stopped out of NVDA right before it runs. What am I doing wrong?',
        'A few likely culprits: stops placed at obvious round numbers, position size too large for your stop distance, and entering mid-move rather than on a pullback. Try sizing so your stop is 1R and place it beyond a structural level, not a fixed percentage.',
      ],
      [
        'How do I figure out a structural level?',
        'Look for the most recent higher-low on your entry timeframe and put the stop just below it. If that distance is too wide for your risk budget, the trade is too big — reduce size rather than tightening into noise.',
      ],
    ],
  },
  {
    persona: 'risk-coach',
    turns: [
      [
        'I had three losing days in a row and I want to size up to make it back.',
        "That's the revenge-trading reflex and it's where accounts go to die. Cut size, not increase it, after a drawdown. Define a daily max loss and stop for the day once you hit it — protecting capital is the edge.",
      ],
      [
        'What max daily loss makes sense?',
        'A common rule is 2–3% of account equity, or roughly your average winning day. The exact number matters less than committing to it before the session and honouring it without negotiation.',
      ],
    ],
  },
  {
    persona: 'chart-reviewer',
    turns: [
      [
        'Does SPY look like a breakout or a fakeout here?',
        "Without the chart I can't see the levels, but checklist it: is volume expanding on the break, is it holding above the prior range on a retest, and is breadth confirming? Two of three or better is a real break; one of three is usually a trap.",
      ],
    ],
  },
];

async function seedAdvisorAndWallet(tx: Transaction, userId: string, rng: Rng, now: number) {
  const model = 'claude-opus-4-8';
  const providerId = 'anthropic';

  type Txn = typeof walletTransactions.$inferInsert;
  const txnRows: Txn[] = [];

  // Opening top-up: $50 in micro-USD.
  let balance = 50_000_000n;
  txnRows.push({
    userId,
    kind: 'credit',
    amount: balance,
    balanceAfter: balance,
    stripeEventId: `evt_demo_${randomUUID().slice(0, 12)}`,
    stripePaymentIntentId: `pi_demo_${randomUUID().slice(0, 12)}`,
    createdAt: new Date(now - 25 * DAY_MS),
  });

  let totalTurns = 0;
  for (let t = 0; t < ADVISOR_THREADS.length; t++) {
    const thread = ADVISOR_THREADS[t];
    const convCreated = new Date(now - between(rng, 2, 20) * DAY_MS);
    const [conv] = await tx
      .insert(advisorConversations)
      .values({
        userId,
        title: thread.turns[0][0].slice(0, 80),
        personaId: thread.persona,
        providerId,
        model,
        createdAt: convCreated,
        updatedAt: convCreated,
      })
      .returning();

    let cursor = convCreated.getTime();
    for (const [userText, assistantText] of thread.turns) {
      const clientMessageId = randomUUID();
      cursor += 30_000;
      const userAt = new Date(cursor);
      cursor += between(rng, 4000, 12000);
      const assistantAt = new Date(cursor);

      const promptTokens = randInt(rng, 600, 3500);
      const completionTokens = randInt(rng, 200, 1200);

      await tx.insert(advisorMessages).values([
        {
          conversationId: conv.id,
          role: 'user',
          contentParts: [{ type: 'text', text: userText }],
          clientMessageId,
          createdAt: userAt,
        },
        {
          conversationId: conv.id,
          role: 'assistant',
          contentParts: [{ type: 'text', text: assistantText }],
          promptTokens,
          completionTokens,
          clientMessageId,
          createdAt: assistantAt,
        },
      ]);

      // Wallet usage for this turn.
      const creditCost = BigInt(randInt(rng, 3000, 22000)); // micro-USD
      const [usage] = await tx
        .insert(usageRecords)
        .values({
          userId,
          conversationId: conv.id,
          providerId,
          model,
          inputTokens: BigInt(promptTokens),
          outputTokens: BigInt(completionTokens),
          creditCost,
          rawCost: (creditCost * 8n) / 10n,
          createdAt: assistantAt,
        })
        .returning();

      balance -= creditCost;
      txnRows.push({
        userId,
        kind: 'debit',
        amount: -creditCost,
        balanceAfter: balance,
        usageRecordId: usage.id,
        createdAt: assistantAt,
      });
      totalTurns++;
    }

    await tx
      .update(advisorConversations)
      .set({ updatedAt: new Date(cursor) })
      .where(eq(advisorConversations.id, conv.id));
  }

  await tx
    .insert(wallets)
    .values({ userId, balance, reserved: 0n, createdAt: new Date(now - 25 * DAY_MS) });
  await tx.insert(walletTransactions).values(txnRows);

  // Monthly platform-turn counter for the current UTC month (plan-tiers
  // REQ-8.3: turn_count counts platform-key turns only). Every seeded turn
  // above writes a usage record + wallet debit — i.e. all are credits-mode
  // platform turns — so totalTurns is the correct platform count and none are
  // within-allowance (allowanceTurns: 0).
  const period = new Date(now);
  const periodKey = `${period.getUTCFullYear()}-${String(period.getUTCMonth() + 1).padStart(2, '0')}`;
  await tx
    .insert(advisorTurnCounters)
    .values({ userId, periodKey, turnCount: totalTurns, allowanceTurns: 0 });

  // Default the user's persona + consent so the advisor opens ready to go.
  await tx
    .update(users)
    .set({ advisorDefaultPersonaId: 'default-trading-advisor', advisorTradeDataConsent: true })
    .where(eq(users.id, userId));
}

async function seedCsvHistory(
  tx: Transaction,
  userId: string,
  account: SeededAccount,
  now: number,
) {
  // A single terminal (committed) import row — historical record only, never
  // surfaced as an active import. `result` is jsonb with no schema constraint.
  await tx.insert(csvImportStaging).values({
    userId,
    accountId: account.id,
    status: 'committed',
    result: { summary: { totalRows: 14, validRows: 12, errorRows: 2 }, accountId: account.id },
    committedResult: {
      positionsCreated: 12,
      fillsCreated: 24,
      positionIds: [],
      accountId: account.id,
    },
    createdAt: new Date(now - 30 * DAY_MS),
    claimedAt: new Date(now - 30 * DAY_MS),
    expiresAt: new Date(now + DAY_MS),
  });
}

// --- Orchestration ------------------------------------------------------------

async function generateForUser(cfg: DemoUserConfig, now: number) {
  const userId = await ensureUser(cfg);
  const rng = mulberry32(cfg.rngSeed);

  const tally = await db.transaction(async (tx) => {
    await resetUserData(tx, userId);

    await tx
      .update(users)
      .set({
        isAdmin: cfg.isAdmin,
        displayCurrency: cfg.displayCurrency,
        taxJurisdiction: cfg.taxJurisdiction,
        theme: cfg.theme,
        // advisor fields reset here; re-set by seedAdvisorAndWallet when applicable.
        advisorDefaultPersonaId: null,
        advisorTradeDataConsent: false,
        changelogViewedAt: new Date(now),
      })
      .where(eq(users.id, userId));

    const brokerMap = await createBrokerages(tx, userId, cfg.accounts);
    const accts = await createAccounts(tx, userId, cfg.accounts, brokerMap);

    const positionTally = await generatePositions(tx, userId, accts, cfg.positionCount, rng, now);
    await seedExpenses(tx, userId, cfg.displayCurrency, cfg.expenseCount, rng, now);
    await seedExchangeRates(tx, userId, accts, cfg.displayCurrency, rng, now);

    if (cfg.withAdvisor) await seedAdvisorAndWallet(tx, userId, rng, now);
    if (cfg.withCsvHistory) await seedCsvHistory(tx, userId, accts[0], now);

    return positionTally;
  });

  // Dashboard layout is built after commit so it reflects the committed data.
  const widgets = await buildDefaultLayout(userId);
  await db
    .insert(dashboardLayouts)
    .values({ userId, widgets })
    .onConflictDoUpdate({ target: dashboardLayouts.userId, set: { widgets } });

  logger.info('Seeded demo user', {
    email: cfg.email,
    admin: cfg.isAdmin,
    accounts: cfg.accounts.length,
    positions: cfg.positionCount,
    closed: tally.closed,
    open: tally.open,
    draft: tally.draft,
  });
  return tally;
}

async function main() {
  logger.info('Demo seed: bootstrapping (migrations + close-hook registration)…');
  await bootstrap();

  const now = Date.now();
  for (const cfg of DEMO_USERS) {
    await generateForUser(cfg, now);
  }

  logger.info(
    `Demo seed complete. Log in at the web app with any seeded email and password "${DEMO_PASSWORD}".`,
  );
  logger.info(
    'Provider/external API keys are intentionally NOT seeded (they are encrypted and the boot decrypt-canary would reject placeholder ciphertext).',
  );
}

main()
  .then(async () => {
    await sql.end({ timeout: 5 });
    process.exit(0);
  })
  .catch(async (err) => {
    logger.error('Demo seed failed', { error: err instanceof Error ? err.message : String(err) });
    console.error(err);
    await sql.end({ timeout: 5 }).catch(() => {});
    process.exit(1);
  });

import Decimal from 'decimal.js';

import {
  getCurrencyMinorUnits,
  RULE_WEIGHT_VALUES,
  type ComplianceEntry,
  type PositionCompliance,
  type TradingRule,
} from '@tradr/shared';

import type { SnapshotPosition } from '@/features/performance/performance.query';
import { classifyOne } from '@/features/performance/performance.service';
import {
  aggregateFills,
  computeOpenCostBasis,
  computeRealizationEvents,
} from '@/features/positions/pnl';
import { computeRiskReward } from '@/features/positions/risk-reward';

// The pure rule evaluator (design C5). One deterministic function from a user's
// rules and the position data around them to per-position compliance. It reads
// no database, no clock and never imports positions.service: everything it needs
// is loaded into `ScoringData` by the caller. It reuses `pnl.ts`, `risk-reward`
// and the flat classification in `performance.service`.

// --- Scoring input types (design Data Models, D3) ---

/**
 * A position with the extra fields scoring needs on top of the performance
 * snapshot row: its account, the open and creation instants, the plan prices,
 * whether it carries notes, its account timezone and starting balance.
 */
export interface ScoringPosition extends SnapshotPosition {
  accountId: string;
  openedAt: string | null;
  createdAt: string;
  stopLoss: string | null;
  targetPrice: string | null;
  hasNotes: boolean;
  accountTimezone: string;
  startingBalance: string;
}

/** One balance-type ledger row: the signed amount posted to an account. */
export interface BalanceEntry {
  accountId: string;
  occurredAt: string;
  signedAmount: string;
}

/** Everything the evaluator scores from, loaded in one read (design C4). */
export interface ScoringData {
  rules: TradingRule[];
  positions: ScoringPosition[];
  ledger: BalanceEntry[];
}

// --- Context ---

interface PopulationEvent {
  occurredAt: Date;
  netPnl: Decimal;
}

/**
 * One rule population — the non-draft positions a rule applies to (Requirement
 * 3.1), keyed on account scope, tag scope and currency. It carries the
 * population sorted by open instant then creation instant, its realisation
 * events by `occurredAt`, and its losing flat instants (design C5). Built once
 * per distinct key and memoised on the context.
 */
interface Population {
  positions: ScoringPosition[];
  events: PopulationEvent[];
  losingFlats: Date[];
}

export interface ScoringContext {
  weekStartDay: 0 | 1;
  data: ScoringData;
  byId: Map<string, ScoringPosition>;
  ledgerByAccount: Map<string, BalanceEntry[]>;
  populations: Map<string, Population>;
}

/**
 * Build a scoring context from loaded data. Indexes positions by id and ledger
 * rows by account; populations are built lazily and memoised as rules ask for
 * them, so a context with no context-type rules builds none.
 */
export function buildScoringContext(data: ScoringData, weekStartDay: 0 | 1): ScoringContext {
  const byId = new Map<string, ScoringPosition>();
  for (const p of data.positions) byId.set(p.id, p);

  const ledgerByAccount = new Map<string, BalanceEntry[]>();
  for (const e of data.ledger) {
    const list = ledgerByAccount.get(e.accountId);
    if (list) list.push(e);
    else ledgerByAccount.set(e.accountId, [e]);
  }

  return { weekStartDay, data, byId, ledgerByAccount, populations: new Map() };
}

// --- Time helpers ---

// The open instant is `openedAt`, else the creation time (design D7).
function openInstantMs(p: ScoringPosition): number {
  return new Date(p.openedAt ?? p.createdAt).getTime();
}

function createdMs(p: ScoringPosition): number {
  return new Date(p.createdAt).getTime();
}

// Population order: open instant, then creation instant (design C5).
function byOpenThenCreated(a: ScoringPosition, b: ScoringPosition): number {
  return openInstantMs(a) - openInstantMs(b) || createdMs(a) - createdMs(b);
}

// Calendar date (YYYY-MM-DD) of `date` in `timeZone`. Replicates the module-
// private `zonedDateKey` in positions.service (`en-CA` renders the zone-local
// date in ISO order, so a plain string compare is a same-day test); the private
// one is not imported (design C5).
function zonedDateKey(date: Date, timeZone: string): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(date);
}

// Weekday (0 = Sunday, per WEEKDAY_LABELS) of a YYYY-MM-DD key.
function weekdayOfKey(key: string): number {
  const [y, m, d] = key.split('-').map(Number);
  return new Date(Date.UTC(y!, m! - 1, d!)).getUTCDay();
}

// The trading-week key: the date `key` moved back to the week's start day
// (design C5). Two dates share a key iff they are in the same trading week.
function weekKeyOf(key: string, weekStartDay: 0 | 1): string {
  const [y, m, d] = key.split('-').map(Number);
  const weekday = new Date(Date.UTC(y!, m! - 1, d!)).getUTCDay();
  const daysBack = (weekday - weekStartDay + 7) % 7;
  const start = new Date(Date.UTC(y!, m! - 1, d! - daysBack));
  const yy = start.getUTCFullYear();
  const mm = String(start.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(start.getUTCDate()).padStart(2, '0');
  return `${yy}-${mm}-${dd}`;
}

// --- Populations ---

// The rule's currency scope: the params currency for a currency-amount type,
// else no currency filter.
function ruleCurrency(rule: TradingRule): string | null {
  return 'currency' in rule.definition.params ? rule.definition.params.currency : null;
}

function getPopulation(ctx: ScoringContext, rule: TradingRule): Population {
  const accountScope = rule.accountId;
  const tagScope = rule.tagId;
  const currency = ruleCurrency(rule);
  const key = `${accountScope ?? '-'}|${tagScope ?? '-'}|${currency ?? '-'}`;

  const cached = ctx.populations.get(key);
  if (cached) return cached;

  const positions = ctx.data.positions
    .filter(
      (p) =>
        p.status !== 'draft' &&
        (accountScope === null || p.accountId === accountScope) &&
        (tagScope === null || p.tags.some((t) => t.id === tagScope)) &&
        (currency === null || p.currency === currency),
    )
    .sort(byOpenThenCreated);

  const events: PopulationEvent[] = [];
  const losingFlats: Date[] = [];
  for (const p of positions) {
    const minorUnits = getCurrencyMinorUnits(p.currency);
    const side = p.side as 'long' | 'short';
    const assetType = p.assetType as 'stock' | 'option';

    for (const ev of computeRealizationEvents(
      p.fills.map((f) => ({ ...f, filledAt: new Date(f.filledAt) })),
      side,
      assetType,
      minorUnits,
    )) {
      events.push({ occurredAt: ev.occurredAt, netPnl: ev.netPnl });
    }

    const classified = classifyOne(p);
    if (classified && classified.classification === 'losing') {
      losingFlats.push(classified.closedAt);
    }
  }
  events.sort((a, b) => a.occurredAt.getTime() - b.occurredAt.getTime());
  losingFlats.sort((a, b) => a.getTime() - b.getTime());

  const population: Population = { positions, events, losingFlats };
  ctx.populations.set(key, population);
  return population;
}

// Account balance at an instant: starting balance plus every signed balance-type
// ledger amount posted strictly before it (Requirement 2.2, max_risk_percent).
function balanceAtInstant(
  ctx: ScoringContext,
  accountId: string,
  startingBalance: string,
  instantMs: number,
): Decimal {
  let balance = new Decimal(startingBalance);
  for (const e of ctx.ledgerByAccount.get(accountId) ?? []) {
    if (new Date(e.occurredAt).getTime() < instantMs) balance = balance.plus(e.signedAmount);
  }
  return balance;
}

// --- Evaluation ---

/**
 * Score one rule against one position. Returns `null` when the rule does not
 * apply (Requirement 3.1), else a `ComplianceEntry`. The evaluator compares
 * unrounded values in decimal.js and repeats the calculator's risk and notional
 * formula (design D15).
 */
export function evaluateRule(
  rule: TradingRule,
  target: ScoringPosition,
  ctx: ScoringContext,
): ComplianceEntry | null {
  // Applicability (Requirement 3.1): non-draft, account scope, tag scope, and —
  // for a currency-amount type — the account currency equals the rule currency.
  if (target.status === 'draft') return null;
  if (rule.accountId !== null && target.accountId !== rule.accountId) return null;
  if (rule.tagId !== null && !target.tags.some((t) => t.id === rule.tagId)) return null;
  const ruleCcy = ruleCurrency(rule);
  if (ruleCcy !== null && target.currency !== ruleCcy) return null;

  const def = rule.definition;

  const mk = (
    outcome: ComplianceEntry['outcome'],
    unit: ComplianceEntry['unit'],
    currency: string | null,
    measured: string | null,
    limit: string,
    reason: ComplianceEntry['reason'],
  ): ComplianceEntry => ({
    ruleId: rule.id,
    type: def.type,
    description: rule.description,
    weight: rule.weight,
    outcome,
    unit,
    currency,
    measured,
    limit,
    reason,
  });

  // Target aggregates (unrounded, decimal.js — design D15). Average entry is the
  // quantity-weighted entry price; the multiplier is 100 for an option.
  const totals = aggregateFills(target.fills);
  const entryQty = new Decimal(totals.entryQty);
  const avgEntry = entryQty.isZero() ? new Decimal(0) : new Decimal(totals.entryCost).div(entryQty);
  const mult = target.assetType === 'option' ? 100 : 1;
  const stop = target.stopLoss;
  const oInstant = openInstantMs(target);

  switch (def.type) {
    case 'max_risk_percent': {
      const limit = def.params.percent;
      if (stop === null) return mk('not_evaluable', 'percent', null, null, limit, 'no_stop_loss');
      const balance = balanceAtInstant(ctx, target.accountId, target.startingBalance, oInstant);
      if (balance.lte(0)) {
        return mk('not_evaluable', 'percent', null, null, limit, 'non_positive_balance');
      }
      const risk = avgEntry.minus(stop).abs().times(entryQty).times(mult);
      const measured = risk.div(balance).times(100);
      return mk(
        measured.gt(limit) ? 'breach' : 'pass',
        'percent',
        null,
        measured.toString(),
        limit,
        null,
      );
    }

    case 'max_risk_amount': {
      const { amount, currency } = def.params;
      if (stop === null) {
        return mk('not_evaluable', 'currency', currency, null, amount, 'no_stop_loss');
      }
      const risk = avgEntry.minus(stop).abs().times(entryQty).times(mult);
      return mk(
        risk.gt(amount) ? 'breach' : 'pass',
        'currency',
        currency,
        risk.toString(),
        amount,
        null,
      );
    }

    case 'max_position_size': {
      const { amount, currency } = def.params;
      const notional = avgEntry.times(entryQty).times(mult);
      return mk(
        notional.gt(amount) ? 'breach' : 'pass',
        'currency',
        currency,
        notional.toString(),
        amount,
        null,
      );
    }

    case 'min_risk_reward': {
      const limit = def.params.ratio;
      if (stop === null) return mk('not_evaluable', 'ratio', null, null, limit, 'no_stop_loss');
      if (target.targetPrice === null) {
        return mk('not_evaluable', 'ratio', null, null, limit, 'no_target_price');
      }
      const { targetRR } = computeRiskReward({
        avgEntryPrice: avgEntry.toDecimalPlaces(8, Decimal.ROUND_HALF_UP).toNumber(),
        avgExitPrice: null,
        side: target.side as 'long' | 'short',
        targetPrice: target.targetPrice,
        stopLoss: stop,
      });
      if (targetRR === null)
        return mk('not_evaluable', 'ratio', null, null, limit, 'no_planned_rr');
      return mk(
        new Decimal(targetRR).lt(limit) ? 'breach' : 'pass',
        'ratio',
        null,
        String(targetRR),
        limit,
        null,
      );
    }

    case 'max_daily_loss':
    case 'max_weekly_loss': {
      const { amount, currency } = def.params;
      const limit = new Decimal(amount).negated();
      const population = getPopulation(ctx, rule);
      const tz = target.accountTimezone;
      const targetKey =
        def.type === 'max_daily_loss'
          ? zonedDateKey(new Date(oInstant), tz)
          : weekKeyOf(zonedDateKey(new Date(oInstant), tz), ctx.weekStartDay);

      let sum = new Decimal(0);
      for (const ev of population.events) {
        if (ev.occurredAt.getTime() >= oInstant) continue;
        const key =
          def.type === 'max_daily_loss'
            ? zonedDateKey(ev.occurredAt, tz)
            : weekKeyOf(zonedDateKey(ev.occurredAt, tz), ctx.weekStartDay);
        if (key === targetKey) sum = sum.plus(ev.netPnl);
      }
      // A loss equal to the limit breaches (design D8): at or below minus amount.
      return mk(
        sum.lte(limit) ? 'breach' : 'pass',
        'currency',
        currency,
        sum.toString(),
        limit.toString(),
        null,
      );
    }

    case 'max_total_exposure': {
      const { amount, currency } = def.params;
      const population = getPopulation(ctx, rule);
      let exposure = avgEntry.times(entryQty).times(mult);
      for (const p of population.positions) {
        if (p.id === target.id) continue;
        const before = p.fills.filter((f) => new Date(f.filledAt).getTime() < oInstant);
        const basis = computeOpenCostBasis(
          aggregateFills(before),
          p.side as 'long' | 'short',
          p.assetType as 'stock' | 'option',
          getCurrencyMinorUnits(p.currency),
        );
        exposure = exposure.plus(new Decimal(basis).abs());
      }
      return mk(
        exposure.gt(amount) ? 'breach' : 'pass',
        'currency',
        currency,
        exposure.toString(),
        amount,
        null,
      );
    }

    case 'required_fields': {
      const fields = def.params.fields;
      const empty = fields.filter((f) =>
        f === 'stop_loss'
          ? target.stopLoss === null
          : f === 'target_price'
            ? target.targetPrice === null
            : f === 'notes'
              ? !target.hasNotes
              : target.tags.length === 0,
      );
      return mk(
        empty.length > 0 ? 'breach' : 'pass',
        'list',
        null,
        empty.join(','),
        fields.join(','),
        null,
      );
    }

    case 'allowed_markets': {
      const markets = def.params.markets;
      const inSet = markets.includes(target.assetType as 'stock' | 'option');
      return mk(inSet ? 'pass' : 'breach', 'list', null, target.assetType, markets.join(','), null);
    }

    case 'allowed_directions': {
      const directions = def.params.directions;
      const inSet = directions.includes(target.side as 'long' | 'short');
      return mk(inSet ? 'pass' : 'breach', 'list', null, target.side, directions.join(','), null);
    }

    case 'no_trading_days': {
      const weekdays = def.params.weekdays;
      const weekday = weekdayOfKey(zonedDateKey(new Date(oInstant), target.accountTimezone));
      return mk(
        weekdays.includes(weekday) ? 'breach' : 'pass',
        'list',
        null,
        String(weekday),
        weekdays.join(','),
        null,
      );
    }

    case 'max_trades_per_day': {
      const count = def.params.count;
      const population = getPopulation(ctx, rule);
      const tz = target.accountTimezone;
      const targetKey = zonedDateKey(new Date(oInstant), tz);
      let earlier = 0;
      for (const p of population.positions) {
        if (p.id === target.id) continue;
        const isEarlier =
          openInstantMs(p) < oInstant ||
          (openInstantMs(p) === oInstant && createdMs(p) < createdMs(target));
        if (isEarlier && zonedDateKey(new Date(openInstantMs(p)), tz) === targetKey) earlier++;
      }
      const measured = earlier + 1;
      return mk(
        measured > count ? 'breach' : 'pass',
        'count',
        null,
        String(measured),
        String(count),
        null,
      );
    }

    case 'cooldown_after_loss': {
      const minutes = def.params.minutes;
      const population = getPopulation(ctx, rule);
      const sevenDaysMs = 7 * 24 * 60 * 60 * 1000;
      let latest: number | null = null;
      for (const flat of population.losingFlats) {
        const t = flat.getTime();
        if (t < oInstant && oInstant - t <= sevenDaysMs && (latest === null || t > latest)) {
          latest = t;
        }
      }
      // No losing flat in the window: a pass with null measured (design D9),
      // which still counts in the score denominator (Requirement 4.1).
      if (latest === null) return mk('pass', 'minutes', null, null, String(minutes), null);
      const measured = new Decimal(oInstant - latest).div(60000);
      return mk(
        measured.lt(minutes) ? 'breach' : 'pass',
        'minutes',
        null,
        measured.toString(),
        String(minutes),
        null,
      );
    }
  }
}

/**
 * Score one position against every enabled rule. A draft has no finality and no
 * entries (design D19). The score is 100 × pass weight ÷ (pass + breach weight),
 * `ROUND_HALF_UP` to an integer, null on a zero denominator (Requirement 4.1,
 * 4.2). Status is compliant with no breach, else non-compliant; unscored when
 * the score is null (Requirement 4.3).
 */
export function scorePosition(ctx: ScoringContext, positionId: string): PositionCompliance {
  const target = ctx.byId.get(positionId);
  if (!target) throw new Error(`scorePosition: position ${positionId} not in context`);

  if (target.status === 'draft') {
    return { finality: null, score: null, status: 'unscored', entries: [] };
  }

  const entries: ComplianceEntry[] = [];
  for (const rule of ctx.data.rules) {
    if (!rule.enabled) continue;
    const entry = evaluateRule(rule, target, ctx);
    if (entry !== null) entries.push(entry);
  }

  let passWeight = new Decimal(0);
  let breachWeight = new Decimal(0);
  for (const entry of entries) {
    if (entry.outcome === 'pass') passWeight = passWeight.plus(RULE_WEIGHT_VALUES[entry.weight]);
    else if (entry.outcome === 'breach') {
      breachWeight = breachWeight.plus(RULE_WEIGHT_VALUES[entry.weight]);
    }
  }

  const denom = passWeight.plus(breachWeight);
  const score = denom.isZero()
    ? null
    : passWeight.times(100).div(denom).toDecimalPlaces(0, Decimal.ROUND_HALF_UP).toNumber();

  const finality = target.status === 'open' ? 'provisional' : 'final';
  const status =
    score === null ? 'unscored' : breachWeight.isZero() ? 'compliant' : 'non_compliant';

  return { finality, score, status, entries };
}

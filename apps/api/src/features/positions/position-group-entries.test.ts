/**
 * multi-leg-positions task 4 — `position-group-entries.ts` (design C6;
 * requirements.md AC 1.6, 3.1, 3.2, 3.3, 3.7, 6.1, 6.2, NFR Performance).
 *
 * Pure unit tests of `assembleListEntries(rows, filters)`. Rows are hand-built
 * objects shaped exactly like `findPositionListByUser`'s raw SQL result
 * (`positions.query.ts:53-110`): the existing snake_case columns plus the two
 * task 4 adds, `group_id` and `label_override`. No DB, no mocked
 * collaborator — `assembleListEntries` is pure, so a plain object in gives a
 * plain object out.
 *
 * Contract (one case per success criterion from the task-4 author brief):
 *
 *  1. "two legs of a group return as one entry carrying both legs, placed
 *     where its latest-updated leg first appears" — Pre: rows for one
 *     ungrouped position and two 2-leg groups, interleaved and pre-sorted
 *     descending by each row's own `updated_at` (as the real
 *     `ORDER BY p.updated_at DESC` would hand them over), with one group's
 *     second leg appearing after the OTHER group's first leg. Call:
 *     `assembleListEntries(rows, {})`. Observe: 3 entries, in the order
 *     [ungrouped, groupA, groupB] — each group sitting at the index of its
 *     own latest-updated leg's first appearance — and each group's `legs`
 *     carries both its leg ids. Source: design.md C6 post-conditions ("An
 *     entry sits where its latest-updated leg first appears").
 *  2. "a group with one open leg reads open and with all legs closed reads
 *     closed" — Pre: one group with one closed and one open leg, another
 *     group with two closed legs. Call: `assembleListEntries(rows, {})`.
 *     Observe: the first reads `status: 'open'`, the second `status:
 *     'closed'`. Source: requirements.md AC 1.6.
 *  3. "openedAt, closedAt, createdAt and updatedAt follow AC 1.6" — Pre: a
 *     closed group with legs at distinct opened/closed/created/updated
 *     timestamps, and an open group whose one closed leg already carries a
 *     `closed_at`. Call: `assembleListEntries(rows, {})`. Observe: the closed
 *     group's `openedAt`/`createdAt` are the earliest leg values, its
 *     `closedAt`/`updatedAt` the latest; the open group's `closedAt` is null
 *     despite one leg already holding a `closed_at`. Source: requirements.md
 *     AC 1.6 verbatim.
 *  4. "netPnl is null while no leg has an exit" — Pre: a group of two legs,
 *     both entry-only (`exit_qty: '0'`). Call: `assembleListEntries(rows,
 *     {})`. Observe: `grossPnl` and `netPnl` are both null. Source:
 *     requirements.md AC 3.1 ("net P&L SHALL be null while no leg has an
 *     exit"); design.md C6 ("grossPnl and netPnl are null until a leg has an
 *     exit").
 *  5. "gross, net, fees and openCostBasis are the sums of the legs' figures"
 *     — Pre: one fully-closed leg (entry 100 → exit 120, qty 10, no fees)
 *     and one still-open leg (entry 5, qty 2, no fees). Call:
 *     `assembleListEntries(rows, {})`. Observe: `grossPnl` 200, `netPnl` 200,
 *     `brokerageFees` 0, `openCostBasis` 1000 — exactly the sum of each
 *     leg's own `computePnlFromTotals`/`computeOpenCostBasis` figures
 *     (`pnl.ts:73-232`), worked by hand. Source: requirements.md AC 3.1, 3.3.
 *  6. "rounded at the account's minor units" (AC 3.7) — Pre: a JPY-currency
 *     (0 minor units) group, one leg entry 100 → exit 100.6 (realizing 0.6),
 *     one leg still open. Call: `assembleListEntries(rows, {})`. Observe:
 *     `netPnl` and `grossPnl` are both 1, not 0.6 — proving the sum rounds at
 *     the account's own minor units rather than a hardcoded 2. Source:
 *     requirements.md AC 3.7; `getCurrencyMinorUnits('JPY') === 0`
 *     (`packages/shared/src/constants/currencies.ts:7`).
 *  7. "a debit reads positive netEntry and a credit negative" — Pre: the two
 *     requirements.md AC 3.6 worked examples (long 100C@5 + short 110C@2;
 *     short 100P@3 + long 95P@1), as two groups. Call:
 *     `assembleListEntries(rows, {})`. Observe: `netEntry` 300 for the first,
 *     −200 for the second. Source: requirements.md AC 3.6 verbatim.
 *  8. "an override replaces label and detectedLabel still reads the detected
 *     one" — Pre: a valid bull-call-spread leg pair, once with
 *     `label_override` set on every leg's row (as the join would produce)
 *     and once with it null. Call: `assembleListEntries(rows, {})`. Observe:
 *     the first reads `label: '<override>'`, `detectedLabel: 'BCS'`; the
 *     second reads `label: 'BCS'` too (no override to fall back from).
 *     Source: requirements.md AC 2.3, 2.4; design.md Data Models
 *     (`labelOverride`/`detectedLabel` on `PositionGroupEntry`).
 *  9. "`status` ... match AC 6.2" — Pre: one open group, one closed group.
 *     Call: `assembleListEntries(rows, { status: 'open' })` and again with
 *     `{ status: 'closed' }`. Observe: each call returns only the
 *     matching group. Source: requirements.md AC 6.2.
 * 10. "`classification` (closed groups only) ... match AC 6.2" — Pre: a
 *     closed winning group, a closed losing group, and an open group whose
 *     one closed leg alone would realize a win. Call:
 *     `assembleListEntries(rows, { classification: 'winning' })`. Observe:
 *     only the closed winning group is returned — the open group is excluded
 *     despite its positive partial P&L, because an open group's
 *     classification is null. Source: requirements.md AC 6.2 ("classification
 *     SHALL match ... for closed groups only").
 * 11. "`tag` (every listed tag across the legs together) match AC 6.2" —
 *     Pre: a group whose two legs carry disjoint tags plus one tag shared by
 *     both. Call: `assembleListEntries(rows, { tag: [a, b] })` where `a`/`b`
 *     sit on different legs (expect the group returned, `tags` de-duplicated
 *     to 3), and again with one tag no leg carries (expect no groups
 *     returned). Source: requirements.md AC 6.2 ("tag SHALL match when the
 *     legs' tags together hold every listed tag").
 *
 * Folded/dropped criteria:
 *  - "the list issues one list query however many groups exist" (NFR
 *    Performance) and "a grouped position's detail carries group and an
 *    ungrouped one's carries none" need the real route and DB — covered in
 *    `positions.test.ts` (describe block "positions — multi-leg groups on
 *    list/detail (task 4)").
 *  - "an ungrouped item is unchanged" is a regression guard, not a red test
 *    here: `grep -n "toStrictEqual\|toEqual({$" positions.test.ts` finds no
 *    whole-row equality assertion for an ungrouped list item, so every
 *    existing ungrouped-list assertion (e.g. positions.test.ts:237-250's
 *    accountId-filter test) keeps passing unchanged once `group_id`/
 *    `label_override` are added to the query and `mapListRow` is moved
 *    unchanged. Likewise AC 6.2's `accountId` sub-clause for an ungrouped row
 *    is the same pre-existing regression guard (`positions.test.ts:237-250`,
 *    "lists positions filtered by accountId") — the SQL predicate is
 *    untouched by this task.
 */
import { describe, it, expect } from 'vitest';

import { assembleListEntries } from './position-group-entries';

interface RawTag {
  id: string;
  name: string;
  category: string;
  color: string | null;
}

interface RawRowOverrides {
  id?: string;
  user_id?: string;
  account_id?: string;
  group_id?: string | null;
  symbol?: string;
  side?: 'long' | 'short';
  asset_type?: 'stock' | 'option';
  status?: 'draft' | 'open' | 'closed';
  notes?: string | null;
  opened_at?: Date | null;
  closed_at?: Date | null;
  created_at?: Date;
  updated_at?: Date;
  target_price?: string | null;
  stop_loss?: string | null;
  account_name?: string;
  account_currency?: string;
  account_timezone?: string;
  brokerage_name?: string | null;
  entry_qty?: string;
  exit_qty?: string;
  entry_cost?: string;
  exit_cost?: string;
  entry_fees?: string;
  exit_fees?: string;
  tags?: RawTag[];
  label_override?: string | null;
}

function d(day: number): Date {
  return new Date(Date.UTC(2026, 0, day));
}

function row(overrides: RawRowOverrides = {}) {
  return {
    id: 'leg-default',
    user_id: 'user-1',
    account_id: 'acct-1',
    group_id: null,
    symbol: 'AAPL',
    side: 'long' as const,
    asset_type: 'stock' as const,
    status: 'open' as const,
    notes: null,
    opened_at: d(1),
    closed_at: null,
    created_at: d(1),
    updated_at: d(1),
    target_price: null,
    stop_loss: null,
    account_name: 'Acct',
    account_currency: 'USD',
    account_timezone: 'UTC',
    brokerage_name: null,
    entry_qty: '0',
    exit_qty: '0',
    entry_cost: '0',
    exit_cost: '0',
    entry_fees: '0',
    exit_fees: '0',
    tags: [] as RawTag[],
    label_override: null,
    ...overrides,
  };
}

// Narrows a `PositionListEntry` to its group branch for the tests below.
function groupEntry(
  entries: unknown[],
  groupId: string,
): {
  id: string;
  kind: string;
  status: string;
  openedAt: Date | null;
  closedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
  netEntry: number;
  grossPnl: number | null;
  netPnl: number | null;
  brokerageFees: number;
  openCostBasis: number;
  classification: string | null;
  label: string;
  detectedLabel: string;
  tags: RawTag[];
  legs: { id: string }[];
} {
  const found = (entries as Array<Record<string, unknown>>).find(
    (e) => e.kind === 'group' && e.id === groupId,
  );
  if (!found) throw new Error(`no group entry with id ${groupId}`);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return found as any;
}

describe('assembleListEntries (design C6)', () => {
  it('collapses a group into one entry carrying both legs, placed at its latest-updated leg', () => {
    const rows = [
      row({ id: 'x', group_id: null, updated_at: d(4) }),
      row({ id: 'a1', group_id: 'gA', updated_at: d(3) }),
      row({ id: 'b1', group_id: 'gB', updated_at: d(2) }),
      row({ id: 'a2', group_id: 'gA', updated_at: d(1) }),
      row({ id: 'b2', group_id: 'gB', updated_at: d(0) }),
    ];

    const entries = assembleListEntries(rows, {}) as Array<Record<string, unknown>>;

    expect(entries).toHaveLength(3);
    expect(entries[0]!.id).toBe('x');
    expect(entries[0]!.kind).toBeUndefined();
    expect(entries[1]!.kind).toBe('group');
    expect(entries[1]!.id).toBe('gA');
    expect(entries[2]!.kind).toBe('group');
    expect(entries[2]!.id).toBe('gB');

    const a = groupEntry(entries, 'gA');
    const b = groupEntry(entries, 'gB');
    expect(a.legs.map((l) => l.id).sort()).toEqual(['a1', 'a2']);
    expect(b.legs.map((l) => l.id).sort()).toEqual(['b1', 'b2']);
  });

  it('derives group status: open unless every leg is closed', () => {
    const rows = [
      row({ id: 'o1', group_id: 'gOpen', status: 'closed', updated_at: d(2) }),
      row({ id: 'o2', group_id: 'gOpen', status: 'open', updated_at: d(1) }),
      row({ id: 'c1', group_id: 'gClosed', status: 'closed', updated_at: d(0) }),
      row({ id: 'c2', group_id: 'gClosed', status: 'closed', updated_at: d(-1) }),
    ];

    const entries = assembleListEntries(rows, {});

    expect(groupEntry(entries, 'gOpen').status).toBe('open');
    expect(groupEntry(entries, 'gClosed').status).toBe('closed');
  });

  it('derives openedAt/closedAt/createdAt/updatedAt per AC 1.6', () => {
    const rows = [
      row({
        id: 'closed-1',
        group_id: 'gClosed',
        status: 'closed',
        opened_at: d(1),
        closed_at: d(10),
        created_at: d(1),
        updated_at: d(10),
      }),
      row({
        id: 'closed-2',
        group_id: 'gClosed',
        status: 'closed',
        opened_at: d(5),
        closed_at: d(20),
        created_at: d(3),
        updated_at: d(20),
      }),
      row({
        id: 'open-closed-leg',
        group_id: 'gOpen',
        status: 'closed',
        opened_at: d(2),
        closed_at: d(5),
        created_at: d(2),
        updated_at: d(5),
      }),
      row({
        id: 'open-open-leg',
        group_id: 'gOpen',
        status: 'open',
        opened_at: d(3),
        closed_at: null,
        created_at: d(3),
        updated_at: d(6),
      }),
    ];

    const entries = assembleListEntries(rows, {});

    const closed = groupEntry(entries, 'gClosed');
    expect(closed.openedAt).toEqual(d(1));
    expect(closed.closedAt).toEqual(d(20));
    expect(closed.createdAt).toEqual(d(1));
    expect(closed.updatedAt).toEqual(d(20));

    const open = groupEntry(entries, 'gOpen');
    expect(open.status).toBe('open');
    expect(open.closedAt).toBeNull();
    expect(open.openedAt).toEqual(d(2));
    expect(open.createdAt).toEqual(d(2));
    expect(open.updatedAt).toEqual(d(6));
  });

  it("leaves netPnl and grossPnl null while no leg has an exit", () => {
    const rows = [
      row({
        id: 'leg-1',
        group_id: 'gNoExit',
        asset_type: 'option',
        symbol: 'AAPL260116C150',
        entry_qty: '1',
        entry_cost: '5',
        exit_qty: '0',
      }),
      row({
        id: 'leg-2',
        group_id: 'gNoExit',
        asset_type: 'option',
        symbol: 'AAPL260116C160',
        side: 'short',
        entry_qty: '1',
        entry_cost: '2',
        exit_qty: '0',
      }),
    ];

    const entry = groupEntry(assembleListEntries(rows, {}), 'gNoExit');

    expect(entry.grossPnl).toBeNull();
    expect(entry.netPnl).toBeNull();
  });

  it("sums gross P&L, net P&L, fees and open cost basis across legs", () => {
    const rows = [
      row({
        id: 'closed-leg',
        group_id: 'gSums',
        status: 'closed',
        entry_qty: '10',
        entry_cost: '1000',
        entry_fees: '0',
        exit_qty: '10',
        exit_cost: '1200',
        exit_fees: '0',
      }),
      row({
        id: 'open-leg',
        group_id: 'gSums',
        asset_type: 'option',
        symbol: 'AAPL260116C150',
        status: 'open',
        entry_qty: '2',
        entry_cost: '10',
        entry_fees: '0',
        exit_qty: '0',
      }),
    ];

    const entry = groupEntry(assembleListEntries(rows, {}), 'gSums');

    // closed-leg: avgEntry 100, avgExit 120 ⇒ realized/gross 200, fees 0,
    // openCostBasis 0 (fully exited). open-leg: no exit ⇒ contributes 0 to
    // P&L; openCostBasis = avgEntry(5) × openQty(2) × multiplier(100) = 1000.
    expect(entry.grossPnl).toBe(200);
    expect(entry.netPnl).toBe(200);
    expect(entry.brokerageFees).toBe(0);
    expect(entry.openCostBasis).toBe(1000);
  });

  it("rounds the summed figures at the account's minor units (AC 3.7)", () => {
    const rows = [
      row({
        id: 'jpy-closed-leg',
        group_id: 'gJpy',
        account_currency: 'JPY',
        status: 'closed',
        entry_qty: '1',
        entry_cost: '100',
        entry_fees: '0',
        exit_qty: '1',
        exit_cost: '100.6',
        exit_fees: '0',
      }),
      row({
        id: 'jpy-open-leg',
        group_id: 'gJpy',
        account_currency: 'JPY',
        asset_type: 'option',
        symbol: 'AAPL260116C150',
        status: 'open',
        entry_qty: '1',
        entry_cost: '5',
        entry_fees: '0',
        exit_qty: '0',
      }),
    ];

    const entry = groupEntry(assembleListEntries(rows, {}), 'gJpy');

    // 0.6 realized, rounded at JPY's 0 minor units (ROUND_HALF_UP) ⇒ 1 — not
    // the 0.6 a hardcoded 2-decimal round would leave.
    expect(entry.netPnl).toBe(1);
    expect(entry.grossPnl).toBe(1);
  });

  it('nets a debit positive and a credit negative (AC 3.2, AC 3.6 worked examples)', () => {
    const rows = [
      // AC 3.6: long 100 call at 5.00, short 110 call at 2.00 ⇒ net entry 300.
      row({
        id: 'debit-long',
        group_id: 'gDebit',
        asset_type: 'option',
        symbol: 'AAPL260116C100',
        side: 'long',
        entry_qty: '1',
        entry_cost: '5',
        entry_fees: '0',
      }),
      row({
        id: 'debit-short',
        group_id: 'gDebit',
        asset_type: 'option',
        symbol: 'AAPL260116C110',
        side: 'short',
        entry_qty: '1',
        entry_cost: '2',
        entry_fees: '0',
      }),
      // AC 3.6: short 100 put at 3.00, long 95 put at 1.00 ⇒ net entry −200.
      row({
        id: 'credit-short',
        group_id: 'gCredit',
        asset_type: 'option',
        symbol: 'AAPL260116P100',
        side: 'short',
        entry_qty: '1',
        entry_cost: '3',
        entry_fees: '0',
      }),
      row({
        id: 'credit-long',
        group_id: 'gCredit',
        asset_type: 'option',
        symbol: 'AAPL260116P95',
        side: 'long',
        entry_qty: '1',
        entry_cost: '1',
        entry_fees: '0',
      }),
    ];

    const entries = assembleListEntries(rows, {});

    expect(groupEntry(entries, 'gDebit').netEntry).toBe(300);
    expect(groupEntry(entries, 'gCredit').netEntry).toBe(-200);
  });

  it('keeps an override as the label while detectedLabel stays the pure-detected value', () => {
    // A valid bull call spread (BCS): long the lower strike, short the higher.
    const bcsLegs = (groupId: string, labelOverride: string | null) => [
      row({
        id: `${groupId}-long`,
        group_id: groupId,
        asset_type: 'option' as const,
        symbol: 'AAPL260116C100',
        side: 'long' as const,
        entry_qty: '1',
        label_override: labelOverride,
      }),
      row({
        id: `${groupId}-short`,
        group_id: groupId,
        asset_type: 'option' as const,
        symbol: 'AAPL260116C110',
        side: 'short' as const,
        entry_qty: '1',
        label_override: labelOverride,
      }),
    ];

    const rows = [
      ...bcsLegs('gOverride', 'My Custom Spread'),
      ...bcsLegs('gNoOverride', null),
    ];

    const entries = assembleListEntries(rows, {});

    const withOverride = groupEntry(entries, 'gOverride');
    expect(withOverride.label).toBe('My Custom Spread');
    expect(withOverride.detectedLabel).toBe('BCS');

    const withoutOverride = groupEntry(entries, 'gNoOverride');
    expect(withoutOverride.label).toBe('BCS');
    expect(withoutOverride.detectedLabel).toBe('BCS');
  });

  it('matches the status filter against the derived group status (AC 6.2)', () => {
    const rows = [
      row({ id: 'open-leg', group_id: 'gOpen', status: 'open' }),
      row({ id: 'closed-leg-1', group_id: 'gClosed', status: 'closed' }),
      row({ id: 'closed-leg-2', group_id: 'gClosed', status: 'closed' }),
    ];

    const openOnly = assembleListEntries(rows, { status: 'open' }) as Array<
      Record<string, unknown>
    >;
    expect(openOnly.map((e) => e.id)).toEqual(['gOpen']);

    const closedOnly = assembleListEntries(rows, { status: 'closed' }) as Array<
      Record<string, unknown>
    >;
    expect(closedOnly.map((e) => e.id)).toEqual(['gClosed']);
  });

  it('matches the classification filter against closed groups only (AC 6.2)', () => {
    const rows = [
      // gWin: closed, net +100.
      row({
        id: 'win-1',
        group_id: 'gWin',
        status: 'closed',
        entry_qty: '10',
        entry_cost: '1000',
        exit_qty: '10',
        exit_cost: '1200',
      }),
      row({
        id: 'win-2',
        group_id: 'gWin',
        symbol: 'MSFT',
        status: 'closed',
        entry_qty: '10',
        entry_cost: '500',
        exit_qty: '10',
        exit_cost: '400',
      }),
      // gLose: closed, net −150.
      row({
        id: 'lose-1',
        group_id: 'gLose',
        status: 'closed',
        entry_qty: '10',
        entry_cost: '1000',
        exit_qty: '10',
        exit_cost: '800',
      }),
      row({
        id: 'lose-2',
        group_id: 'gLose',
        symbol: 'MSFT',
        status: 'closed',
        entry_qty: '10',
        entry_cost: '500',
        exit_qty: '10',
        exit_cost: '550',
      }),
      // gOpenPartial: one closed leg realizing +200, one still open ⇒ group
      // status stays 'open', so classification must stay null despite the
      // positive partial net P&L.
      row({
        id: 'partial-closed',
        group_id: 'gOpenPartial',
        status: 'closed',
        entry_qty: '10',
        entry_cost: '1000',
        exit_qty: '10',
        exit_cost: '1200',
      }),
      row({
        id: 'partial-open',
        group_id: 'gOpenPartial',
        symbol: 'MSFT',
        status: 'open',
        entry_qty: '10',
        entry_cost: '500',
        exit_qty: '0',
      }),
    ];

    const winners = assembleListEntries(rows, { classification: 'winning' }) as Array<
      Record<string, unknown>
    >;
    expect(winners.map((e) => e.id)).toEqual(['gWin']);

    const openPartial = groupEntry(assembleListEntries(rows, {}), 'gOpenPartial');
    expect(openPartial.status).toBe('open');
    expect(openPartial.classification).toBeNull();
  });

  it("matches the tag filter when the legs' tags together hold every listed tag (AC 6.2)", () => {
    const setup = { id: 'tag-setup', name: 'Setup A', category: 'setup', color: '#111111' };
    const emotion = { id: 'tag-emotion', name: 'Calm', category: 'emotion', color: '#222222' };
    const shared = { id: 'tag-shared', name: 'Shared', category: 'general', color: '#333333' };

    const rows = [
      row({ id: 'tagged-1', group_id: 'gTagged', tags: [setup, shared] }),
      row({ id: 'tagged-2', group_id: 'gTagged', symbol: 'MSFT', tags: [emotion, shared] }),
    ];

    const matched = assembleListEntries(rows, {
      tag: ['tag-setup', 'tag-emotion'],
    }) as Array<Record<string, unknown>>;
    expect(matched.map((e) => e.id)).toEqual(['gTagged']);
    const tags = groupEntry(matched, 'gTagged').tags;
    expect(tags.map((t) => t.id).sort()).toEqual(['tag-emotion', 'tag-setup', 'tag-shared']);

    const unmatched = assembleListEntries(rows, {
      tag: ['tag-setup', 'tag-mistake'],
    }) as Array<Record<string, unknown>>;
    expect(unmatched.map((e) => e.id)).toEqual([]);
  });
});

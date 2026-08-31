/**
 * The activation checklist's completion rules — the ONLY place they are stated.
 *
 * An item's completed state is DERIVED from the user's actual data, never read
 * from a stored per-step flag. That is why this takes plain primitives and not a
 * query result, a hook, or a server response: there is nothing to keep in sync,
 * nothing to reconcile, and nothing that can drift out of agreement with
 * reality. Resuming across sessions and devices falls out of the same property
 * for free — the counts are the same counts on every device.
 *
 * Completion is reachable by ANY route. The counts alone decide, so a position
 * created by CSV import, an account created outside the walkthrough, or a trade
 * closed months before onboarding shipped all tick their item. Nothing here may
 * ever filter by HOW the data arrived.
 *
 * Keep this module pure: no React, no TanStack Query, no fetch, no DOM. Its test
 * runs under the node environment precisely to prove that.
 */

/**
 * Stable per-item identity. Each item's action opens the matching walkthrough
 * step set (`lib/steps/{account,calculator,position,close}.ts`), so these ids
 * are the join between the two and must not be renamed casually.
 */
export type ChecklistItemId = 'account' | 'calculator' | 'position' | 'close';

export interface ChecklistItem {
  id: ChecklistItemId;
  /** Sentence-case label, in the words the UI itself uses. */
  label: string;
  done: boolean;
}

export interface ChecklistInput {
  /**
   * How many brokerage accounts the user has. Demo data is not an account the
   * user created, so the caller excludes it.
   */
  accountCount: number;
  /**
   * How many positions the user has EVER created — open and closed alike, in
   * every account they created themselves. Demo data is not something the user
   * logged, so the caller excludes the sample account's rows here too, for the
   * same reason it excludes the account itself. It must NOT be filtered by
   * status. Item 3 asks whether the user has ever logged a position, and that
   * fact cannot become untrue later: an open-only count would un-tick item 3 the
   * moment the user closed their last position, and a user who had closed
   * everything could never reach `allComplete`, so the checklist would never
   * retire. The name says "ever created" so a caller holding a status-filtered
   * count — the web app's `usePositions({ status })` returns one — cannot pass
   * it here by accident.
   */
  positionsEverCreatedCount: number;
  /**
   * How many of the user's own positions are currently closed — demo rows
   * excluded by the caller, as above. This one IS a status-filtered count; that
   * is exactly what item 4 asks. It stands on its own — no relationship to
   * `positionsEverCreatedCount` is assumed or checked.
   */
  closedPositionCount: number;
  /**
   * The one exception to deriving completion from the user's own rows. The
   * calculator is stateless — it computes and returns, writing no row — so item
   * 2 has no other data trace. This is a timestamp recording a fact, not a
   * completion flag; absent (or null) means the calculator has not been used.
   * The API OMITS the key rather than sending null, hence the optional as well
   * as the null.
   *
   * Any non-empty string counts as used, malformed ones included. That is a
   * deliberate choice, not an oversight: the value is stored in a jsonb column,
   * so junk is genuinely reachable, and parsing it strictly would strand the
   * user's checklist on a bad stored value with no way for them to clear it.
   * Item 2 only asks WHETHER the calculator was used, never WHEN, so the
   * forgiving read cannot get the question it actually answers wrong.
   */
  calculatorFirstUsedAt?: string | null;
}

export interface Checklist {
  /** Exactly four items, in the order the UI shows them. */
  items: ChecklistItem[];
  /** When this is true the checklist retires. The UI decides how. */
  allComplete: boolean;
  /**
   * The three data-creating items — account, position, close — are all done.
   * The calculator is deliberately not consulted: it creates no data, so an
   * unused calculator must not keep the dashboard on its welcome view once the
   * user's journal genuinely has something to show. The dashboard swaps to the
   * real grid on this; the checklist itself runs on until `allComplete`.
   */
  coreComplete: boolean;
}

/**
 * Derive the four-item activation checklist from the user's data.
 *
 * The items are INDEPENDENT, not sequential. Nothing says the order must be
 * obeyed, and completion is reachable by any route, so an out-of-order state —
 * positions imported by CSV before the user ever opened the calculator, say —
 * is a legitimate state that must be representable rather than treated as
 * invalid. No item gates on the one before it; each answers only its own
 * question. The order in the array is presentation order, not a dependency
 * chain.
 *
 * Total and forgiving: it validates nothing and throws nothing. A count is read
 * as `> 0` and nothing else, so a negative or NaN count is simply not positive
 * and leaves its item untouched, and the two position counts are never compared
 * with each other. A checklist is a nudge — bad input should degrade to an
 * un-ticked item, never to an error the user cannot get past.
 */
/**
 * The four items as AUTHORED — their ids, their labels and the order they are
 * shown in. No user data is involved, so this says nothing about completion.
 *
 * Split out of `deriveChecklist` because a second caller needs the NAMES
 * without needing the answers. The walkthrough's permanent entry point in
 * settings offers all four sets to every user, so it has nothing to derive a
 * checklist from — and must not read onboarding state to find out what the four
 * sets are called, because reading it is what the retired user's read gate
 * exists to avoid. One list, so the two cannot disagree about which four items
 * there are or what order they come in.
 */
export const CHECKLIST_ITEMS: readonly Omit<ChecklistItem, 'done'>[] = [
  { id: 'account', label: 'Create a brokerage account' },
  { id: 'calculator', label: 'Size a trade in the calculator' },
  { id: 'position', label: 'Log a position' },
  { id: 'close', label: 'Close it and see the stats' },
];

export function deriveChecklist(input: ChecklistInput): Checklist {
  // The completion rules, still stated exactly once and only here.
  const done: Record<ChecklistItemId, boolean> = {
    account: input.accountCount > 0,
    calculator: Boolean(input.calculatorFirstUsedAt),
    position: input.positionsEverCreatedCount > 0,
    close: input.closedPositionCount > 0,
  };
  const items: ChecklistItem[] = CHECKLIST_ITEMS.map((item) => ({ ...item, done: done[item.id] }));

  return {
    items,
    allComplete: items.every((item) => item.done),
    coreComplete: done.account && done.position && done.close,
  };
}

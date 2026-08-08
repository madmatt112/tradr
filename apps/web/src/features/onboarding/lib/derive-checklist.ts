/**
 * The activation checklist's completion rules — the ONLY place they are stated.
 *
 * R4.2: an item's completed state is DERIVED from the user's actual data, never
 * read from a stored per-step flag. That is why this takes plain primitives and
 * not a query result, a hook, or a server response: there is nothing to keep in
 * sync, nothing to reconcile, and nothing that can drift out of agreement with
 * reality. Resumability across sessions and devices (R4.4) falls out of the same
 * property for free — the counts are the same counts on every device.
 *
 * R4.3: completion is reachable by ANY route. The counts alone decide, so a
 * position created by CSV import, an account created outside the walkthrough, or
 * a trade closed months before onboarding shipped all tick their item. Nothing
 * here may ever filter by HOW the data arrived.
 *
 * Keep this module pure: no React, no TanStack Query, no fetch, no DOM. Its test
 * runs under the node environment precisely to prove that.
 */

/**
 * Stable per-item identity. Task 24 wires a per-item action to the matching
 * walkthrough step set (`lib/steps/{account,calculator,position,close}.ts`), so
 * these ids are the join between the two and must not be renamed casually.
 */
export type ChecklistItemId = 'account' | 'calculator' | 'position' | 'close';

export interface ChecklistItem {
  id: ChecklistItemId;
  /** Sentence-case label, in the words the UI itself uses (R4.1). */
  label: string;
  done: boolean;
}

export interface ChecklistInput {
  /**
   * How many brokerage accounts the user has. Demo data is not an account the
   * user created, so the caller excludes it (R4.8).
   */
  accountCount: number;
  /**
   * How many positions the user has EVER created — open and closed alike, in
   * every account they created themselves. Demo data is not something the user
   * logged, so the caller excludes the sample account's rows here too, for the
   * same reason it excludes the account itself (R4.8). It must NOT be filtered
   * by status. Item 3 asks whether the
   * user has ever logged a position, and that fact cannot become untrue later:
   * an open-only count would un-tick item 3 the moment the user closed their
   * last position, and a user who had closed everything could never reach
   * `allComplete`, so the checklist would never retire (R4.7). The name says
   * "ever created" so a caller holding a status-filtered count — the web app's
   * `usePositions({ status })` returns one — cannot pass it here by accident.
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
   * The single named R4.2 exception. The calculator is stateless — it computes
   * and returns, writing no row — so item 2 has no other data trace. This is a
   * timestamp recording a fact, not a completion flag; absent (or null) means
   * the calculator has not been used. The API OMITS the key rather than sending
   * null, hence the optional as well as the null.
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
  /** Exactly four items, in the R4.1 order. */
  items: ChecklistItem[];
  /** R4.7 — when this is true the checklist retires. The UI decides how. */
  allComplete: boolean;
}

/**
 * Derive the four-item activation checklist from the user's data.
 *
 * The items are INDEPENDENT, not sequential. The requirements never say the
 * order must be obeyed, and R4.3 explicitly allows any route in, so an
 * out-of-order state — positions imported by CSV before the user ever opened
 * the calculator, say — is a legitimate state that must be representable rather
 * than treated as invalid. No item gates on the one before it; each answers
 * only its own question. The order in the array is presentation order (R4.1),
 * not a dependency chain.
 *
 * Total and forgiving: it validates nothing and throws nothing. A count is read
 * as `> 0` and nothing else, so a negative or NaN count is simply not positive
 * and leaves its item untouched, and the two position counts are never compared
 * with each other. A checklist is a nudge — bad input should degrade to an
 * un-ticked item, never to an error the user cannot get past.
 */
export function deriveChecklist(input: ChecklistInput): Checklist {
  const items: ChecklistItem[] = [
    {
      id: 'account',
      label: 'Create a brokerage account',
      done: input.accountCount > 0,
    },
    {
      id: 'calculator',
      label: 'Size a trade in the calculator',
      done: Boolean(input.calculatorFirstUsedAt),
    },
    {
      id: 'position',
      label: 'Log a position',
      done: input.positionsEverCreatedCount > 0,
    },
    {
      id: 'close',
      label: 'Close it and see the stats',
      done: input.closedPositionCount > 0,
    },
  ];

  return { items, allComplete: items.every((item) => item.done) };
}

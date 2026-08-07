import { z } from 'zod';

// Onboarding PREFERENCE state (user-onboarding R4.5, R4.6, R4.7, R7.2), stored
// as the `users.onboarding` jsonb column.
//
// PREFERENCE ONLY. Per-item checklist completion is NEVER stored here — it is
// derived at read time from the user's real data (account count, position
// count, closed-position count) so it cannot disagree with reality, drift, or
// need repair (R4.2). If you are tempted to add `accountCreated` or
// `positionLogged` to this object, that is the bug this comment exists to stop.
//
// `calculatorFirstUsedAt` is the single named exception, and it is not a
// completion flag: the calculator writes nothing else to the database, so
// checklist item 2 has no other data trace. It records a fact — when the
// calculator was first used — and the derivation reads it like any other
// primitive.
//
// This is one jsonb column rather than three scalar columns because
// `coachMarksSeen` is a growing SET of surface keys; as columns it would
// eventually need its own table for what is a UI preference. Follows the
// `dashboard_layouts.widgets` precedent.
//
// The column carries one key this schema deliberately does not describe: the
// server's private `demo` marker, written by the sample-account seeder and read
// by its teardown (see the accounts slice). It is not a preference and is not
// the client's business, so it is stripped on the way out by the rule below
// rather than published. Do not "tidy it up" into this object.

export const OnboardingStatusSchema = z.enum(['pending', 'active', 'skipped', 'done']);

export type OnboardingStatus = z.infer<typeof OnboardingStatusSchema>;

// EVERY field is optional-with-a-default, which is what makes the column's
// `DEFAULT '{}'` work with no backfill: an existing row stores `{}`, parses
// here, and comes out as a fully populated, usable state. The defaulting lives
// in the schema on purpose — the API, the hook and the derivation all read a
// resolved OnboardingState and none of them has to special-case an empty
// object, a missing key, or a pre-migration row.
//
// 'pending' is the correct default for a row that predates the column: it has
// neither opted out nor finished, so it is exactly where a brand-new user is.
//
// Unknown keys are STRIPPED (Zod's default) rather than rejected, unlike the
// wire-body schemas in expense.ts / accounting.ts / dashboard.ts that call
// .strict(). Those guard payloads arriving from a client. This one also parses
// rows that were WRITTEN by another deployment: a key added by a newer version
// of Tradr must not make an older one throw on read of its own users table.
// The PATCH body schema is the place to be strict about what a client may send.
export const OnboardingStateSchema = z.object({
  status: OnboardingStatusSchema.default('pending'),
  // Z-form ISO timestamp, matching every other `.datetime()` field in this
  // package (positions' filledAt, changelog's publishedAt).
  calculatorFirstUsedAt: z.string().datetime().optional(),
  // Surface keys, treated as a set. Order is not meaningful and duplicates are
  // prevented by the server-side merge, not by the type.
  coachMarksSeen: z.array(z.string()).default([]),
});

// The RESOLVED state: what every reader gets after parsing. Nothing is
// optional-with-a-default here — the defaults already ran.
export type OnboardingState = z.infer<typeof OnboardingStateSchema>;

// The STORED state: what is actually in the jsonb column, where every key may
// be absent and `{}` is the commonest value on earth for this table. This, not
// OnboardingState, is the honest `$type` for the Drizzle column — `{}` is not a
// valid OnboardingState, and typing the column as one would tell every reader
// that `row.onboarding.status` is a string when for existing rows it is
// undefined. (Contrast dashboard_layouts.widgets, where the `'[]'` default IS a
// valid WidgetPlacement[], so its `$type` can be the resolved type directly.)
export type StoredOnboardingState = z.input<typeof OnboardingStateSchema>;

// A coach-mark key names a UI surface (R7.1), so it is short and slug-shaped.
// Bounded because the stored set only ever grows: nothing removes a key, so an
// unbounded key would let a client grow one row's jsonb without limit.
export const COACH_MARK_KEY_MAX_LENGTH = 64;

// And the set itself is bounded for the same reason — R7.1 names five surfaces,
// so this is an order of magnitude of headroom. Enforced by the server-side
// merge, not here: the client never sends the whole array (see below).
export const MAX_COACH_MARKS_SEEN = 64;

// The PATCH body. STRICT, unlike OnboardingStateSchema above: this one's author
// is a client, so an unexpected key really is a mistake and saying so beats
// silently dropping it. (The state schema strips because it also parses rows
// written by another deployment — see the comment on it.)
//
// `coachMarkSeen` is SINGULAR and deliberately not the stored field's name. The
// stored `coachMarksSeen` is a set that only grows, so the operation a client
// needs is "append this one key, idempotently" — not "here is the whole array",
// which would make two tabs able to clobber each other's marks and would let a
// client shrink the set by omission. Naming the operation rather than the field
// makes it impossible to send the array by accident.
//
// Every field is optional, and at least one is required: a body naming nothing
// has no effect, and answering 200 to it would hide a client bug.
export const OnboardingPatchSchema = z
  .object({
    status: OnboardingStatusSchema.optional(),
    calculatorFirstUsedAt: z.string().datetime().optional(),
    coachMarkSeen: z.string().min(1).max(COACH_MARK_KEY_MAX_LENGTH).optional(),
  })
  .strict()
  .refine((patch) => Object.keys(patch).length > 0, {
    message: 'Provide at least one of status, calculatorFirstUsedAt or coachMarkSeen',
  });

export type OnboardingPatch = z.infer<typeof OnboardingPatchSchema>;

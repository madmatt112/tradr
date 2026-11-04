// The plan-tiers refusal codes the create flows map inline (REQ-11.5).
// Branching happens on the CODE only, never message text. Shared between
// CreatePositionDialog and MultiLegEntryForm so neither duplicates the copy.
export const TIER_REFUSAL_MESSAGES: Record<string, string> = {
  TIER_LIMIT_POSITIONS: "You've reached your plan's position limit.",
  TIER_ACCOUNT_NOT_WRITABLE:
    'This account is read-only on your plan — pick your writable account, or change it on the Accounts page.',
};

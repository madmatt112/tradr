export const EXPENSE_CATEGORIES = [
  'data_subscription',
  'platform_fee',
  'software',
  'education',
  'hardware',
  'other',
] as const;

export type ExpenseCategory = (typeof EXPENSE_CATEGORIES)[number];

export const EXPENSE_CATEGORY_LABELS: Record<ExpenseCategory, string> = {
  data_subscription: 'Data subscription',
  platform_fee: 'Platform fee',
  software: 'Software',
  education: 'Education',
  hardware: 'Hardware',
  other: 'Other',
};

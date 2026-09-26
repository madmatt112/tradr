// The mechanical table inventory (design C2, Req 2.4). Every `pgTable` the schema
// barrel (`@/db/schema`) defines is classified here as either exported by the
// account archive or deliberately excluded from it. The companion test walks the
// barrel and fails when a table is in neither list or in both, so a new table
// can never silently escape classification (Req 2.4).
//
// The two lists are the SQL table names (`getTableName`), not the Drizzle export
// identifiers. Membership mirrors Req 2.1 (exported) and Req 2.2 (excluded); the
// per-table rationale lives in the schema map in codebase-context.md.

// The user-owned categories the archive carries (Req 2.1). `users` is exported
// for its preference columns only; the export reader (C2) never writes identity
// or secret columns, and no payload carries a `user_id` (Req 2.3).
export const EXPORTED_TABLES = [
  'users',
  'accounts',
  'brokerages',
  'fee_schedules',
  'positions',
  'fills',
  'tags',
  'position_tags',
  'position_images',
  'ledger_entries',
  'exchange_rates',
  'expenses',
  'dashboard_layouts',
  'advisor_personas',
  'advisor_conversations',
  'advisor_messages',
  'advisor_summaries',
] as const;

// The tables the archive never exports (Req 2.2): sessions and tokens, encrypted
// keys, the whole billing/wallet mirror, admin and abuse counters, CSV-import
// scratch state, platform reference data, the migrations journal and the
// deletion tombstones.
export const EXCLUDED_TABLES = [
  'sessions',
  'advisor_provider_keys',
  'external_api_keys',
  'wallets',
  'usage_records',
  'wallet_transactions',
  'subscriptions',
  'billing_customers',
  'webhook_events',
  'advisor_turn_counters',
  'advisor_image_counters',
  'admin_audit_log',
  'csv_import_staging',
  'csv_import_counters',
  'email_tokens',
  'symbols',
  'symbol_sync_state',
  '_post_migrations_journal',
  'account_deletions',
  'account_deletion_schedules',
] as const;

export type ExportedTable = (typeof EXPORTED_TABLES)[number];
export type ExcludedTable = (typeof EXCLUDED_TABLES)[number];

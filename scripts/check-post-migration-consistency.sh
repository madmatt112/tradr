#!/usr/bin/env bash
# performance-charts §1.5 (r4 §1.3) — ONE-WAY, CONDITIONAL invariant.
#
# This script enforces the Task 13/15 same-PR gate: it must be impossible to
# land one without the other. It is a no-op on main until either (a) a
# post-migration SQL file exists or (b) migrate.ts exports runPostMigrations.
# Once EITHER is present, the full chain must be complete:
#
#   (1) every CREATE INDEX CONCURRENTLY <name> in apps/api/src/db/post-migrations/*.sql
#       has a matching `index('<name>')` declaration in
#       apps/api/src/db/schema/positions.schema.ts (schema graph stays in sync);
#   (2) apps/api/src/db/migrate.ts exports `runPostMigrations`;
#   (3) apps/api/src/index.ts calls `runPostMigrations`.
#
# The REVERSE direction — every schema index has a post-migration file — is
# NOT asserted. Pre-existing transactional-migration indexes
# (positions_user_id_idx, positions_account_id_idx, …) have no post-migration
# files and don't need them.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
POST_DIR="$REPO_ROOT/apps/api/src/db/post-migrations"
SCHEMA="$REPO_ROOT/apps/api/src/db/schema/positions.schema.ts"
MIGRATE_FILE="$REPO_ROOT/apps/api/src/db/migrate.ts"
INDEX_FILE="$REPO_ROOT/apps/api/src/index.ts"

shopt -s nullglob
post_files=("$POST_DIR"/*.sql)
shopt -u nullglob

migrate_has_export=0
if [[ -f "$MIGRATE_FILE" ]]; then
  # Detect all legitimate JS export forms:
  #   export function runPostMigrations        (named-function declaration)
  #   export async function runPostMigrations
  #   export const runPostMigrations = ...     (const-binding + arrow or function expr)
  #   export let runPostMigrations = ...
  #   export { runPostMigrations }             (braced re-export or named export list)
  #   export { foo as runPostMigrations }      (aliased export)
  # Deliberately excludes bare `runPostMigrations` mentions in comments or string literals.
  if grep -qE '^export\s+(async\s+)?function\s+runPostMigrations\b' "$MIGRATE_FILE" \
     || grep -qE '^export\s+(const|let|var)\s+runPostMigrations\b' "$MIGRATE_FILE" \
     || grep -qE '^export\s*\{[^}]*\brunPostMigrations\b' "$MIGRATE_FILE" \
     || grep -qE '^export\s*\{[^}]*\bas\s+runPostMigrations\b' "$MIGRATE_FILE"; then
    migrate_has_export=1
  fi
fi

if [[ ${#post_files[@]} -eq 0 && $migrate_has_export -eq 0 ]]; then
  echo "post-migration consistency: not activated (no post-migration files and no runPostMigrations export — skipping)"
  exit 0
fi

status=0

for f in "${post_files[@]}"; do
  # Strip SQL line comments first so a `-- … CREATE INDEX CONCURRENTLY …`
  # comment can't be mistaken for the real statement.
  name=$(sed 's/--.*//' "$f" \
           | grep -oE 'CREATE INDEX CONCURRENTLY(\s+IF NOT EXISTS)?\s+[A-Za-z0-9_]+' \
           | awk '{print $NF}' | head -n1)
  if [[ -z "$name" ]]; then
    echo "ERR: $(basename "$f") has no CREATE INDEX CONCURRENTLY <name> statement"
    status=1
    continue
  fi
  if ! grep -qE "index\([\"']${name}[\"']\)" "$SCHEMA"; then
    echo "ERR: post-migration index '$name' from $(basename "$f") is not declared in positions.schema.ts"
    echo "     add: .index(\"$name\") to the matching pgTable definition so drizzle's schema graph stays in sync."
    status=1
  fi
done

if [[ $migrate_has_export -eq 0 ]]; then
  echo "ERR: $MIGRATE_FILE does not export runPostMigrations (required once post-migration files exist)"
  status=1
fi

# An import alone is not enough — require runPostMigrations to be invoked
# directly (`runPostMigrations(`) OR passed as a value that gets invoked
# through an indirection for testability (`= runPostMigrations`, as
# bootPostMigrations's default parameter does). The import line matches
# neither alternative.
if [[ ! -f "$INDEX_FILE" ]] || ! grep -qE '\brunPostMigrations\s*\(|=\s*runPostMigrations\b' "$INDEX_FILE"; then
  echo "ERR: $INDEX_FILE does not call runPostMigrations(...) — an import alone is not enough"
  status=1
fi

if [[ $status -eq 0 ]]; then
  echo "post-migration consistency: OK"
fi

exit $status

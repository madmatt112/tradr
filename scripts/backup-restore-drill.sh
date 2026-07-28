#!/usr/bin/env bash
# hosted-platform Task 20 — backup → restore → integrity drill (REQ-10).
#
# Backs up the SOURCE database with `pg_dump`, restores it into a FRESH STAGING
# instance, and runs the node integrity checker (`backup-restore-check.mjs`) for a
# binary pass/fail recovery test (REQ-10.1/10.2). Exit 0 on a healthy restore,
# non-zero on a pending migration / FK orphan / row-count mismatch / unreachable
# object.
#
# STAGING ONLY — NEVER PRODUCTION (REQ-10.1). The drill NEVER restores over an
# existing database: it CREATES a throwaway DB named `tradr_restore_drill_<ts>` on
# the staging server, restores into that, and DROPs it afterwards. It also refuses
# to run when the staging target resolves to the same host+port+database as the
# source. These two guards make it structurally impossible to overwrite production.
#
# DB ⇄ BUCKET BACKUP-CONSISTENCY BOUNDARY (REQ-10.4): a `pg_dump` captures advisor
# image POINTER ROWS but NOT the bucket objects they reference. Object storage is an
# external store; its backup and its consistency with the DB pointers are a SEPARATE
# backup concern — operator/provider posture in the hosting runbook (REQ-11.1), not
# provided by this DB drill. When object storage is configured the checker adds a
# best-effort reachability probe against the LIVE bucket (REQ-10.3); that detects
# wholesale image loss at drill time, it is not a point-in-time DB+bucket guarantee.
#
# ---------------------------------------------------------------------------
# Usage (manual / CI):
#   SOURCE_DATABASE_URL=postgres://user:pass@src-host:5432/tradr \
#   STAGING_ADMIN_URL=postgres://user:pass@staging-host:5432/postgres \
#   scripts/backup-restore-drill.sh
#
# Required env:
#   SOURCE_DATABASE_URL  Database to back up (read-only; never modified).
#   STAGING_ADMIN_URL    Admin connection to a SEPARATE staging Postgres server
#                        (point it at its maintenance DB, e.g. .../postgres). The
#                        drill CREATEs and DROPs the throwaway restore DB here.
# Optional env:
#   KEEP_STAGING=1       Do not DROP the restored staging DB (for inspection).
#   POINTER_SAMPLE_LIMIT Deterministic first-N-by-key pointer sample (default: all).
#   OBJECT_STORAGE_*     When set, the checker adds the object-reachability leg.
# ---------------------------------------------------------------------------
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CHECKER="$REPO_ROOT/scripts/backup-restore-check.mjs"

: "${SOURCE_DATABASE_URL:?set SOURCE_DATABASE_URL to the database to back up}"
: "${STAGING_ADMIN_URL:?set STAGING_ADMIN_URL to a SEPARATE staging server admin connection (never production)}"

# --- Staging-only guard: host+port+db of source vs staging admin -------------
# Strip credentials + query string, then compare host:port/db.
strip_target() {
  # postgres://user:pass@host:port/db?opts  ->  host:port/db
  printf '%s' "$1" | sed -E 's#^[a-zA-Z]+://##; s#^[^@]*@##; s#\?.*$##'
}
SRC_TARGET="$(strip_target "$SOURCE_DATABASE_URL")"
STAGING_TARGET="$(strip_target "$STAGING_ADMIN_URL")"
if [[ "$SRC_TARGET" == "$STAGING_TARGET" ]]; then
  echo "REFUSING: STAGING_ADMIN_URL resolves to the same host+port+database as the source ($SRC_TARGET)." >&2
  echo "          The staging target MUST be a separate instance — never restore over the source/production." >&2
  exit 2
fi

# --- Fresh throwaway staging database ---------------------------------------
STAGING_DB="tradr_restore_drill_$(date +%s)_$$"
# Guard: we only ever create/drop a name with this prefix — defence in depth.
case "$STAGING_DB" in
  tradr_restore_drill_*) : ;;
  *) echo "REFUSING: generated staging DB name '$STAGING_DB' is not a drill DB." >&2; exit 2 ;;
esac

# Build the restore URL by swapping the admin DB name for the fresh drill DB.
# STAGING_ADMIN_URL = scheme://creds@host:port/admindb?opts
RESTORE_DATABASE_URL="$(printf '%s' "$STAGING_ADMIN_URL" | sed -E "s#(^[a-zA-Z]+://[^/]+/)[^?]*#\1$STAGING_DB#")"

DUMP_FILE="$(mktemp -t tradr-drill-XXXXXX.dump)"
BASELINE_FILE="$(mktemp -t tradr-drill-baseline-XXXXXX.json)"

cleanup() {
  rm -f "$DUMP_FILE" "$BASELINE_FILE"
  if [[ "${KEEP_STAGING:-0}" != "1" ]]; then
    psql "$STAGING_ADMIN_URL" -v ON_ERROR_STOP=1 -qc "DROP DATABASE IF EXISTS \"$STAGING_DB\";" || true
  else
    echo "KEEP_STAGING=1 — leaving restored DB: $STAGING_DB" >&2
  fi
}
trap cleanup EXIT

echo "==> Capturing source row-count baseline (REQ-10.2b)"
{
  printf '{'
  first=1
  for t in users accounts positions fills ledger_entries advisor_conversations advisor_messages; do
    n="$(psql "$SOURCE_DATABASE_URL" -tAX -c "SELECT count(*)::int FROM $t")"
    [[ $first -eq 1 ]] && first=0 || printf ','
    printf '"%s":%s' "$t" "$n"
  done
  printf '}'
} > "$BASELINE_FILE"

echo "==> pg_dump source"
pg_dump --format=custom --no-owner --no-privileges --file="$DUMP_FILE" "$SOURCE_DATABASE_URL"

echo "==> Creating fresh staging DB: $STAGING_DB"
psql "$STAGING_ADMIN_URL" -v ON_ERROR_STOP=1 -qc "CREATE DATABASE \"$STAGING_DB\";"

echo "==> pg_restore into staging"
pg_restore --no-owner --no-privileges --dbname="$RESTORE_DATABASE_URL" "$DUMP_FILE"

echo "==> Running integrity checker"
RESTORE_DATABASE_URL="$RESTORE_DATABASE_URL" \
BASELINE_COUNTS="$BASELINE_FILE" \
POINTER_SAMPLE_LIMIT="${POINTER_SAMPLE_LIMIT:-0}" \
  node "$CHECKER"

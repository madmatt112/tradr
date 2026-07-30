#!/usr/bin/env bash
#
# Tradr self-hosting quickstart — the canonical setup path.
#
# This script IS the documentation. The README and the docs site point at it
# rather than restating the commands, so there is no second copy to drift — the
# setup story had already diverged across three hand-maintained copies (one used
# a placeholder clone URL, one documented FEATURE_GATING and one didn't).
#
# The `docker-smoke` CI job runs `--env-only`, so the secret-generation recipes
# below are executed on every push rather than proofread.
#
# Usage:
#   ./docker/quickstart.sh              generate .env (if absent), then start the stack
#   ./docker/quickstart.sh --env-only   generate .env and stop; start the stack yourself
#
# Existing .env files are never overwritten. Values already set in the
# environment win, so CI can pin them and a human gets fresh random secrets.
set -euo pipefail

cd "$(dirname "$0")/.."

ENV_ONLY=false
[ "${1:-}" = "--env-only" ] && ENV_ONLY=true

# 1. Check prerequisites: Docker with Compose v2, and openssl for the secrets.
docker compose version >/dev/null 2>&1 || { echo "need Docker with Compose v2"; exit 1; }
command -v openssl >/dev/null || { echo "need openssl"; exit 1; }

# 2. Generate the three required secrets and write .env.
#    POSTGRES_PASSWORD is hex so the URL compose builds stays parseable — a
#    base64 password can contain @ : / ? and silently corrupt DATABASE_URL.
if [ ! -f .env ]; then
  cp .env.example .env
  POSTGRES_PASSWORD="${POSTGRES_PASSWORD:-$(openssl rand -hex 24)}"
  SESSION_SECRET="${SESSION_SECRET:-$(openssl rand -base64 24)}"
  ENCRYPTION_KEY="${ENCRYPTION_KEY:-$(openssl rand -hex 32)}"

  sed -i.bak \
    -e "s|^POSTGRES_PASSWORD=.*|POSTGRES_PASSWORD=${POSTGRES_PASSWORD}|" \
    -e "s|^SESSION_SECRET=.*|SESSION_SECRET=${SESSION_SECRET}|" \
    -e "s|^ENCRYPTION_KEY=.*|ENCRYPTION_KEY=${ENCRYPTION_KEY}|" \
    .env && rm -f .env.bak

  # Pin the encryption key by its fingerprint. Without it, booting with the WRONG
  # key fails late and quietly — a stored provider key simply won't decrypt. With
  # it, the api refuses to start and says so. Needs xxd (vim-common); skipped
  # rather than fatal, since it is a recommendation, not a requirement.
  if command -v xxd >/dev/null; then
    ENCRYPTION_KEY_FINGERPRINT="$(printf '%s' "$ENCRYPTION_KEY" | xxd -r -p \
      | openssl dgst -sha256 -binary | xxd -p -c 32)"
    sed -i.bak \
      -e "s|^#* *ENCRYPTION_KEY_FINGERPRINT=.*|ENCRYPTION_KEY_FINGERPRINT=${ENCRYPTION_KEY_FINGERPRINT}|" \
      .env && rm -f .env.bak
  fi

  # WEB_PORT is not a secret; honour it only when the caller pinned one.
  if [ -n "${WEB_PORT:-}" ]; then
    sed -i.bak -e "s|^WEB_PORT=.*|WEB_PORT=${WEB_PORT}|" .env && rm -f .env.bak
  fi
fi

if [ "$ENV_ONLY" = true ]; then
  echo "wrote .env — start the stack with: docker compose up -d"
  exit 0
fi

# 3. Start the stack, then wait for the api to report healthy.
docker compose up -d

WEB_PORT="$(grep -E '^WEB_PORT=' .env | cut -d= -f2)"
WEB_PORT="${WEB_PORT:-8080}"

echo "waiting for http://localhost:${WEB_PORT}/api/health ..."
for _ in $(seq 1 60); do
  if curl -fsS "http://localhost:${WEB_PORT}/api/health" 2>/dev/null; then
    echo
    echo "Tradr is up: http://localhost:${WEB_PORT}"
    exit 0
  fi
  sleep 2
done

echo "api did not become healthy — check: docker compose logs api" >&2
exit 1

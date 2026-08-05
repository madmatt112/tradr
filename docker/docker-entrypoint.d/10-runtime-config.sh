#!/bin/sh
# Runtime config (Req 3.1, 3.3, 3.5; observability REQ-6.1/6.3/6.5/6.6):
# regenerate /config.js on every container start so the served SPA reads its
# API base AND frontend telemetry keys from the environment, not the build.
#
# window.__TRADR_CONFIG__ gets a "key":<json-value> pair for each PRESENT,
# non-empty container env var. An unset/empty var yields an ABSENT field
# (never ""), which the SPA reads as that surface being absent. Mapping:
#   API_BASE_URL         -> apiBaseUrl
#   POSTHOG_PUBLIC_KEY   -> posthogPublicKey
#   POSTHOG_PUBLIC_HOST  -> posthogPublicHost
#   POSTHOG_PUBLIC_ENVIRONMENT -> posthogPublicEnvironment  (deployment label
#     stamped on every frontend event; absent => events are unstamped)
#   APP_VERSION          -> appVersion   (corner version badge; absent => the SPA shows "localdev")
#
# ONE deliberate exception to the absent-when-unset rule: advisorImageMaxBytes is
# ALWAYS emitted (as an unquoted JSON number) so the client pre-upload cap check
# always has a value — the always-on image byte cap (hosted-platform REQ-4.6).
# When ADVISOR_IMAGE_MAX_BYTES is unset/empty it defaults to MAX_IMAGE_BYTES_DEFAULT
# (4500000, packages/shared/src/schemas/advisor.ts).
#   ADVISOR_IMAGE_MAX_BYTES -> advisorImageMaxBytes (default 4500000)
#
# All-unset         -> window.__TRADR_CONFIG__={"advisorImageMaxBytes":4500000};
# API_BASE_URL only -> window.__TRADR_CONFIG__={"apiBaseUrl":"<value>","advisorImageMaxBytes":4500000};
# advisorImageMaxBytes is ALWAYS emitted (the default when unset), so the output
# is no longer byte-for-byte identical to the previous API_BASE_URL-only/unset script.
#
# Runs under the official nginx:alpine entrypoint, which sources/execs
# /docker-entrypoint.d/*.sh before launching nginx. nginx serves this file
# uncached (Cache-Control: no-store, set in the rendered server config).
# This unconditionally overwrites /config.js on every start, so a dist-shipped
# dev public/config.js never leaks into production.
set -eu

config_file="/usr/share/nginx/html/config.js"

# Escape \ and " so the value is a valid JS/JSON string literal (busybox sed).
json_str() {
  printf '%s' "$1" | sed -e 's/\\/\\\\/g' -e 's/"/\\"/g'
}

body=""

# Append "key":"<escaped value>" to body when the value is present/non-empty.
emit() {
  [ -n "$2" ] || return 0
  if [ -n "$body" ]; then
    body="${body},"
  fi
  body="${body}\"$1\":\"$(json_str "$2")\""
}

# Append "key":<number> to body — an unquoted JSON number, always emitted.
emit_num() {
  if [ -n "$body" ]; then
    body="${body},"
  fi
  body="${body}\"$1\":$2"
}

emit apiBaseUrl         "${API_BASE_URL:-}"
emit posthogPublicKey   "${POSTHOG_PUBLIC_KEY:-}"
emit posthogPublicHost  "${POSTHOG_PUBLIC_HOST:-}"
emit posthogPublicEnvironment "${POSTHOG_PUBLIC_ENVIRONMENT:-}"
emit appVersion         "${APP_VERSION:-}"

# Always-on image byte cap: emit the operator override or the shared default.
# Guard the override — only a non-negative integer is safe to emit as a bare JSON
# number. Anything non-numeric/empty (or injection-shaped) falls back to the
# default rather than producing invalid/injectable JS.
advisor_image_max_bytes="${ADVISOR_IMAGE_MAX_BYTES:-4500000}"
case "$advisor_image_max_bytes" in
  ''|*[!0-9]*) advisor_image_max_bytes=4500000 ;;
esac
emit_num advisorImageMaxBytes "$advisor_image_max_bytes"

printf 'window.__TRADR_CONFIG__={%s};\n' "$body" > "$config_file"

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
# APP_VERSION is BAKED into the image (Dockerfile.web ARG/ENV), not injected from
# .env — see the metrics section at the bottom of this script.
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
# The script ALSO writes the Prometheus exposition file /usr/share/nginx/html/metrics
# (served at /metrics), but ONLY when METRICS_ENABLED=true (observability REQ-7.1).
# Additional vars read for that half:
#   METRICS_ENABLED      -> gates the /metrics file entirely (default false => absent)
#   APP_VERSION          -> the version/commit labels on tradr_web_build_info (REQ-7.4)
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

# ---------------------------------------------------------------------------
# Prometheus exposition for the SPA's build identity (observability REQ-7).
#
# Absent by default: written ONLY when METRICS_ENABLED=true (REQ-7.1). The
# `rm -f` is UNCONDITIONAL and load-bearing — without it, flipping
# METRICS_ENABLED from true to false on an existing volume/root would leave the
# previous file being served forever (REQ-7.9).
#
# The version/commit split MIRRORS the api's parseAppVersion()
# (apps/api/src/features/metrics/metrics.registry.ts): version is APP_VERSION
# verbatim ("unknown" when unset/empty), commit is the text after its final
# "-", or "unknown" when there is no "-". The two halves must agree on VALUES,
# not just label names, or joining tradr_web_build_info against
# tradr_build_info reports drift where there is none (REQ-3.6, REQ-7.4).
# ---------------------------------------------------------------------------
metrics_file="/usr/share/nginx/html/metrics"
rm -f "$metrics_file"

if [ "${METRICS_ENABLED:-false}" = "true" ]; then
  app_version="${APP_VERSION:-unknown}"
  case "$app_version" in
    *-*) commit="${app_version##*-}" ;;
    *)   commit="unknown" ;;
  esac
  {
    printf '# HELP tradr_web_build_info Deployed web (SPA) build information.\n'
    printf '# TYPE tradr_web_build_info gauge\n'
    printf 'tradr_web_build_info{version="%s",commit="%s"} 1\n' \
      "$(json_str "$app_version")" "$(json_str "$commit")"
  } > "$metrics_file"
fi

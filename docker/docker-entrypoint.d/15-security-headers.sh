#!/bin/sh
# Security headers (security-hardening, design C11; Req 6.1, 6.2, 6.4, 6.5, 6.7,
# 6.8): render the Content-Security-Policy and the four static headers at
# container start and write them to /etc/nginx/conf.d/security-headers.inc, which
# every self-header SPA location includes. The CSP comes from the build-shipped
# template /usr/share/nginx/html/csp-policy.txt (design C10): its inline-script
# hash is already baked in; this entrypoint only fills the per-deploy origins,
# which sit outside NGINX_ENVSUBST_FILTER (Dockerfile.web) and so cannot be
# expanded by the official envsubst pass.
#
# Runs under the official nginx:alpine entrypoint, which execs
# /docker-entrypoint.d/*.sh in lexical order before launching nginx; this script
# (15-) runs before 20-envsubst-on-templates renders default.conf, so the .inc
# exists by the time nginx reads the `include conf.d/security-headers.inc;`.
#
# Every input is optional and read as ${VAR:-} (never bare, so `set -u` is safe):
#   API_BASE_URL        -> the API origin in connect-src/img-src; blank is valid
#                          (same-origin /api) and substitutes an empty origin; a
#                          set value's origin must match the pinned pattern.
#   POSTHOG_PUBLIC_KEY  -> gates the PostHog origins entirely (absent => none).
#   POSTHOG_PUBLIC_HOST -> which PostHog origins, mapped as C10's posthogOrigins.
#   HSTS_ENABLED        -> adds Strict-Transport-Security when exactly "true".
set -eu

csp_file="/usr/share/nginx/html/csp-policy.txt"
inc_file="/etc/nginx/conf.d/security-headers.inc"

api_base_url="${API_BASE_URL:-}"
posthog_public_key="${POSTHOG_PUBLIC_KEY:-}"
posthog_public_host="${POSTHOG_PUBLIC_HOST:-}"
hsts_enabled="${HSTS_ENABLED:-}"

# The CSP template must be shipped in the image (design C10 / C11 dependency).
if [ ! -f "$csp_file" ]; then
  echo "15-security-headers.sh: missing CSP template $csp_file" >&2
  exit 1
fi

# scheme://authority of a URL, dropping any path (its "origin").
origin_of() {
  _scheme="${1%%://*}"
  _after="${1#*://}"
  _authority="${_after%%/*}"
  printf '%s://%s' "$_scheme" "$_authority"
}

# API origin: blank stays blank (same-origin); a set value's origin is validated.
api_origin=""
if [ -n "$api_base_url" ]; then
  api_origin="$(origin_of "$api_base_url")"
  if ! printf '%s' "$api_origin" | grep -Eq '^https?://[A-Za-z0-9.-]+(:[0-9]+)?$'; then
    echo "15-security-headers.sh: API_BASE_URL origin '$api_origin' is not a bare http(s) origin" >&2
    exit 1
  fi
fi

# PostHog origins: only when keyed; map the host as C10's posthogOrigins does
# (app/us -> the us pair, eu -> the eu pair, else the host's own origin).
posthog_origins=""
if [ -n "$posthog_public_key" ]; then
  case "$posthog_public_host" in
    ''|https://app.posthog.com|https://app.posthog.com/*|https://app.i.posthog.com|https://app.i.posthog.com/*|https://us.posthog.com|https://us.posthog.com/*|https://us.i.posthog.com|https://us.i.posthog.com/*|https://us-assets.posthog.com|https://us-assets.posthog.com/*|https://us-assets.i.posthog.com|https://us-assets.i.posthog.com/*)
      posthog_origins="https://us.i.posthog.com https://us-assets.i.posthog.com" ;;
    https://eu.posthog.com|https://eu.posthog.com/*|https://eu.i.posthog.com|https://eu.i.posthog.com/*|https://eu-assets.posthog.com|https://eu-assets.posthog.com/*|https://eu-assets.i.posthog.com|https://eu-assets.i.posthog.com/*)
      posthog_origins="https://eu.i.posthog.com https://eu-assets.i.posthog.com" ;;
    *)
      posthog_origins="$(origin_of "$posthog_public_host")" ;;
  esac
fi

# Fill the origin placeholders and normalise whitespace exactly as C10's
# renderCsp does: collapse runs of spaces, drop any space before ';', and trim.
csp_policy="$(
  sed \
    -e "s|__API_ORIGIN__|${api_origin}|g" \
    -e "s|__POSTHOG_ORIGINS__|${posthog_origins}|g" \
    -e 's|  *| |g' \
    -e 's| *;|;|g' \
    -e 's|^ *||' \
    -e 's| *$||' \
    "$csp_file"
)"

{
  printf 'add_header Content-Security-Policy "%s" always;\n' "$csp_policy"
  printf 'add_header X-Content-Type-Options "nosniff" always;\n'
  printf 'add_header X-Frame-Options "DENY" always;\n'
  printf 'add_header Referrer-Policy "strict-origin-when-cross-origin" always;\n'
  printf 'add_header Permissions-Policy "camera=(), microphone=(), geolocation=(), payment=(), usb=()" always;\n'
  if [ "$hsts_enabled" = "true" ]; then
    printf 'add_header Strict-Transport-Security "max-age=31536000; includeSubDomains" always;\n'
  fi
} > "$inc_file"

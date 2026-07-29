# Tradr

[![License: Apache 2.0](https://img.shields.io/badge/License-Apache_2.0-blue.svg)](./LICENSE)

A self-hostable trading journal and analysis platform. Log trades, review
performance, and (optionally) get AI advisor feedback. It runs as a plain manual
journal with **no optional keys** configured — the AI advisor and external
integrations are opt-in. See
[docs/external-services.md](docs/external-services.md) for the full inventory
of external services and what enables each.

## Self-hosting quickstart

Requires Docker with Compose v2 (`docker compose`).

```bash
# 1. Clone
git clone <repo-url> tradr
cd tradr

# 2. Create your env file from the template
cp .env.example .env

# 3. Generate the required secrets and paste them into .env:
openssl rand -base64 24   # -> SESSION_SECRET (>=32 chars)
openssl rand -hex 24      # -> POSTGRES_PASSWORD (URL-safe; hex avoids @ : / ?)
openssl rand -hex 32      # -> ENCRYPTION_KEY

# 4. Set POSTGRES_USER / POSTGRES_PASSWORD / POSTGRES_DB in .env.
#    Compose derives DATABASE_URL for the api from these — do NOT set it yourself.

# 5. Start the stack
docker compose up -d
```

The web UI is published on `http://localhost:8080` by default (override with
`WEB_PORT` in `.env`). Check liveness:

```bash
curl -fsS http://localhost:8080/api/health    # {"status":"ok","version":"vX.Y.Z"}
```

### Required vs. optional

**Required** (the stack will not work without these):

- `POSTGRES_USER`, `POSTGRES_PASSWORD`, `POSTGRES_DB` — database credentials.
  Compose builds the api's `DATABASE_URL` from them.
- `SESSION_SECRET` — auth session signing key (≥32 chars).
- `ENCRYPTION_KEY` — 32-byte hex key used to encrypt stored provider keys.

**Optional** — Tradr runs as a manual journal without any of these:

- AI advisor provider keys (added in-app, encrypted with `ENCRYPTION_KEY`).
- `ENCRYPTION_KEY_FINGERPRINT` — recommended; pins the key so a wrong-key boot
  fails fast (see the runbook).
- `ENCRYPTION_KEY_PREVIOUS` — only used during key rotation.
- `ADVISOR_*` tuning, `UNUSUAL_WHALES_BASE_URL`, persona prompt overrides.

See `.env.example` for the full annotated list with generation recipes.

### Analytics (optional, off by default)

Tradr can optionally send **product analytics** to
[PostHog](https://posthog.com) — set `POSTHOG_API_KEY` (backend business events)
and/or `POSTHOG_PUBLIC_KEY` (frontend UI events) to turn it on. With no keys set
it constructs no client and makes no telemetry calls; there is nothing to opt
out of. Events carry no PII and no trading data — users are identified only by an
opaque id, and payloads (including captured error stacks) are redaction-scrubbed
before they leave the container. See [docs/analytics.md](docs/analytics.md) for
the event catalogue and privacy design.

### TLS

The shipped compose file does **not** terminate TLS. Running HTTPS is the
operator's responsibility: put your own reverse proxy / edge in front of the
`web` container. If you do, add that edge to `TRUSTED_PROXIES` so per-IP rate
limiting stays accurate (see the runbook).

### Operations

For upgrades, backups, migration status, the coupled timeout/upload settings,
and diagnosing an `ENCRYPTION_KEY` mismatch crash-loop, see
[`docs/runbooks/deployment.md`](docs/runbooks/deployment.md).

## Releasing (maintainers)

Versions are driven by git tags: `make release VERSION=X.Y.Z` bumps and tags,
and pushing the tag publishes GHCR images plus a GitHub Release — but only
after CI passes on the tagged commit (a gate in the Release workflow blocks
publishing otherwise). The full process, assumptions, and failure modes are in
[`docs/runbooks/release.md`](docs/runbooks/release.md).

What that version number promises — which surfaces are covered, what counts as
a breaking change, and when to pin `:X.Y.Z` rather than track `:latest` — is in
[`docs/versioning.md`](docs/versioning.md).

## License & Trademark

Tradr is open source under the **[Apache License 2.0](./LICENSE)** — free to use, self-host, modify, and
redistribute. See [`NOTICE`](./NOTICE) for attribution terms.

The Apache-2.0 license covers the **code**, not the **name**. **"Tradr"** and the Tradr logo are trademarks;
see the [Trademark Policy](./TRADEMARK.md) before using the name or logo in a fork, product, service, or
domain. Fork the code freely, but a modified or independently hosted version must use a different name.

Contributions are welcome under Apache-2.0 via a [Developer Certificate of Origin](./CONTRIBUTING.md) sign-off
(no CLA) — see [`CONTRIBUTING.md`](./CONTRIBUTING.md). To report a vulnerability, see [`SECURITY.md`](./SECURITY.md).

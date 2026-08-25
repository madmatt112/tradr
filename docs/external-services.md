# External services

What a **running** Tradr instance talks to over the network, why, and which
configuration turns each connection on. Build/CI dependencies are out of scope.
For setup procedures see the [deployment runbook](runbooks/deployment.md).

## Baseline: no external services required

With no optional keys configured, Tradr is a manual trading journal that talks
only to its own PostgreSQL. Every integration below is **opt-in and
feature-gating**: when its configuration is absent, the feature is absent (not
degraded) and the process makes **no outbound calls** for it.

## Optional services (implemented today)

### LLM providers

| Service       | Endpoint host       | Enabled by                                              |
| ------------- | ------------------- | ------------------------------------------------------- |
| Anthropic API | `api.anthropic.com` | `ANTHROPIC_API_KEY` (platform key) or per-user BYOK key |
| OpenAI API    | `api.openai.com`    | `OPENAI_API_KEY` (platform key) or per-user BYOK key    |

Called directly via `@anthropic-ai/sdk` and `openai`, and only on an instance
that has opted in with `DISABLE_ADVISOR=false` — the default makes no LLM call
at all, keys or no keys. Keys resolve in two ways: platform env keys (billed
against wallet credits, see Stripe below) or user-provided BYOK keys stored
AES-256-GCM-encrypted in the database (`ENCRYPTION_KEY`).

### Market data — Unusual Whales

| Service            | Endpoint host           | Enabled by                                             |
| ------------------ | ----------------------- | ------------------------------------------------------ |
| Unusual Whales API | `api.unusualwhales.com` | Per-user API key, stored encrypted (settings, not env) |

Options flow, stock quotes, and options chains, fetched server-side. Same
opt-in as the LLM providers: nothing is called on the default posture. The key
is per-user BYOK in the `external_api_keys` table; `UNUSUAL_WHALES_BASE_URL`
only overrides the host for test stubs.

### Wallet billing — Stripe

| Direction | Purpose                                   | Enabled by                                  |
| --------- | ----------------------------------------- | ------------------------------------------- |
| Outbound  | Checkout sessions for wallet credits      | `STRIPE_SECRET_KEY`                         |
| Inbound   | Payment-confirmation webhooks from Stripe | `STRIPE_WEBHOOK_SECRET` + reachable webhook |

Both vars are required to enable billing; without them the purchase UI is
absent. Note the **inbound** dependency: Stripe
must be able to reach the deployment's webhook endpoint.

### Changelog — GitHub API

The in-app changelog fetches the Releases feed of `CHANGELOG_GITHUB_REPO`
(default `madmatt112/tradr`) from `api.github.com`, server-side and
unauthenticated. Always on, but read-only and anonymous; point a fork at its
own repo or leave the default.

### Observability (PostHog product analytics)

| Service | Where it runs            | Endpoint host (default) | Enabled by           |
| ------- | ------------------------ | ----------------------- | -------------------- |
| PostHog | Frontend (`posthog-js`)  | `us.i.posthog.com`      | `POSTHOG_PUBLIC_KEY` |
| PostHog | Backend (`posthog-node`) | `us.i.posthog.com`      | `POSTHOG_API_KEY`    |

Both surfaces gate independently; all four observability vars are optional. A
fresh clone with none set loads no SDK and makes no telemetry calls. Structured
logs go to stdout only — Tradr ships them to no third-party sink of its own. See
the privacy-posture notes in `.env.example` for exactly what is (and is not)
sent, and [analytics.md](analytics.md) for the PostHog event catalogue and
privacy design.

### Hosted-platform capabilities (self-hosters leave unset)

| Service                    | Purpose                                    | Enabled by                              |
| -------------------------- | ------------------------------------------ | --------------------------------------- |
| S3-compatible object store | Uploaded images (R2 / S3 / MinIO)          | All four `OBJECT_STORAGE_*` credentials |
| Redis                      | Shared rate limiting across API containers | `REDIS_URL`                             |

Fallbacks when unset: images are stored inline as base64 in PostgreSQL;
rate limiting is process-local in-memory. Single-container self-hosts never
need either.

## tradr.cloud hosting stack

The managed offering runs the same images on: **Supabase** (managed Postgres —
transaction pooler + direct endpoint — and Supabase Storage as the S3 backend),
**Fly.io** (API VM), **Cloudflare Pages** (SPA/CDN), and **Upstash Redis** once
a second API machine exists. These are deployment choices, not application
dependencies.

## Egress summary

For locked-down networks, the complete set of hosts a fully configured
instance connects out to:

- `api.anthropic.com`, `api.openai.com` — LLM calls (opt-in, `DISABLE_ADVISOR=false`)
- `api.unusualwhales.com` — Unusual Whales market data (same opt-in)
- `api.stripe.com` — wallet purchases
- `api.github.com` — changelog releases feed
- `us.i.posthog.com` (or configured host) — PostHog analytics, backend + frontend
- The configured `OBJECT_STORAGE_ENDPOINT` — uploaded images (hosted)
- The configured `REDIS_URL` — rate limiting (hosted, multi-container)

Inbound: Stripe webhooks.

## Planned, not yet built

- **Interactive Brokers (IBKR)** — read-only broker connection for positions
  and live prices (`ibkr-integration` spec, deferred mid-redesign). Today only
  CSV-import presets mention IBKR; there is no runtime integration.
- **Transactional email** — explicitly a future spec. There is **no email
  sending anywhere in the codebase**. Password recovery deliberately does not
  depend on it: self-host uses the `tradr reset-password` CLI; hosted is
  admin-assisted token issue until the email spec ships.

## Notably absent

No chart-image APIs, no external fonts or CDN scripts (the frontend bundle is self-contained), no
external session store (sessions live in PostgreSQL), and no message queues.
The only hard runtime dependency is PostgreSQL itself.

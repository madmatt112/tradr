# Product analytics (PostHog)

Tradr can **optionally** send product-analytics events to
[PostHog](https://posthog.com). It is **off by default** — a fresh clone with no
PostHog keys set constructs no client, makes no outbound calls, and behaves
identically to an instance that has never heard of PostHog. You opt **in** by
setting a key; there is nothing to opt out of otherwise.

This doc covers what the integration is, what it captures, and its privacy
design. For the network/service view (hosts, egress) see
[external-services.md](external-services.md); for the annotated env vars see
`.env.example`.

## Two surfaces, one PostHog project

| Surface  | Package        | Enabled by           | Captures                                             |
| -------- | -------------- | -------------------- | ---------------------------------------------------- |
| Backend  | `posthog-node` | `POSTHOG_API_KEY`    | Confirmed business events (the authoritative signal) |
| Frontend | `posthog-js`   | `POSTHOG_PUBLIC_KEY` | A small set of deliberate UI-intent events           |

Each surface gates **independently** on its own key — enabling one does not
enable the other. Both default to the `us.i.posthog.com` host, overridable via
`POSTHOG_HOST` (backend) and `POSTHOG_PUBLIC_HOST` (frontend).

Most of the signal is **backend**: events fire on the real state change (after
the DB transaction commits, or from a Stripe webhook), so they can't be lost to
an ad-blocker, a closed tab, or a click that never completes — and several have
no frontend moment at all (a Stripe webhook, an email-verification link, a CSV
import finishing).

## Enabling it

```bash
# Backend business events
POSTHOG_API_KEY=phc_your_project_key
# POSTHOG_HOST=https://eu.i.posthog.com   # optional; defaults to us.i.posthog.com

# Frontend UI events (separate key; can be the same PostHog project)
POSTHOG_PUBLIC_KEY=phc_your_project_key
# POSTHOG_PUBLIC_HOST=https://eu.i.posthog.com
```

Backend keys go in the api container's environment; the two `POSTHOG_PUBLIC_*`
values are read by the web container's entrypoint into the runtime `config.js`
(no rebuild needed — see `.env.example`).

## What is captured

### Backend business events

All keyed by an **opaque user id** (the database UUID — never an email), fired
fire-and-forget after the operation commits. Properties are identifiers, enums,
or counts only — never prices, quantities, P&L, balances, or any financial
value.

| Event                      | When                                     | Properties                         |
| -------------------------- | ---------------------------------------- | ---------------------------------- |
| `user_signed_up`           | New account registered                   | —                                  |
| `user_logged_in`           | Successful email+password login          | —                                  |
| `email_verified`           | Verification link consumed               | —                                  |
| `password_reset_completed` | Password reset finished                  | —                                  |
| `account_created`          | Trading account created                  | —                                  |
| `account_deleted`          | Trading account deleted                  | —                                  |
| `position_created`         | Position opened                          | `assetType`                        |
| `position_closed`          | Position closed                          | `assetType`                        |
| `csv_import_completed`     | CSV trade import committed               | `positionsCreated`, `fillsCreated` |
| `checkout_session_created` | Stripe checkout started (wallet credits) | `packId`                           |
| `credits_purchased`        | Credits granted after payment (webhook)  | `packId`                           |

### Person profile (`identify`)

On registration, email verification, and login the backend sets a single
non-PII person property, `email_verified` (boolean), keyed by the opaque id.
**No email, name, or other PII is ever written to the profile.**

### Server-exception capture

Unhandled errors that reach the API's error handler (genuine 500s only) are
sent to PostHog error tracking, keyed by the user id when known — but **only
after the error message and stack are run through the same redaction scrubber
the rest of the telemetry uses**, so a stray email, token, or key embedded in
an exception is masked before it leaves the container. The exception type is
preserved for grouping.

### Frontend events

The browser SDK captures **masked pageviews** on client-side navigation — only
the matched route **pattern** (e.g. `/_auth/positions/$positionId`), never the
resolved id, query string, or referrer — plus a small set of deliberate product
events. Today the only deliberate event is `position_create_dialog_opened`;
autocapture is off, so nothing else is sent automatically.

## Privacy posture

- **No PII, no trading data.** No event payload (backend or frontend) carries
  emails, names, secrets, prices, quantities, P&L, balances, or order details.
  Users are identified only by the opaque database id.
- **Boundary-level redaction.** Property values (backend and frontend) and
  captured exception message/stack pass through a shared scrubber that masks
  secret/token/email/filename shapes — enforced in the capture helpers, not left
  to individual call sites.
- **Cookieless, minimal frontend.** The browser SDK runs with `autocapture` and
  session recording **disabled**, uses **memory-only** persistence (no cookies,
  no `localStorage` id), and neutralises the client IP (`$ip = null`, geo-IP
  enrichment dropped). Pageviews are captured but masked to the route pattern
  (see above). For defence in depth, also enable PostHog's project-side "Discard
  client IP data".

## Turning it off / confirming it's off

Unset (or leave blank) `POSTHOG_API_KEY` and `POSTHOG_PUBLIC_KEY`. With no key:

- the backend constructs no `posthog-node` client — every capture/identify/
  exception call returns immediately, does no work, and sends nothing;
- the frontend never loads `posthog-js` (it's a dynamic import gated on the key);
- no request is ever made to a PostHog host.

The graceful-absence behaviour is covered by an automated end-to-end test
(`e2e/tests/observability.spec.ts`, which boots an unconfigured stack and
asserts no telemetry network requests and no console errors) and by unit tests
asserting each backend helper is a no-op when unconfigured.

## Where this lives

- Backend client + capture helpers: `apps/api/src/lib/posthog.ts`
- Backend redaction scrubber: `apps/api/src/lib/telemetry-redact.ts`
- Frontend SDK wrapper: `apps/web/src/lib/telemetry/posthog.ts`
- Config + gating predicates: `apps/api/src/lib/config.ts` (`isPostHogConfigured`)
- Event catalogue and privacy design are documented above.

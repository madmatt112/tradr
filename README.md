<h1 align="center">▴ Tradr</h1>

<p align="center">
  <strong>The open-source trading journal that shows its work.</strong><br>
  Log every fill, size the trade before you take it, and ask an AI advisor about your own P&amp;L.
</p>

<p align="center">
  <a href="./LICENSE"><img alt="License: Apache 2.0" src="https://img.shields.io/badge/License-Apache_2.0-blue.svg"></a>
  <a href="https://github.com/madmatt112/tradr/actions/workflows/ci.yml"><img alt="CI" src="https://github.com/madmatt112/tradr/actions/workflows/ci.yml/badge.svg?branch=main"></a>
  <a href="https://github.com/madmatt112/tradr/releases/latest"><img alt="Latest release" src="https://img.shields.io/github/v/release/madmatt112/tradr?sort=semver"></a>
</p>

<!-- Screenshot slot: a real capture of a seeded instance goes here. Do not use
     the marketing hero mock — its figures are illustrative sample data, and an
     invented equity curve in the README of a finance tool is a credibility risk. -->

Tradr is a self-hostable journal for options and equities traders. It records the whole
arc of a position — draft, scale-in, partial close — with every fill, fee, and note
attached, then shows you what your record actually says.

It runs as a complete manual journal with **no keys configured at all**. The AI advisor
and every external integration are opt-in, and nothing phones home until you switch it
on. It never places an order.

## How to run it

**Self-hosted, with the quickstart below** — free and completely unlimited, forever. No
feature is fenced off; plan gating is a single deployment setting that ships **off**.

A managed option at `app.tradr.cloud` is planned and **not open yet**, so self-hosting is
the way to run Tradr today. Nothing about the self-hosted build depends on it.

## Quickstart

Requires Docker with Compose v2 and `openssl`. About two minutes.

```bash
git clone https://github.com/madmatt112/tradr.git
cd tradr
./docker/quickstart.sh
```

The script generates the three required secrets, writes your `.env`, starts the stack,
and waits for the API to report healthy. It never overwrites an existing `.env`. When it
finishes, Tradr is on <http://localhost:8080> (override with `WEB_PORT`).

This is the same script CI runs in its `docker-smoke` job, so these instructions are
executed on every push rather than proofread. To do it by hand instead, or to run behind
TLS, against your own Postgres, or on a different port, see the
[self-hosting guide](https://docs.tradr.cloud/self-hosting/docker-compose/).

## Status

**v0.5.x — pre-1.0, and moving quickly.** What that promises:

- **The HTTP API is not stable yet.** Breaking endpoint changes can land in any release
  until v1.0.0. Pin a tag rather than tracking `:latest` if that matters to you.
- **Migrations are forward-only and run automatically on API startup.** There are no
  down-migrations. Schema changes are split expand-then-contract across releases, so
  redeploying the previous image stays a viable recovery.
- **Releases are CI-gated.** A tag publishes images only after CI passes on that exact
  commit.
- **Back up before every upgrade.** See the [deployment runbook](docs/runbooks/deployment.md).

Full policy — what counts as a breaking change, which surfaces are covered — in
[`docs/versioning.md`](docs/versioning.md). Release notes are the changelog: see
[Releases](https://github.com/madmatt112/tradr/releases), which the app also renders
in-product.

## What it does

- **Positions** — draft, open, scale in, close in parts. Multiple fills roll up into one
  position with a correct average and realized P&L, net of per-fill fees.
- **Trade calculator** — position size, R:R, dollar risk, and estimated fees from your
  entry, target, and stop, before anything is at risk.
- **Accounts & ledger** — multiple brokerages and currencies on a double-entry ledger,
  with reconciliation.
- **Performance** — equity curve built from net P&L, broken down daily through all-time.
- **Options tools** — chain lookup, OCC symbol parsing, Black-Scholes pricing with full Greeks.
- **AI advisor** — conversation grounded in your own trade history, opt-in and off by
  default. Bring your own Anthropic or OpenAI key; self-hosted, it is never metered.
- **CSV import** — bring years of history from any broker with a column-mapping step.
  Direct read-only broker connections are on the roadmap, not shipped.

## Configuration

Three values must be set; everything else has a working default. `./docker/quickstart.sh`
generates all three:

| Variable            | What it is                                                                                                                    |
| ------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `POSTGRES_PASSWORD` | Database password. Compose builds the API's `DATABASE_URL` from the `POSTGRES_*` values — do not set `DATABASE_URL` yourself. |
| `SESSION_SECRET`    | Signs auth session cookies (≥32 chars).                                                                                       |
| `ENCRYPTION_KEY`    | 32-byte hex key encrypting stored provider keys at rest (AES-256-GCM).                                                        |

`ENCRYPTION_KEY_FINGERPRINT` is optional but recommended — it makes a wrong-key boot fail
fast and loudly instead of failing later when a stored key won't decrypt.

Every key is documented inline in [`.env.example`](.env.example). What a running instance
talks to over the network, and which setting enables each connection, is in
[`docs/external-services.md`](docs/external-services.md). Analytics are **off unless you
set a key** — see [`docs/analytics.md`](docs/analytics.md).

**TLS is yours.** The shipped compose file does not terminate it. Put your own reverse
proxy in front of the `web` container, and add that edge to `TRUSTED_PROXIES` so per-IP
rate limiting stays accurate.

## Documentation

|                                                                       |                                                            |
| --------------------------------------------------------------------- | ---------------------------------------------------------- |
| [User guide](https://docs.tradr.cloud/user-guide/getting-started/)    | Using Tradr — first trade to performance review            |
| [Self-hosting](https://docs.tradr.cloud/self-hosting/docker-compose/) | Install, upgrade, back up, run behind TLS                  |
| [`docs/`](docs/)                                                      | Operator and maintainer references that live with the code |

## Contributing

Issues and pull requests are welcome. Development setup, code style, the migration policy,
and the DCO sign-off requirement are in [`CONTRIBUTING.md`](CONTRIBUTING.md) — commits need
`git commit -s`, and there is no CLA.

To report a vulnerability, follow [`SECURITY.md`](SECURITY.md). Please don't open a public
issue for security problems.

## License & Trademark

Apache-2.0 — free to use, self-host, modify, and redistribute. See [`LICENSE`](LICENSE) and
[`NOTICE`](NOTICE).

The license covers the **code**, not the **name**. "Tradr" and the Tradr logo are
trademarks: fork the code freely, but a modified or independently hosted version needs a
different name. See [`TRADEMARK.md`](TRADEMARK.md).

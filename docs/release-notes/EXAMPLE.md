<!--
Worked example of TEMPLATE.md, fully filled in. Content is fabricated for
illustration — v0.9.0 does not exist. This file is not picked up by the
release workflow (it doesn't match a tag name); it exists purely as a
reference for what a completed docs/release-notes/vX.Y.Z.md should look like.
-->

Defensible cost basis, and a CSV importer for the brokers that don't have an API.

Tradr v0.9.0 focuses on getting historical trades into the ledger accurately, however they were made. It adds configurable cost-basis accounting, a CSV importer for brokerages without a direct API integration, and a new dashboard widget for reviewing realized P&L by strategy. This release also closes two edges of the ledger reconciliation logic reported since v0.8.0's onboarding and options work landed, both involving same-day round trips being counted twice under certain fee-timing conditions.

## Highlights

- Cost-basis method (FIFO, LIFO, or specific-lot) is now configurable per account in Settings → Accounts, and is applied retroactively to realized P&L on every account, not just new fills.
- CSV import is available for brokerages without an API integration. Map your export's columns once and Tradr will de-duplicate against any fills already synced through a connected broker, so linking a CSV import to an existing API-synced account is safe.
- A new "Realized P&L by Strategy" dashboard widget groups closed trades by the tag assigned at entry, so a swing-trading and a scalping book kept in the same account can be evaluated separately.
- Same-day round trips (a contract bought and sold within the same session) no longer double-count in the realized P&L ledger — the underlying issue was a fee applied before the closing fill was fully reconciled.
- Options expiry dates are now resolved in the contract's listed timezone rather than the server's, which had been shifting some Friday expiries to Thursday for accounts running outside US market hours.

## Breaking changes

- **Default cost-basis method changed from FIFO to average-cost** for every account created before this release, to match what most retail brokerages report by default on a 1099. Realized P&L figures will change once the API recomputes them on first boot after upgrading — this is expected, and reflects the same number your broker would show under average-cost. If you rely on FIFO or LIFO for tax purposes, set the method explicitly under Settings → Accounts before your next filing.
- **`GET /api/positions/:id/fills` now returns each fee as an object (`{ amount, currency }`) instead of a bare number**, to support the CSV importer's multi-currency fills. Any external tooling or scripts reading that endpoint directly will need a matching update. The HTTP API is not yet stable pre-1.0 (see the API stability note in the project's contributor docs), so this ships without a compatibility shim.

## Upgrade notes

On first boot after upgrading, the API recomputes realized P&L for every account under the new default cost-basis method described above. Expect a one-time startup delay proportional to how many closed positions you have — a few seconds for most self-hosted instances, longer for accounts with several thousand fills. No new required environment variables are introduced; a standard `docker compose pull && docker compose up -d` is sufficient for a Compose deployment.

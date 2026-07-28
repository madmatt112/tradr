# Security Policy

Tradr handles sensitive data — trading history, brokerage connections, and (when configured) LLM/market-data
API keys and payment details. We take security reports seriously and appreciate responsible disclosure.

## Supported versions

Tradr is pre-1.0 and moves quickly. Security fixes are made against the **latest release** and `main`.
Self-hosters should track the latest published image tag; fixes are not backported to older versions.

| Version                 | Supported                  |
| ----------------------- | -------------------------- |
| Latest release / `main` | ✅                         |
| Older releases          | ❌ (upgrade to the latest) |

## Reporting a vulnerability

**Please do not open a public issue, pull request, or discussion for security problems.** Public disclosure
before a fix is available puts self-hosters at risk.

Report privately via **either**:

1. **GitHub private vulnerability reporting** (preferred) — on the repository, go to the **Security** tab →
   **Report a vulnerability**. This opens a private advisory visible only to you and the maintainers.
2. **Email** — **security@tradr.cloud**. If you'd like to encrypt the report, ask for a PGP key in your first
   message.

Please include, as far as you can:

- A description of the issue and its impact.
- Steps to reproduce, or a proof of concept.
- The affected version/commit and your configuration (self-hosted vs. the hosted `tradr.cloud` platform).
- Any suggested remediation.

## What to expect

- **Acknowledgement** within a few business days.
- An initial assessment and a plan (including a severity rating) once we've reproduced the issue.
- Coordinated disclosure: we'll agree a timeline with you, prepare a fix and an advisory, credit you (if you
  wish), and publish once self-hosters have a patched release available.

We ask that you give us reasonable time to remediate before any public disclosure.

## Scope

- **The Tradr software** (this repository) — anything affecting self-hosted or hosted deployments:
  authentication/session handling, authorization/row-scoping, injection, secret handling (BYOK key
  encryption), the Stripe webhook path, the IBKR OAuth flow, the AI advisor's data access, etc.
- **The hosted platform (`tradr.cloud`)** — report platform-specific issues the same way.

Out of scope: findings that require a fully compromised host or physical access (a self-hosted single-server
deployment inherently trusts its own environment — see the threat-model notes in the docs), best-practice
suggestions without a concrete vulnerability, and reports against third-party services Tradr integrates with
(report those to the respective vendor).

## Safe harbor

We consider good-faith security research that follows this policy to be authorized. We will not pursue or
support legal action against researchers who: report privately and promptly, avoid privacy violations and
service disruption, don't access or modify other users' data beyond the minimum needed to demonstrate the
issue, and give us reasonable time to respond before disclosing.

Thank you for helping keep Tradr and its users safe.

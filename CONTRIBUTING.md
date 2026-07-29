# Contributing to Tradr

Thanks for your interest in improving Tradr — the open-source trading journal and analysis platform.
This guide covers how to propose changes and the one legal formality we ask of every contributor
(the DCO sign-off).

## License of contributions

Tradr is licensed under the **Apache License, Version 2.0** (see `LICENSE`). By contributing, you agree
that your contributions are licensed under the same Apache-2.0 terms — "inbound = outbound." You retain
copyright in your contributions; there is **no Contributor License Agreement (CLA)** and no copyright
assignment. We ask only that you sign off on the Developer Certificate of Origin (below).

## Developer Certificate of Origin (DCO)

Every commit must be signed off. The sign-off certifies that you wrote the change (or otherwise have the
right to submit it under Apache-2.0) — it is the full text below. It is **not** a CLA and takes two extra
characters on the commit command.

Add the sign-off automatically with `-s`:

```bash
git commit -s -m "feat: add position-sizing presets"
```

This appends a line to your commit message:

```
Signed-off-by: Your Name <your.email@example.com>
```

Use your real name and an email you can be reached at. If you forgot to sign off, amend the last commit
with `git commit --amend -s --no-edit` (or, for several commits, `git rebase --signoff <base>`).

<details>
<summary>Developer Certificate of Origin, Version 1.1 (full text)</summary>

```
Developer Certificate of Origin
Version 1.1

Copyright (C) 2004, 2006 The Linux Foundation and its contributors.

Everyone is permitted to copy and distribute verbatim copies of this
license document, but changing it is not allowed.


Developer's Certificate of Origin 1.1

By making a contribution to this project, I certify that:

(a) The contribution was created in whole or in part by me and I
    have the right to submit it under the open source license
    indicated in the file; or

(b) The contribution is based upon previous work that, to the best
    of my knowledge, is covered under an appropriate open source
    license and I have the right under that license to submit that
    work with modifications, whether created in whole or in part
    by me, under the same open source license (unless I am
    permitted to submit under a different license), as indicated
    in the file; or

(c) The contribution was provided directly to me by some other
    person who certified (a), (b) or (c) and I have not modified
    it.

(d) I understand and agree that this project and the contribution
    are public and that a record of the contribution (including all
    personal information I submit with it, including my sign-off) is
    maintained indefinitely and may be redistributed consistent with
    this project or the open source license(s) involved.
```

</details>

Sign-off is enforced in CI (the DCO check). Pull requests with unsigned commits will be blocked until
every commit carries a matching `Signed-off-by` line.

## How to contribute

1. **Open an issue first** for anything non-trivial — a bug report with reproduction steps, or a short
   proposal for a feature or change. This avoids duplicated or wasted work.
2. **Fork and branch.** Use a short-lived feature branch off `main` (trunk-based development; no long-lived
   `develop` branch).
3. **Make the change**, keeping it focused — one logical change per pull request.
4. **Run the checks locally** before pushing (see below).
5. **Open a pull request** describing what changed and why, and linking the issue.

## Development setup

Requirements: **Node.js 22 LTS** and **pnpm**. Local PostgreSQL runs via Docker Compose.

```bash
pnpm install
pnpm dev            # start the app + API
pnpm test           # run the test suite (Vitest)
pnpm check-types    # type-check all packages
pnpm lint           # lint
```

See the **Self-hosting & Development** documentation for full setup, architecture, and the database/migration
workflow.

## Code style

Tradr favors **simple, boring, readable code over clever abstractions.** A few guidelines:

- **Don't over-engineer.** Implement what the issue asks for — no speculative features or configuration.
- **Match the surrounding code** — its naming, structure, and patterns (vertical feature slices;
  service-layer business logic; thin Drizzle query functions; shared Zod schemas in `packages/shared`).
- **Types are documentation** — prefer explicit types; let the compiler catch mistakes.
- **Tests live next to the code they test.** Add or update tests for behavior you change.
- **Conventional Commits** for commit messages (`feat:`, `fix:`, `chore:`, `docs:`, `refactor:`, …), first
  line under 72 characters.
- Formatting and linting are enforced via a pre-commit hook and in CI.

## API and documentation changes

If you add, remove, or modify an API endpoint, update its OpenAPI/Swagger definition **in the same pull
request**, and update the relevant documentation. Docs live in the repo — changes to how the app is built,
configured, or self-hosted should land alongside the code that changes them.

## Database migrations

Migrations run automatically when the API boots, and Drizzle migrations are **forward-only** —
there are no down-migrations. Downgrading to an earlier image therefore leaves the schema ahead
of the code, so the old code has to keep working against the new schema. That is what makes
"redeploy the previous version" a viable recovery, both for the hosted deployment and for a
self-hoster who upgrades and needs to step back.

To keep that true, split schema changes across releases — **expand, then contract:**

- **Expand (release N):** add the new column, table, or index. Additive changes only. Backfill
  and dual-write if the data has to move. The previous release's code still runs unmodified.
- **Contract (release N+1 or later):** drop the old column, table, or constraint — only once
  release N is deployed and known good.

In practice: **never drop or rename in the same release that stops using the thing.** A pull
request that adds a `DROP COLUMN`, `DROP TABLE`, or a rename alongside the code change that made
it unused should be split in two.

Renames are the easy trap — a rename is a drop plus an add. Add the new column, write to both,
then remove the old one in a later release.

No migration in the repo drops or renames a column or table; the only removal so far is an index
(`0020`). Keep it that way unless you are deliberately doing the contract half of a change that
shipped in an earlier release.

## Reporting security issues

Please do **not** open a public issue for security vulnerabilities. Instead, report them privately per
`SECURITY.md` (or email the maintainers) so a fix can be prepared before disclosure.

## Trademark

The Apache-2.0 license covers the **code**, not the **name**. "Tradr" and the Tradr logo are trademarks —
see `TRADEMARK.md` before using them in a fork, product, service, or domain name.

---

Thank you for helping build the open-source alternative to closed trading journals.

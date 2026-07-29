# Versioning policy

What Tradr's version number promises, and what counts as a breaking change.
This is the policy; for how a version actually gets built and published, see the
[release runbook](runbooks/release.md).

The version number exists to answer one question for a self-hoster: **can I pull
the new image and restart without reading anything first?**

## Current status: pre-1.0

Tradr is in the `0.y.z` series. Under semantic versioning that means the
compatibility contract below is **not yet stable** — anything in it may change
in a release. Concretely, while on `0.y.z`:

- A breaking change bumps the **minor** (`0.5.1` → `0.6.0`).
- Everything else — features, fixes, performance, UI — bumps the **patch**
  (`0.5.1` → `0.5.2`).

`1.0.0` is not a quality milestone; it is the point at which the contract stops
moving. It will be cut when the HTTP API and the database schema have settled,
and when instances other than the maintainer's run Tradr in production. From
`1.0.0` on, the normal semver rules apply and breaking changes wait for a major.

## The compatibility contract

Tradr is an application, not a library, so its "public API" is the set of
surfaces an operator or client depends on:

| Surface                                      | In the contract | A breaking change looks like                                                                                                           |
| -------------------------------------------- | --------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| **HTTP API** (`/api/…`)                      | Yes             | Removing or renaming an endpoint; removing a response field; making an optional request field required; changing status-code semantics |
| **Database schema**                          | Yes             | Dropping or renaming a column or table (see below)                                                                                     |
| **Configuration** (env vars, `.env.example`) | Yes             | Renaming or removing a variable; making an optional one required; changing a default in a way that changes behaviour                   |
| **Deployment contract**                      | Yes             | Renaming a Compose service, image, volume path, or exposed port; adding a required external dependency                                 |
| **Auth & sessions**                          | Yes             | Anything that forces every user to log in again, or invalidates existing API credentials                                               |
| **Web UI**                                   | No              | Layout, wording, and workflow changes are never breaking                                                                               |
| **Internal module structure**                | No              | Nothing in `apps/` or `packages/` is published as a package; TypeScript types are not a public surface                                 |

The HTTP API is **unversioned** — routes are `/api/…`, with no `/v1` prefix.
The release version _is_ the API version, which is why an API change is a
release-level concern rather than something negotiated per request.

## What each field means

| Field     | Post-1.0 meaning                            | Pre-1.0 (today)            |
| --------- | ------------------------------------------- | -------------------------- |
| **MAJOR** | A breaking change to any contracted surface | Stays `0`                  |
| **MINOR** | Backwards-compatible functionality          | Breaking changes land here |
| **PATCH** | Backwards-compatible fixes                  | Everything else lands here |

The bump for a release is the **most significant change in the batch**. Twenty
fixes plus one breaking change is one breaking release, not twenty-one
releases.

## Schema changes are usually not breaking

Migrations run automatically when the API boots and are **forward-only** —
Drizzle has no down-migrations. Contributors are required to split schema
changes across releases using expand/contract; the rule and its rationale live
in [CONTRIBUTING.md](../CONTRIBUTING.md#database-migrations).

Because of that rule, an ordinary schema change is additive and does **not**
make a release breaking — the previous release's code still runs against the
new schema. What a release _does_ cost is downgrade range:

- **Expand** releases (additive) — upgrade and downgrade both safe.
- **Contract** releases (a `DROP` of something an earlier release still used) —
  the upgrade is safe, but you can no longer roll back past this version. This
  is called out in the release notes.

## Release cadence

Releases are **batched, not continuous**. A merged pull request is not a
release, and merging does not imply a version bump.

- Cut a release every **2–4 weeks**, or whenever `main` accumulates something a
  self-hoster would actually want to pull. In practice that is tens of commits,
  not one.
- **Skip empty cycles.** If nothing meaningful landed, don't cut a release.
- **Security fixes ship out of band**, immediately, as their own patch release.
  They do not wait for the next batch.

Release notes are user-facing: the GitHub Release feed is what the in-app
changelog renders. A release should read as a coherent set of changes, which is
another reason not to tag per pull request.

## Declaring a breaking change in a pull request

Contributors never edit version numbers — `make release` owns the `package.json`
fields, and the git tag is the source of truth. What a pull request does instead
is _declare_ the bump it would require, via its
[Conventional Commit](../CONTRIBUTING.md#code-style) message. For example, if a
previously optional setting were to become mandatory:

```
feat!: require EMAIL_FROM whenever SMTP_HOST is set

BREAKING CHANGE: an instance with SMTP_HOST set but no EMAIL_FROM now
fails to boot instead of disabling email. Set EMAIL_FROM or unset SMTP_HOST.
```

Use the `!` marker and a `BREAKING CHANGE:` footer whenever the change touches a
contracted surface from the table above. At release time the maintainer takes
the highest declared severity across everything merged since the last tag, and
that determines the bump.

Enabling a capability behind an `is*Configured()` gate is **not** breaking. A
capability that is inert until an operator configures it changes nothing for an
instance that hasn't.

## Upgrading (for self-hosters)

- **Pin `:X.Y.Z`** to control when you move. `:latest` always points at the most
  recent release and moves on every one — fine for tracking head, unsuitable if
  you want to choose your upgrade window.
- **Read the release notes before a minor bump** while Tradr is pre-1.0; that is
  where breaking changes are announced.
- **Recovering from a bad upgrade** means redeploying the previous image tag.
  That works as long as no contract release sits between the two versions —
  see the note above.

The tradr.cloud managed service deploys the same published artifacts as
self-hosters pull, so there is no separate hosted version number and no drift
between what is running there and what is released here.

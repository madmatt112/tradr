<!--
Release notes for vX.Y.Z.

This is the human-written prose that release.yml prepends above the
auto-generated "## What's Changed" PR list (body_path + generate_release_notes
on the softprops/action-gh-release step). It is framing, not a duplicate of
that list — keep it short, and skip anything the list already says perfectly
well on its own.

To use: copy this file to docs/release-notes/vX.Y.Z.md, fill it in, delete
this comment block and any section you don't need, then `make release`.
This file itself is never picked up by the workflow (it doesn't match a tag).
-->

<one-sentence tagline for the release>

<2-4 sentence overview. Written for someone who hasn't read the commits —
explain why this release happened and what it's for, not what changed line by
line. If there's nothing worth saying beyond the PR list, skip this file
entirely for the release; generate_release_notes alone is a fine release.>

## Highlights

- <the 1-3 things a user would actually notice, described as an outcome
  ("options chain now anchors on ATM"), not a commit message>

## Breaking changes

<!-- Omit this section if there are none. Tradr is pre-1.0 — breaking
API/schema changes are expected and don't need shims (see CLAUDE.md) — so
just be plain about what changed and what a self-hoster needs to do, if
anything. -->

- **<what changed>** — <what to do about it, or "no action needed">

## Upgrade notes

<!-- Only if upgrading takes more than `docker compose pull && up -d` — a new
required env var, a migration that can't run online, a config rename, etc.
Omit if there's nothing beyond the normal pull-and-restart. -->

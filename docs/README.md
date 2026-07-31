# Tradr in-repo documentation

References that live with the code, so a change to how Tradr is built, configured,
or operated lands in the same pull request as the change itself.

The polished, task-oriented documentation is on the docs site:
**[User guide](https://docs.tradr.cloud/user-guide/getting-started/)** ·
**[Self-hosting](https://docs.tradr.cloud/self-hosting/docker-compose/)**.
Start there if you want to _use_ or _install_ Tradr. Start here if you want to know
how something works, or what it promises.

That site is built from [`apps/docs`](../apps/docs) in this repository, so a doc fix
is an ordinary pull request. Run it locally with `pnpm --filter @tradr/docs dev`.

## For operators

| Document                                           | Answers                                                                                                                                                          |
| -------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [`versioning.md`](versioning.md)                   | Can I pull the new image and restart without reading anything first? What counts as a breaking change, and when to pin a tag.                                    |
| [`external-services.md`](external-services.md)     | What does a running instance talk to over the network, and which setting turns each connection on? (Nothing, by default.)                                        |
| [`analytics.md`](analytics.md)                     | What does Tradr capture if I enable PostHog, and what does it deliberately never capture? Off unless you set a key.                                              |
| [`runbooks/deployment.md`](runbooks/deployment.md) | Day-two operations: health and migration status, upgrades, backups, the coupled timeout/upload settings, and diagnosing an `ENCRYPTION_KEY` mismatch crash-loop. |

First-time install is not here — it is [`../docker/quickstart.sh`](../docker/quickstart.sh)
and the [self-hosting guide](https://docs.tradr.cloud/self-hosting/docker-compose/).

## For maintainers

| Document                                                                 | Answers                                                                                        |
| ------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------- |
| [`runbooks/release.md`](runbooks/release.md)                             | How a version gets built, tagged, and published, and what blocks a release.                    |
| [`runbooks/positions_index_build.md`](runbooks/positions_index_build.md) | Building, deploying, and recovering the `positions_user_status_closed_at_idx` composite index. |

## Conventions

- **Every documented command should be executable.** The quickstart is a script CI runs
  (`docker-smoke`), not prose. Prefer generating a reference from its source over
  restating it — `.env.example` is the authority on configuration, and this tree links to
  it rather than copying it.
- **One home per topic.** If something is already documented on the docs site or in
  `.env.example`, link to it instead of writing a second copy that will drift.

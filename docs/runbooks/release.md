# Release runbook

How a version of Tradr gets built and published. Covers the GitHub Actions
workflows, the versioning model, and the assumptions an operator must know. For
what a running instance connects to, see [External services](../external-services.md).

## The workflows

| Workflow    | File          | Trigger                  | What it does                                                    |
| ----------- | ------------- | ------------------------ | --------------------------------------------------------------- |
| **CI**      | `ci.yml`      | push to `main`; every PR | Lint, typecheck, tests, migrations, docker smoke, e2e           |
| **Release** | `release.yml` | push of a `v*` tag       | CI gate → multi-arch GHCR images → SPA tarball → GitHub Release |

Releasing publishes **artifacts only** — GHCR images, the SPA tarball, and a
GitHub Release. Deploying those artifacts to a running environment is a
separate, downstream concern (for the tradr.cloud managed offering it lives in
a private ops repo). Nothing here reaches a live environment on its own.

## Versioning model

The **git tag `vX.Y.Z` is the single source of version truth**. Everything
else derives from it at build time:

- GHCR images `ghcr.io/<owner>/tradr-api` and `tradr-web`, tagged `X.Y.Z` and
  `latest`.
- The `tradr-web-dist-vX.Y.Z.tar.gz` release asset (the built SPA, consumed by
  the downstream hosted deploy).
- The GitHub Release itself, whose feed the in-app changelog reads
  (`CHANGELOG_GITHUB_REPO`).

The `version` fields in the workspace `package.json` files are never read at
runtime. `make release` keeps them in lockstep with the tag purely so a
checkout self-describes its version.

## Cutting a release

```bash
make release VERSION=1.2.3   # bumps package.json versions, commits, tags v1.2.3
git push origin HEAD v1.2.3  # push commit and tag TOGETHER
```

The push starts two workflows at once:

1. **CI** on the `main` push — the bump commit has never been tested, so this
   is its test run.
2. **Release** on the tag push — its first job (`ci-gate`) finds that CI run
   and waits for it. Only when CI is green does the release job build and
   publish. If CI fails, nothing is published.

Expect a release to take CI's duration plus the image builds (the multi-arch
arm64 build under QEMU dominates).

## Assumptions and expectations

- **Tag from `main`.** The workflows don't enforce this, but every consumer
  assumes a release is a descendant of `main`'s history.
- **Push the commit with the tag.** CI only triggers on branch pushes and PRs,
  not tags. A tag pushed for a commit GitHub has never run CI on fails the
  gate after ~5 minutes with "No CI run found".
- **Any `v*` tag publishes — there is no monotonicity check.** Tagging
  `v0.0.9` after `v1.0.0` will happily rebuild `:latest` from older code.
  Don't tag historical commits unless that is exactly what you want.
- **`:latest` always moves.** Every release re-tags `latest` on both images.
  Self-hosters pinning `latest` get whatever was released most recently.
- **The GHCR packages must be public** for self-hosters (and the hosted deploy)
  to pull them without credentials. Package visibility is independent of repo
  visibility, and the exposure is releases-only: images contain the built
  bundles, never secrets.

## Failure modes

- **Gate fails (CI red or missing):** nothing was published. Fix the problem
  on `main`. If the fix lands in a new commit, delete and re-cut the tag on
  the new commit (below) — re-running the failed workflow run would still
  point at the old commit.
- **Release job fails after the gate** (e.g. the SPA build step): images may
  already be on GHCR without a GitHub Release. Re-run the workflow run from
  the Actions tab — image pushes and the Release creation are overwrite-safe.
- **Re-releasing the same version:** delete the GitHub Release first, then the
  tag, then re-tag — a release-creation step running against a deleted tag can
  silently re-create the tag at the wrong commit, so never delete the tag
  while a Release run for it is in flight:

  ```bash
  gh release delete v1.2.3 --yes        # if the Release was created
  git push origin :refs/tags/v1.2.3     # delete remote tag
  git tag -d v1.2.3                     # delete local tag
  make release VERSION=1.2.3            # re-cut on the corrected commit
  git push origin HEAD v1.2.3
  ```

## Deploying a release

Deployment of the published artifacts is downstream of this repo. The
tradr.cloud managed offering deploys them from a separate private ops repo; a
self-hoster pulls the published GHCR image per the
[deployment runbook](deployment.md).

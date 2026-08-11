.PHONY: dev seed-user seed-demo

# Local-dev seed user (override on the CLI, e.g.
#   make seed-user SEED_USER_EMAIL=me@example.com SEED_USER_PASSWORD=hunter2xyz).
# API_URL points at the api server directly (PORT in .env / config default 3100).
SEED_USER_EMAIL ?= dev@example.com
SEED_USER_PASSWORD ?= devpass123
API_URL ?= http://localhost:3100

# Known-good local-dev .env. This is a real file target (NOT .PHONY), so Make
# only runs the recipe when .env is missing — an existing .env is never
# clobbered. Values match docker-compose.dev.yml (postgres/postgres @ :5433,
# db tradr_dev) and satisfy the api config schema's three required vars
# (DATABASE_URL, SESSION_SECRET >=32 chars, ENCRYPTION_KEY 64 hex chars). These
# are throwaway local secrets — never used outside local development.
.env:
	@printf '%s\n' \
	  'NODE_ENV=development' \
	  'PORT=3100' \
	  'DATABASE_URL=postgresql://postgres:postgres@localhost:5433/tradr_dev' \
	  'DB_POOL_SIZE=10' \
	  'SESSION_SECRET=local-dev-session-secret-change-me-at-least-32-chars' \
	  'ENCRYPTION_KEY=0000000000000000000000000000000000000000000000000000000000000000' \
	  > .env
	@echo "Created a local-dev .env (git-ignored). See .env.example for optional vars."

dev: .env
	docker compose -f docker-compose.dev.yml up -d
	pnpm dev

# Create a local-dev login user via the live register endpoint (so password
# hashing/validation matches production). Requires `make dev` to be running.
# Idempotent: a pre-existing account (409) is treated as success.
seed-user:
	@code=$$(curl -sS -o /tmp/tradr-seed-user.json -w '%{http_code}' \
	    -X POST $(API_URL)/api/auth/register \
	    -H 'Content-Type: application/json' \
	    -d '{"email":"$(SEED_USER_EMAIL)","password":"$(SEED_USER_PASSWORD)"}' 2>/dev/null) || \
	  { echo "Could not reach the API at $(API_URL) — is 'make dev' running?"; exit 1; }; \
	case "$$code" in \
	  201) echo "Created dev user: $(SEED_USER_EMAIL) / $(SEED_USER_PASSWORD)" ;; \
	  409) echo "Dev user already exists: $(SEED_USER_EMAIL) / $(SEED_USER_PASSWORD)" ;; \
	  *) echo "Register failed (HTTP $$code):"; cat /tmp/tradr-seed-user.json; echo; exit 1 ;; \
	esac

# Generate believable demo/dummy data (accounts, brokerages, positions/fills
# with derived ledger P&L, expenses, FX rates, advisor history, wallet). Unlike
# seed-user this talks to the DB directly via the service layer, so it does NOT
# need the api server running — only the dev database. Idempotent: each run
# resets the demo users' data and regenerates it deterministically. Logins:
# dev@example.com (admin) and demo2@example.com, password devpass123.
seed-demo: .env
	docker compose -f docker-compose.dev.yml up -d
	pnpm --filter @tradr/api seed

# Cut a release. The git tag vX.Y.Z is the single version driver: pushing it
# runs release.yml (GHCR images tradr-api/tradr-web:X.Y.Z + :latest, the
# tradr-web-dist tarball, and the GitHub Release that feeds the in-app
# changelog and any downstream deploy). release.yml publishes NOTHING until the CI
# workflow is green for the tagged commit, so push commit and tag together
# (the command below) and the release waits for that CI run. The package.json
# version fields are never read at runtime; this keeps them in lockstep with
# the tag so the checkout self-describes its version. Commits the bump and
# creates the tag — pushing (what actually publishes) is left to you:
#   make release VERSION=1.2.3
#   git push origin HEAD v1.2.3
# Full process + failure modes: docs/runbooks/release.md
VERSIONED_PKGS := apps/api apps/web packages/shared bench e2e

# The published API reference embeds apps/api's version as `info.version`, and CI
# gates on the committed artifact matching a fresh generate. Bumping the package
# versions without regenerating therefore reds CI on the bump commit itself, which
# blocks release.yml's ci-gate and publishes nothing. Regenerate in the same commit.
OPENAPI_ARTIFACT := apps/docs/src/openapi/tradr-api.json

.PHONY: release
release:
	@test -n "$(VERSION)" || { echo "usage: make release VERSION=1.2.3"; exit 1; }
	@echo "$(VERSION)" | grep -qE '^[0-9]+\.[0-9]+\.[0-9]+$$' || { echo "VERSION must be bare semver (1.2.3, no leading v)"; exit 1; }
	@git diff --quiet HEAD || { echo "working tree not clean — commit or stash first"; exit 1; }
	@for p in $(VERSIONED_PKGS); do (cd $$p && npm pkg set version=$(VERSION)); done
	pnpm --filter @tradr/docs openapi:generate
	git add $(addsuffix /package.json,$(VERSIONED_PKGS)) $(OPENAPI_ARTIFACT)
	git commit -m "chore(release): v$(VERSION)"
	git tag v$(VERSION)
	@echo "Tagged v$(VERSION). Publish with: git push origin HEAD v$(VERSION)"

# Refresh the local graphify knowledge graph against current main. Optional and
# local-only — graphify-out/ is git-ignored and nothing in the build depends on
# it. AST-only, so no API cost. See CLAUDE.md for what the graph is used for.
.PHONY: update-graphify-graph
update-graphify-graph:
	git checkout main
	git pull --ff-only
	graphify update .

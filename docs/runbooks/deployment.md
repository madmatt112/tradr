# Deployment runbook

**Day-two** operations for a self-hosted instance: health, upgrades, backups, and
the failure modes worth recognising early.

This is not the install guide. First-time setup is
[`docker/quickstart.sh`](../../docker/quickstart.sh) — the script CI executes — and
the [self-hosting guide](https://www.tradr.cloud/docs/self-hosting/docker-compose/)
covers the three-service layout, prerequisites, and configuration in full. Setup
instructions used to be restated here as well, and the two copies drifted; this
page now links rather than repeats.

For what the containers connect out to, and which keys enable each connection, see
[External services](../external-services.md).

Two facts to keep in mind while reading the rest of this page: only `web` exposes a
host port, and `DATABASE_URL` for `api` is built from the `POSTGRES_*` vars inside
`docker-compose.yml` — any `DATABASE_URL` in `.env` is ignored by the compose stack.

## Health and migration status

Liveness:

```bash
curl -fsS http://localhost:${WEB_PORT:-8080}/api/health
# {"status":"ok"}   (200; 503 {"status":"error"} if the DB is unreachable)
```

Migration status (read-only; uses a separate connection, not the app pool):

```bash
docker compose exec api tradr migrate --status
```

Exit codes: `0` schema current, `1` pending migrations, `2` cannot connect.
The `tradr` CLI ships four subcommands, all runnable with
`docker compose exec api tradr <subcommand>`:

| Subcommand                                    | Does                                                                                                 |
| --------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| `migrate --status`                            | Reports schema state via the exit codes above.                                                       |
| `reset-password <email> [--password <value>]` | Resets a user's password from the server — the recovery path on an instance with no SMTP configured. |
| `storage migrate-to-inline`                   | Moves object-storage-backed uploads back into the database.                                          |
| `storage gc`                                  | Deletes orphaned upload blobs.                                                                       |

## Upgrades, migrations, and backups

Migrations are **forward-only** — there is no down/rollback. Migrations apply
automatically on `api` startup. The policy is therefore **back up before every
upgrade**.

Upgrade an image-based deployment:

```bash
docker compose pull
docker compose up -d
```

### Back up before upgrading

The database lives in the `pgdata` named volume. Take a logical dump:

```bash
docker compose exec -T postgres \
  pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" > backup-$(date +%F).sql
```

Or copy the volume while the stack is stopped (volume copy):

```bash
docker compose down
docker run --rm -v tradr_pgdata:/data -v "$PWD":/backup alpine \
  tar czf /backup/pgdata-$(date +%F).tar.gz -C /data .
docker compose up -d
```

The volume is named `pgdata` in the compose file; Docker prefixes it with the
project name (the compose directory), so it resolves to e.g.
`tradr_pgdata`. Confirm with `docker volume ls`.

### `start_period` note

`api` has a healthcheck `start_period: 180s`. A post-migration that runs
`CREATE INDEX CONCURRENTLY` on a large `positions` table can take a while; the
180s grace prevents the container being killed as unhealthy mid-migration, and
`restart: unless-stopped` will not interrupt an in-flight migration. During this
window `api` shows `health: starting` and the SPA's API calls 502 — this is
expected and resolves once migrations finish. Operators with very large tables
can set `SKIP_POST_MIGRATIONS=true` and run `pnpm migrate:post` out-of-band.

## Coupled settings

Two pairs of settings must be kept consistent or requests fail:

- **nginx timeout ↔ app stream timeout.** `ADVISOR_NGINX_PROXY_TIMEOUT`
  (default `180s`, consumed by the `web`/nginx container) MUST exceed
  `ADVISOR_STREAM_TIMEOUT_MS` (default `120000`, the app). If nginx is shorter
  it cuts advisor streaming responses early. The app should time out first.
- **upload size ↔ images per message.** `MAX_UPLOAD_SIZE` (default `20m`,
  nginx `client_max_body_size`) must be large enough to carry
  `ADVISOR_MAX_IMAGES_PER_MESSAGE` (default `4`) images in one request, or large
  uploads return 413. This ceiling is a documented limit, not a per-image cap.

## Rate limiting and the proxy chain

The app derives the client IP from `x-forwarded-for`, trusting only the proxies
listed in `TRUSTED_PROXIES` (default `172.28.0.0/24`, the compose subnet
`TRADR_SUBNET`). Per-IP rate limiting is best-effort, not turnkey.

If you run **your own TLS edge** in front of the `web` container, you MUST add
that edge's address to `TRUSTED_PROXIES` (and keep it in sync with the compose
subnet). Otherwise the app attributes every request to the edge's IP and
collapses all users into one rate-limit bucket. Cross-origin / split-origin
deployments (SPA and API on different origins) are not supported.

## TLS

TLS termination is **the operator's responsibility**. Run your own reverse
proxy / edge in front of the `web` container. The shipped compose file does not
terminate TLS — it is out of scope.

## Encryption key: pinning, mismatch crash-loop, and rotation

The advisor encrypts stored provider keys with `ENCRYPTION_KEY` (AES-256-GCM,
BYOK). Key material is loaded once at bootstrap.

### Pin the fingerprint

Set `ENCRYPTION_KEY_FINGERPRINT` to the `sha256` of the raw key bytes. When set,
`api` aborts at startup (before migrations) if the loaded key doesn't match —
turning a silent wrong-key deploy into a fast, clearly logged failure.

Derive it from the key you are actually running. `docker/quickstart.sh` does this
for you; by hand, read `ENCRYPTION_KEY` out of `.env` and hash **that**:

```bash
ENCRYPTION_KEY="$(grep -E '^ENCRYPTION_KEY=' .env | cut -d= -f2)"
printf '%s' "$ENCRYPTION_KEY" | xxd -r -p | openssl dgst -sha256 -binary | xxd -p -c 32
```

Do **not** pipe `openssl rand -hex 32` into that hash: it fingerprints a brand-new
random key rather than yours, so the value can never match and the api exits on
every boot.

With the fingerprint **unset** and at least one stored provider key, a wrong key
instead fails later via the decrypt canary (same crash-loop). With the
fingerprint unset and no provider keys (a default manual-journal install),
neither gate fires and a wrong key goes unnoticed until you store a key — which
is why pinning the fingerprint is recommended.

### Symptom of a wrong / changed `ENCRYPTION_KEY`

- The **SPA loads** (the `web` container is up; it depends on `api` only
  loosely), but **API calls fail — 502 / network error** from `web`.
- The **`api` container restarts repeatedly** (`restart: unless-stopped`
  retrying the failed boot — a loud crash-loop).

### Diagnose — lead with the positive discriminator

A slow migration still inside the 180s `start_period` looks identical at first
(`api` `health: starting`, SPA 502ing). Discriminate before reading logs:

```bash
docker compose exec api tradr migrate --status
```

- **Exit 0 + schema current while the SPA still 502s ⇒ the database is fine and
  the fault is the encryption-key gate** — not a migration still running.
- Then confirm in the logs:

```bash
docker compose logs api | grep encryption_fingerprint_mismatch
```

The fingerprint mismatch logs the distinct `encryption_fingerprint_mismatch`
event at error level, then exits non-zero.

(If `tradr migrate --status` shows pending migrations or hangs, you're likely
looking at an in-progress migration inside `start_period`, not a key problem —
wait it out.)

### Fix / rotate the key

- **Wrong key deployed:** restore the correct `ENCRYPTION_KEY` (and matching
  `ENCRYPTION_KEY_FINGERPRINT`), then `docker compose up -d`.
- **Rotating to a new key:** put the new key in `ENCRYPTION_KEY`, move the old
  key into `ENCRYPTION_KEY_PREVIOUS` so existing ciphertext still decrypts,
  update `ENCRYPTION_KEY_FINGERPRINT` to the new key's fingerprint, and restart
  the stack. Keys are cached at bootstrap, so rotation requires a restart.

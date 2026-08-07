# Tradr

Self-hostable trading journal and analysis platform.

See [`README.md`](README.md) for the self-hosting quickstart and
[`CONTRIBUTING.md`](CONTRIBUTING.md) for development setup, code style, and the
DCO sign-off requirement.

## Conventions for AI coding agents

- Match the surrounding code — naming, structure, and patterns (vertical feature
  slices; service-layer business logic; thin Drizzle query functions; shared Zod
  schemas in `packages/shared`).
- Don't over-engineer. Implement what was asked, no speculative features.
- Tests live next to the code they test; add or update them for behavior you change.
- When adding, removing, or modifying an API endpoint, update its `@swagger`
  JSDoc block in the same change.
- All `<button>` and button-like elements must include `cursor-pointer` — HTML
  buttons default to the arrow cursor.

## Hosted vs self-hosted

Hosted-only capabilities (object storage, Redis-backed rate limiting,
split-origin CORS, Stripe billing, plan gating) are **opt-in and config-gated**
via the `is*Configured()` predicates and `FEATURE_GATING` in
`apps/api/src/lib/config.ts`. With nothing configured, the stack runs as a plain
self-hosted journal — `apps/api/src/app.self-host-parity.test.ts` enforces this.
Keep that boundary intact: never make a gated capability unconditional.

## graphify (optional, local only)

[graphify](https://github.com/safishamsi/graphify) builds a queryable knowledge graph of the
repo. Its artifacts live in `graphify-out/` and are **deliberately untracked** — they are large
and machine-generated. Nothing here depends on them; build your own with `graphify .` if you
want one.

When `graphify-out/graph.json` exists:

- Prefer `graphify query "<question>"` over a broad grep for codebase questions. Use
  `graphify path "<A>" "<B>"` for relationships and `graphify explain "<concept>"` for a single
  concept — each returns a scoped subgraph rather than the whole report.
- Read `graphify-out/GRAPH_REPORT.md` only for broad architecture review.
- Run `graphify update .` after changing code to keep the graph current (AST-only, no API cost).

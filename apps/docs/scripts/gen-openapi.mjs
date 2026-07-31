// Generate the committed OpenAPI artifact the docs API reference is built from.
//
// The API app (apps/api) does NOT emit a machine-readable OpenAPI document at
// runtime — `@hono/zod-openapi` is deferred (see apps/api symbols.route.ts). The
// real, authoritative OpenAPI surface is the hand-authored `@swagger` JSDoc block
// colocated with every route in `apps/api/src/features/**/*.route.ts`, governed by
// the CLAUDE.md rule "when adding/modifying API endpoints, keep their Swagger
// definition up to date". This script assembles those blocks into one OpenAPI
// document with `swagger-jsdoc` and writes it to `src/openapi/tradr-api.json`,
// which `starlight-openapi` renders as native /docs pages (astro.config.mjs).
//
// It reads apps/api and does NOT modify it (no route, no runtime, no
// app-behavior change). The reference is GENERATED from the app's own endpoint
// docs, so it cannot drift: change a route's `@swagger` block, re-run this,
// rebuild. It is intentionally a build-time author tool (a devDependency), never
// part of `astro build`, so the static docs build only ever reads the committed
// JSON.
//
// CI enforces this: the `checks` job regenerates the artifact and fails on a
// non-empty `git diff`, so a route change that skips the `@swagger` block is
// caught in the same PR (.github/workflows/ci.yml).
//
//   Regenerate:  pnpm --filter @tradr/docs openapi:generate
//                (or, from apps/docs:  node scripts/gen-openapi.mjs)

import { mkdirSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import swaggerJSDoc from 'swagger-jsdoc';

const scriptDir = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);

// apps/docs/scripts -> apps/api
const apiRoot = resolve(scriptDir, '../../api');
const apiPkg = require(resolve(apiRoot, 'package.json'));
const outFile = resolve(scriptDir, '../src/openapi/tradr-api.json');

const spec = swaggerJSDoc({
  // Throw on a `@swagger` block that does not parse. Without this, swagger-jsdoc
  // prints the YAML error, drops that block, and returns a spec that is missing
  // the endpoint — and the process still exits 0. The CI drift gate would then
  // pass, because the committed artifact matches the broken parse. A colon in an
  // unquoted description is enough to lose an endpoint this way.
  failOnErrors: true,
  definition: {
    openapi: '3.0.3',
    info: {
      title: 'Tradr API',
      version: apiPkg.version ?? '0.0.0',
      description:
        'HTTP API for Tradr — the open-source trading journal with an AI advisor.\n\n' +
        'This reference is generated from the `@swagger` JSDoc blocks that live next to ' +
        'each route in the API source, so it always matches the endpoints the app actually ' +
        'serves. All routes are mounted under `/api`. The same API backs both the hosted ' +
        'app (`api.tradr.cloud`) and a self-hosted instance (reached through the web ' +
        'container at `/api`). Most endpoints require an authenticated session cookie.',
    },
    servers: [
      { url: 'https://api.tradr.cloud', description: 'Hosted (tradr.cloud)' },
      { url: 'http://localhost:3100', description: 'Local development (API PORT default)' },
    ],
  },
  // Every route file's hand-authored `@swagger` block; test files (`*.test.ts`)
  // do not match `*.route.ts` and are excluded.
  apis: [resolve(apiRoot, 'src/features/**/*.route.ts')],
});

// Sanitize `paths`: keep only real path items — a `/`-prefixed key carrying at
// least one HTTP operation. swagger-jsdoc merges EVERY parsed `@swagger`/`@openapi`
// JSDoc block into the document, and options.route.ts documents its pure helpers
// with `@swagger-example` blocks (occ-parse/black-scholes samples), which parse to
// stray non-path YAML and surface as numeric junk keys. This mechanical filter
// removes them without hand-authoring any endpoint content, so the reference is
// still generated wholesale from the source blocks.
const HTTP_METHODS = ['get', 'put', 'post', 'delete', 'patch', 'options', 'head', 'trace'];
const rawPaths = spec.paths ?? {};
spec.paths = Object.fromEntries(
  Object.entries(rawPaths).filter(
    ([key, item]) =>
      key.startsWith('/') &&
      item &&
      typeof item === 'object' &&
      Object.keys(item).some((method) => HTTP_METHODS.includes(method)),
  ),
);
const droppedKeys = Object.keys(rawPaths).length - Object.keys(spec.paths).length;

const pathCount = Object.keys(spec.paths).length;
if (pathCount === 0) {
  console.error(
    'gen-openapi: no paths were extracted from the API @swagger blocks — refusing to write an empty spec.',
  );
  process.exit(1);
}

// Deterministic output: recursively sort object keys so re-running without an API
// change produces a byte-identical artifact (no spurious diffs from glob order).
function sortDeep(value) {
  if (Array.isArray(value)) return value.map(sortDeep);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, sortDeep(value[key])]),
    );
  }
  return value;
}

mkdirSync(dirname(outFile), { recursive: true });
writeFileSync(outFile, `${JSON.stringify(sortDeep(spec), null, 2)}\n`);

const opCount = Object.values(spec.paths).reduce(
  (n, item) =>
    n +
    Object.keys(item).filter((k) =>
      ['get', 'put', 'post', 'delete', 'patch', 'options', 'head', 'trace'].includes(k),
    ).length,
  0,
);
console.log(
  `gen-openapi: wrote ${outFile} (${pathCount} paths, ${opCount} operations` +
    `${droppedKeys > 0 ? `, dropped ${droppedKeys} non-path key(s)` : ''}).`,
);

/**
 * Local GitHub releases stub for the e2e suite (changelog spec, Task 14).
 *
 * The changelog GitHub client (apps/api/.../github-releases.client.ts) is the
 * single outbound choke point for release fetches. In e2e we must NOT hit the
 * live GitHub API (non-deterministic, rate-limited). Instead the API-under-test
 * is booted with `CHANGELOG_GITHUB_BASE_URL` pointed at THIS server (the
 * REQ-3.6 seam), which serves two deterministic fixture releases:
 *
 *   GET  /repos/{owner}/{repo}/releases → fixture array (GitHub REST shape)
 *   GET  /__health                      → Playwright webServer readiness probe
 *   POST /__mode {"mode":"ok"|"fail"}   → failure toggle (design Component 10;
 *                                         NEW surface — no uw-stub precedent)
 *
 * In `fail` mode the releases route returns 500, letting e2e prove the API
 * serves its process-local cache when upstream is down (scenario 3).
 *
 * Fixture discipline (design Component 10):
 * - `html_url` values MUST be `https://github.com/...`-form — the schema's
 *   scheme refine constrains payload VALUES (the stub's localhost transport is
 *   fine, but a localized fixture link would fail the whole-array Zod parse
 *   and collapse every scenario into the generic unavailable state).
 * - Timestamps are fixed in the past so every release predates any mid-suite
 *   registration (scenario 2's badge-absence determinism).
 *
 * Used two ways (uw-stub-server idiom):
 *   1. As a Playwright `webServer` entry — run directly (`tsx
 *      github-stub-server.ts`), reads `GITHUB_STUB_PORT` from the env.
 *   2. Programmatically — import { startGithubStubServer } for ad-hoc control.
 */
import { createServer, type Server } from 'node:http';

// This file runs as a standalone CLI (via tsx / Playwright webServer) outside
// the apps/api boot path, so it reads its port from the env directly. The
// project-wide `process.env` ban does not apply here (same carve-out as
// uw-stub-server.ts / playwright.config.ts).
/* eslint-disable no-restricted-syntax */
const DEFAULT_PORT = 4601;

type StubMode = 'ok' | 'fail';

// Two fixture releases in the GitHub REST `GET /repos/{owner}/{repo}/releases`
// shape (only the fields the API client's Zod schema reads, plus nothing it
// would reject). Deliberately listed OLDEST-FIRST so scenario 1's newest-first
// assertion exercises the API's server-side sort, not fixture order.
const FIXTURE_RELEASES = [
  {
    id: 1001,
    tag_name: 'v0.1.0',
    name: 'v0.1.0 — First release',
    body: [
      'Initial release of the trading journal.',
      '',
      'before <script>window.__changelogXss = true</script> after',
      '',
      'Inline HTML must render as plain text, never live markup.',
    ].join('\n'),
    published_at: '2026-01-15T09:00:00Z',
    created_at: '2026-01-15T08:00:00Z',
    html_url: 'https://github.com/e2e-fixtures/tradr-changelog/releases/tag/v0.1.0',
    prerelease: false,
  },
  {
    id: 1002,
    tag_name: 'v0.2.0',
    name: 'v0.2.0 — Beta improvements',
    body: [
      '## What changed',
      '',
      '| Feature | Status |',
      '| ------- | ------ |',
      '| Changelog page | Shipped |',
      '| Release badge | Shipped |',
    ].join('\n'),
    published_at: '2026-02-20T10:00:00Z',
    created_at: '2026-02-20T09:00:00Z',
    html_url: 'https://github.com/e2e-fixtures/tradr-changelog/releases/tag/v0.2.0',
    prerelease: true,
  },
];

const RELEASES_PATH = /^\/repos\/[^/]+\/[^/]+\/releases$/;

function readBody(req: import('node:http').IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (chunk: Buffer) => {
      data += chunk.toString('utf8');
    });
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

export interface GithubStubHandle {
  server: Server;
  port: number;
  url: string;
  close: () => Promise<void>;
}

export function startGithubStubServer(port = DEFAULT_PORT): Promise<GithubStubHandle> {
  // Mutable failure toggle — e2e flips it via POST /__mode (design Component 10).
  let mode: StubMode = 'ok';

  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');

    // Health probe used by Playwright `webServer.url` readiness check.
    if (url.pathname === '/__health') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ status: 'ok', mode }));
      return;
    }

    if (url.pathname === '/__mode' && req.method === 'POST') {
      void readBody(req)
        .then((raw) => {
          let next: unknown;
          try {
            next = (JSON.parse(raw) as { mode?: unknown }).mode;
          } catch {
            next = undefined;
          }
          if (next !== 'ok' && next !== 'fail') {
            res.writeHead(400, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ error: 'mode must be "ok" or "fail"' }));
            return;
          }
          mode = next;
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ mode }));
        })
        .catch(() => {
          res.writeHead(500, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: 'body read failed' }));
        });
      return;
    }

    if (RELEASES_PATH.test(url.pathname) && req.method === 'GET') {
      if (mode === 'fail') {
        res.writeHead(500, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ message: 'stub upstream failure' }));
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(FIXTURE_RELEASES));
      return;
    }

    res.writeHead(404, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'not_found', path: url.pathname }));
  });

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, () => {
      resolve({
        server,
        port,
        url: `http://localhost:${port}`,
        close: () =>
          new Promise<void>((res, rej) => server.close((err) => (err ? rej(err) : res()))),
      });
    });
  });
}

// CLI entrypoint: Playwright `webServer` spawns this file via tsx.
const isMain = import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  const port = Number(process.env.GITHUB_STUB_PORT ?? DEFAULT_PORT);
  startGithubStubServer(port)
    .then((handle) => {
      console.log(`[github-stub] listening on ${handle.url}`);
    })
    .catch((err) => {
      console.error('[github-stub] failed to start', err);
      process.exit(1);
    });
}
/* eslint-enable no-restricted-syntax */

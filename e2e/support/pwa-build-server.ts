/**
 * Two-build PWA upgrade harness (design C7, Data Models / Decision D8;
 * Requirement 8.4).
 *
 * `buildPair` produces two real production builds of apps/web into a temp
 * directory and `startPwaBuildServer` serves one of them at a time, so an
 * installed service worker can be driven across a build change inside the e2e
 * job — the one thing a single `vite preview` cannot do. Build B carries a marker
 * folded into every chunk's content hash, so the entry and the lazy route chunks
 * all get fresh hashes and the two `index.html` entry `src` values differ (the
 * helper fails loudly otherwise).
 *
 * The two builds run in a short-lived CHILD process (pwa-build-worker.ts, run
 * with tsx) that `buildPair` spawns and awaits. In-process they left esbuild's
 * service process and the builds' retained resources alive for the rest of the
 * single-worker e2e job, starving every spec that ran after pwa-upgrade.spec.ts
 * on the 2-core CI runner; a child process reclaims all of it on exit.
 *
 * The server never writes into `apps/web/dist`: every build targets an `outDir`
 * under the OS temp directory. The generated `/config.js` is the minimal body the
 * docker entrypoint writes at runtime (`docker/docker-entrypoint.d/10-runtime-config.sh`);
 * production adds other keys, which this harness does not need.
 */
import { spawn } from 'node:child_process';
import { createReadStream, readFileSync, statSync } from 'node:fs';
import {
  createServer,
  request as httpRequest,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from 'node:http';
import { createRequire } from 'node:module';
import { dirname, extname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

// Design Data Models: the harness binds port 4604 (free alongside the stub
// servers on 4599-4603, the API on 3100 and web on 5173).
const DEFAULT_PORT = 4604;

// The child-process builder, run with tsx so the two Vite builds (and their
// esbuild service) are fully reclaimed when it exits.
const BUILD_WORKER = fileURLToPath(new URL('./pwa-build-worker.ts', import.meta.url));

/**
 * The module entry `<script type="module" src="...">` value from a built
 * `index.html` — the hashed `/assets/index-*.js` entry point. Exported so a test
 * can assert the served page booted on the expected build.
 */
export function readEntrySrc(buildDir: string): string {
  const html = readFileSync(join(buildDir, 'index.html'), 'utf8');
  const match = html.match(/<script[^>]*type="module"[^>]*\ssrc="([^"]+)"/);
  if (!match) {
    throw new Error(`pwa-build-server: no module entry <script> in ${buildDir}/index.html`);
  }
  return match[1];
}

/**
 * Build apps/web twice into `<outDir>/a` and `<outDir>/b` by spawning
 * {@link BUILD_WORKER} (pwa-build-worker.ts) in a short-lived tsx child process
 * and awaiting its exit, so esbuild and Vite are fully reclaimed and never starve
 * the rest of the single-worker e2e job. Build B carries a marker so its entry
 * hash differs; the helper throws unless the two entry `src` values differ.
 * Returns the two build directories for {@link startPwaBuildServer}.
 */
export async function buildPair(outDir: string): Promise<{ a: string; b: string }> {
  // Resolve the tsx CLI from the workspace root (hoisted there, not in e2e) so
  // the worker's TypeScript runs without a prior compile step.
  const require = createRequire(import.meta.url);
  const tsxPackageJson = require.resolve('tsx/package.json');
  const tsxBin = JSON.parse(readFileSync(tsxPackageJson, 'utf8')).bin as string;
  const tsxCli = join(dirname(tsxPackageJson), tsxBin);

  await new Promise<void>((resolvePromise, reject) => {
    const child = spawn(process.execPath, [tsxCli, BUILD_WORKER, outDir], {
      stdio: ['ignore', 'inherit', 'inherit'],
    });
    child.on('error', reject);
    child.on('exit', (code) => {
      if (code === 0) resolvePromise();
      else reject(new Error(`pwa-build-server: build worker exited with code ${code}`));
    });
  });

  const aDir = join(outDir, 'a');
  const bDir = join(outDir, 'b');

  if (readEntrySrc(aDir) === readEntrySrc(bDir)) {
    throw new Error(
      'pwa-build-server: builds A and B share an entry src — the marker did not change the hash',
    );
  }

  return { a: aDir, b: bDir };
}

export interface PwaBuildServer {
  url: string; // http://localhost:4604
  serve(build: 'a' | 'b', appVersion?: string): void; // config.js omits appVersion when undefined
  close(): Promise<void>;
}

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.txt': 'text/plain; charset=utf-8',
  '.map': 'application/json',
};

function contentType(filePath: string): string {
  return MIME[extname(filePath).toLowerCase()] ?? 'application/octet-stream';
}

function isFile(p: string): boolean {
  try {
    return statSync(p).isFile();
  } catch {
    return false;
  }
}

// Serve everything `no-store` so the browser's HTTP cache never masks a build
// switch: the service worker's own cache is the only cache the suite exercises.
function serveFile(filePath: string, res: ServerResponse): void {
  res.writeHead(200, { 'content-type': contentType(filePath), 'cache-control': 'no-store' });
  const stream = createReadStream(filePath);
  stream.on('error', () => {
    if (!res.headersSent) res.writeHead(500, { 'content-type': 'text/plain' });
    res.end('Read error');
  });
  stream.pipe(res);
}

// Forward `/api/*` to the booted e2e API, including method, body, request
// headers and every response header (Set-Cookie among them, so a real
// register/login round-trip authenticates the page).
function proxyToApi(req: IncomingMessage, res: ServerResponse, apiOrigin: string): void {
  const target = new URL(req.url ?? '/', apiOrigin);
  const proxyReq = httpRequest(
    {
      protocol: target.protocol,
      hostname: target.hostname,
      port: target.port,
      method: req.method,
      path: target.pathname + target.search,
      headers: { ...req.headers, host: target.host },
    },
    (proxyRes) => {
      res.writeHead(proxyRes.statusCode ?? 502, proxyRes.headers);
      proxyRes.pipe(res);
    },
  );
  proxyReq.on('error', () => {
    if (!res.headersSent) res.writeHead(502, { 'content-type': 'text/plain' });
    res.end('Bad gateway');
  });
  req.pipe(proxyReq);
}

/**
 * Start the harness server. It serves build A by default; call `serve(build,
 * appVersion)` to switch. For each request it answers, in order: a generated
 * `/config.js`, `/api/*` proxied to the e2e API, a real file from the current
 * build, a 404 for a missing `/assets/` path (a vanished chunk), or the current
 * build's `index.html` for any other missing path (the SPA fallback).
 */
export function startPwaBuildServer(opts: {
  builds: { a: string; b: string };
  apiOrigin: string;
  port?: number;
}): Promise<PwaBuildServer> {
  const port = opts.port ?? DEFAULT_PORT;
  let currentDir = opts.builds.a;
  let currentVersion: string | undefined;

  const server: Server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', `http://localhost:${port}`);
    const path = url.pathname;

    // The runtime config script the classic <script src="/config.js"> loads and
    // the update monitor / service worker poll. Omit appVersion when unset, the
    // shape the docker entrypoint writes for an image with APP_VERSION unset.
    if (path === '/config.js') {
      const body =
        currentVersion === undefined
          ? 'window.__TRADR_CONFIG__={};'
          : `window.__TRADR_CONFIG__={"appVersion":${JSON.stringify(currentVersion)}};`;
      res.writeHead(200, { 'content-type': 'text/javascript', 'cache-control': 'no-store' });
      res.end(body);
      return;
    }

    if (path === '/api' || path.startsWith('/api/')) {
      proxyToApi(req, res, opts.apiOrigin);
      return;
    }

    const filePath = resolve(currentDir, `.${path}`);
    if ((filePath === currentDir || filePath.startsWith(currentDir + sep)) && isFile(filePath)) {
      serveFile(filePath, res);
      return;
    }

    // A missing hashed asset is a chunk that this build never served — 404, so a
    // tab left on the previous build hits the §29 chunk-recovery path.
    if (path.startsWith('/assets/')) {
      res.writeHead(404, { 'content-type': 'text/plain', 'cache-control': 'no-store' });
      res.end('Not found');
      return;
    }

    // Any other path is an SPA route — serve the current build's shell.
    serveFile(join(currentDir, 'index.html'), res);
  });

  return new Promise((resolvePromise, reject) => {
    server.once('error', reject);
    server.listen(port, () => {
      resolvePromise({
        url: `http://localhost:${port}`,
        serve(build, appVersion) {
          currentDir = opts.builds[build];
          currentVersion = appVersion;
        },
        close: () =>
          new Promise<void>((res, rej) => server.close((err) => (err ? rej(err) : res()))),
      });
    });
  });
}

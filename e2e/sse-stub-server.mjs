// Standalone SSE drip stub for the CI streaming liveness probe (deployment task
// 12, Req 8.4).
//
// Runs as a COMPOSE SERVICE (node:22-slim, bind-mounted) named `sse-stub` on the
// `web` network — NOT a Playwright webServer. nginx proxies the CI-only probe
// location (docker/conf.d/_probe.inc) to it by DNS name.
//
// It drips a handful of SSE frames spaced out in time so the probe client can
// confirm the proxy path delivers frames incrementally end-to-end (≥2 frames
// with an inter-arrival gap). This is LIVENESS ONLY: it proves the SSE proxy
// path streams; it does NOT prove buffering is disabled (that is the static
// `nginx -T` config assertion's job in the docker-smoke job).
import { createServer } from 'node:http';

const PORT = Number(process.env.PORT || 8080);
const FRAME_COUNT = 5;
const FRAME_GAP_MS = 450; // gap between consecutive frames

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const server = createServer(async (req, res) => {
  const url = new URL(req.url, 'http://stub');

  if (url.pathname === '/healthz') {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('ok');
    return;
  }

  if (url.pathname !== '/_probe/stream') {
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('not found');
    return;
  }

  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });

  // Drip frames spaced ~FRAME_GAP_MS apart so the client sees incremental
  // delivery (inter-arrival gaps), then close.
  for (let i = 0; i < FRAME_COUNT; i += 1) {
    if (res.writableEnded) break;
    res.write(`event: tick\ndata: ${JSON.stringify({ frame: i, ts: Date.now() })}\n\n`);
    if (i < FRAME_COUNT - 1) await sleep(FRAME_GAP_MS);
  }
  res.end();
});

server.listen(PORT, () => {
  console.log(`sse-stub listening on :${PORT} (path: /_probe/stream)`);
});

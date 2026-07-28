// SSE liveness client for the CI streaming probe (deployment task 12, Req 8.4).
//
// POSITIVE LIVENESS ONLY. This reads the SSE ReadableStream and Date.now()-stamps
// each chunk that carries bytes, then confirms the proxy path delivered frames
// incrementally: at least 2 frames arrived with at least one inter-arrival gap
// >= MIN_GAP_MS. That proves the SSE proxy path streams end-to-end against the
// drip stub. It is NOT a negative control: it does not (and cannot) prove
// buffering is disabled — the static `nginx -T` directive assertion in the
// docker-smoke job is the regression guard for that.
//
// Usage: node sse-probe-client.mjs <url> [minGapMs]
//   env: SSE_PROBE_URL, MIN_GAP_MS (argv takes precedence)
const url = process.argv[2] || process.env.SSE_PROBE_URL;
const MIN_GAP_MS = Number(process.argv[3] || process.env.MIN_GAP_MS || 200);

if (!url) {
  console.error('usage: node sse-probe-client.mjs <url> [minGapMs]');
  process.exit(2);
}

const res = await fetch(url, { headers: { Accept: 'text/event-stream' } });
if (!res.ok || !res.body) {
  console.error(`probe ${url}: bad response status=${res.status}`);
  process.exit(1);
}

const reader = res.body.getReader();
const stamps = [];
let buffered = '';
let frames = 0;

for (;;) {
  const { value, done } = await reader.read();
  if (done) break;
  if (value && value.length > 0) {
    stamps.push(Date.now());
    buffered += Buffer.from(value).toString('utf8');
    // Count completed SSE frames (terminated by a blank line).
    const parts = buffered.split('\n\n');
    buffered = parts.pop() ?? '';
    frames += parts.filter((p) => p.trim().length > 0).length;
  }
}

// Largest gap between consecutive chunk arrivals.
let maxGap = 0;
for (let i = 1; i < stamps.length; i += 1) {
  maxGap = Math.max(maxGap, stamps[i] - stamps[i - 1]);
}

console.log(`probe ${url}: reads=${stamps.length} frames=${frames} maxGap=${maxGap}ms`);

if (frames < 2) {
  console.error(`probe ${url}: received ${frames} frames (< 2) — SSE proxy path did not stream`);
  process.exit(1);
}

if (maxGap < MIN_GAP_MS) {
  console.error(
    `probe ${url}: max inter-arrival gap ${maxGap}ms < ${MIN_GAP_MS}ms — frames did not arrive incrementally`,
  );
  process.exit(1);
}

console.log(`probe ${url}: OK — streamed incrementally (${frames} frames, max gap ${maxGap}ms >= ${MIN_GAP_MS}ms)`);

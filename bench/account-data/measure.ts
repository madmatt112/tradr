/**
 * Drive export + import against a running API, sampling its health and memory
 * while it runs (spec account-export-import, task 19; spec
 * import-off-request-thread, task 13 for the trust marks and Origin header).
 * Signs in to a base URL, then times each step — export (empty), import
 * preview, import confirm, and a second export of the now-restored data —
 * while polling `/api/health` every 5 s (5 s timeout) and the metrics endpoint
 * every second for `process_resident_memory_bytes` and
 * `nodejs_heap_size_used_bytes`
 * (apps/api/src/features/metrics/metrics.registry.ts:176; armed on staging in
 * tradr-hosted fly.staging.toml). Prints a per-step wall time, peak RSS/heap
 * with a trust mark, and health table.
 *
 * Portable to either target: the local `docker run --memory=256m` container and,
 * once Deploy Staging has shipped this branch, the 256 MB staging machine.
 *
 * Run with tsx:
 *   BASE_URL=http://localhost:3100 METRICS_URL=http://localhost:9464/metrics \
 *     ORIGIN=http://localhost:3100 \
 *     tsx bench/account-data/measure.ts <archivePath> [label]
 *
 * ORIGIN, when set, is sent as the `Origin` header on every POST (register
 * included) so the bench clears a split-origin CSRF check with no preload shim.
 */
import { createReadStream, statSync } from 'node:fs';
import { Readable } from 'node:stream';

// A standalone driver (not the API), so it reads its own env directly — the
// existing bench harnesses do the same for DATABASE_URL.
/* eslint-disable no-restricted-syntax */
const BASE_URL = process.env.BASE_URL ?? 'http://localhost:3100';
const METRICS_URL = process.env.METRICS_URL ?? 'http://localhost:9464/metrics';
const SKIP_EXPORT_AFTER = process.env.SKIP_EXPORT_AFTER === '1';
const ORIGIN = process.env.ORIGIN;
/* eslint-enable no-restricted-syntax */

const MIB = 1024 * 1024;
const METRICS_INTERVAL_MS = 1_000;
const STALE_GAP_MS = 5_000;
const HEALTH_INTERVAL_MS = 5_000;
const HEALTH_TIMEOUT_MS = 5_000;

interface Steppable {
  setStep(step: string): void;
}

interface StepResult {
  step: string;
  seconds: number;
  ok: boolean;
  bytes?: number;
  note?: string;
}

// --- metrics sampler ---------------------------------------------------------

// Parse one gauge value from Prometheus exposition text (a line beginning with the
// metric name, then whitespace, then a float that may be in exponent form).
function parseGauge(text: string, name: string): number | undefined {
  const re = new RegExp(`^${name}(?:\\{[^}]*\\})?\\s+([0-9eE.+-]+)`, 'm');
  const m = re.exec(text);
  return m ? Number(m[1]) : undefined;
}

interface ScrapeAttempt {
  tMs: number;
  step: string;
  ok: boolean;
  rss?: number;
  heap?: number;
}

interface StepBound {
  step: string;
  startMs: number;
  endMs?: number;
}

// Keeps one record per scrape attempt — failures included — so a step's memory
// figure can be marked untrustworthy instead of silently reusing a stale or
// missing reading (design C11, Requirement 6.2).
class MetricsSampler implements Steppable {
  readonly attempts: ScrapeAttempt[] = [];
  private readonly bounds: StepBound[] = [];
  private timer?: ReturnType<typeof setInterval>;
  private step = 'idle';
  private readonly startMs = Date.now();

  setStep(step: string): void {
    const now = Date.now() - this.startMs;
    const prev = this.bounds[this.bounds.length - 1];
    if (prev && prev.endMs === undefined) prev.endMs = now;
    this.bounds.push({ step, startMs: now });
    this.step = step;
  }

  start(): void {
    const tick = async (): Promise<void> => {
      const step = this.step;
      const tMs = Date.now() - this.startMs;
      try {
        const res = await fetch(METRICS_URL);
        if (!res.ok) {
          this.attempts.push({ tMs, step, ok: false });
          return;
        }
        const text = await res.text();
        const rss = parseGauge(text, 'process_resident_memory_bytes');
        const heap = parseGauge(text, 'nodejs_heap_size_used_bytes');
        this.attempts.push({ tMs, step, ok: rss !== undefined, rss, heap });
      } catch {
        // A scrape can race a restart — recorded as a failed attempt, not dropped.
        this.attempts.push({ tMs, step, ok: false });
      }
    };
    void tick();
    this.timer = setInterval(() => void tick(), METRICS_INTERVAL_MS);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
  }

  peakRss(step?: string): number {
    const rows = step ? this.attempts.filter((a) => a.step === step) : this.attempts;
    return rows.reduce((max, a) => Math.max(max, a.ok ? a.rss ?? 0 : 0), 0);
  }

  peakHeap(step?: string): number {
    const rows = step ? this.attempts.filter((a) => a.step === step) : this.attempts;
    return rows.reduce((max, a) => Math.max(max, a.ok ? a.heap ?? 0 : 0), 0);
  }

  // A step's memory figure is untrustworthy when any scrape attempt during it
  // failed, or when the gap between the step's start, its successful scrapes
  // and its end exceeds STALE_GAP_MS. No earlier reading is reused either way.
  trusted(step: string): boolean {
    const bound = this.bounds.find((b) => b.step === step);
    if (!bound || bound.endMs === undefined) return false;
    const rows = this.attempts.filter((a) => a.step === step);
    if (rows.some((a) => !a.ok)) return false;
    const points = [bound.startMs, ...rows.map((a) => a.tMs).sort((a, b) => a - b), bound.endMs];
    for (let i = 1; i < points.length; i++) {
      if (points[i] - points[i - 1] > STALE_GAP_MS) return false;
    }
    return true;
  }
}

// --- health sampler ------------------------------------------------------------

interface HealthSample {
  tMs: number;
  step: string;
  ok: boolean;
  ms: number;
}

interface HealthSummary {
  count: number;
  longestMs: number;
  misses: { tMs: number; ms: number }[];
}

// Samples `GET /api/health` on its own clock (design C11, Requirement 6.1), so
// a stalled event loop shows up as a miss here even when a metrics scrape —
// served by the same listener but recorded separately — still succeeds.
class HealthSampler implements Steppable {
  readonly samples: HealthSample[] = [];
  private timer?: ReturnType<typeof setInterval>;
  private step = 'idle';
  private readonly startMs = Date.now();

  setStep(step: string): void {
    this.step = step;
  }

  start(): void {
    const tick = async (): Promise<void> => {
      const step = this.step;
      const t0 = Date.now();
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), HEALTH_TIMEOUT_MS);
      try {
        const res = await fetch(`${BASE_URL}/api/health`, { signal: controller.signal });
        this.samples.push({ tMs: t0 - this.startMs, step, ok: res.status === 200, ms: Date.now() - t0 });
      } catch {
        this.samples.push({ tMs: t0 - this.startMs, step, ok: false, ms: Date.now() - t0 });
      } finally {
        clearTimeout(timeout);
      }
    };
    void tick();
    this.timer = setInterval(() => void tick(), HEALTH_INTERVAL_MS);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
  }

  summary(step?: string): HealthSummary {
    const rows = step ? this.samples.filter((s) => s.step === step) : this.samples;
    return {
      count: rows.length,
      longestMs: rows.reduce((max, s) => Math.max(max, s.ms), 0),
      misses: rows.filter((s) => !s.ok).map((s) => ({ tMs: s.tMs, ms: s.ms })),
    };
  }
}

// --- HTTP helpers ------------------------------------------------------------

let sessionCookie = '';

function uniqueIp(): string {
  return `10.99.19.${Math.floor(Math.random() * 254) + 1}`;
}

// Attach the Origin header to a POST when ORIGIN is set (Requirement 6.3).
function withOrigin(headers: Record<string, string>): Record<string, string> {
  return ORIGIN ? { ...headers, Origin: ORIGIN } : headers;
}

// Register a fresh user and capture the session cookie. A unique forwarded IP
// keeps repeated runs out of the /register per-IP limiter (the container trusts
// 127.0.0.1 via TRUSTED_PROXIES).
async function register(): Promise<string> {
  const email = `bench-${Date.now()}-${Math.floor(Math.random() * 1e6)}@example.com`;
  const res = await fetch(`${BASE_URL}/api/auth/register`, {
    method: 'POST',
    headers: withOrigin({ 'Content-Type': 'application/json', 'X-Forwarded-For': uniqueIp() }),
    body: JSON.stringify({ email, password: 'bench-password-1234' }),
  });
  if (res.status !== 201) {
    throw new Error(`register failed: ${res.status} ${await res.text()}`);
  }
  const setCookie = res.headers.getSetCookie();
  const session = setCookie.find((c) => c.startsWith('session='));
  if (!session) throw new Error('no session cookie in register response');
  sessionCookie = session.split(';')[0];
  return email;
}

// POST the archive file as a raw body (the routes read c.req.raw.body).
function archiveBody(archivePath: string): { body: ReadableStream; contentLength: number } {
  const nodeStream = createReadStream(archivePath);
  return {
    body: Readable.toWeb(nodeStream) as ReadableStream,
    contentLength: statSync(archivePath).size,
  };
}

async function timed(
  steppables: Steppable[],
  step: string,
  fn: () => Promise<Partial<StepResult>>,
): Promise<StepResult> {
  for (const s of steppables) s.setStep(step);
  const start = Date.now();
  try {
    const extra = await fn();
    const seconds = (Date.now() - start) / 1000;
    return { step, seconds, ok: true, ...extra };
  } catch (err) {
    const seconds = (Date.now() - start) / 1000;
    return { step, seconds, ok: false, note: err instanceof Error ? err.message : String(err) };
  } finally {
    for (const s of steppables) s.setStep('idle');
  }
}

// Consume a response body to completion, returning the byte count.
async function drain(res: Response): Promise<number> {
  let bytes = 0;
  const reader = res.body?.getReader();
  if (!reader) return 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    bytes += value.length;
  }
  return bytes;
}

// --- steps -------------------------------------------------------------------

async function exportStep(): Promise<Partial<StepResult>> {
  const res = await fetch(`${BASE_URL}/api/account-data/export`, {
    method: 'POST',
    headers: withOrigin({ Cookie: sessionCookie }),
  });
  if (!res.ok) throw new Error(`export ${res.status}: ${await res.text()}`);
  const bytes = await drain(res);
  return { bytes };
}

async function previewStep(
  archivePath: string,
): Promise<Partial<StepResult> & { digest?: string }> {
  const { body, contentLength } = archiveBody(archivePath);
  const res = await fetch(`${BASE_URL}/api/account-data/import/preview`, {
    method: 'POST',
    headers: withOrigin({ Cookie: sessionCookie, 'Content-Type': 'application/zip' }),
    body,
    // Streamed request body requires half-duplex.
    duplex: 'half',
  } as RequestInit);
  const text = await res.text();
  if (!res.ok) throw new Error(`preview ${res.status}: ${text}`);
  const parsed = JSON.parse(text) as { digest: string; counts: Record<string, number> };
  return {
    digest: parsed.digest,
    bytes: contentLength,
    note: `digest ${parsed.digest.slice(0, 12)}…`,
  };
}

async function confirmStep(archivePath: string, digest: string): Promise<Partial<StepResult>> {
  const { body } = archiveBody(archivePath);
  const res = await fetch(`${BASE_URL}/api/account-data/import?digest=${digest}`, {
    method: 'POST',
    headers: withOrigin({ Cookie: sessionCookie, 'Content-Type': 'application/zip' }),
    body,
    duplex: 'half',
  } as RequestInit);
  const text = await res.text();
  if (!res.ok) throw new Error(`confirm ${res.status}: ${text}`);
  const parsed = JSON.parse(text) as { counts: Record<string, number> };
  const total = Object.values(parsed.counts).reduce((a, b) => a + b, 0);
  return { note: `restored ${total} rows+images` };
}

// --- report ------------------------------------------------------------------

function fmtMiB(bytes: number): string {
  return `${(bytes / MIB).toFixed(1)} MiB`;
}

function report(
  label: string,
  results: StepResult[],
  sampler: MetricsSampler,
  health: HealthSampler,
): void {
  const peakRss = sampler.peakRss();
  const overallHealth = health.summary();
  console.log(`\n=== account-data measurement: ${label} ===`);
  console.log(
    `base=${BASE_URL} metrics=${METRICS_URL} origin=${ORIGIN ?? '(none)'} ` +
      `samples=${sampler.attempts.length} health=${overallHealth.count}`,
  );
  console.log(
    'step            seconds   status   peakRSS     peakHeap  mem        health(n/longest/miss)   detail',
  );
  for (const r of results) {
    const stepPeakRss = sampler.peakRss(r.step);
    const stepPeakHeap = sampler.peakHeap(r.step);
    const mem = sampler.trusted(r.step) ? 'trusted' : 'untrusted';
    const h = health.summary(r.step);
    const healthStr = `${h.count}/${h.longestMs}ms/${h.misses.length}`;
    const detail = [r.bytes !== undefined ? fmtMiB(r.bytes) : '', r.note ?? '']
      .filter(Boolean)
      .join(' ');
    console.log(
      `${r.step.padEnd(15)} ${r.seconds.toFixed(1).padStart(7)}   ${(r.ok ? 'ok' : 'FAIL').padEnd(6)}  ${fmtMiB(stepPeakRss).padStart(10)}  ${fmtMiB(stepPeakHeap).padStart(10)}  ${mem.padEnd(9)}  ${healthStr.padEnd(24)} ${detail}`,
    );
  }
  console.log(`\noverall peak RSS : ${fmtMiB(peakRss)} (192 MiB pass line)`);
  console.log(`overall peak heap: ${fmtMiB(sampler.peakHeap())}`);
  console.log(
    `overall health   : ${overallHealth.count} samples, longest ${overallHealth.longestMs}ms, ${overallHealth.misses.length} misses`,
  );
  console.log(
    JSON.stringify({
      label,
      peakRssMiB: Number((peakRss / MIB).toFixed(1)),
      peakHeapMiB: Number((sampler.peakHeap() / MIB).toFixed(1)),
      health: overallHealth,
      steps: results.map((r) => ({
        step: r.step,
        seconds: Number(r.seconds.toFixed(1)),
        ok: r.ok,
        peakRssMiB: Number((sampler.peakRss(r.step) / MIB).toFixed(1)),
        trustedMemory: sampler.trusted(r.step),
        health: health.summary(r.step),
        note: r.note,
      })),
    }),
  );
}

// --- main --------------------------------------------------------------------

async function main(): Promise<void> {
  const archivePath = process.argv[2];
  const label = process.argv[3] ?? archivePath;
  if (!archivePath) {
    console.error('usage: tsx measure.ts <archivePath> [label]');
    process.exit(2);
  }

  const sampler = new MetricsSampler();
  const health = new HealthSampler();
  const steppables: Steppable[] = [sampler, health];
  sampler.start();
  health.start();

  await register();

  const results: StepResult[] = [];

  results.push(await timed(steppables, 'export-before', exportStep));

  let digest: string | undefined;
  results.push(
    await timed(steppables, 'preview', async () => {
      const r = await previewStep(archivePath);
      digest = r.digest;
      return r;
    }),
  );

  if (digest) {
    results.push(await timed(steppables, 'confirm', () => confirmStep(archivePath, digest!)));
  } else {
    results.push({ step: 'confirm', seconds: 0, ok: false, note: 'skipped: no digest' });
  }

  if (!SKIP_EXPORT_AFTER) {
    results.push(await timed(steppables, 'export-after', exportStep));
  }

  // A final settle sample so idle RSS after the run is captured too.
  await new Promise((r) => setTimeout(r, 1_200));
  sampler.stop();
  health.stop();

  report(label, results, sampler, health);
}

void main();

/**
 * Drive export + import against a running API and sample its memory while it runs
 * (spec account-export-import, task 19). Signs in to a base URL, then times each
 * step — export (empty), import preview, import confirm, and a second export of the
 * now-restored data — while polling the metrics endpoint every second for
 * `process_resident_memory_bytes` and `nodejs_heap_size_used_bytes`
 * (apps/api/src/features/metrics/metrics.registry.ts:176; armed on staging in
 * tradr-hosted fly.staging.toml). Prints a per-step wall time + peak RSS/heap table.
 *
 * Portable to either target: the local `docker run --memory=256m` container and,
 * once Deploy Staging has shipped this branch, the 256 MB staging machine.
 *
 * Run with tsx:
 *   BASE_URL=http://localhost:3100 METRICS_URL=http://localhost:9464/metrics \
 *     tsx bench/account-data/measure.ts <archivePath> [label]
 */
import { createReadStream, statSync } from 'node:fs';
import { Readable } from 'node:stream';

// A standalone driver (not the API), so it reads its own env directly — the
// existing bench harnesses do the same for DATABASE_URL.
/* eslint-disable no-restricted-syntax */
const BASE_URL = process.env.BASE_URL ?? 'http://localhost:3100';
const METRICS_URL = process.env.METRICS_URL ?? 'http://localhost:9464/metrics';
const SKIP_EXPORT_AFTER = process.env.SKIP_EXPORT_AFTER === '1';
/* eslint-enable no-restricted-syntax */

const MIB = 1024 * 1024;

interface Sample {
  tMs: number;
  step: string;
  rss: number;
  heap: number;
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

class MetricsSampler {
  readonly samples: Sample[] = [];
  private timer?: ReturnType<typeof setInterval>;
  private step = 'idle';
  private readonly startMs = Date.now();

  setStep(step: string): void {
    this.step = step;
  }

  start(): void {
    const tick = async (): Promise<void> => {
      try {
        const res = await fetch(METRICS_URL);
        if (!res.ok) return;
        const text = await res.text();
        const rss = parseGauge(text, 'process_resident_memory_bytes');
        const heap = parseGauge(text, 'nodejs_heap_size_used_bytes');
        if (rss !== undefined) {
          this.samples.push({
            tMs: Date.now() - this.startMs,
            step: this.step,
            rss,
            heap: heap ?? 0,
          });
        }
      } catch {
        /* transient — a scrape can race a restart */
      }
    };
    void tick();
    this.timer = setInterval(() => void tick(), 1_000);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
  }

  peakRss(step?: string): number {
    const rows = step ? this.samples.filter((s) => s.step === step) : this.samples;
    return rows.reduce((max, s) => Math.max(max, s.rss), 0);
  }

  peakHeap(step?: string): number {
    const rows = step ? this.samples.filter((s) => s.step === step) : this.samples;
    return rows.reduce((max, s) => Math.max(max, s.heap), 0);
  }
}

// --- HTTP helpers ------------------------------------------------------------

let sessionCookie = '';

function uniqueIp(): string {
  return `10.99.19.${Math.floor(Math.random() * 254) + 1}`;
}

// Register a fresh user and capture the session cookie. A unique forwarded IP
// keeps repeated runs out of the /register per-IP limiter (the container trusts
// 127.0.0.1 via TRUSTED_PROXIES).
async function register(): Promise<string> {
  const email = `bench-${Date.now()}-${Math.floor(Math.random() * 1e6)}@example.com`;
  const res = await fetch(`${BASE_URL}/api/auth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': uniqueIp() },
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
  sampler: MetricsSampler,
  step: string,
  fn: () => Promise<Partial<StepResult>>,
): Promise<StepResult> {
  sampler.setStep(step);
  const start = Date.now();
  try {
    const extra = await fn();
    const seconds = (Date.now() - start) / 1000;
    return { step, seconds, ok: true, ...extra };
  } catch (err) {
    const seconds = (Date.now() - start) / 1000;
    return { step, seconds, ok: false, note: err instanceof Error ? err.message : String(err) };
  } finally {
    sampler.setStep('idle');
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
    headers: { Cookie: sessionCookie },
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
    headers: { Cookie: sessionCookie, 'Content-Type': 'application/zip' },
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
    headers: { Cookie: sessionCookie, 'Content-Type': 'application/zip' },
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

function report(label: string, results: StepResult[], sampler: MetricsSampler): void {
  const peakRss = sampler.peakRss();
  console.log(`\n=== account-data measurement: ${label} ===`);
  console.log(`base=${BASE_URL} metrics=${METRICS_URL} samples=${sampler.samples.length}`);
  console.log('step            seconds   status   peakRSS     peakHeap    detail');
  for (const r of results) {
    const stepPeakRss = sampler.peakRss(r.step);
    const stepPeakHeap = sampler.peakHeap(r.step);
    const detail = [r.bytes !== undefined ? fmtMiB(r.bytes) : '', r.note ?? '']
      .filter(Boolean)
      .join(' ');
    console.log(
      `${r.step.padEnd(15)} ${r.seconds.toFixed(1).padStart(7)}   ${(r.ok ? 'ok' : 'FAIL').padEnd(6)}  ${fmtMiB(stepPeakRss).padStart(10)}  ${fmtMiB(stepPeakHeap).padStart(10)}  ${detail}`,
    );
  }
  console.log(`\noverall peak RSS : ${fmtMiB(peakRss)} (192 MiB pass line)`);
  console.log(`overall peak heap: ${fmtMiB(sampler.peakHeap())}`);
  console.log(
    JSON.stringify({
      label,
      peakRssMiB: Number((peakRss / MIB).toFixed(1)),
      peakHeapMiB: Number((sampler.peakHeap() / MIB).toFixed(1)),
      steps: results.map((r) => ({
        step: r.step,
        seconds: Number(r.seconds.toFixed(1)),
        ok: r.ok,
        peakRssMiB: Number((sampler.peakRss(r.step) / MIB).toFixed(1)),
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
  sampler.start();

  await register();

  const results: StepResult[] = [];

  results.push(await timed(sampler, 'export-before', exportStep));

  let digest: string | undefined;
  results.push(
    await timed(sampler, 'preview', async () => {
      const r = await previewStep(archivePath);
      digest = r.digest;
      return r;
    }),
  );

  if (digest) {
    results.push(await timed(sampler, 'confirm', () => confirmStep(archivePath, digest!)));
  } else {
    results.push({ step: 'confirm', seconds: 0, ok: false, note: 'skipped: no digest' });
  }

  if (!SKIP_EXPORT_AFTER) {
    results.push(await timed(sampler, 'export-after', exportStep));
  }

  // A final settle sample so idle RSS after the run is captured too.
  await new Promise((r) => setTimeout(r, 1_200));
  sampler.stop();

  report(label, results, sampler);
}

void main();

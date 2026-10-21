// Import executor (design C3).
//
// Runs one archive job — a preview or a confirm — to its single outcome, with a
// cancel path and a hard stop. `runImportJobInWorker` spawns the design C4 worker
// off the main thread so a CPU-bound archive read or restore cannot starve the
// event loop (Requirement 1.1); `runImportJobInThread` runs the same job core on
// the calling thread for tests whose per-request transaction a worker's own
// connection cannot see (design D9). `defaultImportExecutor` is the worker one.
//
// The worker reports its result over the wire as `{ status, code, message,
// fields? }` (design C4); `fromWireError` rebuilds the matching error class on the
// main thread so `error.middleware.ts` renders the same envelope as today
// (Requirement 4.3).

import type { EventEmitter } from 'node:events';
import { existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Worker } from 'node:worker_threads';

import { AppError } from '@/lib/errors';

import { ArchiveInvalidError, ImportFailedError, ImportTimedOutError } from './account-data.errors';
import { confirmArchive, previewArchive } from './import.service';
import type {
  ImportJob,
  WorkerControlMessage,
  WorkerErrorPayload,
  WorkerResultMessage,
} from './import.worker';

/** Default grace between a cancel and a hard terminate (design C3 Cancel, D4). */
const DEFAULT_CANCEL_GRACE_MS = 20_000;

/** The worker's old-generation heap limit: a runaway becomes a coded 500 (D6). */
const WORKER_MAX_OLD_GEN_MB = 96;

/**
 * The read-done value the confirm worker stores into the shared phase flag; past
 * it the executor must not terminate (design D7, Requirement 2.5). Mirrors the
 * `PHASE_READ_DONE` constant in `import.worker.ts` (design Data Models).
 */
const PHASE_READ_DONE = 1;

export interface ImportExecutorOptions {
  cancelGraceMs?: number;
  /** Overrides worker-module discovery; set by tests (design C3 Worker spawn). */
  workerUrl?: URL;
}

export type ImportExecutor = (
  job: ImportJob,
  signal: AbortSignal,
  opts?: ImportExecutorOptions,
) => Promise<unknown>;

/**
 * Rebuild the error a worker reported in wire form (design C6). An
 * `ARCHIVE_INVALID` code becomes an `ArchiveInvalidError` carrying its validation
 * fields; any other code becomes a plain `AppError` with the wire status, code
 * and message, so the error middleware renders the same envelope as a thrown one.
 */
export function fromWireError(wire: WorkerErrorPayload): AppError {
  if (wire.code === 'ARCHIVE_INVALID') {
    return new ArchiveInvalidError(wire.fields ?? [], wire.message);
  }
  return new AppError(wire.status, wire.code, wire.message);
}

// The worker bundle built once per process for dev/test, cached as a promise so
// concurrent spawns share one build (design D8).
let builtWorkerUrl: Promise<URL> | undefined;

/**
 * Build the worker bundle once per process under `os.tmpdir()` and return its
 * URL (design D8). Reached only in dev (tsx) and vitest, where the source `.ts`
 * worker beside this module inherits the loader but not the `@/` path alias
 * (probe P7); production spawns `dist/import.worker.js` instead. The C7 build
 * helper sits outside the api `rootDir`, so it is loaded through a runtime URL
 * import — a literal path would pull it into `tsc` and break `check-types`.
 */
function buildWorkerOnce(): Promise<URL> {
  builtWorkerUrl ??= (async () => {
    const helperUrl = new URL('../../../scripts/build-import-worker.mjs', import.meta.url);
    const { buildImportWorker } = (await import(helperUrl.href)) as {
      buildImportWorker: (opts: { outdir: string }) => Promise<unknown>;
    };
    const outdir = mkdtempSync(join(tmpdir(), 'tradr-import-worker-'));
    await buildImportWorker({ outdir });
    return pathToFileURL(join(outdir, 'import.worker.js'));
  })();
  return builtWorkerUrl;
}

/**
 * The worker module to spawn: the bundled `import.worker.js` beside the running
 * module when it exists (the `dist/` bundle), otherwise a bundle built on first
 * use (design C3 Worker spawn, D8). A test passes `workerUrl` to bypass both.
 */
async function resolveWorkerUrl(override?: URL): Promise<URL> {
  if (override) return override;
  const beside = new URL('./import.worker.js', import.meta.url);
  if (existsSync(beside)) return beside;
  return buildWorkerOnce();
}

/**
 * Run the job in a fresh worker thread and settle with its single outcome
 * (design C3). The first `result` message resolves; the first `error` message
 * rejects with the rebuilt error; a worker `'error'` event (an uncaught throw or
 * `ERR_WORKER_OUT_OF_MEMORY`) or an `'exit'` with no terminal message rejects
 * with `ImportFailedError`; a terminate after a cancel rejects with
 * `ImportTimedOutError`. The promise settles only after the worker's `'exit'`.
 *
 * On a cancel the executor posts `{ type: 'cancel' }` once, then after
 * `cancelGraceMs` (default 20,000) terminates the worker only when its phase is
 * not read-done — a confirm past its read is never terminated (design D7).
 */
export const runImportJobInWorker: ImportExecutor = async (job, signal, opts = {}) => {
  const cancelGraceMs = opts.cancelGraceMs ?? DEFAULT_CANCEL_GRACE_MS;
  const url = await resolveWorkerUrl(opts.workerUrl);

  // phase[0]: 0 = reading, 1 = read done; the confirm core sets it through the
  // worker's onReadDone (design Data Models). A SharedArrayBuffer so the main
  // thread can read it while the worker is busy (probe P6).
  const phase = new Int32Array(new SharedArrayBuffer(4));

  const worker = new Worker(url, {
    workerData: { job, phase },
    resourceLimits: { maxOldGenerationSizeMb: WORKER_MAX_OLD_GEN_MB },
  });

  // The DOM lib's global `Worker` interface (no `on`) shadows the node class's
  // instance type under this tsconfig, so subscribe through its EventEmitter side.
  const workerEvents = worker as unknown as EventEmitter;

  return await new Promise((resolve, reject) => {
    let terminal: WorkerResultMessage | undefined;
    let terminatedAfterCancel = false;
    let cancelTimer: ReturnType<typeof setTimeout> | undefined;

    const onAbort = () => {
      worker.postMessage({ type: 'cancel' } satisfies WorkerControlMessage);
      cancelTimer = setTimeout(() => {
        if (Atomics.load(phase, 0) !== PHASE_READ_DONE) {
          terminatedAfterCancel = true;
          void worker.terminate();
        }
      }, cancelGraceMs);
    };

    if (signal.aborted) onAbort();
    else signal.addEventListener('abort', onAbort, { once: true });

    workerEvents.on('message', (msg: WorkerResultMessage) => {
      terminal ??= msg; // the first terminal message is the outcome
    });

    // A worker `'error'` is always followed by `'exit'`, which settles below with
    // ImportFailedError; this listener keeps the error off the main thread.
    workerEvents.on('error', () => undefined);

    workerEvents.on('exit', () => {
      if (cancelTimer) clearTimeout(cancelTimer);
      signal.removeEventListener('abort', onAbort);
      if (terminal) {
        if (terminal.type === 'result') resolve(terminal.value);
        else reject(fromWireError(terminal.error));
      } else if (terminatedAfterCancel) {
        reject(new ImportTimedOutError());
      } else {
        reject(new ImportFailedError());
      }
    });
  });
};

/**
 * Run the job core on the calling thread with the same outcome (design C3,
 * D9). The `holdMs` test hold is a synchronous CPU wait, exactly the pre-feature
 * execution model the Requirement 1.4 red run uses. A cancel aborts the core's
 * signal with `ImportTimedOutError`, which the reader throws at its next push;
 * there is no worker to terminate, so `cancelGraceMs` and `workerUrl` are unused.
 */
export const runImportJobInThread: ImportExecutor = async (job, signal) => {
  const controller = new AbortController();
  const onAbort = () => controller.abort(new ImportTimedOutError());
  if (signal.aborted) onAbort();
  else signal.addEventListener('abort', onAbort, { once: true });

  // Test-only synchronous CPU hold (Requirement 1.4); never set in production.
  if (job.holdMs) {
    const until = Date.now() + job.holdMs;
    while (Date.now() < until) {
      // busy-wait
    }
  }

  try {
    if (job.kind === 'preview') {
      return await previewArchive(job.userId, job.archivePath, {
        caps: job.caps,
        signal: controller.signal,
      });
    }
    return await confirmArchive(job.userId, job.archivePath, {
      caps: job.caps,
      lockTimeout: job.lockTimeout,
      signal: controller.signal,
    });
  } finally {
    signal.removeEventListener('abort', onAbort);
  }
};

/** The executor the orchestrators use by default (design C3): the worker one. */
export const defaultImportExecutor: ImportExecutor = runImportJobInWorker;

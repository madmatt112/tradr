// Per-operation import worker entry (design C4).
//
// Runs one archive job — a preview or a confirm — off the API's main thread so a
// CPU-bound archive read or restore cannot starve the event loop (Requirement
// 1.1). The executor (import.executor.ts) spawns this module as a `worker_threads`
// worker, passing the job and a shared phase flag in `workerData`, and sends a
// single `cancel` message when the deadline fires or the client disconnects.
//
// The worker reads the job, runs the matching archive-job core (import.service.ts)
// against its own inherited database pool, posts exactly one terminal message in
// the wire form below, then closes its pool and exits. The wire form carries only
// status, code, message and (for an `ArchiveInvalidError`) the validation fields —
// never a stack, a path or another user's data. No environment variable or config
// gate is read (Requirement 1.3): one worker lives and dies inside one request.

import { parentPort, workerData } from 'node:worker_threads';

import type { ArchiveCaps, ArchiveCounts, ImportPreview, ImportResult } from '@tradr/shared';

import { sql } from '@/db';
import { AppError, ValidationError } from '@/lib/errors';

import { ImportTimedOutError } from './account-data.errors';
import { confirmArchive, previewArchive } from './import.service';

/** The job the executor hands the worker in `workerData.job`. */
export type ImportJob =
  | {
      kind: 'preview';
      userId: string;
      archivePath: string;
      caps?: Partial<ArchiveCaps>;
      /** Test-only synchronous CPU hold (Requirement 1.4); never set in production. */
      holdMs?: number;
    }
  | {
      kind: 'confirm';
      userId: string;
      archivePath: string;
      caps?: Partial<ArchiveCaps>;
      lockTimeout?: string;
      holdMs?: number;
    };

/** The one message the main thread may send the worker (design Data Models). */
export type WorkerControlMessage = { type: 'cancel' };

/** The error shape that crosses the wire; no stack or path (design C4). */
export type WorkerErrorPayload = {
  status: number;
  code: string;
  message: string;
  fields?: Array<{ path: string; code: string; message: string }>;
};

/** The one terminal message the worker posts back (design Data Models). */
export type WorkerResultMessage =
  | {
      type: 'result';
      value: Omit<ImportPreview, 'digest'> | { result: ImportResult; counts: ArchiveCounts };
    }
  | { type: 'error'; error: WorkerErrorPayload };

// `workerData.phase` is an Int32Array(1) over a SharedArrayBuffer. It starts at 0
// (reading); the confirm sets it to 1 once its read is done, after which the
// executor must not terminate the worker (design D7, Requirement 2.5).
const PHASE_READ_DONE = 1;

/**
 * Reduce an error to the wire form. An `AppError` crosses with its own status,
 * code and message (and an `ArchiveInvalidError`'s validation fields); anything
 * else — only a preview can throw a non-`AppError`, since the confirm core maps
 * its own — becomes the 500 import-failed error with the preview message.
 */
function toWireError(err: unknown): WorkerErrorPayload {
  if (err instanceof AppError) {
    const payload: WorkerErrorPayload = {
      status: err.statusCode,
      code: err.code,
      message: err.message,
    };
    if (err instanceof ValidationError && err.fields) payload.fields = err.fields;
    return payload;
  }
  return {
    status: 500,
    code: 'IMPORT_FAILED',
    message: 'The archive could not be checked.',
  };
}

async function run(): Promise<void> {
  const { job, phase } = workerData as { job: ImportJob; phase: Int32Array };

  // One controller for the whole operation. The first `cancel` aborts it with the
  // timeout error, which the reader throws at its next push (design C5). Past a
  // confirm's read nothing checks it, so the commit still runs (design D7).
  const controller = new AbortController();
  parentPort?.on('message', (msg: WorkerControlMessage) => {
    if (msg?.type === 'cancel' && !controller.signal.aborted) {
      controller.abort(new ImportTimedOutError());
    }
  });

  // Test-only CPU hold on the worker thread (Requirement 1.4). Proves the main
  // thread keeps serving while this operation is busy; never set in production.
  if (job.holdMs) {
    const until = Date.now() + job.holdMs;
    while (Date.now() < until) {
      // busy-wait
    }
  }

  let message: WorkerResultMessage;
  try {
    if (job.kind === 'preview') {
      const value = await previewArchive(job.userId, job.archivePath, {
        caps: job.caps,
        signal: controller.signal,
      });
      message = { type: 'result', value };
    } else {
      const value = await confirmArchive(job.userId, job.archivePath, {
        caps: job.caps,
        lockTimeout: job.lockTimeout,
        signal: controller.signal,
        onReadDone: () => Atomics.store(phase, 0, PHASE_READ_DONE),
      });
      message = { type: 'result', value };
    }
  } catch (err) {
    message = { type: 'error', error: toWireError(err) };
  }

  // Exactly one terminal message, then close this worker's own pool and exit (the
  // shutdown precedent at apps/api/src/index.ts:138). The `process.exit(0)` is
  // load-bearing: the `parentPort` cancel listener above keeps this worker's event
  // loop ref'd, so once the message is delivered and the pool is closed the thread
  // would otherwise never emit `'exit'` and the executor — which settles only on
  // `'exit'` (design C4) — would hang the whole request.
  parentPort?.postMessage(message);
  await sql.end();
  process.exit(0);
}

void run();

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { afterAll, describe, expect, it } from 'vitest';

import { AppError } from '@/lib/errors';

import { ArchiveInvalidError, ImportFailedError } from './account-data.errors';
import { fromWireError, runImportJobInWorker } from './import.executor';
import type { ImportJob, WorkerErrorPayload } from './import.worker';

const tmpDirs: string[] = [];

/**
 * Writes a worker module that loads and exits with no `postMessage` call, so
 * its `'exit'` event is the only thing `runImportJobInWorker` sees (design C3
 * Outcome: "an 'exit' with no terminal message rejects with ImportFailedError").
 * `.mjs` makes Node load it as ESM regardless of the enclosing directory, since
 * `tmpdir()` has no `package.json` to set `"type": "module"`.
 */
function writeNoTerminalMessageWorker(): URL {
  const dir = mkdtempSync(join(tmpdir(), 'import-executor-test-'));
  tmpDirs.push(dir);
  const file = join(dir, 'no-terminal-message.worker.mjs');
  writeFileSync(file, '// loads, does nothing, exits with no postMessage\n');
  return pathToFileURL(file);
}

afterAll(() => {
  for (const dir of tmpDirs) rmSync(dir, { recursive: true, force: true });
});

/**
 * Contract — fromWireError(wire) (design C6; Requirement 4.3)
 *
 * | Criterion (task 6 Success)                                              | Pre-condition                               | Call (seam)                | Observable result                                      | Expected-value source |
 * | ------------------------------------------------------------------------- | -------------------------------------------- | --------------------------- | -------------------------------------------------------- | ---------------------- |
 * | rebuilds an `ARCHIVE_INVALID` wire error as `ArchiveInvalidError`        | wire has `code: 'ARCHIVE_INVALID'` + fields | `fromWireError(wire)`        | instance of `ArchiveInvalidError`, same fields + message | design C6: "rebuilds `ArchiveInvalidError(fields, message)` when `code` is `ARCHIVE_INVALID`" |
 * | rebuilds any other code as `AppError` with its status, code and message | wire has a non-`ARCHIVE_INVALID` code       | `fromWireError(wire)`        | instance of `AppError` (not `ArchiveInvalidError`), same status/code/message | design C6: "else an `AppError(status, code, message)`" |
 *
 * Contract — runImportJobInWorker(job, signal, { workerUrl }) (design C3; Requirements 1.1, 2.4)
 *
 * | Criterion (task 6 Success)                                               | Pre-condition                                          | Call (seam)                                         | Observable result                      | Expected-value source |
 * | -------------------------------------------------------------------------- | -------------------------------------------------------- | ----------------------------------------------------- | ----------------------------------------- | ---------------------- |
 * | a worker that exits with no terminal message rejects with the failed class | `workerUrl` points at a module that posts no message    | `runImportJobInWorker(job, signal, { workerUrl })`    | promise rejects, `instanceof ImportFailedError` | design C3 Outcome: "an 'exit' with no terminal message rejects with `ImportFailedError`" |
 */
describe('fromWireError', () => {
  it('rebuilds an ARCHIVE_INVALID wire error as ArchiveInvalidError with its fields', () => {
    const wire: WorkerErrorPayload = {
      status: 400,
      code: 'ARCHIVE_INVALID',
      message: 'The archive has 2 problems.',
      fields: [
        { path: 'accounts[0].name', code: 'invalid_type', message: 'Required' },
        { path: 'positions[3].quantity', code: 'too_small', message: 'Must be positive' },
      ],
    };

    const error = fromWireError(wire);

    expect(error).toBeInstanceOf(ArchiveInvalidError);
    expect(error.message).toBe(wire.message);
    expect((error as ArchiveInvalidError).fields).toEqual(wire.fields);
  });

  it('rebuilds any other code as an AppError with its status, code and message', () => {
    const wire: WorkerErrorPayload = {
      status: 503,
      code: 'IMPORT_BUSY',
      message: 'The account is busy with another data operation; retry shortly.',
    };

    const error = fromWireError(wire);

    expect(error).toBeInstanceOf(AppError);
    expect(error).not.toBeInstanceOf(ArchiveInvalidError);
    expect(error.statusCode).toBe(wire.status);
    expect(error.code).toBe(wire.code);
    expect(error.message).toBe(wire.message);
  });
});

describe('runImportJobInWorker', () => {
  it('rejects with ImportFailedError when the worker exits with no terminal message', async () => {
    const workerUrl = writeNoTerminalMessageWorker();
    const signal = new AbortController().signal;
    const job: ImportJob = {
      kind: 'preview',
      userId: 'test-user',
      archivePath: '/tmp/import-executor-test-does-not-exist.zip',
    };

    await expect(runImportJobInWorker(job, signal, { workerUrl })).rejects.toBeInstanceOf(
      ImportFailedError,
    );
  }, 10000);
});

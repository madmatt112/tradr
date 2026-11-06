import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

import ts from 'typescript';
import { describe, expect, it } from 'vitest';

/**
 * Design C13: the product has no background scheduler. Every long-running
 * `setInterval` is one of five known heartbeats (a stream keep-alive, a
 * fence poll, an idle ping, and two sweepers' own tick loop) and nothing in
 * `apps/api/src` imports a cron library. This test walks the real tree with
 * the TypeScript compiler's own parser so a new timer or import shows up as
 * a failing count rather than a missed code-review comment.
 */

const SRC_ROOT = dirname(fileURLToPath(import.meta.url));

const CRON_DENYLIST = ['node-cron', 'cron', 'node-schedule', 'bree', 'agenda', 'bullmq'];

/** The only files allowed a `setInterval` call, and how many each may hold. */
const ALLOWED_SET_INTERVAL: Record<string, number> = {
  'features/advisor/stream.handler.ts': 1,
  'lib/object-storage/gc-fence.ts': 1,
  'features/account-data/import.service.ts': 1,
  'features/account-deletion/account-deletion.sweeper.ts': 1,
  'features/auth/auth.sweeper.ts': 1,
};

export interface ScanResult {
  setIntervalCalls: number;
  cronImports: string[];
}

function isSetIntervalCallee(expr: ts.Expression): boolean {
  if (ts.isIdentifier(expr)) return expr.text === 'setInterval';
  if (ts.isPropertyAccessExpression(expr)) return expr.name.text === 'setInterval';
  return false;
}

/** Parse one source file's text and count `setInterval` calls and cron-library imports. */
export function scanSource(sourceText: string, fileName = 'sample.ts'): ScanResult {
  const sourceFile = ts.createSourceFile(fileName, sourceText, ts.ScriptTarget.Latest, true);
  let setIntervalCalls = 0;
  const cronImports: string[] = [];

  function visit(node: ts.Node): void {
    if (ts.isCallExpression(node) && isSetIntervalCallee(node.expression)) {
      setIntervalCalls++;
    }
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
      const mod = node.moduleSpecifier.text;
      if (CRON_DENYLIST.includes(mod)) cronImports.push(mod);
    }
    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
  return { setIntervalCalls, cronImports };
}

/** Every product `.ts` file under `root`, skipping tests. */
function walkProductFiles(root: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(root, { withFileTypes: true, recursive: true })) {
    if (!entry.isFile()) continue;
    if (!entry.name.endsWith('.ts')) continue;
    if (entry.name.endsWith('.test.ts')) continue;
    out.push(join(entry.parentPath, entry.name));
  }
  return out;
}

describe('no-scheduler guard (design C13)', () => {
  it('apps/api/src holds only the five known heartbeat intervals and no cron-library import', () => {
    const actualSetInterval: Record<string, number> = {};
    const cronHits: string[] = [];

    for (const file of walkProductFiles(SRC_ROOT)) {
      const rel = relative(SRC_ROOT, file).split('\\').join('/');
      const result = scanSource(readFileSync(file, 'utf8'), rel);
      if (result.setIntervalCalls > 0) actualSetInterval[rel] = result.setIntervalCalls;
      if (result.cronImports.length > 0) {
        cronHits.push(`${rel}: ${result.cronImports.join(', ')}`);
      }
    }

    expect(cronHits).toEqual([]);
    expect(actualSetInterval).toEqual(ALLOWED_SET_INTERVAL);
  });

  it('counts a bare setInterval call', () => {
    expect(scanSource('setInterval(() => {}, 1000);').setIntervalCalls).toBe(1);
  });

  it('counts setInterval as a property access', () => {
    expect(scanSource('globalThis.setInterval(() => {}, 1000);').setIntervalCalls).toBe(1);
  });

  it('counts two calls in the same file', () => {
    const src = 'setInterval(() => {}, 1000); setInterval(() => {}, 2000);';
    expect(scanSource(src).setIntervalCalls).toBe(2);
  });

  it('does not count a type position', () => {
    const src = 'let heartbeat: ReturnType<typeof setInterval> | undefined;';
    expect(scanSource(src).setIntervalCalls).toBe(0);
  });

  it('does not count a comment', () => {
    const src = '// setInterval is used elsewhere, this file holds no call\nconst x = 1;';
    expect(scanSource(src).setIntervalCalls).toBe(0);
  });

  it('flags an import from the cron-library denylist', () => {
    expect(scanSource("import cron from 'node-cron';").cronImports).toEqual(['node-cron']);
  });

  it('passes a sample importing an allowed module', () => {
    expect(scanSource("import { z } from 'zod';").cronImports).toEqual([]);
  });
});

import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { ESLint } from 'eslint';
import { describe, it, expect } from 'vitest';

// Resolve the repo root from this file's own location (…/apps/web/scripts/
// __tests__/ → up 4) so the test is portable across machines and CI runners.
// Previously this was a hardcoded local absolute path, which made the ESLint
// cwd/filePath unresolvable on the CI runner.
const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');
const SELF_TEST_PATH = `${PROJECT_ROOT}/apps/web/src/features/drawer/components/__SelfTest.tsx`;

const eslint = new ESLint({ cwd: PROJECT_ROOT });
const lint = async (source: string) =>
  (await eslint.lintText(source, { filePath: SELF_TEST_PATH }))[0].messages;

describe('drawer import restriction', () => {
  it('flags direct banned import (@/stores/event-bus.store)', async () => {
    const msgs = await lint(`import {} from '@/stores/event-bus.store';\nexport {};\n`);
    expect(msgs.some((m) => m.ruleId === 'no-restricted-imports')).toBe(true);
  });

  it('allows non-restricted import (@/lib/format)', async () => {
    const msgs = await lint(`import {} from '@/lib/format';\nexport {};\n`);
    expect(msgs.some((m) => m.ruleId === 'no-restricted-imports')).toBe(false);
  });

  it('flags barrel import (@/stores) via patterns group', async () => {
    const msgs = await lint(`import {} from '@/stores';\nexport {};\n`);
    expect(msgs.some((m) => m.ruleId === 'no-restricted-imports')).toBe(true);
  });
});

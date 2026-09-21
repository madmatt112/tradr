// @vitest-environment node
//
// The Statistics-panel deep links only work if every anchor in STAT_ANCHORS is
// a heading id the docs build actually emits. Rather than hardcode the expected
// slugs, this test derives them the way the docs build does: it reads the
// Methodology page, feeds its headings in document order to the same
// `github-slugger` the MDX pipeline uses, and asserts each anchor is in the
// resulting id set. A heading rename on the docs side fails here, naming the
// missing id, before it can ship a dead in-app link (2.2, 2.4).
//
// `github-slugger` is a web devDependency imported here only — never at runtime
// (it must not join the performance chunk). The host rule mirrors
// CoachMark.test.tsx:254: the docs host lives in docs.ts and nowhere else.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import GithubSlugger from 'github-slugger';
import { describe, expect, it } from 'vitest';

import { DOCS_BASE_URL } from '@/lib/docs';

import { STAT_ANCHORS } from './statAnchors';

const THIS_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(THIS_DIR, '../../../../../..');
const GLOSSARY = path.join(
  REPO_ROOT,
  'apps/docs/src/content/docs/user-guide/reference/metrics-glossary.mdx',
);

const HEADING = /^#{1,6}\s+(.+?)\s*$/;
const FENCE = /^\s*```/;

/**
 * Slug every heading in `markdown`, in document order, through one slugger —
 * so the deduping counters match the docs build — skipping fenced code so a
 * `#` comment inside a code block is not mistaken for a heading.
 */
function collectHeadingIds(markdown: string): Set<string> {
  const slugger = new GithubSlugger();
  const ids = new Set<string>();
  let inFence = false;
  for (const line of markdown.split('\n')) {
    if (FENCE.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    const match = HEADING.exec(line);
    if (match) ids.add(slugger.slug(match[1]));
  }
  return ids;
}

describe('STAT_ANCHORS', () => {
  it('every anchor is a heading id on the Methodology page', () => {
    const ids = collectHeadingIds(readFileSync(GLOSSARY, 'utf8'));
    const present = [...ids];
    for (const [field, anchor] of Object.entries(STAT_ANCHORS)) {
      expect(
        present,
        `STAT_ANCHORS.${field} points at #${anchor}, which the page does not have. Page ids: ${present.join(', ')}`,
      ).toContain(anchor);
    }
  });

  it('does not hardcode the docs host (it lives in docs.ts only)', () => {
    const source = readFileSync(path.join(THIS_DIR, 'statAnchors.ts'), 'utf8');
    expect(source).not.toContain(DOCS_BASE_URL);
  });
});

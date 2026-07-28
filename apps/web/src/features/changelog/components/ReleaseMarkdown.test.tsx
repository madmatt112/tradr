// @vitest-environment jsdom
import { cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import type { ChangelogRelease } from '@tradr/shared';

import { ReleaseCard } from './ReleaseCard';
import { ReleaseMarkdown } from './ReleaseMarkdown';

afterEach(cleanup);

describe('ReleaseMarkdown', () => {
  it('renders GFM tables', () => {
    const md = '| Feature | Status |\n| ------- | ------ |\n| Charts  | Done   |';
    const { container } = render(<ReleaseMarkdown content={md} />);

    const table = container.querySelector('table');
    expect(table).not.toBeNull();
    expect(table!.querySelectorAll('th')).toHaveLength(2);
    expect(table!.textContent).toContain('Charts');
    expect(table!.textContent).toContain('Done');
  });

  it('renders inline HTML and <script> as text, never live markup (sanitize property)', () => {
    const md =
      'before <script>alert("xss")</script> after <img src=x onerror=alert(1)> <b>bold</b>';
    const { container } = render(<ReleaseMarkdown content={md} />);

    // rehype-sanitize default schema + no rehype-raw: the tags never become
    // live DOM elements — the identical property the advisor's
    // MarkdownRenderer pins for assistant messages.
    expect(container.querySelector('script')).toBeNull();
    expect(container.querySelector('img')).toBeNull();
    expect(container.querySelector('b')).toBeNull();
    // The surrounding markdown text and the tags' inner text survive as text.
    expect(container.textContent).toContain('before');
    expect(container.textContent).toContain('after');
    expect(container.textContent).toContain('alert("xss")');
    expect(container.textContent).toContain('bold');
  });

  it('gives headings, lists, and links a real style tier (no inert prose classes)', () => {
    const md = "## What's Changed\n\n* a change\n* another change\n";
    const { container } = render(<ReleaseMarkdown content={md} />);

    // The `prose` plugin is not installed, so the tiers must come from the
    // element styles themselves — an unstyled heading/list is the bug.
    const heading = container.querySelector('h2');
    expect(heading?.className).toContain('uppercase');
    const list = container.querySelector('ul');
    expect(list?.className).toContain('list-disc');
    expect(list!.querySelectorAll('li')).toHaveLength(2);
  });

  it('shortens auto-linked GitHub URLs to their identifier', () => {
    const md = [
      'ci: something by @someone in https://github.com/madmatt112/tradr/pull/12',
      '',
      '**Full Changelog**: https://github.com/madmatt112/tradr/compare/v0.1.0...v0.5.0',
    ].join('\n');
    const { container } = render(<ReleaseMarkdown content={md} />);

    const links = [...container.querySelectorAll('a')];
    expect(links.map((a) => a.textContent)).toEqual(['#12', 'v0.1.0…v0.5.0']);
    // The href is untouched — only the visible text is shortened.
    expect(links[0].getAttribute('href')).toBe('https://github.com/madmatt112/tradr/pull/12');
    expect(links[0].getAttribute('rel')).toBe('noreferrer noopener');
  });

  it('leaves authored link text and non-GitHub URLs alone', () => {
    const md =
      '[see the PR](https://github.com/madmatt112/tradr/pull/12) and https://example.com/a/b';
    const { container } = render(<ReleaseMarkdown content={md} />);

    const links = [...container.querySelectorAll('a')];
    expect(links.map((a) => a.textContent)).toEqual(['see the PR', 'https://example.com/a/b']);
  });
});

function makeRelease(overrides: Partial<ChangelogRelease> = {}): ChangelogRelease {
  return {
    id: '1',
    name: 'v1.2.0',
    tag: 'v1.2.0',
    publishedAt: '2026-05-01T12:00:00Z',
    body: 'Some **notes**.',
    htmlUrl: 'https://github.com/madmatt112/tradr/releases/tag/v1.2.0',
    prerelease: false,
    ...overrides,
  };
}

describe('ReleaseCard', () => {
  it('shows the Pre-release badge only when flagged', () => {
    const { container, rerender } = render(<ReleaseCard release={makeRelease()} />);
    expect(container.textContent).not.toContain('Pre-release');

    rerender(<ReleaseCard release={makeRelease({ prerelease: true })} />);
    expect(container.textContent).toContain('Pre-release');
  });

  it('renders title, body markdown, and a safe external GitHub link', () => {
    const { container } = render(<ReleaseCard release={makeRelease()} />);

    expect(container.textContent).toContain('v1.2.0');
    expect(container.querySelector('strong')?.textContent).toBe('notes');

    const link = container.querySelector('a');
    expect(link).not.toBeNull();
    expect(link!.getAttribute('href')).toBe(
      'https://github.com/madmatt112/tradr/releases/tag/v1.2.0',
    );
    expect(link!.getAttribute('target')).toBe('_blank');
    expect(link!.getAttribute('rel')).toBe('noreferrer noopener');
    expect(link!.className).toContain('cursor-pointer');
  });
});

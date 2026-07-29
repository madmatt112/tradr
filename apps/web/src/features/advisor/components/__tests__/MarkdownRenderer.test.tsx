// @vitest-environment jsdom
// MarkdownRenderer typography (REQ-1.13).
//
// These pin the properties that were silently broken while the component
// carried `prose` classes with no @tailwindcss/typography installed: under
// Preflight's reset the headings, list markers, table rules and block margins
// all resolved to nothing, and links rendered in the body text colour. The
// assertions are on the emitted classes rather than computed style because
// jsdom does not run Tailwind — a class-less heading or list is the bug.
import { cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import { MarkdownRenderer } from '../MarkdownRenderer';

afterEach(cleanup);

describe('MarkdownRenderer typography', () => {
  it('gives h1/h2/h3 distinct tiers instead of body text', () => {
    const { container } = render(<MarkdownRenderer content={'# One\n\n## Two\n\n### Three\n'} />);

    const h1 = container.querySelector('h1')!;
    const h2 = container.querySelector('h2')!;
    const h3 = container.querySelector('h3')!;
    for (const h of [h1, h2, h3]) expect(h.className).not.toBe('');
    // Each tier is told apart by something — size, then weight, then case.
    expect(h1.className).toContain('text-lg');
    expect(h2.className).toContain('font-semibold');
    expect(h3.className).toContain('uppercase');
    expect(h1.className).not.toBe(h2.className);
    expect(h2.className).not.toBe(h3.className);
  });

  it('keeps list markers, including ordered numbering and nesting', () => {
    const md = '- a\n- b\n  - nested\n\n1. first\n2. second\n';
    const { container } = render(<MarkdownRenderer content={md} />);

    const ul = container.querySelector('ul')!;
    const ol = container.querySelector('ol')!;
    // An unnumbered ordered list is lost information, not just lost styling.
    expect(ul.className).toContain('list-disc');
    expect(ol.className).toContain('list-decimal');
    expect(ul.className).toContain('pl-6');
    // The sub-list survives as a real nested list rather than being flattened.
    expect(container.querySelector('li ul')).not.toBeNull();
  });

  it('renders links visibly distinct from prose, and safe for a new tab', () => {
    const { container } = render(<MarkdownRenderer content="see [docs](https://example.com/x)" />);

    const link = container.querySelector('a')!;
    expect(link.getAttribute('href')).toBe('https://example.com/x');
    expect(link.getAttribute('target')).toBe('_blank');
    expect(link.getAttribute('rel')).toBe('noreferrer noopener');
    // Colour alone is easy to miss mid-sentence, so the underline is not
    // hover-only — and the link must not inherit plain body styling.
    expect(link.className).toContain('text-primary');
    expect(link.className).toContain('underline');
  });

  it('does not wrap a fenced code block in a redundant outer <pre>', () => {
    const { container } = render(<MarkdownRenderer content={'```ts\nconst a = 1;\n```\n'} />);

    // The `code` handler emits its own block wrapper (shiki, or this Suspense
    // fallback), so react-markdown's default <pre> would nest one inside it.
    expect(container.querySelector('pre')).not.toBeNull();
    expect(container.querySelector('pre pre')).toBeNull();
  });

  it('styles GFM tables with real rules', () => {
    const md = '| Metric | Value |\n| ------ | ----- |\n| Stop | 4.20 |';
    const { container } = render(<MarkdownRenderer content={md} />);

    const table = container.querySelector('table')!;
    expect(table.querySelectorAll('th')).toHaveLength(2);
    expect(container.querySelector('th')!.className).not.toBe('');
    expect(container.querySelector('td')!.className).toContain('border-b');
  });

  it('still renders inline HTML as text, never live markup (sanitize property)', () => {
    const md = 'before <script>alert("xss")</script> after <b>bold</b>';
    const { container } = render(<MarkdownRenderer content={md} />);

    // The typography change must not have loosened the sanitiser: no
    // rehype-raw, default schema, so tags never become live DOM elements.
    expect(container.querySelector('script')).toBeNull();
    expect(container.querySelector('b')).toBeNull();
    expect(container.textContent).toContain('alert("xss")');
    expect(container.textContent).toContain('bold');
  });
});

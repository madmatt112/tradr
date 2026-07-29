// ReleaseMarkdown — sanitised Markdown for GitHub release notes (REQ-4.3).
//
// Deliberate SIBLING of the advisor's MarkdownRenderer
// (features/advisor/components/MarkdownRenderer.tsx) — the same security
// discipline, restated here on purpose:
// - `react-markdown` + `remark-gfm` (tables, strikethrough, task lists, etc.).
// - `rehype-sanitize` with the DEFAULT schema; we deliberately do NOT add
//   `rehype-raw`, so inline HTML in release bodies is rendered as text,
//   never as live markup — the identical property the advisor pins for
//   assistant messages (its REQ-1.13).
//
// Not extracted/shared: the advisor renderer hard-wires advisor concerns
// (the lazy ShikiCodeBlock import and assistant-message prose styling).
// Release notes get plain <pre><code> fenced blocks — no shiki — which also
// keeps the changelog chunk smaller. (Design Component 9.)
//
// TYPOGRAPHY — an explicit `components` map, NOT @tailwindcss/typography.
// That plugin is not a dependency and index.css never loads it, so the
// `prose prose-sm dark:prose-invert` classes this file used to carry emitted
// nothing at all: under Preflight's heading/list reset every release body
// rendered as one flat block of body text — no heading tier, no bullets, no
// spacing between sections. Styling the elements directly rebuilds the
// hierarchy on the app's own tokens and adds no dependency to the
// lazy-loaded changelog chunk.

import { Children, Fragment, type ReactNode } from 'react';
import Markdown, { type Components } from 'react-markdown';
import rehypeSanitize from 'rehype-sanitize';
import remarkGfm from 'remark-gfm';

// GitHub auto-links bare URLs, so most link text in a release body IS a
// 60-character URL — the longest, loudest run on a line whose actual subject
// is the change description. Collapse the routine references to the
// identifier a reader recognises (`#12`, `v0.1.0…v0.5.0`) and set them in the
// mono face, the treatment the app gives every other identifier and figure.
// Only when the link text IS the URL — authored link text is the author's own
// hierarchy and is left alone.
const GITHUB_REF = /^https:\/\/github\.com\/[^/]+\/[^/]+\/(pull|issues|compare|commits)\/(.+)$/;

function shortenGitHubRef(href: string): string | null {
  const match = GITHUB_REF.exec(href);
  if (!match) return null;
  const [, kind, rest] = match;
  if (kind === 'pull' || kind === 'issues') return /^\d+$/.test(rest) ? `#${rest}` : null;
  return rest.replace('...', '…');
}

/** The link's text when it is a single plain string, else null. */
function textOf(children: ReactNode): string | null {
  if (typeof children === 'string') return children;
  if (Array.isArray(children) && children.length === 1 && typeof children[0] === 'string') {
    return children[0];
  }
  return null;
}

// Every generated bullet ends with the same attribution — "…<the actual
// change> by @user in <link>". It repeats verbatim down the whole list and is
// never what the line is about, so it drops to the muted role and the change
// description keeps the foreground. Anchored at the end of a text run, so it
// only ever matches the tail that immediately precedes the PR link; the link
// itself is untouched and keeps its own colour.
const ATTRIBUTION = /^([\s\S]*?)(\s+by\s+@[A-Za-z0-9-]+\s+in\s*)$/;

function mutedAttribution(children: ReactNode): ReactNode {
  const items = Children.toArray(children);
  let matched = false;
  const next = items.map((child, i) => {
    if (typeof child !== 'string') return child;
    const m = ATTRIBUTION.exec(child);
    if (!m) return child;
    matched = true;
    return (
      <Fragment key={i}>
        {m[1]}
        <span className="text-muted-foreground">{m[2]}</span>
      </Fragment>
    );
  });
  return matched ? next : children;
}

// `##` is the spine of a GitHub release body ("What's Changed", "New
// Contributors"). Set as an eyebrow — small, uppercase, tracked, muted — it
// separates from the version above and the list below by case and colour
// rather than by size alone, so the tier still reads at small body sizes.
const SECTION = 'mt-6 mb-2 text-xs font-semibold uppercase tracking-[0.08em] text-muted-foreground';
const SUBSECTION = 'mt-4 mb-2 text-sm font-semibold text-foreground';
const LINK = 'text-primary underline-offset-4 hover:underline cursor-pointer';

const components: Components = {
  h1: ({ children }) => <h1 className={SECTION}>{children}</h1>,
  h2: ({ children }) => <h2 className={SECTION}>{children}</h2>,
  h3: ({ children }) => <h3 className={SUBSECTION}>{children}</h3>,
  h4: ({ children }) => <h4 className={SUBSECTION}>{children}</h4>,
  h5: ({ children }) => <h5 className={SUBSECTION}>{children}</h5>,
  h6: ({ children }) => <h6 className={SUBSECTION}>{children}</h6>,

  // `li` covers tight lists (text sits directly in the item), `p` covers loose
  // ones (remark wraps the item's text in a paragraph) — the attribution can
  // land in either, and the match is anchored so neither double-applies.
  p: ({ children }) => <p className="my-3">{mutedAttribution(children)}</p>,
  ul: ({ children }) => (
    <ul className="my-3 list-disc space-y-1.5 pl-6 marker:text-border">{children}</ul>
  ),
  ol: ({ children }) => (
    <ol className="my-3 list-decimal space-y-1.5 pl-6 marker:text-muted-foreground">{children}</ol>
  ),
  li: ({ children }) => <li>{mutedAttribution(children)}</li>,

  strong: ({ children }) => <strong className="font-semibold text-foreground">{children}</strong>,
  em: ({ children }) => <em className="italic">{children}</em>,
  blockquote: ({ children }) => (
    <blockquote className="my-3 border-l-2 border-border pl-3 text-muted-foreground">
      {children}
    </blockquote>
  ),
  hr: () => <hr className="my-6 border-border" />,

  a: ({ href, children }) => {
    const short = href && textOf(children) === href ? shortenGitHubRef(href) : null;
    return (
      <a
        href={href}
        target="_blank"
        rel="noreferrer noopener"
        className={short ? `font-mono text-xs ${LINK}` : LINK}
      >
        {short ?? children}
      </a>
    );
  },

  // Mono sits one step down from the surrounding body text — it runs
  // optically larger at the same nominal size.
  code: ({ children }) => (
    <code className="rounded bg-muted px-1 py-0.5 font-mono text-xs">{children}</code>
  ),
  pre: ({ children }) => (
    <pre className="my-3 overflow-x-auto rounded-md border bg-muted p-3 text-xs">{children}</pre>
  ),

  table: ({ children }) => (
    <div className="my-4 overflow-x-auto rounded-md border">
      {/* Last row drops its rule so it does not double up with the wrapper's. */}
      <table className="w-full text-left text-sm [&_tr:last-child_td]:border-b-0">{children}</table>
    </div>
  ),
  th: ({ children }) => (
    <th className="border-b bg-muted/50 px-3 py-2 text-xs font-semibold uppercase tracking-[0.06em] text-muted-foreground">
      {children}
    </th>
  ),
  td: ({ children }) => <td className="border-b px-3 py-2">{children}</td>,
};

export interface ReleaseMarkdownProps {
  content: string;
}

export function ReleaseMarkdown({ content }: ReleaseMarkdownProps) {
  return (
    <div className="text-sm leading-relaxed break-words [&>*:first-child]:mt-0 [&>*:last-child]:mb-0">
      <Markdown
        remarkPlugins={[remarkGfm]}
        rehypePlugins={[rehypeSanitize]}
        components={components}
      >
        {content}
      </Markdown>
    </div>
  );
}

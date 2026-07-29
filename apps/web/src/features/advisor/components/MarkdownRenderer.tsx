// MarkdownRenderer — sanitised Markdown for assistant messages (REQ-1.13).
//
// - `react-markdown` + `remark-gfm` (tables, strikethrough, task lists, etc.).
// - `rehype-sanitize` with the DEFAULT schema strips inline HTML and scripts;
//   we deliberately do NOT add `rehype-raw`, so raw HTML in the model output is
//   rendered as text, never as live markup (REQ-1.13 "no inline HTML").
// - Fenced code blocks are syntax-highlighted by `shiki`, which is loaded
//   lazily via `React.lazy` on first code-block render (REQ-1.13 — the
//   highlighter must not be in the initial bundle). Until it resolves, a plain
//   <pre><code> is shown via the Suspense fallback.
//
// This renderer is used ONLY for assistant messages. User messages are plain
// text (Transcript renders them without Markdown).
//
// TYPOGRAPHY — an explicit `components` map, NOT @tailwindcss/typography. That
// plugin is not a dependency and index.css never loads it, so the
// `prose prose-sm dark:prose-invert` classes this file used to carry emitted
// nothing: under Preflight's reset, model output lost its heading tier, ALL
// list markers (ordered numbering included), table rules, and every block
// margin, and links rendered in the body text colour — indistinguishable from
// prose. The changelog's ReleaseMarkdown carries the same treatment for the
// same reason; the two stay siblings rather than a shared module because they
// style different content at different scales (this one keeps the transcript's
// inherited body size so assistant text matches user text, and owns the shiki
// path; the changelog runs at text-sm and owns its own link handling).

import { Suspense, lazy, type ReactNode } from 'react';
import Markdown, { type Components } from 'react-markdown';
import rehypeSanitize from 'rehype-sanitize';
import remarkGfm from 'remark-gfm';

// Isolated chunk: importing shiki only happens when a code block first renders.
const ShikiCodeBlock = lazy(() => import('./ShikiCodeBlock'));

function extractText(children: ReactNode): string {
  if (typeof children === 'string') return children;
  if (Array.isArray(children)) return children.map(extractText).join('');
  return '';
}

// Three heading tiers. Models reach for `##` and `###` constantly, so those two
// have to be told apart at a glance: `##` by weight and size, `###` by dropping
// to a tracked, muted label. Kept modest — this is a chat reply, not a document.
const H1 = 'mt-6 mb-2 text-lg font-semibold';
const H2 = 'mt-6 mb-2 text-base font-semibold';
const H3 = 'mt-4 mb-1 text-sm font-semibold uppercase tracking-[0.08em] text-muted-foreground';

const components: Components = {
  h1: ({ children }) => <h1 className={H1}>{children}</h1>,
  h2: ({ children }) => <h2 className={H2}>{children}</h2>,
  h3: ({ children }) => <h3 className={H3}>{children}</h3>,
  h4: ({ children }) => <h4 className={H3}>{children}</h4>,
  h5: ({ children }) => <h5 className={H3}>{children}</h5>,
  h6: ({ children }) => <h6 className={H3}>{children}</h6>,

  p: ({ children }) => <p className="my-3">{children}</p>,
  // Markers carry real information in model output — an unnumbered "1. 2. 3."
  // is a lost sequence, and a flattened sub-list is a lost relationship.
  ul: ({ children }) => (
    <ul className="my-3 list-disc space-y-1 pl-6 marker:text-muted-foreground">{children}</ul>
  ),
  ol: ({ children }) => (
    <ol className="my-3 list-decimal space-y-1 pl-6 marker:text-muted-foreground">{children}</ol>
  ),

  strong: ({ children }) => <strong className="font-semibold">{children}</strong>,
  em: ({ children }) => <em className="italic">{children}</em>,
  blockquote: ({ children }) => (
    <blockquote className="my-3 border-l-2 border-border pl-3 text-muted-foreground">
      {children}
    </blockquote>
  ),
  hr: () => <hr className="my-6 border-border" />,

  // Model output embeds links mid-sentence, where colour alone is easy to miss,
  // so these stay underlined rather than revealing the underline on hover.
  // External by construction — the sanitiser's default schema already bounds
  // the protocol, and noreferrer/noopener bounds the new tab.
  a: ({ href, children }) => (
    <a
      href={href}
      target="_blank"
      rel="noreferrer noopener"
      className="cursor-pointer text-primary underline underline-offset-4"
    >
      {children}
    </a>
  ),

  code({ className, children, ...props }) {
    const match = /language-(\w+)/.exec(className ?? '');
    const raw = extractText(children);
    // Inline code (no language- class and no newline) stays a simple <code>.
    if (!match && !raw.includes('\n')) {
      return (
        <code className="rounded bg-muted px-1 py-0.5 font-mono text-sm" {...props}>
          {children}
        </code>
      );
    }
    const lang = match?.[1] ?? 'text';
    const fallback = (
      <pre className="overflow-x-auto rounded-md bg-muted p-3 text-sm">
        <code>{raw}</code>
      </pre>
    );
    return (
      <Suspense fallback={fallback}>
        <ShikiCodeBlock code={raw.replace(/\n$/, '')} lang={lang} />
      </Suspense>
    );
  },
  // A fenced block's `code` handler above returns its OWN block wrapper (the
  // shiki <div> or the fallback <pre>), so react-markdown's default <pre> would
  // wrap a block element in a <pre> — invalid, and it double-boxed the shiki
  // output. Pass the child through and let the handler own the block.
  pre: ({ children }) => <>{children}</>,

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

export interface MarkdownRendererProps {
  content: string;
}

export function MarkdownRenderer({ content }: MarkdownRendererProps) {
  return (
    <div className="break-words [&_li_ol]:my-1 [&_li_ul]:my-1 [&>*:first-child]:mt-0 [&>*:last-child]:mb-0">
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

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

const components: Components = {
  code({ className, children, ...props }) {
    const match = /language-(\w+)/.exec(className ?? '');
    const raw = extractText(children);
    // Inline code (no language- class and no newline) stays a simple <code>.
    if (!match && !raw.includes('\n')) {
      return (
        <code className="rounded bg-muted px-1 py-0.5 text-sm" {...props}>
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
};

export interface MarkdownRendererProps {
  content: string;
}

export function MarkdownRenderer({ content }: MarkdownRendererProps) {
  return (
    <div className="prose prose-sm dark:prose-invert max-w-none break-words">
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

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

import Markdown from 'react-markdown';
import rehypeSanitize from 'rehype-sanitize';
import remarkGfm from 'remark-gfm';

export interface ReleaseMarkdownProps {
  content: string;
}

export function ReleaseMarkdown({ content }: ReleaseMarkdownProps) {
  return (
    <div className="prose prose-sm dark:prose-invert max-w-none break-words">
      <Markdown remarkPlugins={[remarkGfm]} rehypePlugins={[rehypeSanitize]}>
        {content}
      </Markdown>
    </div>
  );
}

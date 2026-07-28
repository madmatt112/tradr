// ShikiCodeBlock — the ONLY module that imports `shiki`. It is loaded lazily
// (React.lazy) by MarkdownRenderer on the first code-block render, so `shiki`
// (a multi-MB WASM + grammar payload) never lands in the initial `/advisor`
// chunk (REQ-1.13).
//
// Default export is required by React.lazy. The component highlights its code
// asynchronously via shiki's `codeToHtml` shorthand (Context7-verified import
// shape: `import { codeToHtml } from 'shiki'`). While the async highlight is
// pending, a plain <pre><code> is shown so streamed code is never blank.

import { useEffect, useState } from 'react';
import { codeToHtml } from 'shiki';

export interface ShikiCodeBlockProps {
  code: string;
  lang: string;
}

function ShikiCodeBlock({ code, lang }: ShikiCodeBlockProps) {
  const [html, setHtml] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    codeToHtml(code, { lang, theme: 'github-dark' })
      .then((out) => {
        if (!cancelled) setHtml(out);
      })
      .catch(() => {
        // Unknown language / grammar failure: fall back to the plain block.
        if (!cancelled) setHtml(null);
      });
    return () => {
      cancelled = true;
    };
  }, [code, lang]);

  if (html === null) {
    return (
      <pre className="overflow-x-auto rounded-md bg-muted p-3 text-sm">
        <code>{code}</code>
      </pre>
    );
  }

  // shiki output is a self-contained <pre> with inline styles; it is generated
  // by shiki (not user input) so dangerouslySetInnerHTML is safe here.
  return (
    <div
      className="advisor-shiki overflow-x-auto rounded-md text-sm [&_pre]:p-3"
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}

export default ShikiCodeBlock;

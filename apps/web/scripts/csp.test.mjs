// Red tests for task 18 (security-hardening, C10 — CSP artefact).
//
// Contract, per exported function (design.md C10; Requirements 6.2, 6.3, 6.4, 6.6):
//
// - inlineScriptHashes(html)
//   Pre:  apps/web/index.html has exactly one <script> tag with no `src`
//         attribute (the boot-theme IIFE between the `tradr:boot-theme`
//         marker comments).
//   Call: inlineScriptHashes(readFileSync('apps/web/index.html', 'utf8'))
//   Obs:  returns ["'sha256-<base64 digest of the exact script text>'"].
//   Src:  SHA-256/base64 computed independently in this file from the exact
//         script text extracted from the real index.html (Req 6.6: a changed
//         inline script must change the served hash with no hand edit).
//
// - cspTemplate(hashes)
//   Pre:  none (pure function of its argument).
//   Call: cspTemplate(["'sha256-<fixture-hash>'"])
//   Obs:  the `script-src` directive carries 'self', the given hash, and
//         neither 'unsafe-inline' nor 'unsafe-eval'; `default-src`,
//         `frame-ancestors`, `object-src`, `base-uri` and `form-action` are
//         exactly the locked-down values; `style-src` carries 'unsafe-inline'.
//   Src:  design.md C10's exact template string (Req 6.2, 6.3).
//
// - renderCsp(template, origins)
//   Pre:  a template produced by cspTemplate.
//   Call: renderCsp(template, { apiOrigin, posthogOrigins })
//   Obs:  `connect-src` and `img-src` contain 'self', the api origin and the
//         posthog origins; with no origins given, the rendered policy
//         contains no `__` placeholder.
//   Src:  design.md C10 interface description (Req 6.4; "leaves no __").
//
// - posthogOrigins(host)
//   Pre:  none (pure function of its argument).
//   Call: posthogOrigins(host)
//   Obs:  the US pair for unset/us/app hosts, the EU pair for an eu host,
//         the host's own origin for any other host.
//   Src:  posthog-js 1.387.0 `endpointFor`/`region` getter, probed directly
//         against apps/web/node_modules/posthog-js/dist/module.js (region
//         regex `/https:\/\/(app|us|us-assets)(\.i)?\.posthog\.com/i` for US,
//         `/https:\/\/(eu|eu-assets)(\.i)?\.posthog\.com/i` for EU, else the
//         apiHost itself) — design.md C10.

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { cspTemplate, inlineScriptHashes, posthogOrigins, renderCsp } from './csp.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const indexHtmlPath = resolve(here, '../index.html');

// Pulls the directive named `name` (e.g. "script-src") out of a rendered
// policy string, so a style-src exception for 'unsafe-inline' can never leak
// into the script-src assertion.
function directive(policy, name) {
  const found = policy
    .split(';')
    .map((part) => part.trim())
    .find((part) => part === name || part.startsWith(`${name} `));
  if (found === undefined) {
    throw new Error(`no "${name}" directive in policy: ${policy}`);
  }
  return found;
}

describe('inlineScriptHashes', () => {
  it('hashes exactly the one inline script in the real index.html that has no src, as a CSP hash-source (Req 6.6)', () => {
    const html = readFileSync(indexHtmlPath, 'utf8');

    // Independently locate the one bare `<script>…</script>` (no attributes,
    // so the `src="/config.js"` and `src="/src/main.tsx"` scripts are
    // excluded) and hash its exact text, mirroring CSP's hash-source
    // algorithm (sha256 over the raw inline script text, base64-encoded).
    const bareScripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)];
    expect(bareScripts).toHaveLength(1);
    const expectedDigest = createHash('sha256').update(bareScripts[0][1], 'utf8').digest('base64');

    expect(inlineScriptHashes(html)).toEqual([`'sha256-${expectedDigest}'`]);
  });
});

describe('cspTemplate', () => {
  const hash = "'sha256-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA='";
  const template = cspTemplate([hash]);

  it('puts the inline-script hash in script-src with no unsafe-inline or unsafe-eval (Req 6.2)', () => {
    const scriptSrc = directive(template, 'script-src');
    expect(scriptSrc).toContain("'self'");
    expect(scriptSrc).toContain(hash);
    expect(scriptSrc).not.toContain('unsafe-inline');
    expect(scriptSrc).not.toContain('unsafe-eval');
  });

  it('locks default-src, frame-ancestors, object-src, base-uri and form-action to self/none (Req 6.2)', () => {
    expect(directive(template, 'default-src')).toBe("default-src 'self'");
    expect(directive(template, 'frame-ancestors')).toBe("frame-ancestors 'none'");
    expect(directive(template, 'object-src')).toBe("object-src 'none'");
    expect(directive(template, 'base-uri')).toBe("base-uri 'self'");
    expect(directive(template, 'form-action')).toBe("form-action 'self'");
  });

  it('allows unsafe-inline in style-src (Req 6.3)', () => {
    expect(directive(template, 'style-src')).toBe("style-src 'self' 'unsafe-inline'");
  });
});

describe('renderCsp', () => {
  const hash = "'sha256-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA='";
  const template = cspTemplate([hash]);

  it('fills connect-src and img-src with self, the API origin and the PostHog origins (Req 6.4)', () => {
    const rendered = renderCsp(template, {
      apiOrigin: 'https://api.example.com',
      posthogOrigins: ['https://us.i.posthog.com', 'https://us-assets.i.posthog.com'],
    });

    for (const name of ['connect-src', 'img-src']) {
      const src = directive(rendered, name);
      expect(src).toContain("'self'");
      expect(src).toContain('https://api.example.com');
      expect(src).toContain('https://us.i.posthog.com');
      expect(src).toContain('https://us-assets.i.posthog.com');
    }
  });

  it('leaves no unexpanded "__" placeholder when no origins are given (Req 6.4)', () => {
    const rendered = renderCsp(template, {});
    expect(rendered).not.toContain('__');
  });
});

describe('posthogOrigins', () => {
  it('gives the US pair when the host is unset (Req 6.4)', () => {
    expect(posthogOrigins(undefined)).toEqual([
      'https://us.i.posthog.com',
      'https://us-assets.i.posthog.com',
    ]);
  });

  it('gives the US pair for us and app hosts (Req 6.4)', () => {
    expect(posthogOrigins('https://us.posthog.com')).toEqual([
      'https://us.i.posthog.com',
      'https://us-assets.i.posthog.com',
    ]);
    expect(posthogOrigins('https://app.posthog.com')).toEqual([
      'https://us.i.posthog.com',
      'https://us-assets.i.posthog.com',
    ]);
  });

  it('gives the EU pair for an eu host (Req 6.4)', () => {
    expect(posthogOrigins('https://eu.posthog.com')).toEqual([
      'https://eu.i.posthog.com',
      'https://eu-assets.i.posthog.com',
    ]);
  });

  it("gives the host's own origin for a custom host (Req 6.4)", () => {
    expect(posthogOrigins('https://ph.example.com')).toEqual(['https://ph.example.com']);
  });
});

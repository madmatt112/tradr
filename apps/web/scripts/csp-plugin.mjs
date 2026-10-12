// Vite plugin that emits the CSP artefact and serves it from `vite preview`
// (security-hardening, design C10).
//
//   writeBundle           -> writes dist/csp-policy.txt beside the built
//                            index.html (the template with the inline-script
//                            hash; origins stay as placeholders for C11/C12).
//   configurePreviewServer -> sets the rendered policy (no origins) and the four
//                            static headers on every non-/api/ response, ahead of
//                            the proxy and static-file middlewares (Req 6.10).
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { STATIC_SECURITY_HEADERS, cspTemplate, inlineScriptHashes, renderCsp } from './csp.mjs';

// The template (hash filled, origins as placeholders) from a built index.html.
function templateFromHtml(htmlPath) {
  return cspTemplate(inlineScriptHashes(readFileSync(htmlPath, 'utf8')));
}

export function cspArtifactPlugin() {
  return {
    name: 'tradr-csp-artifact',

    // Fires after the bundle (including index.html) is written to options.dir
    // (rollup 4.59.0 writeBundle hook).
    writeBundle(options) {
      const template = templateFromHtml(resolve(options.dir, 'index.html'));
      writeFileSync(resolve(options.dir, 'csp-policy.txt'), template);
    },

    // vite 6.4.1: middlewares added in the hook body run before the proxy and
    // the static-file handler, so the headers reach every page the preview
    // server serves.
    configurePreviewServer(server) {
      const outDir = resolve(server.config.root, server.config.build.outDir);
      const policy = renderCsp(templateFromHtml(resolve(outDir, 'index.html')), {});
      server.middlewares.use((req, res, next) => {
        if (!(req.url ?? '').startsWith('/api/')) {
          res.setHeader('Content-Security-Policy', policy);
          for (const [name, value] of Object.entries(STATIC_SECURITY_HEADERS)) {
            res.setHeader(name, value);
          }
        }
        next();
      });
    },
  };
}

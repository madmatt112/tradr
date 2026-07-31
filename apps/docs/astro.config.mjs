// @ts-check
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

import { defineConfig } from 'astro/config';
import starlight from '@astrojs/starlight';
import starlightLlmsTxt from 'starlight-llms-txt';
import starlightPageContextAction from 'starlight-page-context-action';
import starlightLinksValidator from 'starlight-links-validator';
import starlightOpenAPI, { createOpenAPISidebarGroup } from 'starlight-openapi';
import sitemap from '@astrojs/sitemap';

// The Tradr documentation site. It lives in the product repo, next to the code
// it documents, so a doc change ships in the same PR as the change it describes
// and one CI run gates both.
//
// Served at www.tradr.cloud/docs. `base` prefixes every route and every emitted
// asset with /docs, so the site is self-contained under that one prefix and the
// marketing site can front it.
//
// Note that `base` does NOT nest the build output — dist/ is flat, and the HTML
// inside refers to /docs/…. Whatever fronts this project must therefore strip
// the /docs prefix before serving from dist/. Serving dist/ at a path other than
// /docs will 404 every asset.
const openAPISidebarGroup = createOpenAPISidebarGroup();

const CONTENT_DIR = fileURLToPath(new URL('./src/content/docs', import.meta.url));

/**
 * Slugs of pages that are listed in the IA but not written yet.
 *
 * Four independent levers control whether a page is discoverable, and sidebar
 * membership is none of them:
 *
 *   Sidebar   `sidebar:` below
 *   Search    `pagefind: false` in the page's frontmatter
 *   Crawlers  a robots/noindex `head:` entry in the page's frontmatter
 *   Sitemap   the `filter` on sitemap() below
 *   llms      starlightLlmsTxt()'s `exclude`
 *
 * `exclude` reaches `llms-small.txt` only — verified against starlight-llms-txt
 * 0.11.0, where llms-full.txt.ts never passes the option to the generator. That
 * is deliberate on the plugin's part: llms-full.txt means the full set. So an
 * AI reading the abridged set gets only written pages, and one reading the full
 * set sees the placeholders clearly labelled as such.
 *
 * The config-level levers would drift from the frontmatter ones if they were
 * hand-listed, so they are derived from the frontmatter instead: the noindex
 * marker on the page IS the single source of truth. Write a page, delete its
 * two frontmatter lines, and every lever flips together.
 */
function collectUnwrittenSlugs(dir = CONTENT_DIR) {
  /** @type {string[]} */
  const slugs = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      slugs.push(...collectUnwrittenSlugs(full));
    } else if (entry.name.endsWith('.mdx') || entry.name.endsWith('.md')) {
      const frontmatter = readFileSync(full, 'utf8').split('\n---')[0];
      if (/content:\s*noindex/.test(frontmatter)) {
        slugs.push(relative(CONTENT_DIR, full).replace(/\.mdx?$/, ''));
      }
    }
  }
  return slugs;
}

const UNWRITTEN = collectUnwrittenSlugs();

export default defineConfig({
  site: 'https://www.tradr.cloud',
  base: '/docs',
  output: 'static',
  integrations: [
    starlight({
      title: 'Tradr docs',
      description:
        'Documentation for Tradr — the open-source trading journal with an AI advisor. User guide for the hosted app plus self-hosting and development guides.',
      pagefind: true,
      // Every page gets an "Edit this page" link straight to its source. This is
      // only possible now that the docs live in the public product repo.
      editLink: {
        baseUrl: 'https://github.com/madmatt112/tradr/edit/main/apps/docs/',
      },
      head: [
        { tag: 'link', attrs: { rel: 'icon', href: '/docs/favicon.ico', sizes: 'any' } },
        { tag: 'link', attrs: { rel: 'apple-touch-icon', href: '/docs/apple-touch-icon.png' } },
      ],
      plugins: [
        starlightLlmsTxt({ exclude: UNWRITTEN }),
        starlightPageContextAction(),
        // The API reference, rendered from the committed OpenAPI artifact that
        // scripts/gen-openapi.mjs generates out of apps/api's `@swagger` blocks.
        // Listed before the links validator so its routes exist when links are
        // checked.
        starlightOpenAPI([
          {
            base: 'self-hosting/reference/api',
            schema: './src/openapi/tradr-api.json',
            sidebar: {
              label: 'API reference',
              collapsed: true,
              group: openAPISidebarGroup,
              operations: { badges: true },
            },
          },
        ]),
        // Fails the build — and therefore CI — on any broken internal link.
        starlightLinksValidator(),
      ],
      customCss: ['./src/styles/fonts.css', './src/styles/tokens.css', './src/styles/docs.css'],
      social: [{ icon: 'github', label: 'GitHub', href: 'https://github.com/madmatt112/tradr' }],
      // IA by audience — what the reader is trying to do — not by Diátaxis mode.
      // The modes remain an authoring discipline (docs/STYLE.md); they were never
      // useful as navigation. Page paths are unchanged.
      sidebar: [
        { label: 'Start here', slug: 'index' },
        {
          label: 'User guide',
          items: [
            { label: 'Getting started', slug: 'user-guide/getting-started' },
            { label: 'Log and manage positions', slug: 'user-guide/positions' },
            { label: 'Use the trade calculator', slug: 'user-guide/trade-calculator' },
            { label: 'Customise the dashboard', slug: 'user-guide/dashboard' },
            { label: 'Accounts & the multi-currency ledger', slug: 'user-guide/accounts' },
            { label: 'Review performance & P&L', slug: 'user-guide/performance' },
            { label: 'Use the AI advisor', slug: 'user-guide/ai-advisor' },
            { label: 'Options tools', slug: 'user-guide/options-tools' },
            { label: 'Import your history', slug: 'user-guide/import-history' },
            { label: 'Accounting & tax', slug: 'user-guide/accounting-tax' },
            { label: 'Metrics glossary', slug: 'user-guide/reference/metrics-glossary' },
            { label: 'Plan limits', slug: 'user-guide/reference/plan-limits' },
          ],
        },
        {
          label: 'Run it yourself',
          items: [
            { label: 'Install with Docker Compose', slug: 'self-hosting/docker-compose' },
            { label: 'Upgrade an instance', slug: 'self-hosting/upgrades' },
            { label: 'Back up and restore', slug: 'self-hosting/backup-restore' },
            {
              label: 'Configure email, Stripe, and LLM keys',
              slug: 'self-hosting/optional-integrations',
            },
            {
              label: 'Bring your own Postgres / run behind a pooler',
              slug: 'self-hosting/external-postgres',
            },
            { label: 'Put TLS in front of the stack', slug: 'self-hosting/tls-reverse-proxy' },
            { label: 'Environment variables', slug: 'self-hosting/reference/env-vars' },
            { label: 'CLI reference (tradr)', slug: 'self-hosting/reference/cli' },
            openAPISidebarGroup,
          ],
        },
        {
          label: 'Build on it',
          items: [
            { label: 'Set up a local dev environment', slug: 'self-hosting/local-dev' },
            { label: 'Architecture overview', slug: 'self-hosting/explanation/architecture' },
            { label: 'Database & migrations', slug: 'self-hosting/explanation/migrations' },
            { label: 'Database schema', slug: 'self-hosting/reference/db-schema' },
            { label: 'Security model', slug: 'self-hosting/explanation/security' },
            {
              label: 'Contributing',
              link: 'https://github.com/madmatt112/tradr/blob/main/CONTRIBUTING.md',
              attrs: { target: '_blank' },
            },
          ],
        },
        {
          label: 'Why it works this way',
          items: [
            {
              label: "Hosted vs self-hosted: what's different",
              slug: 'user-guide/explanation/hosted-vs-self-hosted',
            },
            {
              label: 'How the AI advisor reasons',
              slug: 'user-guide/explanation/how-the-advisor-works',
            },
            {
              label: 'Why journaling improves your trading',
              slug: 'user-guide/explanation/why-journal',
            },
          ],
        },
      ],
    }),
    sitemap({
      // Keep unwritten pages out of the sitemap. Submitting ~20 near-identical
      // placeholder pages for indexing is a thin-content liability, and it is
      // what made 97 of the old site's 98 sitemap URLs placeholder docs pages.
      filter: (page) =>
        !UNWRITTEN.some((slug) => page === `https://www.tradr.cloud/docs/${slug}/`),
    }),
  ],
});

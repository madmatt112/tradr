// Content collections for apps/docs. Starlight owns the `docs` collection that
// renders every page under src/content/docs/**. Uses Starlight's docs loader +
// schema so frontmatter (title, description, sidebar overrides, Aside
// directives, etc.) is validated at build time.
import { docsLoader } from '@astrojs/starlight/loaders';
import { docsSchema } from '@astrojs/starlight/schema';
import { defineCollection } from 'astro:content';

export const collections = {
  docs: defineCollection({ loader: docsLoader(), schema: docsSchema() }),
};

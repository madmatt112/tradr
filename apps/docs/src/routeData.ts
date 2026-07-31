import { defineRouteMiddleware } from '@astrojs/starlight/route-data';

// Keep the generated API reference from swallowing site search.
//
// The reference is 93 operations, each its own page, and every one repeats the
// domain vocabulary — "position", "account", "expense". Measured on the built
// index before this existed: searching "positions" returned seven API operation
// pages before the single user-guide page that actually answers the question.
// Someone looking for how to log a trade got a wall of endpoint stubs.
//
// So the operation pages are excluded from the search index. The reference is
// still fully reachable — it has its own sidebar group, and the API overview
// page stays indexed, so searching "API" finds the way in. What you lose is
// full-text search *within* the reference; browsing by endpoint is how that
// material is read anyway, and the sidebar does that better than search.
//
// Starlight reads `entry.data.pagefind` in Page.astro to decide whether to mark
// <main> as a Pagefind body, so clearing it here removes the page from the index
// without touching the generated content.
const API_BASE = 'self-hosting/reference/api';

export const onRequest = defineRouteMiddleware((context) => {
  const { entry } = context.locals.starlightRoute;
  // The overview lives at the base itself; everything deeper is one operation.
  if (entry.id.startsWith(`${API_BASE}/`)) {
    entry.data.pagefind = false;
  }
});

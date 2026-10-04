import { QueryClientProvider } from '@tanstack/react-query';
import { createRouter, RouterProvider } from '@tanstack/react-router';
import { ThemeProvider } from 'next-themes';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import { setRouter } from './lib/api';
import { installChunkRecovery } from './lib/chunkRecovery';
import { queryClient } from './lib/queryClient';
import { registerServiceWorker } from './lib/serviceWorker';
import { initPostHogClient } from './lib/telemetry/posthog';
import { routeTree } from './routeTree.gen';
import './index.css';
const router = createRouter({ routeTree });
setRouter(router);

// Register the single chunk-preload-error listener before render, so it exists
// before any lazy import can fail (design Component 3).
installChunkRecovery();

declare module '@tanstack/react-router' {
  interface Register {
    router: typeof router;
  }
}

// Frontend telemetry composition root (design Component 9). The call is
// internally gated and a no-op when unconfigured; it subscribes to router
// navigations for masked pageviews. initPostHogClient is async — fire and forget
// so it never blocks the first paint.
void initPostHogClient(router);

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <ThemeProvider attribute="class" defaultTheme="system" storageKey="theme">
        <RouterProvider router={router} />
      </ThemeProvider>
    </QueryClientProvider>
  </StrictMode>,
);

// Register the service worker after first render (design Component 3). The call
// is internally gated — a no-op in dev/preview builds and where service workers
// are unsupported — and never blocks first paint.
registerServiceWorker();
